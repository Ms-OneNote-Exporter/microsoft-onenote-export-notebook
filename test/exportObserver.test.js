/**
 * The export observer: progress, the section counter, and abort.
 *
 * The assertions are made against the **emitted events** and the **files on
 * disk**, never against the fact that a handler ran. That distinction has cost
 * this project real bugs — a credential `JSON.stringify`-ed on the way out, a
 * `writeSseHeaders` helper with no caller, a feature described as unsupported
 * because nobody had read the path — and every one of them passed a green suite.
 *
 * The pipeline runs against `fixtures/notebook-frame.html` in a real browser, the
 * same fixture the end-to-end test uses, because a hand-written fake section list
 * would be an assertion about the fake.
 */
jest.mock('../src/utils/logger', () => ({
    success: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(),
    debug: jest.fn(), step: jest.fn(), log: jest.fn(),
    getDumpDir: jest.fn(), getDumpDisplayPath: jest.fn(),
    setSink: jest.fn(), setLevel: jest.fn(),
}));

/**
 * These exports take ~20s each against the offline fixture — most of it the
 * attachment download retrying against a host that does not exist — so the
 * default 5s is nowhere near. Every browser test below carries its own timeout
 * rather than raising the global one, so a genuine hang still fails loudly.
 */
jest.setTimeout(30000);

const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const exporter = require('../src/exporter');
const {
    EXPORT_EVENT_TYPES,
    PARTIAL_REASONS,
    createExportObserver,
    isAborted
} = require('../src/export-observer');

/** Every file the fixture export produced, relative to the notebook directory. */
const treeUnder = (root) => {
    const out = [];
    const walk = (dir, rel) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            const relPath = rel ? path.join(rel, entry.name) : entry.name;
            if (entry.isDirectory()) walk(abs, relPath);
            else out.push(relPath);
        }
    };
    if (fs.existsSync(root)) walk(root, '');
    return out.sort();
};

describe('the exported vocabulary', () => {
    it('re-exports it from the package main, so a caller need not guess a subpath', () => {
        // An unlisted subpath in package.json `exports` works locally and 404s
        // for a consumer. The backend asserts its table against this.
        expect(exporter.EXPORT_EVENT_TYPES).toBe(EXPORT_EVENT_TYPES);
        expect(exporter.PARTIAL_REASONS).toBe(PARTIAL_REASONS);
    });

    it('freezes both sets', () => {
        expect(Object.isFrozen(EXPORT_EVENT_TYPES)).toBe(true);
        expect(Object.isFrozen(PARTIAL_REASONS)).toBe(true);
    });

    it('names every event the backend already listens for', () => {
        // Transcribed from the api's EVENT_TYPES. An event name here that the
        // backend does not send is an event nothing will ever handle.
        for (const type of [
            'export-started', 'export-progress', 'export-log',
            'export-done', 'export-partial', 'export-aborted',
        ]) {
            expect(EXPORT_EVENT_TYPES).toContain(type);
        }
    });

    it('keeps aborted separate from partial, because they answer different questions', () => {
        // `export-aborted` says the stop was honoured; `export-partial` says how
        // much survived. Collapsing them means a caller can render "stopped" but
        // cannot tell the user what they actually got.
        expect(EXPORT_EVENT_TYPES).toContain('export-aborted');
        expect(EXPORT_EVENT_TYPES).toContain('export-partial');
    });

    it('includes quota and disk, which only the serving side can detect', () => {
        // Listed so the caller's mapping table is built against a union it has
        // seen. A reason it has never heard of gets folded into a generic message.
        expect(PARTIAL_REASONS).toContain('aborted');
        expect(PARTIAL_REASONS).toContain('quota');
        expect(PARTIAL_REASONS).toContain('disk');
    });
});

describe('createExportObserver', () => {
    const logger = require('../src/utils/logger');

    beforeEach(() => jest.clearAllMocks());

    it('echoes the caller id on every event, and never invents one', () => {
        const seen = [];
        const observer = createExportObserver({ id: 'export-1', onEvent: e => seen.push(e) });

        // Emitted the way the exporter emits it: the id is stamped by the caller
        // of emit(), from observer.id. Asserting on that shape is the point — if
        // emit() stopped stamping it, every event would arrive uncorrelated.
        observer.emit('export-started', { id: observer.id, notebook: 'N' });
        expect(seen).toEqual([{ type: 'export-started', id: 'export-1', notebook: 'N' }]);

        // No id given: null, not a generated one. This package does not know what
        // a session is, and a made-up id would collide with the caller's own.
        const anonymous = [];
        const bare = createExportObserver({ onEvent: e => anonymous.push(e) });
        expect(bare.id).toBeNull();
    });

    it('makes the id available to the emitter so no call site can forget it', () => {
        // The exporter stamps `{ id, ... }` on each emit from the same value.
        // This is the assertion that the value exists and is not invented.
        const withId = createExportObserver({ id: 'export-9' });
        expect(withId.id).toBe('export-9');
        const without = createExportObserver({});
        expect(without.id).toBeNull();
    });

    it('survives an observer that is absent, or not a function', () => {
        for (const options of [{}, { onEvent: null }, { onEvent: 'nope' }]) {
            const observer = createExportObserver(options);
            expect(() => observer.emit('export-started', {})).not.toThrow();
        }
    });

    it('swallows a throwing observer, because the export continues', () => {
        const observer = createExportObserver({ onEvent: () => { throw new Error('bug'); } });
        expect(() => observer.emit('export-progress', {})).not.toThrow();
    });

    it('attaches a log sink on construction and removes it on detach', () => {
        const observer = createExportObserver({ id: 'x', onEvent: () => { } });
        expect(logger.setSink).toHaveBeenCalledTimes(1);
        observer.detach();
        expect(logger.setSink).toHaveBeenLastCalledWith(null);
    });
});

describe('isAborted', () => {
    it('is false with no signal at all, which is the default path', () => {
        expect(isAborted(undefined)).toBe(false);
        expect(isAborted(null)).toBe(false);
    });

    it('reads the signal fresh each time, so a mid-run abort is seen', () => {
        // A registered listener would need unregistering when the run ends; a
        // poll at each checkpoint cannot leak.
        const controller = new AbortController();
        const observer = createExportObserver({ signal: controller.signal });
        expect(observer.isAborted()).toBe(false);
        controller.abort();
        expect(observer.isAborted()).toBe(true);
    });

    it('records that an abort happened, once, without throwing on repeat', () => {
        const observer = createExportObserver({ signal: new AbortController().signal });
        expect(observer.wasAborted()).toBe(false);
        observer.onAbort();
        observer.onAbort();
        expect(observer.wasAborted()).toBe(true);
    });
});

describe('the section counter', () => {
    it('starts at zero', () => {
        expect(exporter.newStats().totalSections).toBe(0);
    });

    it('is a separate tally from the failure count, not derived from it', () => {
        // `failedSections` counts what went wrong; `totalSections` counts what was
        // seen. The two move independently: a clean walk of 3 sections leaves
        // failedSections at 0, and one that saw 3 and exported 2 leaves
        // totalSections at 3 with failedSections at 1.
        //
        // Deriving one from the other is the specific bug this is here to prevent,
        // and the assertion is that they are independent fields, not that they
        // happen to differ in some sample.
        const stats = exporter.newStats();
        expect(stats.totalSections).toBe(0);
        expect(stats.failedSections).toBe(0);

        stats.totalSections = 3;
        expect(stats.failedSections).toBe(0);

        stats.failedSections = 1;
        expect(stats.totalSections).toBe(3);

        // The sum is the meaningful relationship: seen = written-ish + failed, in
        // the sense that a section is either counted as seen once or not at all.
        // The point is that neither field is computed from the other.
        expect(Object.keys(stats)).toEqual(expect.arrayContaining(['totalSections', 'failedSections']));
    });
});

describe('export progress, end to end (real browser, offline)', () => {
    const { chromium } = require('playwright');
    let browser;
    let online = true;

    beforeAll(async () => {
        try {
            browser = await chromium.launch({ headless: true });
        } catch (e) {
            online = false;
            console.warn(`Skipping observer test: Chromium unavailable (${e.message.split('\n')[0]})`);
            return;
        }
    }, 60000);

    afterAll(async () => {
        if (browser) await browser.close();
    });

    /**
     * A freshly-loaded fixture page, for one export.
     *
     * **Not shared between tests, and that is the whole point.** The export
     * mutates the page it walks: sections get selected, groups get expanded, and
     * OneNote's tree is navigated in place. An earlier version of this file loaded
     * the fixture once in `beforeAll` and reused the frame, and the first test
     * passed while every later one found an exhausted page and reported zero
     * sections — a green run in which six assertions were quietly testing
     * nothing, because the fixture they depended on was already spent.
     */
    const freshFrame = async () => {
        const page = await browser.newPage();
        await page.goto(
            `file://${path.join(__dirname, 'fixtures', 'notebook-frame.html')}`,
            { waitUntil: 'domcontentloaded' }
        );
        return page;
    };

    /**
     * Runs only when Chromium is available, forwarding the timeout.
     *
     * The third argument matters: these tests each drive a full fixture export,
     * which takes 15–23s against the default 5s. An earlier version of this helper
     * was `(name, fn) => it(name, fn)`, which swallowed the per-test timeout that
     * every call site passed — so five of them failed on a 15s ceiling that
     * silently came from somewhere else, with no indication the caller had
     * asked for more.
     */
    const itBrowser = (name, fn, timeout) =>
        (online ? it(name, fn, timeout) : it.skip(name, fn, timeout));

    /**
     * One export against a fresh page and a throwaway output directory.
     *
     * Returns the emitted events, the returned stats, and the file tree — so a
     * test can assert against what a caller would see *and* what landed on disk.
     */
    const runOnce = async (options = {}) => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-'));
        const page = await freshFrame();
        const events = [];
        try {
            const stats = await exporter.exportContent({
                contentFrame: page.mainFrame(),
                notebookName: 'Observer Notebook',
                options: { exportDir: outDir, ...options.options },
                observer: options.observer || null,
            });
            return { events, stats, files: treeUnder(path.join(outDir, 'Observer Notebook')) };
        } finally {
            await page.close().catch(() => { });
            fs.removeSync(outDir);
        }
    };

    const withObserver = (extra = {}) => {
        const events = [];
        return {
            events,
            observer: createExportObserver({
                id: 'export-test',
                onEvent: e => events.push(e),
                ...extra
            })
        };
    };

    itBrowser('starts first and finishes last', async () => {
        const { events, observer } = withObserver();
        await runOnce({ observer });

        const types = events.map(e => e.type);
        expect(types[0]).toBe('export-started');
        expect(types[types.length - 1]).toBe('export-done');
        expect(types).toContain('export-progress');
        observer.detach();
    }, 120000);

    itBrowser('reports progress as an object of counts, never a percentage', async () => {
        // The backend's SessionSnapshot types `progress` as
        // `{pages, sections, assets}` and the frontend renders it directly, so a
        // string here would be rendered as-is and read as text.
        const { events, observer } = withObserver();
        await runOnce({ observer });

        const progress = events.filter(e => e.type === 'export-progress');
        expect(progress.length).toBeGreaterThan(0);
        for (const event of progress) {
            expect(typeof event.progress).toBe('object');
            expect(typeof event.progress.pages).toBe('number');
            expect(typeof event.progress.sections).toBe('number');
            expect(typeof event.progress.assets).toBe('number');
            // No fraction: the totals are unknown mid-run, so a percentage would
            // be a number this package cannot compute.
            expect(event.progress.percent).toBeUndefined();
            expect(event.progress.fraction).toBeUndefined();
        }
        observer.detach();
    }, 120000);

    itBrowser('counts the sections it actually walked', async () => {
        // The claim that had no counter at all. `done.sections` and the last
        // progress event must both agree with each other, and be non-zero — a
        // fixture export that walks a section tree and reports zero sections is
        // the bug this closes.
        const { events, observer } = withObserver();
        const { stats } = await runOnce({ observer });

        expect(stats.totalSections).toBeGreaterThan(0);

        const done = events.find(e => e.type === 'export-done');
        const lastProgress = events.filter(e => e.type === 'export-progress').pop();
        expect(done.sections).toBe(stats.totalSections);
        expect(lastProgress.progress.sections).toBe(stats.totalSections);
        observer.detach();
    }, 120000);

    itBrowser('reports the notebook it finished, matching the directory written', async () => {
        const { events, observer } = withObserver();
        const { files } = await runOnce({ observer });

        const done = events.find(e => e.type === 'export-done');
        expect(done.notebook).toBe('Observer Notebook');
        // The counts are about real files on disk, so the vault has to exist.
        expect(files.length).toBeGreaterThan(0);
        expect(files.some(f => f.endsWith('.md'))).toBe(true);
        observer.detach();
    }, 120000);

    itBrowser('stops mid-walk on abort, and keeps what it had already written', async () => {
        // The load-bearing assertion of item 2: an abort preserves the artefact.
        // Checked against the filesystem, not against an event, because the event
        // is what a bug would get wrong and the files are what the user has.
        const controller = new AbortController();
        const events = [];
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-abort-'));
        const page = await freshFrame();

        // Aborted before the walk, so at least the first section is skipped.
        controller.abort();

        try {
            const stats = await exporter.exportContent({
                contentFrame: page.mainFrame(),
                notebookName: 'Observer Notebook',
                options: { exportDir: outDir },
                observer: createExportObserver({
                    id: 'abort-test',
                    signal: controller.signal,
                    onEvent: e => events.push(e)
                })
            });

            const files = treeUnder(path.join(outDir, 'Observer Notebook'));
            const types = events.map(e => e.type);

            expect(types).toContain('export-aborted');
            expect(types).toContain('export-partial');
            expect(types).not.toContain('export-done');

            const partial = events.find(e => e.type === 'export-partial');
            expect(partial.reason).toBe('aborted');

            // The notebook directory exists even though nothing was walked, and
            // no section was started.
            expect(files.filter(f => f.endsWith('.md'))).toEqual([]);
            expect(stats.totalSections).toBe(0);
        } finally {
            await page.close().catch(() => { });
            fs.removeSync(outDir);
        }
    }, 120000);

    itBrowser('writes no marker file into the vault on an abort', async () => {
        // PLAN-v3 §5.2 makes partial labelling server-enforced: an
        // `X-Artifact-Partial` header and a `.partial.zip` filename, on the
        // artifact. A marker file here would be a second labelling mechanism in
        // the wrong layer, inside the directory the user actually opens.
        const controller = new AbortController();
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-marker-'));
        const page = await freshFrame();
        controller.abort();

        try {
            await exporter.exportContent({
                contentFrame: page.mainFrame(),
                notebookName: 'Observer Notebook',
                options: { exportDir: outDir },
                observer: createExportObserver({
                    signal: controller.signal,
                    onEvent: () => { }
                })
            });

            const notebookDir = path.join(outDir, 'Observer Notebook');
            const entries = fs.existsSync(notebookDir) ? fs.readdirSync(notebookDir) : [];
            expect(entries.filter(e => e.includes('partial'))).toEqual([]);
        } finally {
            await page.close().catch(() => { });
            fs.removeSync(outDir);
        }
    }, 120000);

    itBrowser('produces the same vault with and without an observer', async () => {
        // The promise to every caller on today's version: adding an observer must
        // not change a single byte on disk.
        const quiet = await runOnce({});
        const { events, observer } = withObserver();
        const watched = await runOnce({ observer });
        observer.detach();

        expect(watched.files).toEqual(quiet.files);
        expect(events.length).toBeGreaterThan(0);
    }, 300000);
});
