const fs = require('fs-extra');
const os = require('os');
const path = require('path');

/**
 * Tests for the live notebook handle.
 * The failure these exist for (2026-09-28) is not hypothetical and not subtle:
 * five real runs of
 *
 *     node src/index.js export --notebook "My Notebook" --auth-file ... --notheadless
 *
 * all reached the same line - the frame finder had just reported
 * `Found content frame (navigation): .../onenoteframe.aspx` - and all died
 * within a second, at the first DOM call, with
 *
 *     frame.evaluate: Target page, context or browser has been closed
 *     at getSections (src/scrapers.js:15:18)
 *
 * reported as an unhandled promise rejection, so not even the CLI's own error
 * handler ran. Two separate defects were involved and both are covered here:
 *
 *   1. the export pinned one Frame object for the whole run, so any event that
 *      invalidated it - OneNote re-creating the frame on a reload, the tab
 *      closing, the renderer crashing - was unrecoverable;
 *   2. the `.sectionList` wait reported every failure as a timeout, so a dead
 *      tab looked like a slow DOM.
 *
 * The unit tests use fakes to pin the two outcomes down cheaply; the browser
 * tests prove the recovery works against a real frame being replaced, because a
 * fake cannot produce a genuine detach.
 */

// The logger singleton is mocked so the summary assertions are about what the
// user is told, not about stdout - and so a browser run does not spray the test
// output. The logger module exports the instance directly, so the mock is the
// object itself rather than a { default: ... } wrapper.
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

const { chromium } = require('playwright');
const logger = require('../src/utils/logger');
const exporter = require('../src/exporter');
const {
    createNotebookSession,
    NotebookUnavailableError,
    frameIsUsable,
    isTransientFrameError
} = require('../src/notebookFrame');

/** All text the mocked logger was asked to print, flattened. */
const said = () => [].concat(
    ...['success', 'warn', 'info'].map((lvl) => logger[lvl].mock.calls.map((c) => String(c[0])))
).join('\n');

/** Collects log lines instead of writing them, so the tests stay quiet. */
const fakeLog = () => {
    const lines = { debug: [], info: [], warn: [], error: [] };
    return {
        lines,
        debug: (m) => lines.debug.push(m),
        info: (m) => lines.info.push(m),
        warn: (m) => lines.warn.push(m),
        error: (m) => lines.error.push(m)
    };
};

const targetClosed = () => new Error('frame.evaluate: Target page, context or browser has been closed');
const contextDestroyed = () => new Error('frame.evaluate: Execution context was destroyed, most likely because of a navigation.');

/**
 * A frame that behaves like the one Playwright hands out: a real object that
 * becomes a husk when OneNote replaces it, and a dead one when its page goes.
 */
const makeFrame = (page, name) => {
    const frame = {
        live: true,
        name: () => name,
        page: () => page,
        isDetached: () => !frame.live,
        evaluate: jest.fn(async () => `evaluated in ${name}`),
        $: jest.fn(async () => ({ tag: name })),
        $$eval: jest.fn(async () => [])
    };
    return frame;
};

/** A page that can lose its frame, or lose itself, on demand. */
const makePage = () => {
    const handlers = {};
    return {
        closed: false,
        frames: [],
        on(event, fn) { (handlers[event] = handlers[event] || []).push(fn); },
        emit(event) { (handlers[event] || []).forEach((fn) => fn()); },
        isClosed() { return this.closed; }
    };
};

describe('notebook session: a frame OneNote replaced', () => {
    it('finds the new frame and carries on instead of using the detached one', async () => {
        const log = fakeLog();
        const page = makePage();
        const first = makeFrame(page, 'first');
        const second = makeFrame(page, 'second');
        page.frames = [first, second];

        const find = jest.fn(async () => second);
        const notebook = createNotebookSession({ page, frame: first, find, log });

        first.live = false;   // OneNote reloaded and replaced the frame

        expect(await notebook.evaluate(() => 1)).toBe('evaluated in second');
        expect(find).toHaveBeenCalledWith(page);
        expect(log.lines.info.join(' ')).toMatch(/replaced by a page reload/);
    });

    it('retries a call that lost its execution context mid-flight', async () => {
        const page = makePage();
        const frame = makeFrame(page, 'only');
        frame.evaluate = jest.fn()
            .mockRejectedValueOnce(contextDestroyed())
            .mockResolvedValueOnce('evaluated in only');
        page.frames = [frame];

        const notebook = createNotebookSession({
            page, frame, find: async () => frame, log: fakeLog()
        });

        expect(await notebook.evaluate(() => 1)).toBe('evaluated in only');
    });

    it('does not retry a call that failed for an ordinary reason', async () => {
        const page = makePage();
        const frame = makeFrame(page, 'only');
        const realFailure = new Error('Section wrapper not found for ID: nope');
        frame.$ = jest.fn().mockRejectedValue(realFailure);
        page.frames = [frame];

        const find = jest.fn(async () => frame);
        const notebook = createNotebookSession({ page, frame, find, log: fakeLog() });

        await expect(notebook.$('#nope')).rejects.toBe(realFailure);
        expect(find).not.toHaveBeenCalled();
    });

    it('gives up rather than looking forever when no frame comes back', async () => {
        const page = makePage();
        const frame = makeFrame(page, 'only');
        frame.live = false;
        page.frames = [frame];

        const find = jest.fn(async () => null);
        const notebook = createNotebookSession({ page, frame, find, log: fakeLog() });

        await expect(notebook.evaluate(() => 1)).rejects.toThrow(NotebookUnavailableError);
        expect(find.mock.calls.length).toBeLessThanOrEqual(3);
    });
});

describe('notebook session: an editor tab that is gone', () => {
    it('says the tab was closed, and what to do about it', async () => {
        const page = makePage();
        const frame = makeFrame(page, 'only');
        page.frames = [frame];

        const find = jest.fn(async () => frame);
        const notebook = createNotebookSession({ page, frame, find, log: fakeLog() });

        // What Playwright emits, in the order it emits it, once a tab is closed.
        page.emit('close');
        page.closed = true;

        const error = await notebook.frame().catch((e) => e);

        expect(error).toBeInstanceOf(NotebookUnavailableError);
        expect(error.message).toMatch(/tab was closed/);
        expect(error.message).toMatch(/Re-run the export/);
        // Nothing to re-find: the page itself is what is missing.
        expect(find).not.toHaveBeenCalled();
    });

    it('distinguishes a crashed renderer from a closed tab, because the advice differs', async () => {
        const page = makePage();
        const frame = makeFrame(page, 'only');
        page.frames = [frame];

        const notebook = createNotebookSession({
            page, frame, find: async () => frame, log: fakeLog()
        });

        // A crashed renderer fires 'crash' and nothing else, so this is the only
        // evidence that distinguishes "the machine ran out of memory" from
        // "somebody closed the tab" - both arrive as the same Playwright error.
        page.emit('crash');
        page.closed = true;

        const error = await notebook.frame().catch((e) => e);

        expect(error).toBeInstanceOf(NotebookUnavailableError);
        expect(error.message).toMatch(/crashed/);
        expect(error.message).toMatch(/out of memory/);
    });

    it('never mentions Playwright internals in the message the user reads', async () => {
        const page = makePage();
        const frame = makeFrame(page, 'only');
        page.frames = [frame];
        page.closed = true;

        const notebook = createNotebookSession({ page, frame, log: fakeLog() });

        const error = await notebook.frame().catch((e) => e);

        // The point of the message is that someone reading it has a notebook and
        // a browser, not a stack trace: no library named, no frames, no paths.
        expect(error.message).not.toMatch(/playwright|node_modules|at .*\(/i);
        // ...and the evidence is still available for whoever debugs it.
        expect(error.state).toMatch(/pageClosed=/);
    });
});

describe('notebook session: surface used by the exporter', () => {
    it('reports the page that owns the live frame, which is what downloads need', async () => {
        const page = makePage();
        const frame = makeFrame(page, 'only');
        page.frames = [frame];

        const notebook = createNotebookSession({ page, frame, log: fakeLog() });

        expect(notebook.page()).toBe(page);
    });

    it('forwards whatever Playwright Frame method the exporter calls', async () => {
        const page = makePage();
        const frame = makeFrame(page, 'only');
        frame.$$eval = jest.fn(async () => ['a page']);
        page.frames = [frame];

        const notebook = createNotebookSession({ page, frame, log: fakeLog() });

        expect(await notebook.$$eval('.pageNode', (n) => n)).toEqual(['a page']);
        expect(frame.$$eval).toHaveBeenCalledWith('.pageNode', expect.any(Function));
    });

    it('treats a frame whose page is gone as unusable even though it is not detached', () => {
        const page = makePage();
        const frame = makeFrame(page, 'only');
        page.frames = [frame];
        expect(frameIsUsable(frame)).toBe(true);

        page.closed = true;

        expect(frameIsUsable(frame)).toBe(false);
    });

    it('treats a closed page as unusable, which is the fallback the exporter uses', () => {
        // When no content frame can be found, runExport hands the editor *page*
        // in instead, so the session can be given something with isClosed() and
        // no isDetached(). A closed one must still be recognised as dead, or the
        // run retries a dead target three times and then reports a raw Playwright
        // error instead of saying the tab is gone.
        const page = makePage();
        expect(frameIsUsable(page)).toBe(true);

        page.closed = true;

        expect(frameIsUsable(page)).toBe(false);
    });

    it('classifies the errors a reload produces as retryable, and others as not', () => {
        expect(isTransientFrameError(targetClosed())).toBe(true);
        expect(isTransientFrameError(contextDestroyed())).toBe(true);
        expect(isTransientFrameError(new Error('Section wrapper not found for ID: abc'))).toBe(false);
    });
});

describe('the CLI cannot die of an unhandled rejection', () => {
    // Structural, because the failure was structural: Playwright rejects an
    // internal promise when the target goes away, and index.js has to both own
    // the command's promise and report that one. Neither was true - `program.parse()`
    // returns a promise nobody awaited, so any rejection escaped the CLI entirely.
    const indexSource = fs.readFileSync(
        path.resolve(__dirname, '..', 'src', 'index.js'), 'utf8');

    it('awaits the command instead of calling parse() and dropping its promise', () => {
        expect(indexSource).toContain('program.parseAsync()');
        expect(indexSource).not.toMatch(/^program\.parse\(\);/m);
    });

    it('has a handler for rejections that come from Playwright rather than the command', () => {
        expect(indexSource).toMatch(/process\.on\('unhandledRejection'/);
    });
});

/**
 * One browser for the two tests that need a real one.
 *
 * `itBrowser` skips rather than fails when Chromium is unavailable (a machine
 * with no browser installed), and forwards the timeout: these exports run
 * against a real page and take tens of seconds, because the fixture's
 * attachment points at a host that does not exist and all three download
 * strategies are tried before giving up.
 */
let browser;
let online = true;

beforeAll(async () => {
    try {
        browser = await chromium.launch({ headless: true });
    } catch (e) {
        online = false;
        console.warn(`Skipping browser tests: Chromium unavailable (${e.message.split('\n')[0]})`);
    }
}, 60000);

afterAll(async () => {
    if (browser) await browser.close();
});

const itBrowser = (name, fn, timeout) => (online ? it(name, fn, timeout) : it.skip(name, fn, timeout));

describe('chained Playwright calls survive the session', () => {
    // The regression: the session wrapped every method in a promise, so
    // `frame.locator(sel).filter({visible:true}).first()` threw
    // "locator(...).filter is not a function" — a promise has no .filter. The
    // call site swallowed it, so OneNote's download dialog was never dismissed
    // and the export crawled for 90s per attachment while looking, to the user,
    // exactly like a pre-existing product bug. These tests use the real shape of
    // the call in downloadStrategies.js, so it cannot come back unnoticed.

    const makeChain = () => {
        const calls = [];
        const locator = {
            filter: jest.fn(() => locator),
            first: jest.fn(() => locator),
            nth: jest.fn(() => locator),
            isVisible: jest.fn(async () => true),
            click: jest.fn(async () => calls.push('click')),
        };
        return { locator, calls };
    };

    it('returns a real Locator so .filter().first() can be chained', async () => {
        const page = makePage();
        const { locator } = makeChain();
        const frame = makeFrame(page, 'only');
        frame.locator = jest.fn(() => locator);
        page.frames = [frame];

        const notebook = createNotebookSession({ page, frame, log: fakeLog() });

        const found = notebook.locator('button[aria-label="Download"]')
            .filter({ visible: true })
            .first();

        expect(frame.locator).toHaveBeenCalledWith('button[aria-label="Download"]');
        expect(await found.isVisible()).toBe(true);
        // The point: the chain produced a Locator, not a promise.
        expect(typeof found.click).toBe('function');
    });

    it('awaits an awaited call as before', async () => {
        const page = makePage();
        const frame = makeFrame(page, 'only');
        page.frames = [frame];

        const notebook = createNotebookSession({ page, frame, log: fakeLog() });

        expect(await notebook.evaluate(() => 1)).toBe('evaluated in only');
    });

    it('still reports a dead page rather than handing back a husk', async () => {
        const page = makePage();
        const frame = makeFrame(page, 'only');
        page.frames = [frame];
        page.closed = true;

        const notebook = createNotebookSession({ page, frame, log: fakeLog() });

        expect(() => notebook.locator('button')).toThrow(NotebookUnavailableError);
    });
});

describe('a tab that dies mid-export', () => {
    // The per-item handlers in processSections catch everything so one bad page
    // does not end the run. A dead tab is not one bad page: left to them, a
    // notebook of 40 pages produces 29 identical failures and takes minutes to
    // give up on something that cannot recover. So it is re-thrown, and the run
    // reports what it wrote before re-raising.
    itBrowser('stops at the first call after the tab dies instead of failing every item', async () => {
        const page = await browser.newPage();
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'died-'));

        try {
            await page.goto(
                `file://${path.join(__dirname, 'fixtures', 'notebook-frame.html')}`,
                { waitUntil: 'domcontentloaded' }
            );
            const frame = await exporter.findContentFrame(page);

            // Let the section list be read, then take the tab away: the next DOM
            // call is the one that used to throw, and it is inside a per-page
            // handler, so without the re-throw this is where the run would grind
            // on through every remaining page.
            const realEvaluate = frame.evaluate.bind(frame);
            let calls = 0;
            frame.evaluate = async (...args) => {
                if (++calls > 1) await page.close();
                return realEvaluate(...args);
            };

            await expect(exporter.exportContent({
                contentFrame: frame,
                notebookName: 'Vanishing Notebook',
                options: { exportDir: outDir },
                page
            })).rejects.toThrow(NotebookUnavailableError);
        } finally {
            await page.close().catch(() => { });
            fs.removeSync(outDir);
        }
    }, 60000);
});

describe('the summary of a run that was cut short', () => {
    // F-17 territory: a run that did not finish must never be announced as a
    // clean one, and this is the case the counters cannot see - nothing "failed",
    // the walk simply stopped.
    beforeEach(() => jest.clearAllMocks());

    it('does not announce "Export complete!" when the run stopped early', () => {
        const { reportSummary, newStats } = exporter;
        reportSummary(newStats(), null, '/out/NB', 'the OneNote editor tab went away');

        expect(logger.success).not.toHaveBeenCalled();
        expect(said()).toMatch(/stopped early/i);
        expect(said()).toContain('the OneNote editor tab went away');
    });

    it('still reports the totals for what was written', () => {
        const { reportSummary, newStats } = exporter;
        const stats = newStats();
        stats.totalPages = 12;
        reportSummary(stats, null, '/out/NB', 'the OneNote editor tab went away');

        expect(said()).toContain('Total Pages: 12');
    });

    it('is unchanged for a run that finished', () => {
        const { reportSummary, newStats } = exporter;
        reportSummary(newStats(), null, '/out/NB');

        expect(logger.success).toHaveBeenCalledWith('Export complete!');
        expect(said()).not.toMatch(/stopped early/i);
    });
});

describe('a replaced notebook frame, in a real browser', () => {
    // The fixture swaps its iframe 6s in, while the export is mid-section. Before
    // the fix this killed the run at the next DOM call; now the session has to
    // notice the detached frame, find the replacement and finish the page.
    itBrowser('finishes the export when OneNote replaces the notebook frame', async () => {
        const page = await browser.newPage();
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-'));

        try {
            await page.goto(
                `file://${path.join(__dirname, 'fixtures', 'notebook-frame-reload.html')}`,
                { waitUntil: 'domcontentloaded' }
            );

            const stats = await exporter.exportContent({
                contentFrame: await exporter.findContentFrame(page),
                notebookName: 'Reloaded Notebook',
                options: { exportDir: outDir },
                page
            });

            expect(stats.totalPages).toBe(1);
            expect(stats.failedPages).toBe(0);
            expect(stats.failedSections).toBe(0);

            const md = fs.readFileSync(
                path.join(outDir, 'Reloaded Notebook', 'Section One', 'The Page.md'), 'utf8');
            expect(md).toContain('Hello from the fixture');
        } finally {
            await page.close().catch(() => { });
            fs.removeSync(outDir);
        }
    }, 120000);
});
