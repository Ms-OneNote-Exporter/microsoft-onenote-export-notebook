const fs = require('fs-extra');
const os = require('os');
const path = require('path');

/**
 * End-to-end test of the export pipeline against a fixture, in a real browser.
 *
 * This exists because `runExport` used to contain the same ~35 lines twice - once
 * for the --notebook-link path and once for the list-and-click path - and the two
 * copies had already drifted: one waited 10s for `.sectionList` and logged
 * unreadable frames at debug, the other waited 15s and swallowed them silently.
 * A fix applied to one path silently missed the other.
 *
 * The deduplication is only worth anything if the shared half stays shared, so the
 * structural assertions below fail if the two paths grow their own copies again.
 * The behavioural assertions run the real pipeline: a section tree, a page, an
 * image, a table and an internal link, all offline.
 */
const exporter = require('../src/exporter');
const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'exporter.js'), 'utf8');

describe('runExport structure', () => {
    /** The two branch markers that identify the duplicated code. */
    it('calls the shared exportContent helper from the --notebook-link path', () => {
        const linkPath = source.slice(source.indexOf('if (options.notebookLink)'), source.indexOf('listNotebooks('));
        expect(linkPath).toContain('exportContent({');
    });

    it('calls the shared exportContent helper from the list-and-click path', () => {
        const clickPath = source.slice(source.indexOf('openNotebook('));
        expect(clickPath).toContain('exportContent({');
    });

    it('calls the shared findContentFrame helper from both paths', () => {
        const helpers = source.match(/findContentFrame\(/g) || [];
        // One definition plus one call per path.
        expect(helpers).toHaveLength(3);
    });

    // The section walk used to take eight positional parameters and recurse with
    // seven of them again, and one of those was `stats = newStats()` - a mutable
    // default. Any caller that forgot to pass a tally got its own object, and the
    // summary reported whichever call finished last instead of the run's.
    it('gives the section walk one context object, not a positional list', () => {
        const from = source.indexOf('async function processSections(');
        const signature = source.slice(from, from + 400);
        // Destructured in the signature, so a caller cannot transpose arguments.
        expect(signature).toContain('processSections(ctx)');
        expect(signature).toContain('stats');
        expect(signature).not.toMatch(/=\s*new\s+\w+\(\)/);
    });

    it('recurses by inheriting the context and naming only what changes', () => {
        // The property the refactor was for: a field added to the walk is added in
        // one place, and the recursion cannot forget to pass it on.
        const recursive = source.slice(source.indexOf('Entering group:'));
        expect(recursive).toContain('...ctx');
        expect(recursive).toContain('parentId: item.id');
    });

    it('never writes to the options object it is handed', () => {
        // Three functions take `options = {}`, which is one shared object for every
        // call that omits the argument - the same hazard as `stats = newStats()`,
        // and harmless only for as long as nobody writes to it. So the property
        // worth pinning is the write, not the shape of the default.
        const writes = [...source.matchAll(/^\s*options(?:\.\w+)+\s*=[^=]/gm)]
            .map((m) => m[0].trim());
        expect(writes).toEqual([]);
    });

    // The drift that motivated this: two different timeouts for the same wait.
    it('has only one waitForSelector for .sectionList, so the two paths cannot disagree', () => {
        const waits = source.match(/waitForSelector\('\.sectionList'/g) || [];
        expect(waits).toHaveLength(1);
    });

    // Ditto: one silent catch, one that says something. Scoped to the frame-probing
    // helper - the file legitimately contains documented empty catches elsewhere
    // (e.g. the URL-absolutising fallback in the image scraper).
    it('has no silent catch left in findContentFrame', () => {
        const start = source.indexOf('async function findContentFrame');
        const body = source.slice(start, source.indexOf('\n}', start));
        expect(body).not.toMatch(/catch \(e\) \{\s*(\/\/[^\n]*)?\s*\}/);
    });

    it('is substantially shorter than the duplicated version', () => {
        const start = source.indexOf('async function runExport');
        const body = source.slice(start, source.indexOf('\n}', start));
        const lines = body.split('\n').length;
        // It was 238 lines; anything near that means the duplication is back.
        //
        // The bound moved 150 -> 155 for the export observer, which added five
        // lines: build it, pass it to each of the two exportContent call sites,
        // and detach it. Each is load-bearing — the detach in particular, because
        // the logger is a module singleton and a sink that outlives the run sends
        // it to the *next* run's observer. Shaving comments to fit a proxy metric
        // would have been the wrong trade; the property this test guards is
        // duplication, and 155 is nowhere near it.
        expect(lines).toBeLessThan(155);
    });
});

describe('export pipeline end to end (real browser, offline)', () => {
    const { chromium } = require('playwright');
    let browser;
    let online = true;
    let outDir;
    let stats;
    let md;
    let sectionDir;

    beforeAll(async () => {
        try {
            browser = await chromium.launch({ headless: true });
        } catch (e) {
            online = false;
            console.warn(`Skipping pipeline test: Chromium unavailable (${e.message.split('\n')[0]})`);
            return;
        }

        const page = await browser.newPage();
        await page.goto(
            `file://${path.join(__dirname, 'fixtures', 'notebook-frame.html')}`,
            { waitUntil: 'domcontentloaded' }
        );

        outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-'));

        // One export, asserted from several angles below. It takes ~20s, mostly
        // because the fixture's attachment points at a host that does not exist,
        // so all three download strategies are tried before giving up. Running it
        // once and sharing the result keeps the suite honest without tripling
        // that cost.
        stats = await exporter.exportContent({
            contentFrame: page.mainFrame(),
            notebookName: 'Fixture Notebook',
            options: { exportDir: outDir },
        });

        sectionDir = path.join(outDir, 'Fixture Notebook', 'Section One');
        const pageFile = path.join(sectionDir, 'The Page.md');
        md = fs.existsSync(pageFile) ? fs.readFileSync(pageFile, 'utf8') : '';
    }, 120000);

    afterAll(async () => {
        if (outDir) fs.removeSync(outDir);
        if (browser) await browser.close();
    });

    const itBrowser = (name, fn) => (online ? it(name, fn) : it.skip(name, fn));

    itBrowser('reports what it exported, with no failures', () => {
        expect(stats.totalPages).toBe(1);
        expect(stats.failedPages).toBe(0);
        expect(stats.failedSections).toBe(0);
        expect(stats.failedGroups).toBe(0);
    });

    itBrowser('lays the output out as <notebook>/<section>/<page>.md', () => {
        expect(fs.existsSync(path.join(outDir, 'Fixture Notebook'))).toBe(true);
        expect(fs.existsSync(sectionDir)).toBe(true);
        expect(fs.readdirSync(sectionDir)).toContain('The Page.md');
    });

    itBrowser('prepends the date and keeps the body text', () => {
        // The dateTime outline becomes a leading line...
        expect(md).toMatch(/^2026-01-02 03:04/);
        // ...and the title outline becomes the file name, not a body line.
        // (The name still legitimately appears inside the asset filename, so this
        // checks for the title as a line of its own rather than for the substring.)
        expect(md.split('\n').map((l) => l.trim())).not.toContain('The Page');
        expect(md).toContain('Hello from the fixture');
    });

    itBrowser('renders the table as GFM and escapes the pipe in a cell', () => {
        expect(md).toMatch(/\| *Header *\| *Second *\|/);
        expect(md).toMatch(/\| *-+ *\| *-+ *\|/);
        // F-25: without escaping this became a third column.
        expect(md).toContain('a \\| b');
    });

    itBrowser('references the image by its final asset name', () => {
        expect(md).toContain('![[assets/The Page_img_1.png|a one pixel png]]');

        const assetDir = path.join(sectionDir, 'assets');
        expect(fs.readdirSync(assetDir)).toContain('The Page_img_1.png');
        // Real bytes on disk, not a zero-length placeholder.
        expect(fs.statSync(path.join(assetDir, 'The Page_img_1.png')).size).toBeGreaterThan(0);
    });

    itBrowser('links the attachment by its planned name even though it could not be downloaded', () => {
        // The fixture's href does not resolve, so the download fails - and the
        // Markdown must still point at the name the file was going to have.
        expect(md).toContain('[[assets/report.docx]]');
    });

    itBrowser('leaves an unresolvable internal link as readable text', () => {
        expect(md).toContain('Target Page');
        expect(md).not.toContain('onenote-link:');
    });
});
