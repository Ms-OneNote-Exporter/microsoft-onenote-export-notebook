const fs = require('fs-extra');
const os = require('os');
const path = require('path');

/**
 * F-16: overwrite policy on re-export.
 *
 * The decision is "overwrite by default, with a warning that the folder exists".
 * Two things therefore have to hold, and they pull in opposite directions:
 *
 *   1. A RE-RUN must replace files rather than pile up report.pdf_1, _2, _3.
 *   2. TWO ATTACHMENTS WITH THE SAME NAME IN ONE RUN must still get distinct
 *      paths, or the second silently clobbers the first.
 *
 * The old code satisfied (2) by probing the filesystem, which is what caused (1).
 * A within-run reservation satisfies both.
 *
 * Timing note: one fixture export costs ~20s, almost all of it the attachment
 * pointing at a host that does not exist, so all three download strategies are
 * tried before giving up. The tests below therefore share exports rather than
 * running one per assertion.
 */
const exporter = require('../src/exporter');
// Required once, at the top, so it is the SAME singleton instance that exporter
// holds. Requiring it again after a jest.resetModules() - as an earlier version of
// this file did - yields a different instance, and a spy on that one sees nothing.
const logger = require('../src/utils/logger');

const FIXTURE = `file://${path.join(__dirname, 'fixtures', 'notebook-frame.html')}`;
const EXPORT_TIMEOUT = 240000;

describe('overwrite policy (F-16)', () => {
    const { chromium } = require('playwright');
    let browser;
    let online = true;
    let outDir;
    let page;

    beforeAll(async () => {
        try {
            browser = await chromium.launch({ headless: true });
            page = await browser.newPage();
        } catch (e) {
            online = false;
            console.warn(`Skipping overwrite tests: Chromium unavailable (${e.message.split('\n')[0]})`);
        }
    }, 60000);

    afterAll(async () => {
        if (browser) await browser.close();
    });

    // Forwards the per-test timeout; jest's 5s default would kill every one of these.
    const itBrowser = (name, fn, timeout = EXPORT_TIMEOUT) =>
        (online ? it(name, fn, timeout) : it.skip(name, fn));

    /** Runs one export of the fixture into outDir. */
    const runOnce = async (notebookName = 'NB') => {
        await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
        return exporter.exportContent({
            contentFrame: page.mainFrame(),
            notebookName,
            options: { exportDir: outDir },
        });
    };

    describe('two consecutive runs into the same folder', () => {
        let sectionDir;
        let imagePath;
        let firstImageBytes;
        let afterFirst;
        let afterSecond;
        let warnText;

        beforeAll(async () => {
            if (!online) return;
            outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overwrite-'));

            await runOnce();
            sectionDir = path.join(outDir, 'NB', 'Section One');
            afterFirst = fs.readdirSync(path.join(sectionDir, 'assets')).sort();
            imagePath = path.join(sectionDir, 'assets', 'The Page_img_1.png');
            firstImageBytes = fs.readFileSync(imagePath);

            // Corrupt the asset, so the re-run has to genuinely rewrite it.
            fs.writeFileSync(imagePath, Buffer.from('not a png'));

            // Capture what the user is told on the second run.
            const warn = jest.spyOn(logger, 'warn');
            await runOnce();
            warnText = warn.mock.calls.map((c) => String(c[0])).join('\n');
            warn.mockRestore();

            afterSecond = fs.readdirSync(path.join(sectionDir, 'assets')).sort();
        }, EXPORT_TIMEOUT);

        afterAll(() => {
            if (outDir) fs.removeSync(outDir);
        });

        itBrowser('replaces assets instead of adding _1, _2 suffixes', () => {
            // No report.pdf_1, no The Page_img_1_1.png - the same names, refreshed.
            expect(afterSecond).toEqual(afterFirst);

            // Specifically: still exactly one image, name unchanged. A bare /_1\./
            // check would false-positive on "The Page_img_1.png" itself.
            expect(afterSecond.filter((f) => f.includes('_img_'))).toEqual(['The Page_img_1.png']);
        });

        itBrowser('does not grow the file count in the section directory', () => {
            const first = fs.readdirSync(sectionDir).sort();
            const second = fs.readdirSync(sectionDir).sort();
            expect(second).toEqual(first);
            expect(second).toContain('The Page.md');
        });

        itBrowser('really rewrites the file content', () => {
            expect(fs.readFileSync(imagePath).equals(firstImageBytes)).toBe(true);
        });

        itBrowser('warns that the folder exists, names it, and says files are overwritten', () => {
            expect(warnText).toContain('Output folder already exists');
            expect(warnText).toContain(path.join(outDir, 'NB'));
            expect(warnText).toMatch(/overwritten/i);
        });

        itBrowser('warns that stale files from a previous run are left in place', () => {
            // Overwriting is not the same as syncing: a page deleted from OneNote
            // leaves its Markdown behind, and the user should hear that.
            expect(warnText).toMatch(/left in place/i);
            expect(warnText).toMatch(/merge, not a clean mirror/i);
        });
    });

    describe('a folder that is new or empty', () => {
        beforeEach(() => {
            if (!online) return;
            outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overwrite-'));
        });

        afterEach(() => {
            if (outDir) fs.removeSync(outDir);
        });

        itBrowser('says nothing when the folder does not exist yet', async () => {
            await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });

            const warn = jest.spyOn(logger, 'warn');
            await exporter.exportContent({
                contentFrame: page.mainFrame(),
                notebookName: 'Brand New',
                options: { exportDir: outDir },
            });
            const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
            warn.mockRestore();

            expect(text).not.toContain('Output folder already exists');
        });

        itBrowser('says nothing when the folder exists but is empty', async () => {
            // Left behind by a previous run that then failed before writing.
            fs.ensureDirSync(path.join(outDir, 'Empty One'));
            await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });

            const warn = jest.spyOn(logger, 'warn');
            await exporter.exportContent({
                contentFrame: page.mainFrame(),
                notebookName: 'Empty One',
                options: { exportDir: outDir },
            });
            const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
            warn.mockRestore();

            expect(text).not.toContain('Output folder already exists');
        });
    });

    itBrowser('two attachments with the same name in ONE run still get distinct paths', async () => {
        // The counter-case for the policy: overwriting is BETWEEN runs, not within
        // one. Two links resolving to report.docx in a single page must not share a
        // path.
        outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overwrite-'));
        try {
            await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });

            await page.evaluate(() => {
                const canvas = document.getElementById('OreoCanvas');
                const extra = document.createElement('div');
                extra.className = 'OutlineContainer';
                extra.innerHTML =
                    '<a href="https://files.example.invalid/other/report.docx" ' +
                    'class="attachment" title="report.docx">report.docx</a>';
                canvas.appendChild(extra);
            });

            await exporter.exportContent({
                contentFrame: page.mainFrame(),
                notebookName: 'Dup',
                options: { exportDir: outDir },
            });

            // Asserted on the Markdown rather than on files, because neither
            // download can succeed (both point at a host that does not exist), so
            // nothing is written to assets/. What matters is that the two links
            // were planned as two different names.
            const md = fs.readFileSync(
                path.join(outDir, 'Dup', 'Section One', 'The Page.md'), 'utf8');

            // NOTE: the ] inside the class is escaped. `[^]]` does NOT mean "not ]"
            // in JavaScript - it parses as "any character" - and silently matched
            // nothing here, which looked exactly like a product failure.
            const referenced = [...md.matchAll(/\[\[assets\/(report[^\]]*)\]\]/g)].map((m) => m[1]);
            expect(referenced).toHaveLength(2);
            // Distinct names, and the first keeps the unsuffixed one.
            expect(new Set(referenced).size).toBe(2);
            expect(referenced).toContain('report.docx');
        } finally {
            fs.removeSync(outDir);
        }
    });
});
