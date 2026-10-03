const fs = require('fs-extra');
const os = require('os');
const path = require('path');

/**
 * `--screenshot`: a PNG beside every `--dodump` HTML file.
 *
 * The claim is "each HTML dump has a screenshot next to it", and there are four
 * ways that claim can be false without anything looking wrong:
 *
 *  - the screenshot is silently skipped (the flag never reached the writer);
 *  - it is written under a name that does not match its HTML, so a bug report
 *    naming the HTML cannot be paired with the image;
 *  - it is skipped because the writer was handed something that cannot be
 *    captured, and the reason is only visible in a per-page warning;
 *  - a failed screenshot takes the export down with it, which is the opposite of
 *    what a debugging aid should do - especially since it tends to fail exactly
 *    when something has already gone wrong (the tab closed, the frame detached).
 *
 * The third one is how this feature shipped broken: the exporter dumps pages and
 * groups through a NotebookSession, whose proxy answers *every* property with a
 * function, so the writer's `typeof target.screenshot === 'function'` check took
 * the session for a Page and every capture resolved to undefined. All 30 HTML
 * dumps were written; 2 PNGs were. The tests below pass the session for real,
 * because a mocked Page and a real Frame both work perfectly well and hid it.
 *
 * The last one is why the failure paths are pinned here rather than left to
 * inspection: a screenshot that throws inside processSections would be caught by
 * the surrounding `catch` and reported as "Failed to process group", turning a
 * diagnostic into a data-loss bug.
 *
 * Real Chromium is used where the assertion is about Playwright behaviour (a
 * Frame really has no screenshot of its own, and its page really can be captured);
 * the rest are pure.
 */
jest.mock('../src/utils/logger', () => ({
    success: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(),
    debug: jest.fn(), step: jest.fn(), log: jest.fn(),
    getDumpDir: jest.fn(), getDumpDisplayPath: jest.fn(() => 'logs/dumps/now'),
}));

const logger = require('../src/utils/logger');
const { writeDebugDump, ownerPageOf } = require('../src/utils/dumps');
const { createNotebookSession } = require('../src/notebookFrame');
const { chromium } = require('playwright');

let dumpDir;

/** A logger stub whose dump directory is a real temp dir. */
function useTempDumpDir() {
    dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumps-'));
    logger.getDumpDir.mockResolvedValue(dumpDir);
    return dumpDir;
}

/** A stand-in for a Page or Frame: only `content()` is needed to dump HTML. */
function fakeTarget(html = '<html>one</html>') {
    return { content: jest.fn(async () => html) };
}

/**
 * A logger for the notebook session. Its only use here is to swallow the recovery
 * chatter a session logs when it re-attaches to a frame.
 */
const silentLog = () => ({ debug: () => {} });

describe('writeDebugDump', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        useTempDumpDir();
    });

    afterEach(() => {
        if (dumpDir) fs.removeSync(dumpDir);
    });

    it('writes nothing at all when --dodump is off', async () => {
        // The gate has to be inside the writer, not at every call site: a new
        // dump site that forgets the check would otherwise write HTML on every
        // run of every notebook.
        const written = await writeDebugDump(fakeTarget(), 'debug_page_X', {});

        expect(written).toBeNull();
        expect(fs.readdirSync(dumpDir)).toEqual([]);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('writes only the HTML when --screenshot is off', async () => {
        const written = await writeDebugDump(fakeTarget(), 'debug_page_X', { dodump: true });

        expect(written.screenshot).toBeNull();
        expect(fs.readdirSync(dumpDir)).toEqual(['debug_page_X.html']);
        expect(fs.readFileSync(path.join(dumpDir, 'debug_page_X.html'), 'utf8')).toBe('<html>one</html>');
    });

    it('names the PNG after the HTML it belongs to', async () => {
        // The pairing is the point of the feature: a dump directory listing is
        // sorted alphabetically, so `debug_page_Notes.html` and
        // `debug_page_Notes.png` sit next to each other and sort together.
        const target = {
            content: jest.fn(async () => '<html/>'),
            screenshot: jest.fn(async () => Buffer.from('PNG')),
        };

        const written = await writeDebugDump(target, 'debug_page_Notes', { dodump: true, screenshot: true });

        expect(written.html).toBe(path.join(dumpDir, 'debug_page_Notes.html'));
        expect(written.screenshot).toBe(path.join(dumpDir, 'debug_page_Notes.png'));
        expect(fs.readdirSync(dumpDir).sort()).toEqual(['debug_page_Notes.html', 'debug_page_Notes.png']);
        expect(fs.readFileSync(written.screenshot, 'utf8')).toBe('PNG');
    });

    it('screenshots the page that owns a Frame, because a Frame cannot screenshot itself', async () => {
        // The OneNote notebook is an iframe, and Playwright has no screenshot() on
        // a Frame. So the frame dump has to go through frame.page() - and the page
        // is the better image anyway: it shows the notebook as it was on screen.
        const owner = { screenshot: jest.fn(async () => Buffer.from('PNG')) };
        const frame = { content: jest.fn(async () => '<html/>'), page: () => owner };

        const written = await writeDebugDump(frame, 'debug_notebook_content', { dodump: true, screenshot: true });

        expect(owner.screenshot).toHaveBeenCalledTimes(1);
        expect(written.screenshot).toBe(path.join(dumpDir, 'debug_notebook_content.png'));
    });

    it('asks for a viewport, not the whole scrollable page', async () => {
        // The OneNote editor is a virtual canvas that can be enormous, and a
        // full-page capture of one is slow enough to matter over a whole export
        // and large enough to be useless in a bug report.
        const page = { ...fakeTarget(), screenshot: jest.fn(async () => Buffer.from('PNG')) };

        await writeDebugDump(page, 'debug_page_X', { dodump: true, screenshot: true });

        expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: false }));
    });

    it('keeps the HTML and warns when the screenshot fails', async () => {
        // A screenshot fails most often when something has already broken - the
        // tab closed, the frame detached. Losing the export over that would be
        // the tail wagging the dog: the diagnostic is what is left when the run
        // goes wrong, not what causes it.
        const page = {
            content: jest.fn(async () => '<html/>'),
            screenshot: jest.fn(async () => { throw new Error('Target closed'); }),
        };

        const written = await writeDebugDump(page, 'debug_page_X', { dodump: true, screenshot: true });

        expect(written.screenshot).toBeNull();
        expect(fs.existsSync(path.join(dumpDir, 'debug_page_X.html'))).toBe(true);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not screenshot debug_page_X'));
        // The message has to say the HTML survived, or the reader assumes the
        // whole dump is gone and does not look.
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('still written'));
    });

    it('does not throw when a detached frame has no page left to screenshot', async () => {
        const frame = {
            content: jest.fn(async () => '<html/>'),
            page: () => { throw new Error('Frame was detached'); },
        };

        await expect(writeDebugDump(frame, 'debug_page_X', { dodump: true, screenshot: true }))
            .resolves.toMatchObject({ screenshot: null });
    });

    it('warns instead of throwing when the dump cannot be written', async () => {
        const target = { content: jest.fn(async () => { throw new Error('Target closed'); }) };

        const written = await writeDebugDump(target, 'debug_page_X', { dodump: true, screenshot: true });

        expect(written).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not write debug_page_X.html'));
    });

    it('writes dumps owner-only, and tightens a file an earlier run left readable', async () => {
        // F-48: these files hold the authenticated DOM of a real notebook. The mode
        // option on writeFile only applies at creation, and the dump directory is
        // per-minute, so a rerun inside the same minute really does reuse a name.
        fs.writeFileSync(path.join(dumpDir, 'debug_page_X.html'), 'old', { mode: 0o644 });
        const page = { content: jest.fn(async () => '<html/>'), screenshot: jest.fn(async () => Buffer.from('PNG')) };

        await writeDebugDump(page, 'debug_page_X', { dodump: true, screenshot: true });

        if (process.platform !== 'win32') {
            expect(fs.statSync(path.join(dumpDir, 'debug_page_X.html')).mode & 0o777).toBe(0o600);
            expect(fs.statSync(path.join(dumpDir, 'debug_page_X.png')).mode & 0o777).toBe(0o600);
        }
    });

    it('reports where the screenshot went', async () => {
        const page = { content: jest.fn(async () => '<html/>'), screenshot: jest.fn(async () => Buffer.from('PNG')) };

        await writeDebugDump(page, 'debug_page_X', { dodump: true, screenshot: true });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('logs/dumps/now/debug_page_X.png'));
    });
});

describe('ownerPageOf', () => {
    it('returns a Page unchanged', () => {
        const page = { screenshot: () => {} };
        expect(ownerPageOf(page)).toBe(page);
    });

    it('resolves a Frame to its page', () => {
        const page = {};
        expect(ownerPageOf({ page: () => page })).toBe(page);
    });

    it('answers null for nothing, rather than throwing', () => {
        expect(ownerPageOf(null)).toBeNull();
        expect(ownerPageOf({})).toBeNull();
    });

    it('resolves a NotebookSession to the page that owns its frame', () => {
        // The exporter hands writeDebugDump the session, not a Frame, for every
        // page and group dump. The session's proxy answers `screenshot` with a
        // function even though a Frame cannot take one (notebookFrame.js), so a
        // screenshot() feature check calls the session a Page and the capture then
        // resolves to undefined - 28 of 30 PNGs missing on a real run. Only
        // page() is answered for real.
        const page = { screenshot: jest.fn(async () => Buffer.from('PNG')) };
        const frame = {
            content: jest.fn(async () => '<html/>'),
            page: () => page,
            isDetached: () => false,
            isClosed: () => false,
        };
        const session = createNotebookSession({ page, frame, log: silentLog() });

        expect(ownerPageOf(session)).toBe(page);
        // Pins the trap itself, so this cannot regress into passing by accident.
        expect(typeof session.screenshot).toBe('function');
        expect(typeof frame.screenshot).toBe('undefined');
    });

    it('treats a session whose frame is gone as having no page, not as a Page', () => {
        // Falling through to the screenshot() check after page() yields nothing
        // would re-classify the session as a Page and send the capture down the
        // path that resolves to undefined.
        const session = createNotebookSession({
            page: null,
            frame: { isDetached: () => true, isClosed: () => false, page: () => null },
            log: silentLog(),
        });

        expect(ownerPageOf(session)).toBeNull();
    });

    it('answers null for a Frame that no longer has a page', () => {
        expect(ownerPageOf({ page: () => null })).toBeNull();
    });
});

describe('a capture that produced no image', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        useTempDumpDir();
    });

    afterEach(() => {
        if (dumpDir) fs.removeSync(dumpDir);
    });

    it('says which object could not be screenshotted, instead of blaming the disk', async () => {
        // What a missing PNG used to report: `fs.writeFile` complaining about a
        // "data" argument, which says nothing about the notebook or the code.
        const page = { content: jest.fn(async () => '<html/>'), screenshot: jest.fn(async () => undefined) };

        const written = await writeDebugDump(page, 'debug_page_X', { dodump: true, screenshot: true });

        expect(written.screenshot).toBeNull();
        const warning = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warning).toContain('Could not screenshot debug_page_X');
        expect(warning).toContain('the capture returned no image data');
        expect(warning).not.toContain('data" argument must be of type');
    });

    it('says what cannot be screenshotted, rather than leaving a JavaScript error', async () => {
        // `page.screenshot is not a function` says nothing about the notebook. The
        // session is the only thing the exporter hands this writer that answers
        // screenshot() and cannot take one, so the message has to be enough to tell
        // the reader where to look.
        const frame = { content: jest.fn(async () => '<html/>') };
        const session = createNotebookSession({ page: {}, frame, log: silentLog() });

        const written = await writeDebugDump(session, 'debug_page_X', { dodump: true, screenshot: true });

        expect(written.screenshot).toBeNull();
        const warning = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warning).toContain('has no screenshot() of its own');
        expect(warning).not.toContain('is not a function');
    });

    it('refuses an empty image rather than writing a 0-byte PNG', async () => {
        const page = { content: jest.fn(async () => '<html/>'), screenshot: jest.fn(async () => Buffer.alloc(0)) };

        const written = await writeDebugDump(page, 'debug_page_X', { dodump: true, screenshot: true });

        expect(written.screenshot).toBeNull();
        expect(fs.readdirSync(dumpDir)).toEqual(['debug_page_X.html']);
    });
});

describe('writeDebugDump against real Chromium', () => {
    let browser;
    let online = true;

    beforeAll(async () => {
        try {
            browser = await chromium.launch({ headless: true });
        } catch (e) {
            online = false;
            console.warn(`Skipping screenshot browser tests: Chromium unavailable (${e.message.split('\n')[0]})`);
        }
    }, 60000);

    afterAll(async () => {
        if (browser) await browser.close();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        useTempDumpDir();
    });

    afterEach(() => {
        if (dumpDir) fs.removeSync(dumpDir);
    });

    const itBrowser = (name, fn) => (online ? it(name, fn, 30000) : it.skip(name, fn));

    itBrowser('writes a real PNG for a real frame dump', async () => {
        // The mocked tests above prove the calls are made; this proves Playwright
        // actually produces an image for the way the exporter dumps - through a
        // Frame, with the notebook in an iframe, which is the case that has no
        // screenshot method of its own.
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.setContent('<iframe id="notebook" srcdoc="<p>the notebook</p>" style="width:400px;height:200px"></iframe>');
        const frame = await (await page.$('#notebook')).contentFrame();

        const written = await writeDebugDump(frame, 'debug_notebook_content', { dodump: true, screenshot: true });

        // PNG magic number: a zero-byte or HTML file at this path would satisfy a
        // mocked assertion and be useless to whoever opens it.
        const png = fs.readFileSync(written.screenshot);
        expect(png.slice(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        expect(png.length).toBeGreaterThan(100);

        await context.close();
    });

    itBrowser('writes a real PNG when the target is the session the exporter passes', async () => {
        // The case that was broken in production: src/exporter.js dumps pages and
        // groups through a NotebookSession, and the session's proxy answers any
        // property with a function, so the writer took it for a Page and captured
        // nothing. Every page and group dump lost its PNG this way; only the two
        // dumps given a real Page or a real Frame got one. The image must come out
        // of the owning page, since a Frame cannot be captured on its own.
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.setContent('<iframe id="notebook" srcdoc="<p id=target>the notebook</p>" style="width:400px;height:200px"></iframe>');
        const frame = await (await page.$('#notebook')).contentFrame();
        const session = createNotebookSession({ page, frame, log: silentLog() });

        const written = await writeDebugDump(session, 'debug_page_Some notes', { dodump: true, screenshot: true });

        expect(written.screenshot).toBe(path.join(dumpDir, 'debug_page_Some notes.png'));
        const png = fs.readFileSync(written.screenshot);
        expect(png.slice(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        expect(png.length).toBeGreaterThan(100);
        expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('Could not screenshot'));
        // The HTML dump still has to come from the frame, not the page.
        expect(fs.readFileSync(written.html, 'utf8')).toContain('the notebook');

        await context.close();
    });

    itBrowser('writes the HTML it was given, from that same frame', async () => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.setContent('<iframe srcdoc="<p id=target>inside the frame</p>"></iframe>');
        const frame = page.frames().find((f) => f !== page.mainFrame());

        const written = await writeDebugDump(frame, 'debug_page_X', { dodump: true, screenshot: true });

        expect(fs.readFileSync(written.html, 'utf8')).toContain('inside the frame');

        await context.close();
    });
});