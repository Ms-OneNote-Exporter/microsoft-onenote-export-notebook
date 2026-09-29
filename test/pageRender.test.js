const fs = require('fs-extra');
const os = require('os');
const path = require('path');

/**
 * F-61: a page that has not rendered must not be written as a note.
 *
 * A real page of a real notebook was exported as fifteen bytes:
 *
 *     $ od -c "Section S1/Section1-Note1.1_PDFs.md"
 *     0000000  \n  \n   P   a   g   e       C   o   n   t   e   n   t   s
 *
 * That page holds a full-page printout image and two attachments. Nothing about
 * the file says it is wrong - it has a name, a size and no error - and the run
 * that wrote it logged `Saved (0 assets)` and finished declaring success.
 *
 * The cause is a fixed `waitForTimeout(3000)` between selecting a page and
 * scraping it. OneNote tears the old page down before building the new one, so
 * the canvas is briefly empty, and a heavy page can still be mid-render when the
 * sleep ends. The scraper then found no outlines, fell back to `div[role=main]`
 * - a landmark whose only remaining text is its own accessible name - and wrote
 * that as the page.
 *
 * Two runs of the same notebook eleven hours apart produced opposite results for
 * the same page, which is what identifies it as a race rather than a page that
 * cannot be read.
 *
 * These tests pin the three things that have to hold: the wait must wait for the
 * content rather than for a duration, an unrendered page must produce no file at
 * all, and it must be counted as a failure so the run cannot report success.
 */
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
}));

const { chromium } = require('playwright');
const logger = require('../src/utils/logger');
const exporter = require('../src/exporter');
const { getPageContent } = require('../src/scrapers');

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name) => `file://${path.join(FIXTURES, name)}`;

describe('getPageContent reports what it actually found', () => {
    let browser;
    let page;
    let online = true;

    beforeAll(async () => {
        try {
            browser = await chromium.launch({ headless: true });
        } catch (e) {
            online = false;
            console.warn(`Skipping F-61 browser tests: Chromium unavailable (${e.message.split('\n')[0]})`);
        }
    }, 60000);

    afterAll(async () => {
        if (browser) await browser.close();
    });

    beforeEach(async () => {
        jest.clearAllMocks();
        if (online) page = await browser.newPage();
    });

    afterEach(async () => {
        if (page) await page.close().catch(() => { });
    });

    // Forwards the timeout: these drive a real browser and the two "page never
    // rendered" cases deliberately wait out the full render timeout, so the
    // default 5s is not enough.
    const itBrowser = (name, fn, timeout) => (online ? it(name, fn, timeout) : it.skip(name, fn, timeout));

    itBrowser('counts the outlines on a page that rendered', async () => {
        await page.goto(fixture('notebook-frame.html'), { waitUntil: 'domcontentloaded' });

        const content = await getPageContent(page);

        expect(content.outlinesFound).toBeGreaterThan(0);
    });

    itBrowser('reports zero on an empty canvas, which is how a stub is recognised', async () => {
        await page.goto(fixture('empty-canvas.html'), { waitUntil: 'domcontentloaded' });

        const content = await getPageContent(page);

        expect(content.outlinesFound).toBe(0);
        // And this is the trap: the fallback still hands back something that looks
        // like a page. Naming it is why the caller can tell the two apart.
        expect(content.contentHtml).toContain('Page Contents');
    });
});

describe('the wait replaced the sleep', () => {
    const waitForPageContent = exporter.waitForPageContentForTest;
    const isRequestedPageOnScreen = exporter.isRequestedPageOnScreen;

    it('keeps waiting while the canvas is still showing the previous page', async () => {
        // The bug this exists to prevent. OneNote does not clear the canvas when
        // you click a page, so the previous page's outlines are still there and
        // "something is rendered" is true immediately. A wait keyed on that
        // returns at once, and the page is written with its predecessor's text.
        // On the real notebook that gave 16 of 19 pages the wrong content and the
        // run still exited 0.
        const frame = {
            evaluate: jest.fn(async () => (
                frame.evaluate.mock.calls.length < 3
                    ? { outlines: 4, titles: ['The Previous Page'], images: 0, imagesReady: 0 }
                    : { outlines: 4, titles: ['The Page'], images: 0, imagesReady: 0 }
            )),
            waitForTimeout: jest.fn(async () => { }),
        };

        const state = await waitForPageContent(frame, 'The Page');

        expect(state.titles).toEqual(['The Page']);
    });

    it('keeps waiting while the page is still loading its images', async () => {
        // A correctly-titled page whose picture has not loaded yet. The outlines
        // have settled and the title is right, so every check up to this point
        // passes - and the page exports with its picture silently missing.
        //
        // Measured on the real notebook, one polling step apart:
        //   outlines=3  img=16/15   settled, one image still has no source
        //   outlines=3  img=16/16   loaded
        const readings = [
            { outlines: 3, titles: ['Picture Page'], images: 2, imagesReady: 1 },
            { outlines: 3, titles: ['Picture Page'], images: 2, imagesReady: 2 },
            { outlines: 3, titles: ['Picture Page'], images: 2, imagesReady: 2 },
        ];
        let i = 0;
        const frame = {
            evaluate: jest.fn(async () => readings[Math.min(i++, readings.length - 1)]),
            waitForTimeout: jest.fn(async () => { }),
        };

        const state = await waitForPageContent(frame, 'Picture Page');

        // It waited for the image, not just for the title.
        expect(frame.evaluate).toHaveBeenCalledTimes(3);
        expect(state.imagesReady).toBe(2);
    });

    it('does not wait a second poll for a page that is already finished', async () => {
        // The cost of the quiescence check, pinned so it cannot creep up: a page
        // that is correct and unchanged takes one extra 250ms poll and no more.
        const frame = {
            evaluate: jest.fn(async () => (
                { outlines: 4, titles: ['The Page'], images: 3, imagesReady: 3 }
            )),
            waitForTimeout: jest.fn(async () => { }),
        };

        expect(await waitForPageContent(frame, 'The Page')).toBeDefined();
        expect(frame.evaluate).toHaveBeenCalledTimes(2);
        expect(frame.waitForTimeout).toHaveBeenCalledTimes(1);
    });

    it('gives up and reports what the canvas is actually showing', async () => {
        const frame = {
            evaluate: jest.fn(async () => (
                { outlines: 4, titles: ['Some Other Page'], images: 0, imagesReady: 0 }
            )),
            waitForTimeout: jest.fn(async () => { }),
        };

        // A short timeout: the point is that it gives up and says so, not how long
        // it waits.
        const state = await waitForPageContent(frame, 'Wanted Page', 200);

        expect(isRequestedPageOnScreen(state, 'Wanted Page')).toBe(false);
        // The title is carried back so the failure can name the real page.
        expect(state.titles).toEqual(['Some Other Page']);
    });

    it('returns an empty canvas rather than hanging when nothing renders', async () => {
        const frame = {
            evaluate: jest.fn(async () => ({ outlines: 0, titles: [] })),
            waitForTimeout: jest.fn(async () => { }),
        };

        expect((await waitForPageContent(frame, 'The Page', 200)).outlines).toBe(0);
    });

    describe('the signature that detects a page still filling in', () => {
        const { canvasSignature } = exporter;

        it('is the same for two identical readings', () => {
            const state = { outlines: 3, titles: ['P'], images: 2, imagesReady: 2 };
            expect(canvasSignature(state)).toBe(canvasSignature({ ...state }));
        });

        it('differs when an image gains its source', () => {
            // The one transition that matters, and the reason the check exists.
            expect(canvasSignature({ outlines: 3, titles: ['P'], images: 2, imagesReady: 1 }))
                .not.toBe(canvasSignature({ outlines: 3, titles: ['P'], images: 2, imagesReady: 2 }));
        });

        it('differs when a page is cloned', () => {
            expect(canvasSignature({ outlines: 3, titles: ['P'], images: 2, imagesReady: 2 }))
                .not.toBe(canvasSignature({ outlines: 6, titles: ['P', 'P'], images: 4, imagesReady: 4 }));
        });
    });

    describe('deciding whether the canvas has settled on the right page', () => {
        it('rejects the previous page, even though it is fully rendered', () => {
            expect(isRequestedPageOnScreen(
                { outlines: 6, titles: ['Previous Page'] }, 'Wanted Page')).toBe(false);
        });

        it('accepts the page that was asked for', () => {
            expect(isRequestedPageOnScreen(
                { outlines: 6, titles: ['Wanted Page'] }, 'Wanted Page')).toBe(true);
        });

        it('rejects the moment OneNote has cloned the page, content and all', () => {
            // The state that duplicated a page's content into one note. The title
            // is already correct here - both copies carry it - so a check on the
            // title alone lets this through and the scraper then picks up every
            // outline, producing the page twice.
            //
            // Measured on the real notebook, a switch goes:
            //   [previous] -> [previous + previous] -> [] -> [wanted + wanted] -> [wanted]
            expect(isRequestedPageOnScreen(
                { outlines: 6, titles: ['Wanted Page', 'Wanted Page'] }, 'Wanted Page')).toBe(false);
        });

        it('rejects a clone of the outgoing page as well', () => {
            expect(isRequestedPageOnScreen(
                { outlines: 6, titles: ['Wanted Page', 'Previous Page'] }, 'Wanted Page')).toBe(false);
        });

        it('survives the whitespace and case OneNote is inconsistent about', () => {
            // The nav list and the canvas title are not byte-identical for every
            // page, and a strict comparison would fail notes that are fine.
            expect(isRequestedPageOnScreen(
                { outlines: 3, titles: ['Section  S1-Note1  '] }, 'Section S1-Note1')).toBe(true);
        });

        it('accepts a page that rendered but has no title outline', () => {
            // Refusing these would break notes that used to export fine, and an
            // empty title with outlines present is still a rendered page.
            expect(isRequestedPageOnScreen(
                { outlines: 2, titles: [] }, 'Some Page')).toBe(true);
        });

        it('rejects an empty canvas whatever the name', () => {
            // This is the F-61 stub: no outlines at all.
            expect(isRequestedPageOnScreen(
                { outlines: 0, titles: ['Some Page'] }, 'Some Page')).toBe(false);
        });
    });
});

describe('a group is only clicked when it is collapsed', () => {
    // The defect behind F-62, measured on the real notebook:
    //
    //   fresh page load      aria-expanded=false  items=0
    //   after selectSection  aria-expanded=true   items=2
    //   after selectSection  aria-expanded=false  items=0   <- collapsed again
    //
    // Selecting a group is a toggle. A retry that clicks without asking therefore
    // closes the group it just opened, and the exporter goes on to report success
    // with every page underneath it missing.
    const { isGroupExpanded } = require('../src/scrapers');

    /** A frame whose group row reports whatever `expanded` says. */
    const frameWithGroup = (expanded) => ({
        evaluate: jest.fn(async () => expanded),
    });

    it('reads the state the DOM publishes rather than guessing', async () => {
        expect(await isGroupExpanded(frameWithGroup(true), 'g1')).toBe(true);
        expect(await isGroupExpanded(frameWithGroup(false), 'g1')).toBe(false);
    });

    it('reports null when the row is not in the DOM at all', async () => {
        // A missing row is not "collapsed": treating it as such would make the
        // caller click something that is not there.
        const frame = { evaluate: jest.fn(async () => null) };
        expect(await isGroupExpanded(frame, 'gone')).toBeNull();
    });
});

describe('the same wait for a group that has not expanded', () => {
    // F-62. A real run entered SectionGroup1, found nothing, warned, and finished
    // with `Export complete!` and exit 0 - eight pages of the notebook simply
    // absent, with a warning in the log that changed nothing anyone downstream
    // could see. The five-second sleep it replaced was a race, and it lost often
    // enough to matter.
    const waitForGroupItems = exporter.waitForGroupItemsForTest;

    let browser;
    let page;
    let online = true;

    beforeAll(async () => {
        try {
            browser = await chromium.launch({ headless: true });
        } catch (e) {
            online = false;
            console.warn(`Skipping F-62 browser tests: Chromium unavailable (${e.message.split('\n')[0]})`);
        }
    }, 60000);

    afterAll(async () => {
        if (browser) await browser.close();
    });

    beforeEach(async () => {
        if (online) page = await browser.newPage();
    });

    afterEach(async () => {
        if (page) await page.close().catch(() => { });
    });

    const itBrowser = (name, fn, timeout) => (online ? it(name, fn, timeout) : it.skip(name, fn, timeout));

    itBrowser('returns the children of a group that has expanded', async () => {
        // section-list-nested.html holds an expanded group, so the real
        // getSections finds its children on the first poll - which is the point:
        // a group that is ready must not pay the wait.
        await page.goto(fixture('section-list-nested.html'), { waitUntil: 'domcontentloaded' });
        const { getSections } = require('../src/scrapers');
        const group = (await getSections(page, null)).find((i) => i.type === 'group');
        expect(group).toBeDefined();

        const started = Date.now();
        expect(await waitForGroupItems(page.mainFrame(), group.id, 5000)).toBe(2);
        // Returned on the first poll, so it did not sit out the timeout.
        expect(Date.now() - started).toBeLessThan(1000);
    });

    itBrowser('returns 0 rather than hanging when the group never expands', async () => {
        // The empty-canvas fixture has a group-shaped page list but no group, so
        // this is the F-62 case: the id is not in the DOM and getSections can only
        // ever return []. A short timeout - the point is that it gives up and says
        // so, not how long it waits.
        await page.goto(fixture('empty-canvas.html'), { waitUntil: 'domcontentloaded' });

        expect(await waitForGroupItems(page.mainFrame(), 'no-such-group', 200)).toBe(0);
    });
});

describe('an unrendered page produces no file and is counted as a failure', () => {
    let browser;
    let online = true;

    beforeAll(async () => {
        try {
            browser = await chromium.launch({ headless: true });
        } catch (e) {
            online = false;
            console.warn(`Skipping F-61 pipeline test: Chromium unavailable (${e.message.split('\n')[0]})`);
        }
    }, 60000);

    afterAll(async () => {
        if (browser) await browser.close();
    });

    // Forwards the timeout: these drive a real browser and the two "page never
    // rendered" cases deliberately wait out the full render timeout, so the
    // default 5s is not enough.
    const itBrowser = (name, fn, timeout) => (online ? it(name, fn, timeout) : it.skip(name, fn, timeout));

    itBrowser('writes nothing at all, and says the page failed', async () => {
        const page = await browser.newPage();
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f61-'));

        try {
            await page.goto(fixture('empty-canvas.html'), { waitUntil: 'domcontentloaded' });

            const stats = await exporter.exportContent({
                contentFrame: page.mainFrame(),
                notebookName: 'Empty Canvas Notebook',
                options: { exportDir: outDir },
                page
            });

            // The page failed, loudly, rather than being written as a stub.
            expect(stats.failedPages).toBe(1);
            expect(stats.totalPages).toBe(0);

            // And there is no file on disk - not an empty one, not a 15-byte one.
            // This is the assertion the original bug would fail: it wrote a file,
            // and reported success doing it.
            const written = [];
            const walk = (dir) => {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) walk(full);
                    else written.push(path.relative(outDir, full));
                }
            };
            walk(path.join(outDir, 'Empty Canvas Notebook'));
            expect(written).toEqual([]);
        } finally {
            await page.close().catch(() => { });
            fs.removeSync(outDir);
        }
    }, 60000);

    itBrowser('names the page that failed, so it can be found and re-run', async () => {
        const page = await browser.newPage();
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f61b-'));

        try {
            await page.goto(fixture('empty-canvas.html'), { waitUntil: 'domcontentloaded' });

            await exporter.exportContent({
                contentFrame: page.mainFrame(),
                notebookName: 'Empty Canvas Notebook',
                options: { exportDir: outDir },
                page
            });

            // logger.error is called as (message, error), so the page name is in
            // the first argument and the reason in the second.
            const said = logger.error.mock.calls
                .map((c) => `${c[0]} ${(c[1] && c[1].message) || ''}`).join('\n');

            expect(said).toMatch(/The Page/);
            // ...and the reason is stated, not left for the user to deduce from an
            // empty file.
            expect(said).toMatch(/never settled on the canvas/i);
        } finally {
            await page.close().catch(() => { });
            fs.removeSync(outDir);
        }
    }, 60000);
});

describe('a page is never written with the previous page content', () => {
    // The failure this prevents is worse than the stub it replaced. A canvas that
    // is fully rendered but showing the wrong page passes every "is there content"
    // check, so the previous fix - wait for outlines to exist - wrote the outgoing
    // page's text under the incoming page's name. On the real notebook that was 16
    // of 19 pages, and the run reported success.
    let browser;
    let online = true;

    beforeAll(async () => {
        try {
            browser = await chromium.launch({ headless: true });
        } catch (e) {
            online = false;
            console.warn(`Skipping F-61 stale-canvas test: Chromium unavailable (${e.message.split('\n')[0]})`);
        }
    }, 60000);

    afterAll(async () => {
        if (browser) await browser.close();
    });

    // Forwards the timeout: this case waits out the full render budget twice
    // (initial wait, then the re-select), so the default 5s is not enough.
    const itBrowser = (name, fn, timeout) => (online ? it(name, fn, timeout) : it.skip(name, fn, timeout));

    itBrowser('fails the page instead of saving the previous page text', async () => {
        const page = await browser.newPage();
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f61stale-'));

        try {
            await page.goto(fixture('stale-canvas.html'), { waitUntil: 'domcontentloaded' });

            const stats = await exporter.exportContent({
                contentFrame: page.mainFrame(),
                notebookName: 'Stale Canvas Notebook',
                options: { exportDir: outDir },
                page
            });

            // Only the page the canvas is genuinely showing exports. The wanted
            // page is on the nav list but not on the canvas, so it is failed -
            // the fixture's canvas never moves off the page it starts on.
            expect(stats.totalPages).toBe(1);
            expect(stats.failedPages).toBe(1);

            const sectionDir = path.join(outDir, 'Stale Canvas Notebook', 'Section One');
            const files = fs.existsSync(sectionDir) ? fs.readdirSync(sectionDir).sort() : [];

            // The wanted page gets no file at all. The version of this fix that
            // waited on outline count would have written one, and reported
            // success.
            expect(files).toEqual(['The Previous Page.md']);
            expect(fs.existsSync(path.join(sectionDir, 'The Wanted Page.md'))).toBe(false);
        } finally {
            await page.close().catch(() => { });
            fs.removeSync(outDir);
        }
    }, 120000);

    itBrowser('says which page the canvas was actually showing', async () => {
        const page = await browser.newPage();
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f61stale2-'));

        try {
            await page.goto(fixture('stale-canvas.html'), { waitUntil: 'domcontentloaded' });

            await exporter.exportContent({
                contentFrame: page.mainFrame(),
                notebookName: 'Stale Canvas Notebook',
                options: { exportDir: outDir },
                page
            });

            const said = logger.error.mock.calls
                .map((c) => `${c[0]} ${(c[1] && c[1].message) || ''}`).join('\n');

            // Naming the page that was really on screen is the difference between
            // a diagnosable failure and a mystery.
            expect(said).toMatch(/The Wanted Page/);
            expect(said).toMatch(/showing "The Previous Page" instead/i);
        } finally {
            await page.close().catch(() => { });
            fs.removeSync(outDir);
        }
    }, 120000);
});

describe('a page that renders is unaffected', () => {
    let browser;
    let online = true;

    beforeAll(async () => {
        try {
            browser = await chromium.launch({ headless: true });
        } catch (e) {
            online = false;
        }
    }, 60000);

    afterAll(async () => {
        if (browser) await browser.close();
    });

    // Forwards the timeout: these drive a real browser and the two "page never
    // rendered" cases deliberately wait out the full render timeout, so the
    // default 5s is not enough.
    const itBrowser = (name, fn, timeout) => (online ? it(name, fn, timeout) : it.skip(name, fn, timeout));

    itBrowser('still exports normally, with no new failures', async () => {
        const page = await browser.newPage();
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f61c-'));

        try {
            await page.goto(fixture('notebook-frame.html'), { waitUntil: 'domcontentloaded' });

            const stats = await exporter.exportContent({
                contentFrame: page.mainFrame(),
                notebookName: 'Normal Notebook',
                options: { exportDir: outDir },
                page
            });

            expect(stats.totalPages).toBe(1);
            expect(stats.failedPages).toBe(0);
            expect(fs.readFileSync(
                path.join(outDir, 'Normal Notebook', 'Section One', 'The Page.md'), 'utf8'))
                .toContain('Hello from the fixture');
        } finally {
            await page.close().catch(() => { });
            fs.removeSync(outDir);
        }
    }, 60000);
});
