const { createMarkdownConverter } = require('../src/parser');

/**
 * Tests for the Turndown rules in src/parser.js.
 *
 * These run without a browser: Turndown parses the HTML string in Node via
 * @mixmark-io/domino, so the rules can be exercised directly. The HTML used here
 * is the shape src/scrapers.js actually emits - in particular the custom
 * data-local-* attributes it stamps onto the cloned outlines before handing
 * `contentHtml` to the converter.
 */
describe('createMarkdownConverter', () => {
    let td;
    beforeEach(() => {
        td = createMarkdownConverter();
    });

    describe('local images (F-27: alt text is discarded)', () => {
        it('emits an Obsidian embed for a downloaded image', () => {
            const html = '<img data-local-src="Note_img_1" alt="a chart">';
            expect(td.turndown(html)).toBe('![[assets/Note_img_1.png]]');
        });
    });

    describe('local videos (F-24: extension was hardcoded to .mp4)', () => {
        // exporter.js derives the extension from the video URL and rewrites this
        // attribute to the final file name, extension included, so the rule must
        // use the name as-is. Anything else left a dead link for every non-mp4.
        it('uses the extension the exporter actually wrote', () => {
            const html = '<video data-local-video="Note_video_1.mov" src="https://h/clip.mov"></video>';
            expect(td.turndown(html)).toBe('![[assets/Note_video_1.mov]]');
        });

        it('still defaults to mp4 when no extension is advertised', () => {
            const html = '<video data-local-video="Note_video_1" src="https://h/clip"></video>';
            expect(td.turndown(html)).toBe('![[assets/Note_video_1.mp4]]');
        });
    });

    describe('tables (F-25: an unescaped | corrupted the table)', () => {
        // A one-cell row is `| content |`: exactly two UNESCAPED pipes, whatever
        // the cell text contains. Counting unescaped pipes is therefore the
        // precise way to prove a cell's pipes did not become cell delimiters.
        const unescapedPipes = (row) => (row.match(/(?<!\\)\|/g) || []).length;

        it('escapes a pipe inside a cell instead of adding a column', () => {
            const html = '<table><tr><th>H</th></tr><tr><td>a | b</td></tr></table>';
            const md = td.turndown(html);
            expect(md).toContain('| a \\| b |');
            const row = md.split('\n').find((l) => l.includes('a'));
            expect(unescapedPipes(row)).toBe(2);
        });

        it('escapes each pipe in a cell containing two of them', () => {
            // Common in notes that quote shell pipelines or markdown tables.
            const html = '<table><tr><th>H</th></tr><tr><td>a || b</td></tr></table>';
            const md = td.turndown(html);
            const row = md.split('\n').find((l) => l.includes('a'));
            expect(unescapedPipes(row)).toBe(2);
        });

        it('keeps a real second cell as a real second cell', () => {
            const html = '<table><tr><th>H</th></tr><tr><td>a | b</td><td>c</td></tr></table>';
            const md = td.turndown(html);
            const row = md.split('\n').find((l) => l.includes('a'));
            // leading + one real separator + trailing
            expect(unescapedPipes(row)).toBe(3);
        });

        it('flattens newlines inside a cell', () => {
            const html = '<table><tr><th>H</th></tr><tr><td>one<br>two</td></tr></table>';
            expect(td.turndown(html)).toContain('| one two |');
        });
    });

    describe('internal links (F-26: text-less links become [[]])', () => {
        it('marks a link for post-processing', () => {
            const html = '<a data-internal-link="link_0" href="onenote:X.one#Page">See this</a>';
            expect(td.turndown(html)).toBe('[[See this]]<!-- onenote-link:link_0 -->');
        });

        it('leaves a resolvable placeholder even when the link has no text', () => {
            // The resolver turns this into [[path|text]]; with empty text the
            // alias would be empty, so the link must fall back to its href.
            const html = '<a data-internal-link="link_0" href="onenote:X.one#Page"></a>';
            const md = td.turndown(html);
            expect(md).not.toBe('[[]]');
            expect(md).toContain('<!-- onenote-link:link_0 -->');
        });
    });

    describe('file attachments', () => {
        it('links a file whose name already carries an extension', () => {
            const html = '<a data-local-file="report.pdf" data-filename="report.pdf">report</a>';
            expect(td.turndown(html)).toBe('[[assets/report.pdf]]');
        });

        it('appends the extension from data-filename when the local name lacks one', () => {
            const html = '<a data-local-file="report" data-filename="report.docx">report</a>';
            expect(td.turndown(html)).toBe('[[assets/report.docx]]');
        });
    });

    describe('embeds', () => {
        it('converts a YouTube embed back to a watch URL', () => {
            const html = '<iframe data-embed-id="embed_0" src="https://www.youtube.com/embed/abc123"></iframe>';
            expect(td.turndown(html)).toContain('https://www.youtube.com/watch?v=abc123');
        });

        it('converts a Vimeo embed back to a watch URL', () => {
            const html = '<iframe data-embed-id="embed_0" src="https://player.vimeo.com/video/999"></iframe>';
            expect(td.turndown(html)).toContain('https://vimeo.com/999');
        });
    });

    describe('OneNote table furniture', () => {
        it('drops table hover/resize chrome', () => {
            const html = '<div class="TableColumnResizeHandle"></div><p>kept</p>';
            const md = td.turndown(html);
            expect(md).not.toContain('TableColumnResizeHandle');
            expect(md).toContain('kept');
        });
    });

    // The DOM below is the shape `debug_page_Prevent BYOD with Intune.html` holds,
    // copied out of the capture: a `ListMarker` span inside the `ul > li`, carrying
    // the glyph OneNote draws. That is the real thing, not a simplification of it.
    const listItem = (glyph, text) =>
        `<p class="Paragraph">` +
        `<span class="ListMarkerWrappingSpan"><span class="ListMarker" aria-hidden="true">${glyph}</span></span>` +
        `<span class="TextRun"><span class="NormalTextRun">${text}</span></span>` +
        `<span class="EOP">&nbsp;</span></p>`;

    const bulletList = (glyph, text, nested = '') =>
        `<ul class="BulletListStyle1" role="list"><li role="listitem" class="OutlineElement Ltr">` +
        `<div class="ParaWrappingDiv">${listItem(glyph, text)}</div>${nested}</li></ul>`;

    describe('the bullet OneNote draws itself (the `* ○Here we block BYOD` defect)', () => {
        // OneNote stores the bullet glyph as text inside a `ListMarker` span, in the
        // same `li` that Turndown renders as a Markdown list item. Turning down that
        // `li` yields `*   `, and the glyph yields `○`, so the item reached the vault
        // with both: Obsidian drew a bullet and then a stray circle glued to the
        // first word. The note was structurally correct and visually wrong, which is
        // why nothing failed and nothing said so.

        it('keeps the Markdown list item and drops the glyph', () => {
            const md = td.turndown(bulletList('○', 'Here we block BYOD'));
            expect(md.trim()).toBe('*   Here we block BYOD');
        });

        it('drops every bullet glyph OneNote uses, not just this one', () => {
            // The two the Redmo page uses, plus the other glyphs OneNote's bullet
            // styles are built from. A rule that only knew `○` would leave the rest
            // of the notebook broken in exactly the same way.
            for (const glyph of ['•', '○', '▪', '■', '☐', '☒', '✔', 'o', '§']) {
                expect(td.turndown(bulletList(glyph, 'Item')).trim())
                    .toBe('*   Item');
            }
        });

        it('keeps the nesting, so the level is still a level', () => {
            // The page nests three deep. Dropping the glyph must not flatten the
            // list into its top level - indentation is structure too, and a rule
            // that reached in and unwrapped the `li` would lose it.
            const html = bulletList('•', 'Device enrollment restrictions',
                bulletList('○', 'Here we block BYOD'));
            const md = td.turndown(html);
            const lines = md.split('\n').filter((l) => l.trim().startsWith('*'));

            expect(lines).toHaveLength(2);
            expect(lines[0].match(/^\s*/)[0].length)
                .toBeLessThan(lines[1].match(/^\s*/)[0].length);
        });

        it('leaves the item text alone', () => {
            // The defect was the glyph, not the words. Anything that trims or
            // reflows the text alongside it would trade one bug for another.
            const md = td.turndown(bulletList('•', 'IMEI (for android) that are allowed to enroll'));
            expect(md).toContain('IMEI (for android) that are allowed to enroll');
        });

        it('keeps a marker that is not in a list, because there is nothing else', () => {
            // OneNote marks some outline items without the surrounding `li`. There
            // the glyph is the only trace that the line was an item at all, so
            // dropping it would delete content rather than decoration.
            const html = '<p><span class="ListMarker">○</span><span class="TextRun">Bare</span></p>';
            expect(td.turndown(html)).toContain('○');
        });

        it('keeps a number that only the marker carries', () => {
            // Turndown renders a `ul` as `*` whatever the marker says, so for a
            // numbered list marked up as a `ul` the glyph is the ONLY trace of the
            // numbering. Dropping it would turn 1/2/3 into three identical bullets -
            // a worse defect than the one this rule exists to remove. The space is
            // added here because the DOM has none: the marker and the text are
            // adjacent spans, so the untouched output is `1.First`.
            expect(td.turndown(bulletList('1.', 'First')).trim()).toBe('*   1. First');
            expect(td.turndown(bulletList('iv)', 'Fourth')).trim()).toBe('*   iv) Fourth');
        });

        it('drops a number in an `ol`, which renders its own', () => {
            // The mirror of the case above, and the reason the rule checks the
            // parent rather than only the glyph: here Turndown produces `1.` from
            // the `ol` itself, so the marker's `1.` is a duplicate.
            const html = '<ol><li><p>' +
                '<span class="ListMarkerWrappingSpan"><span class="ListMarker">1.</span></span>' +
                '<span class="TextRun">First</span></p></li></ol>';
            const md = td.turndown(html);
            expect(md).toMatch(/1\.\s+First/);
            expect(md.replace(/1\.\s+First/, '')).not.toContain('1.');
        });

        it('leaves a typed-in circle in the text, which is not a marker', () => {
            // A user who writes "○ check this" in a plain paragraph means the
            // character. Only the `ListMarker` span is the renderer talking.
            const html = '<p><span class="TextRun">○ check this</span></p>';
            expect(td.turndown(html)).toContain('○ check this');
        });
    });
});
