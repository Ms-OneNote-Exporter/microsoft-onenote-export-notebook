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
            const { items } = await getSections(page, null);

            expect(items).toHaveLength(3);
            expect(items.map((i) => i.type)).toEqual(['section', 'section', 'group']);
        });

        itBrowser('reads section names from the navItem aria-label', async () => {
            await loadFixture('section-list.html');
            const { items } = await getSections(page, null);

            expect(items[0].name).toBe('Section Alpha');
            expect(items[1].name).toBe('Section Beta');
            expect(items[2].name).toBe('Section Group One');
        });

        itBrowser('strips the accessibility suffixes from the label', async () => {
            await loadFixture('section-list.html');
            const { items: [first] } = await getSections(page, null);

            // The real label is:
            //   "Section Alpha, Section. Selected. Press Tab to navigate to ..."
            expect(first.name).not.toMatch(/Section\./);
            expect(first.name).not.toMatch(/Selected/);
            expect(first.name).not.toMatch(/Press Tab/);
        });

        itBrowser('uses the element id as the section id', async () => {
            await loadFixture('section-list.html');
            const { items } = await getSections(page, null);

            expect(items[0].id).toBe('11111111-1111-4111-8111-111111111111');
        });

        // Observed in the real capture: a group's id is a URL-encoded absolute
        // SharePoint folder URL, not a UUID. linkResolver has to cope with that.
        itBrowser('keeps a group id that is a URL-encoded SharePoint path', async () => {
            await loadFixture('section-list.html');
            const { items } = await getSections(page, null);
            const group = items.find((i) => i.type === 'group');

            expect(group.id).toMatch(/^https%3A%2F%2F/);
            expect(decodeURIComponent(group.id)).toContain('sharepoint.com');
        });

        itBrowser('returns only direct children when a group is expanded', async () => {
            await loadFixture('section-list-nested.html');
            const { items: top } = await getSections(page, null);

            // The nested items are inside a [role="group"] wrapper and must not
            // leak into the top level, or a recursive export would never terminate.
            expect(top).toHaveLength(2);
            expect(top.map((i) => i.name)).toEqual(['Section Alpha', 'Section Group One']);
        });

        itBrowser('descends into an expanded group', async () => {
            await loadFixture('section-list-nested.html');
            const { items: top } = await getSections(page, null);
            const group = top.find((i) => i.type === 'group');

            const { items: children } = await getSections(page, group.id);

            expect(children).toHaveLength(2);
            expect(children.map((i) => i.name)).toEqual(['Nested Section One', 'Nested Group']);
            expect(children[1].type).toBe('group');
        });

        itBrowser('handles a group nested inside a group', async () => {
            await loadFixture('section-list-nested.html');
            const { items: top } = await getSections(page, null);
            const outer = top.find((i) => i.type === 'group');
            const { items: outerItems } = await getSections(page, outer.id);
            const inner = outerItems.find((i) => i.type === 'group');

            const { items: deep } = await getSections(page, inner.id);

            expect(deep).toHaveLength(1);
            expect(deep[0].name).toBe('Deeply Nested Section');
        });

        itBrowser('returns an empty array for an id that is not in the DOM', async () => {
            // F-22: this is the case that used to disappear silently.
            await loadFixture('section-list-nested.html');
            const { items } = await getSections(page, 'no-such-id');
            expect(items).toEqual([]);
        });

        // F-22's residual: an empty list said nothing about *why*, so the caller
        // could not tell a group that is empty from one whose container was never
        // found - and those are opposite news with different remedies.
        itBrowser('says the parent is missing when the id is not in the DOM', async () => {
            await loadFixture('section-list-nested.html');
            const { reason } = await getSections(page, 'no-such-id');
            expect(reason).toBe('no-parent');
        });

        itBrowser('reports no reason at all when the lookup succeeded', async () => {
            await loadFixture('section-list.html');
            const { reason } = await getSections(page, null);
            // A reason is only ever set for an empty result.
            expect(reason).toBeNull();
        });

        itBrowser('reports no reason when a group has children', async () => {
            await loadFixture('section-list-nested.html');
            const { items: top } = await getSections(page, null);
            const group = top.find((i) => i.type === 'group');

            const { items, reason } = await getSections(page, group.id);
            expect(items.length).toBeGreaterThan(0);
            expect(reason).toBeNull();
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

    /**
     * F-60: OneNote renders a file attachment as a container holding an overlay,
     * an icon and a filename label, and more than one of those parts matches the
     * attachment pattern. Against the captured markup that produced six
     * attachments for four real references, and the duplicate was the
     * healthy-looking one: the click marker was placed by a fuzzy title match
     * onto the *other* candidate, so the first was logged as "Could not find
     * clickable element" and could never be fetched at all.
     */
    describe('one file attachment, however many parts it is drawn with', () => {
        /** The element each attachment id was actually placed on. */
        const markedElements = () => page.evaluate(() => {
            const out = {};
            document.querySelectorAll('[data-one-attach-id]').forEach((el) => {
                out[el.getAttribute('data-one-attach-id')] = (el.className || '').toString();
            });
            return out;
        });

        let content;
        let marked;
        let byName;

        beforeAll(async () => {
            await loadFixture('attachment-container.html');
            content = await getPageContent(page);
            marked = await markedElements();
            byName = {};
            for (const a of content.attachments) byName[a.originalName] = a;
        });

        itBrowser('scrapes each file once, not once per part of it', async () => {
            // Four real references in the fixture: two attached files, a
            // deliberate hyperlink to one of them, and a standalone titled
            // element. Six is what the duplicate parts used to produce.
            expect(content.attachments).toHaveLength(4);
        });

        itBrowser('gives the click marker to the overlay, which is what OneNote makes clickable', async () => {
            expect(marked.file_0).toBe('WACEFOverlay');
            expect(marked.file_1).toBe('WACEFOverlay');
        });

        itBrowser('leaves no attachment without a click marker, so none is unfetchable forever', async () => {
            // The F-60 symptom in one assertion: an attachment with no marker can
            // never be downloaded, and was previously reported as a failure on
            // every page it appeared on.
            expect(Object.keys(marked).sort())
                .toEqual(content.attachments.map((a) => a.id).sort());
        });

        itBrowser('keeps two different files apart even though their markup is identical', async () => {
            expect(Object.keys(byName).sort())
                .toEqual(['Meeting Notes.docx', 'Quarterly Report.pdf', 'Standalone Handout.pdf']);
        });

        itBrowser('keeps a hyperlink the author added on purpose, even to a file already attached', async () => {
            // Two references to one document is not a bug: the note says it twice,
            // so the export says it twice. Collapsing this would lose a reference.
            const cloud = content.attachments.filter((a) => a.src);
            expect(cloud).toHaveLength(1);
            expect(cloud[0].originalName).toBe('Quarterly Report.pdf');
            expect(cloud[0].isCloud).toBe(true);
        });

        itBrowser('still scrapes a titled element that has no attachment container around it', async () => {
            // The longest-standing shape in the fixture set must be untouched by
            // any dedup: nothing names an ancestor, so it owns itself.
            expect(byName['Standalone Handout.pdf']).toBeDefined();
            expect(byName['Standalone Handout.pdf'].id).toBe('file_3');
        });
    });

    describe('a downloaded file is still linked from the note', () => {
        /**
         * F-63, and the failure mode that is invisible in every number the summary
         * reports.
         *
         * The F-60 dedup keeps one candidate per file, and the first candidate in
         * OneNote's markup is the click overlay - an *empty* element. The id that
         * becomes the Obsidian embed was stamped there, and turndown never consults
         * a custom rule for a blank node:
         *
         *     Rules.prototype.forNode = function (node) {
         *       if (node.isBlank) return this.blankRule
         *
         * So the embed was never produced. The attachment count stayed right, the
         * asset still downloaded, the run still exited 0 - and the note showed the
         * filename as plain text with nothing linking to the file sitting next to
         * it in assets/. Two files on disk, referenced by zero notes.
         *
         * These assertions are on the *markdown*, not on the HTML, because that is
         * where the defect was invisible. An HTML assertion - "the id is present",
         * which is what the F-60 tests checked - passes with the embed missing.
         */
        const { createMarkdownConverter } = require('../src/parser');

        let markdown;
        let content;

        beforeAll(async () => {
            await loadFixture('attachment-container.html');
            content = await getPageContent(page);
            markdown = createMarkdownConverter().turndown(content.contentHtml);
        });

        itBrowser('renders exactly one embed per attachment it scraped', async () => {
            // The lookbehind matters: an image embed is `![[assets/…]]`, and a
            // pattern without it counts those too. The fixture has two images, so
            // the sloppy version of this assertion passed against the bug by
            // arithmetic coincidence - 2 images + 2 working file embeds == the 4
            // attachments, none of which was the pair that had stopped rendering.
            const fileEmbeds = markdown.match(/(?<!!)\[\[assets\/[^\]]+\]\]/g) || [];
            expect(fileEmbeds).toHaveLength(content.attachments.length);

            // ...and each id appears exactly once, so the parts of one file have
            // not started producing an embed each.
            for (const a of content.attachments) {
                const occurrences = markdown.split(`[[assets/${a.id}`).length - 1;
                expect(occurrences).toBe(1);
            }
        });

        itBrowser('gives the two container attachments their embed back', async () => {
            // These are the ones the F-60 dedup collapsed, and the ones that
            // silently lost their link.
            expect(markdown).toContain('[[assets/file_0.pdf]]');
            expect(markdown).toContain('[[assets/file_1.docx]]');
        });

        itBrowser('does not emit a second embed for the parts of the same file', async () => {
            // The point of F-60 has to survive the fix: one file, one embed, even
            // though the container is drawn as four elements.
            const embeds = markdown.match(/\[\[assets\/file_0\.pdf\]\]/g) || [];
            expect(embeds).toHaveLength(1);
        });

        itBrowser('keeps the deliberate hyperlink as its own embed', async () => {
            expect(markdown).toContain('[[assets/file_2.pdf]]');
        });
    });

    describe("a file chip's icon is not a page image (F-71)", () => {
        /**
         * The chip was scraped twice: once correctly as the attachment, and once as
         * a page image that was never content.
         *
         * OneNote draws an attachment as a container holding an icon and a filename
         * label. That icon is an ordinary `<img>` which clears every other test the
         * image filter makes — not a OneNote UI asset, not `one.png`/`box4x.png`, no
         * `handle`/`one_` in its class, and at 16×16 comfortably over the size floor.
         * So each attachment page grew a phantom image asset:
         *
         *     assets/Alerte-au-gogole_480p.mp4       the attachment, correct
         *     assets/attachment_Videos mp4_img_1.png the chip's icon
         *
         * Served as a `blob:` URL, which the request context cannot fetch (F-51), so
         * it never downloaded. The cost was not the wasted attempt: it was a
         * permanent `> 1 asset could not be downloaded` callout in the note, naming
         * a file that was never in the notebook, plus a permanent addition to the
         * run summary's failure count. Three of four attachment pages did this.
         *
         * The fixture carries a real image next to the chip, because the tempting
         * fixes — skip small images, skip blob images — pass a test written only
         * about the icon while dropping every picture on the page.
         */
        const { createMarkdownConverter } = require('../src/parser');

        let content;
        let markdown;

        beforeAll(async () => {
            await loadFixture('attachment-chip-icon.html');
            content = await getPageContent(page);
            markdown = createMarkdownConverter().turndown(content.contentHtml);
        });

        itBrowser('still exports the chip as the attachment it is', async () => {
            // The exclusion must cost the *icon*, never the file. This is the half
            // that a sloppy version of the fix gets right by accident and the
            // careful version has to keep getting right on purpose.
            expect(content.attachments).toHaveLength(1);
            expect(content.attachments[0].originalName).toBe('Sample_Video_480p.mp4');
        });

        itBrowser('does not collect the chip icon as a page image', async () => {
            expect(content.images).toHaveLength(1);
            expect(content.images[0].src).not.toContain('office.png');
        });

        itBrowser('keeps a real image on the same page', async () => {
            // Without this, "skip every image inside a chip" and "skip every image"
            // are indistinguishable, and the second one loses the user's notes.
            expect(content.images[0].src).toContain('getimage.ashx');
            expect(markdown).toContain('![[assets/img_0.png]]');
        });

        itBrowser('does not spend an image id on the icon', async () => {
            // Without the fix the icon takes `img_0` and the real picture is pushed to
            // `img_1` - so the fix also stops a phantom from renumbering the user's
            // genuine images. Asserted on the id rather than on the embeds, because
            // the embeds are a poor probe here: before the fix the icon was collected
            // as an image and still produced **no embed**, which is exactly why the
            // defect was invisible in the note. It wrote an asset nothing pointed at,
            // then reported that asset as missing.
            expect(content.images.map((i) => i.id)).toEqual(['img_0']);
            expect(content.images[0].src).toContain('getimage.ashx');
        });
    });

    describe('audio and video attachments keep their own names (F-70)', () => {
        /**
         * A naming failure, not a detection one, and that is what made it quiet.
         *
         * OneNote's file chip is recognised by its `WACEF*` class names, so these
         * files were detected and downloaded on every run. But the *name* had to
         * pass the extension allowlist to be believed, and audio and video were
         * not on it, so both fell back to the placeholder name:
         *
         *     assets/attached_file.bin      <- an MP4
         *     assets/attached_file_1.bin    <- an MP3
         *
         * and the notes linked to those. Nothing warned: the download succeeded.
         * The page's own text said `file attached name: …mp4` on the same line.
         *
         * One list decides three things here - whether something counts as a file,
         * what it is called, and what the note links to - so these assertions cover
         * the name and the extension separately, because that is how it breaks.
         */
        const { createMarkdownConverter } = require('../src/parser');

        let content;
        let markdown;

        beforeAll(async () => {
            await loadFixture('attachment-media.html');
            content = await getPageContent(page);
            markdown = createMarkdownConverter().turndown(content.contentHtml);
        });

        itBrowser('names each attachment after the file it is', () => {
            expect(content.attachments.map((a) => a.originalName).sort())
                .toEqual(['Sample_Audio_2min.mp3', 'Sample_Video_480p.mp4']);
        });

        itBrowser('never falls back to the placeholder name for a known media type', () => {
            // The specific symptom on the real notebook. `attached_file` is the
            // value the scraper substitutes when nothing it can see looks like a
            // filename, and its presence here means the name was thrown away while
            // sitting in the attribute right next to it.
            expect(content.attachments.map((a) => a.originalName))
                .not.toContain('attached_file');
        });

        itBrowser('carries the real extension into the note', () => {
            // The link is built from the id plus the extension taken from
            // data-filename; the exporter then renames it to the file's real name.
            // `.bin` in either place means the extension never made it out of here.
            expect(markdown).toContain('[[assets/file_0.mp4]]');
            expect(markdown).toContain('[[assets/file_1.mp3]]');
            expect(markdown).not.toContain('.bin');
        });

        itBrowser('keeps the two files apart without a _1 suffix', () => {
            // Both used to be called `attached_file`, so the second became
            // `attached_file_1.bin` purely by collision - two different documents
            // distinguished by a counter.
            const names = content.attachments.map((a) => a.originalName);
            expect(new Set(names).size).toBe(names.length);
        });
    });

    describe('an attachment OneNote drew outside every outline (F-69)', () => {
        /**
         * The one shape that made getPageContent structurally unable to see a file.
         *
         * The note body is built by cloning the `.OutlineContainer` elements into a
         * detached div, and attachments are then searched for *inside that clone*.
         * OneNote sometimes draws an attachment as an absolutely positioned
         * element that is a **sibling** of the outlines rather than a child of one,
         * so it is never cloned - and the export reported:
         *
         *     Saved (0 assets)
         *
         * with no warning at all. Not a failed download, which is counted and
         * listed in the note; simply nothing found, and therefore nothing said. On
         * the notebook this came from, one attached PDF was missing from the vault
         * on every run while the note kept the text "PDF attached below".
         *
         * The assertions are on the *markdown*, because that is where the defect
         * was invisible: the summary's counts were all correct.
         */
        const { createMarkdownConverter } = require('../src/parser');

        let content;
        let markdown;
        let marked;

        beforeAll(async () => {
            await loadFixture('attachment-outside-outline.html');
            content = await getPageContent(page);
            markdown = createMarkdownConverter().turndown(content.contentHtml);
            marked = await page.evaluate(() => {
                const out = {};
                // The live elements, which is where the click markers are stamped.
                document.querySelectorAll('[data-one-attach-id]').forEach((el) => {
                    out[el.getAttribute('data-one-attach-id')] = (el.className || '').toString();
                });
                return out;
            });
        });

        itBrowser('scrapes the floating attachment at all', async () => {
            expect(content.attachments).toHaveLength(1);
            expect(content.attachments[0].originalName)
                .toBe('Affiche_Rappel_Melon_Charentais-2436220.pdf');
        });

        itBrowser('gives it a click marker, so it is not unfetchable forever', async () => {
            // The F-60 lesson applied to a new shape: an attachment with no marker
            // on a live element can never be downloaded, whatever the summary says.
            expect(Object.keys(marked)).toEqual(content.attachments.map((a) => a.id));
        });

        itBrowser('renders an embed for it in the note', async () => {
            expect(markdown).toContain('[[assets/file_0.pdf]]');
        });

        itBrowser('puts it between the two paragraphs that say where it belongs', async () => {
            // The author wrote "PDF attached below" above it and "PDF attached
            // above" below it, so reading order is not a guess here - it is the
            // note's own instruction. Appending at the end would produce a note
            // that contradicts itself.
            const below = markdown.indexOf('PDF attached below');
            const embed = markdown.indexOf('[[assets/file_0.pdf]]');
            const above = markdown.indexOf('PDF attached above');
            expect(below).toBeGreaterThan(-1);
            expect(embed).toBeGreaterThan(below);
            expect(above).toBeGreaterThan(embed);
        });

        itBrowser('leaves the title and the timestamp out of the body', async () => {
            // The floating attachment must not come through as a second title or a
            // second date: it is joined to the same ordered pass the outlines go
            // through, and those two are still handled as page metadata.
            expect(content.title).toBe('attachment_PDF');
            expect(content.dateTime).toBe('Saturday, October 03, 2026 3:26 PM');
            expect(markdown).not.toContain('attachment_PDF');
        });

        itBrowser('keeps every paragraph of the page', async () => {
            // A guard on the ordering work itself: sorting the body must not drop
            // or duplicate an outline to make room for the attachment.
            expect(markdown).toContain('We added file :');
            expect((markdown.match(/PDF attached below/g) || [])).toHaveLength(1);
            expect((markdown.match(/PDF attached above/g) || [])).toHaveLength(1);
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
