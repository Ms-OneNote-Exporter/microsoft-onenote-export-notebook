const fs = require('fs-extra');
const path = require('path');

/**
 * Scraper tests against fixtures captured from the real OneNote web UI.
 *
 * The fixtures under test/fixtures/ were extracted from a live capture
 * (dumps/20260927/, gitignored) and de-identified: names, UUIDs, CSS-module
 * hashes and tenant strings are all placeholders. Only the structure the code
 * depends on is preserved, so nothing private is committed.
 *
 * These run in a REAL browser rather than against a hand-rolled fake frame,
 * because the scrapers do things a fake cannot honestly reproduce:
 *   - getSections() filters out zero-size elements via offsetWidth/offsetHeight,
 *     so visibility has to be computed by a layout engine;
 *   - it walks parentElement chains looking for [role="group"];
 *   - getPageContent() clones and rewrites a real DOM tree.
 *
 * The alternative - mocking frame.evaluate - would have tested the mock.
 */
const { chromium } = require('playwright');
const { getSections, getPages, getPageContent } = require('../src/scrapers');

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name) => `file://${path.join(FIXTURES, name)}`;

describe('scrapers against captured fixtures', () => {
    let browser;
    let context;
    let page;
    let online = true;

    beforeAll(async () => {
        try {
            browser = await chromium.launch({ headless: true });
            context = await browser.newContext();
            page = await context.newPage();
        } catch (e) {
            online = false;
            console.warn(`Skipping scraper fixture tests: Chromium unavailable (${e.message.split('\n')[0]})`);
        }
    }, 60000);

    afterAll(async () => {
        if (browser) await browser.close();
    });

    const loadFixture = async (name) => {
        await page.goto(fixture(name), { waitUntil: 'domcontentloaded' });
    };

    /** Skips rather than fails when Chromium is unavailable (e.g. no browser installed). */
    const itBrowser = (name, fn) => (online ? it(name, fn) : it.skip(name, fn));

    describe('getSections (STEP 2/3)', () => {
        itBrowser('returns the top-level sections and the group', async () => {
            await loadFixture('section-list.html');
            const items = await getSections(page, null);

            expect(items).toHaveLength(3);
            expect(items.map((i) => i.type)).toEqual(['section', 'section', 'group']);
        });

        itBrowser('reads section names from the navItem aria-label', async () => {
            await loadFixture('section-list.html');
            const items = await getSections(page, null);

            expect(items[0].name).toBe('Section Alpha');
            expect(items[1].name).toBe('Section Beta');
            expect(items[2].name).toBe('Section Group One');
        });

        itBrowser('strips the accessibility suffixes from the label', async () => {
            await loadFixture('section-list.html');
            const [first] = await getSections(page, null);

            // The real label is:
            //   "Section Alpha, Section. Selected. Press Tab to navigate to ..."
            expect(first.name).not.toMatch(/Section\./);
            expect(first.name).not.toMatch(/Selected/);
            expect(first.name).not.toMatch(/Press Tab/);
        });

        itBrowser('uses the element id as the section id', async () => {
            await loadFixture('section-list.html');
            const items = await getSections(page, null);

            expect(items[0].id).toBe('11111111-1111-4111-8111-111111111111');
        });

        // Observed in the real capture: a group's id is a URL-encoded absolute
        // SharePoint folder URL, not a UUID. linkResolver has to cope with that.
        itBrowser('keeps a group id that is a URL-encoded SharePoint path', async () => {
            await loadFixture('section-list.html');
            const group = (await getSections(page, null)).find((i) => i.type === 'group');

            expect(group.id).toMatch(/^https%3A%2F%2F/);
            expect(decodeURIComponent(group.id)).toContain('sharepoint.com');
        });

        itBrowser('returns only direct children when a group is expanded', async () => {
            await loadFixture('section-list-nested.html');
            const top = await getSections(page, null);

            // The nested items are inside a [role="group"] wrapper and must not
            // leak into the top level, or a recursive export would never terminate.
            expect(top).toHaveLength(2);
            expect(top.map((i) => i.name)).toEqual(['Section Alpha', 'Section Group One']);
        });

        itBrowser('descends into an expanded group', async () => {
            await loadFixture('section-list-nested.html');
            const top = await getSections(page, null);
            const group = top.find((i) => i.type === 'group');

            const children = await getSections(page, group.id);

            expect(children).toHaveLength(2);
            expect(children.map((i) => i.name)).toEqual(['Nested Section One', 'Nested Group']);
            expect(children[1].type).toBe('group');
        });

        itBrowser('handles a group nested inside a group', async () => {
            await loadFixture('section-list-nested.html');
            const top = await getSections(page, null);
            const outer = top.find((i) => i.type === 'group');
            const inner = (await getSections(page, outer.id)).find((i) => i.type === 'group');

            const deep = await getSections(page, inner.id);

            expect(deep).toHaveLength(1);
            expect(deep[0].name).toBe('Deeply Nested Section');
        });

        itBrowser('returns an empty array for an id that is not in the DOM', async () => {
            // F-22: this is the case that used to disappear silently.
            await loadFixture('section-list-nested.html');
            const items = await getSections(page, 'no-such-id');
            expect(items).toEqual([]);
        });
    });

    describe('getPages (STEP 4)', () => {
        itBrowser('finds every page node', async () => {
            await loadFixture('page-list.html');
            const pages = await getPages(page);

            expect(pages).toHaveLength(5);
        });

        itBrowser('keeps the braced {uuid}{n} id form', async () => {
            // linkResolver matches hrefs against this exact shape.
            await loadFixture('page-list.html');
            const pages = await getPages(page);

            expect(pages[0].id).toBe('{aaaaaaaa-1111-4111-8111-111111111111}{1}');
            expect(pages[0].id).toMatch(/^\{.+\}\{\d+\}$/);
        });

        itBrowser('strips the "Page. Select…" and "page X of Y" suffixes', async () => {
            await loadFixture('page-list.html');
            const pages = await getPages(page);

            // Real shape: "First Page, page 1 of 5, Page. Selected. Press Ctrl + F6…"
            expect(pages[0].name).toBe('First Page');
            // Real shape: "Second Page, page 2 of 5, Page. Select to open page contents."
            expect(pages[1].name).toBe('Second Page');
        });

        itBrowser('does not over-strip a title containing the word Page', async () => {
            await loadFixture('page-list.html');
            const pages = await getPages(page);

            // "Notes about Page Layout, page 3 of 5, Page. Select to open …"
            expect(pages[2].name).toBe('Notes about Page Layout');
        });

        itBrowser('falls back to Untitled Page when there is no list item', async () => {
            await loadFixture('page-list.html');
            const pages = await getPages(page);

            expect(pages[3].name).toBe('Untitled Page');
        });

        itBrowser('handles a label with no suffix at all', async () => {
            await loadFixture('page-list.html');
            const pages = await getPages(page);

            expect(pages[4].name).toBe('Fifth Page');
        });

        itBrowser('returns an empty list when there are no page nodes', async () => {
            await loadFixture('section-list.html');
            expect(await getPages(page)).toEqual([]);
        });
    });

    describe('getPageContent', () => {
        itBrowser('returns an empty shape for a page with no outlines', async () => {
            await loadFixture('page-list.html');
            const content = await getPageContent(page);

            expect(content.title).toBe('');
            expect(content.images).toEqual([]);
            expect(content.attachments).toEqual([]);
            expect(content.internalLinks).toEqual([]);
        });
    });

    describe('fixtures are safe to commit', () => {
        // The de-identification is the whole point of committing these. If a future
        // capture is pasted in without being scrubbed, this should catch it.
        it.each(fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.html')))(
            '%s contains no tenant or account identifiers',
            (name) => {
                const text = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
                const forbidden = [
                    'mobilutils', 'MOBILUTILS', 'mousquetaires', 'Mousquetaires',
                    'john_mobilutils', '@ MOBILUTILS', 'personal/john',
                    'live.com', 'live.co.uk',
                ];
                for (const needle of forbidden) {
                    expect(text.toLowerCase()).not.toContain(needle.toLowerCase());
                }
            }
        );

        it.each(fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.html')))(
            '%s contains no blob: or signed-in URLs',
            (name) => {
                const text = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
                expect(text).not.toMatch(/blob:/);
                expect(text).not.toMatch(/onedrive|sharepoint\.com\/personal/i);
            }
        );
    });
});
