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
});
