const path = require('path');

/**
 * The browser must outlive the export.
 *
 * Six real runs on 2026-09-28 died like this:
 *
 *     [SUCCESS] Found content frame (navigation): https://…/onenoteframe.aspx?…
 *     [INFO]    Scanning sections...
 *     [WARN]    Timeout waiting for .sectionList, trying to scrape anyway...
 *     frame.evaluate: Target page, context or browser has been closed
 *         at getSections (src/scrapers.js:15:18)
 *
 * with the browser window open on screen, fully rendered, showing the notebook.
 * That contradiction is the whole of this test: the target was not crashing, the
 * tool was closing it.
 *
 * `runExport` ends with a `finally` that closes the browser. Returning a
 * *promise* from inside a `try` with a `finally` does not wait for it - the
 * finally runs the instant the return expression is evaluated:
 *
 *     try { return doTheWork(); } finally { await browser.close(); }   // close() first
 *     try { return await doTheWork(); } finally { await browser.close(); }  // close() after
 *
 * So `return exportContent(...)` closed the browser before the export's first
 * DOM call, and the race decided whether the run got one section in before the
 * browser went. This is a test of *ordering*, so it asserts ordering: the close
 * must be the last thing that happens, never the first.
 *
 * It runs `runExport` against fakes rather than a real notebook, because the bug
 * is a timing bug in a function that only misbehaves when a browser is involved,
 * and because the existing end-to-end test calls `exportContent` directly - which
 * is precisely why it never saw this.
 */
jest.mock('../src/navigator', () => ({
    listNotebooks: jest.fn(),
    openNotebook: jest.fn(),
    openNotebookByLink: jest.fn(),
}));
jest.mock('../src/utils/logger', () => ({
    success: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    step: jest.fn(),
    log: jest.fn(),
    getDumpDir: jest.fn(),
    getDumpDisplayPath: jest.fn(),
    setSink: jest.fn(),
}));

const os = require('os');
const fs = require('fs-extra');
const { listNotebooks, openNotebook, openNotebookByLink } = require('../src/navigator');
const { runExport } = require('../src/exporter');

/** Ordered record of everything the fakes were asked to do. */
const buildStage = () => {
    const events = [];

    // The notebook frame. It reports no sections, which is a valid (empty)
    // notebook: enough to prove the export really reached the DOM, which is the
    // only thing this test needs.
    const frame = {
        isDetached: () => false,
        url: () => 'https://notebook.example.invalid/onenoteframe.aspx',
        page: () => editorPage,
        $: async (sel) => {
            events.push(`frame.${sel}`);
            return sel === '.sectionList' ? {} : null;
        },
        $$eval: async () => [],
        // getSections is the only evaluate this test reaches, and it now answers
        // with {items, reason} rather than a bare array. An empty notebook at the
        // top level is the valid case: no parent, so no reason.
        evaluate: async () => { events.push('frame.evaluate'); return { items: [], reason: null }; },
        waitForSelector: async () => { events.push('frame.waitForSelector'); return {}; },
        waitForTimeout: async () => { events.push('frame.waitForTimeout'); },
        content: async () => '<html></html>',
    };

    const editorPage = {
        url: () => 'https://tenant.example.invalid/personal/user/_layouts/15/Doc.aspx?sourcedoc={abc}',
        frames: () => [frame],
        mainFrame: () => frame,
        isClosed: () => false,
        waitForTimeout: async () => { events.push('page.waitForTimeout'); },
        title: async () => 'My Notebook',
    };

    const browser = {
        newContext: jest.fn(),
        // The event under test.
        close: async () => { events.push('browser.close'); },
    };

    const context = { newPage: async () => editorPage };

    return { browser, context, editorPage, frame, events };
};

describe('runExport does not close the browser before the export is done', () => {
    let outDir;

    beforeEach(() => {
        jest.clearAllMocks();
        outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-'));
    });

    afterEach(() => fs.removeSync(outDir));

    const wireUp = (stage, { byLink = false } = {}) => {
        if (byLink) {
            openNotebookByLink.mockResolvedValue({
                browser: stage.browser, context: stage.context,
                page: stage.editorPage, notebookName: 'My Notebook'
            });
        } else {
            listNotebooks.mockResolvedValue({
                notebooks: [{ name: 'My Notebook', id: 'notebook-row-1' }],
                browser: stage.browser, context: stage.context, page: stage.editorPage,
            });
            openNotebook.mockResolvedValue({
                browser: stage.browser, context: stage.context, page: stage.editorPage
            });
        }
    };

    it('closes the browser only after the export has used it (--notebook)', async () => {
        const stage = buildStage();
        wireUp(stage);

        await runExport({ notebook: 'My Notebook', exportDir: outDir });

        expect(stage.events).toContain('frame.evaluate');
        expect(stage.events.indexOf('browser.close'))
            .toBeGreaterThan(stage.events.indexOf('frame.evaluate'));
    });

    it('closes the browser only after the export has used it (--notebook-link)', async () => {
        const stage = buildStage();
        wireUp(stage, { byLink: true });

        await runExport({ notebookLink: 'https://notebook.example.invalid/x', exportDir: outDir });

        expect(stage.events).toContain('frame.evaluate');
        expect(stage.events.indexOf('browser.close'))
            .toBeGreaterThan(stage.events.indexOf('frame.evaluate'));
    });

    it('still closes the browser when the export fails', async () => {
        // The point of the fix is not to stop the cleanup, it is to move it after
        // the work. A run that throws must not leak the browser.
        const stage = buildStage();
        wireUp(stage);
        stage.frame.evaluate = async () => { throw new Error('scrape blew up'); };

        await expect(runExport({ notebook: 'My Notebook', exportDir: outDir }))
            .rejects.toThrow('scrape blew up');

        expect(stage.events).toContain('browser.close');
    });

    it('has no bare `return exportContent(` left in runExport', () => {
        // Structural, and the reason it is here as well as behaviourally: the
        // difference between this and the bug is one word, it is invisible to a
        // reader and to the type system, and nothing in the toolchain objects -
        // `no-return-await` deliberately exempts `return await` inside a
        // try/finally, because there it is required. So only a test can hold it.
        const source = fs.readFileSync(
            path.resolve(__dirname, '..', 'src', 'exporter.js'), 'utf8');

        // Comments are stripped first: the fix is explained in a comment that
        // quotes the broken form verbatim, and matching that would be a test of
        // the prose rather than of the code. The slice is taken from the
        // stripped text, so the offsets line up.
        const code = source
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        const runExportBody = code.slice(code.indexOf('async function runExport'));

        expect(runExportBody).not.toMatch(/return exportContent\(/);
        expect(runExportBody).toMatch(/return await exportContent\(/);
    });

    it('detaches the log sink, so one run cannot report into the next one', async () => {
        // The logger is a module singleton. A sink left attached when runExport
        // returns would send the *following* run's log lines to this caller's
        // observer — and in a server that exports one notebook per session, into
        // someone else's session entirely.
        const logger = require('../src/utils/logger');
        const stage = buildStage();
        wireUp(stage);

        await runExport({ notebook: 'My Notebook', exportDir: outDir });
        expect(logger.setSink).toHaveBeenLastCalledWith(null);

        // And on the failing path, which is where a `finally` is most likely to be
        // skipped.
        jest.clearAllMocks();
        const failing = buildStage();
        wireUp(failing);
        failing.frame.evaluate = async () => { throw new Error('scrape blew up'); };

        await expect(runExport({ notebook: 'My Notebook', exportDir: outDir }))
            .rejects.toThrow('scrape blew up');
        expect(logger.setSink).toHaveBeenLastCalledWith(null);
    });

    it('emits started and done around the walk, with the caller id on each', async () => {
        const stage = buildStage();
        wireUp(stage);
        const events = [];

        await runExport({
            notebook: 'My Notebook',
            exportDir: outDir,
            id: 'export-abc',
            onEvent: e => events.push(e),
        });

        const types = events.map(e => e.type);
        expect(types[0]).toBe('export-started');
        expect(types).toContain('export-done');

        // `id` is the caller's and must come back on every event, or the caller
        // cannot attribute a line to a run when two overlap.
        for (const event of events) {
            expect(event.id).toBe('export-abc');
        }

        const done = events.find(e => e.type === 'export-done');
        expect(done.notebook).toBe('My Notebook');
        expect(typeof done.pages).toBe('number');
        expect(typeof done.sections).toBe('number');
        expect(typeof done.assets).toBe('number');
    });

    it('behaves identically when no observer is supplied', async () => {
        // The promise from a caller on today's version: no onEvent, no id, no
        // signal. It must still complete, or every existing caller breaks.
        const stage = buildStage();
        wireUp(stage);

        await expect(runExport({ notebook: 'My Notebook', exportDir: outDir }))
            .resolves.toBeDefined();
        expect(stage.events).toContain('frame.evaluate');
    });

    it('completes normally when the observer throws on every event', async () => {
        // The observer is watching, not participating. Its bug must not cost the
        // caller the export.
        const stage = buildStage();
        wireUp(stage);

        await expect(runExport({
            notebook: 'My Notebook',
            exportDir: outDir,
            onEvent: () => { throw new Error('observer bug'); },
        })).resolves.toBeDefined();
    });
});
