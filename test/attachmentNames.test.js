/**
 * F-23: which strings count as filenames, and in what order a name is chosen.
 *
 * The 19-extension list was written out three times inside one evaluate()
 * callback. Three copies is three chances to drift, and nothing tested any of
 * them - a rule this central to deciding what gets downloaded was only ever
 * exercised by running an export.
 *
 * These tests cover the list and the preference order. The code that *uses* them
 * runs in the browser and is covered by the fixture tests in
 * scrapers.fixture.test.js, which drive the real scraper against captured
 * OneNote markup.
 */
const {
    FILE_EXTENSIONS,
    ATTACHMENT_NAME_FIELDS,
    fileExtensionPatternSource,
    fileExtensionPattern,
    looksLikeFileName,
    pickNameFromAttributes,
} = require('../src/attachmentNames');

describe('the extension list', () => {
    it('recognises the formats OneNote attachments actually arrive in', () => {
        const pattern = fileExtensionPattern();

        for (const name of ['report.pdf', 'notes.docx', 'old.doc', 'sheet.xlsx',
            'old.xls', 'deck.pptx', 'old.ppt', 'data.csv', 'log.log', 'config.json',
            'tree.xml', 'readme.md', 'notes.txt', 'bundle.zip', 'old.7z', 'a.svg']) {
            expect(looksLikeFileName(name, pattern)).toBe(true);
        }
    });

    it('accepts the old Office formats, not only the modern ones', () => {
        // A note from 2007 carries .doc/.xls/.ppt, and a list with only the
        // modern extensions would treat those attachments as hyperlinks and
        // silently not download them.
        const pattern = fileExtensionPattern();

        expect(FILE_EXTENSIONS).toEqual(expect.arrayContaining(['doc', 'xls', 'ppt']));
        expect(looksLikeFileName('memo.doc', pattern)).toBe(true);
        expect(looksLikeFileName('sheet.xls', pattern)).toBe(true);
    });

    it('recognises audio and video, which used to be missing entirely (F-70)', () => {
        // The omission did not stop these files being downloaded - a chip is
        // recognised by its WACEF* class names whatever its extension - so the
        // damage was quieter and further down: the name had to pass this list to be
        // believed, so an .mp4 and an .mp3 were written as `attached_file.bin` and
        // the notes linked to that.
        //
        // Audio and video are asserted separately because a list that learns one
        // family and forgets the other is exactly how this happened: .docx was
        // added once (F-23) and audio never was.
        const pattern = fileExtensionPattern();

        for (const name of ['clip.mp3', 'voice.wav', 'memo.m4a', 'song.aac',
            'take.flac', 'sound.ogg', 'clip.wma']) {
            expect(looksLikeFileName(name, pattern)).toBe(true);
        }
        for (const name of ['clip.mp4', 'clip.mov', 'clip.avi', 'clip.mkv',
            'clip.webm', 'clip.m4v', 'clip.wmv']) {
            expect(looksLikeFileName(name, pattern)).toBe(true);
        }
    });

    it('still refuses a truncated media label, now that media are on the list', () => {
        // The strict trailing boundary earns its keep precisely when the list gets
        // longer: OneNote truncates long labels, and "....mp" from a cut video name
        // must not read as a filename.
        const pattern = fileExtensionPattern();

        expect(looksLikeFileName('Sample_Video_480p...mp', pattern)).toBe(false);
        expect(looksLikeFileName('a page in my notebook', pattern)).toBe(false);
    });

    it('rejects a string with no known extension', () => {
        const pattern = fileExtensionPattern();

        expect(looksLikeFileName('a page in my notebook', pattern)).toBe(false);
        expect(looksLikeFileName('https://example.invalid/section', pattern)).toBe(false);
    });

    // The reason the pattern ends with (\?|&|$) rather than a bare \b.
    it('does not accept a truncated token as an extension', () => {
        const pattern = fileExtensionPattern();

        // OneNote truncates long labels, and a naive "anything ending in a known
        // extension" match reads this as a filename.
        expect(looksLikeFileName('Complete_Paris_9th_...6P4', pattern)).toBe(false);
    });

    it('accepts an extension that ends at a real boundary', () => {
        const pattern = fileExtensionPattern();

        expect(looksLikeFileName('report.pdf', pattern)).toBe(true);
        expect(looksLikeFileName('report.pdf?web=1', pattern)).toBe(true);
        expect(looksLikeFileName('Doc2.aspx?file=a.docx', pattern)).toBe(true);
    });

    it('matches on the last extension of a doubled one', () => {
        // file.pdf.xlsx is a real SharePoint shape, and the name is the xlsx.
        const pattern = fileExtensionPattern();
        expect(looksLikeFileName('file.pdf.xlsx', pattern)).toBe(true);
    });

    it('is case-insensitive, as URLs and labels are', () => {
        const pattern = fileExtensionPattern();

        expect(looksLikeFileName('REPORT.PDF', pattern)).toBe(true);
    });

    it('is a fresh RegExp each time, so no caller can poison the next', () => {
        const first = fileExtensionPattern();
        first.lastIndex = 0;

        // A shared /g regex would carry lastIndex between callers; a stale one
        // would make the scraper miss every other attachment.
        expect(fileExtensionPattern()).not.toBe(first);
    });
});

describe('the pattern reaches the page intact', () => {
    // The list lives in Node and is handed to the browser callback as a source
    // string, because that is the only part of a regex that survives the trip
    // across Playwright's evaluate boundary.
    it('produces a source string that rebuilds an equivalent regex', () => {
        const source = fileExtensionPatternSource();
        const rebuilt = new RegExp(source, 'i');

        expect(rebuilt.test('report.pdf')).toBe(true);
        expect(rebuilt.test('sheet.xlsx?web=1')).toBe(true);
        expect(rebuilt.test('not a file')).toBe(false);
    });

    // Tested by what it would let through, not by counting characters: the dot in
    // the pattern has to mean a literal "." and not "any character".
    it('requires a literal dot, not any character', () => {
        const rebuilt = new RegExp(fileExtensionPatternSource(), 'i');

        expect(rebuilt.test('report.pdf')).toBe(true);
        // If the dot were unescaped this would match, and a note containing
        // "reportXpdf" anywhere would be scraped as a file.
        expect(rebuilt.test('reportXpdf')).toBe(false);
    });

    it('contains no unescaped dot beyond the one the builder adds', () => {
        // The leading `\.` is the only dot the pattern should contain: every
        // entry in FILE_EXTENSIONS is a bare word, and the builder escapes any
        // dot in an entry so a future "tar.gz" cannot match "tarXgz".
        const source = fileExtensionPatternSource();
        const dots = source.match(/\./g) || [];

        expect(dots).toHaveLength(1);
    });

    it('has no unescaped alternation bug when a list entry were a prefix', () => {
        // "doc" must not match inside "docx" as a separate alternative; the outer
        // group and the boundary requirement are what keep the alternatives whole.
        const source = fileExtensionPatternSource();
        expect(source.startsWith('\\.(?:')).toBe(true);
        expect(source.endsWith('(\\?|&|$)')).toBe(true);
    });
});

describe('picking a name from the visible attributes', () => {
    // OneNote truncates link text hard, so the full name lives in title or
    // aria-label while the text is the thing that got cut.
    it('prefers the title over the truncated text', () => {
        const chosen = pickNameFromAttributes({
            title: 'Complete_Paris_9th_Arrondissement_Guide.docx',
            ariaLabel: '',
            text: 'Complete_Paris_9th_...',
        });

        expect(chosen).toBe('Complete_Paris_9th_Arrondissement_Guide.docx');
    });

    it('falls back to the aria-label when the title is empty', () => {
        const chosen = pickNameFromAttributes({
            title: '',
            ariaLabel: 'attached_file.bin.pdf',
            text: 'a file',
        });

        expect(chosen).toBe('attached_file.bin.pdf');
    });

    it('uses the text only as a last resort', () => {
        const chosen = pickNameFromAttributes({
            title: 'a title with no extension',
            ariaLabel: 'also nothing here',
            text: 'report.pdf',
        });

        expect(chosen).toBe('report.pdf');
    });

    // OneNote renders a file's text as "report.pdf 1.2 MB 3 Sep" across lines.
    it('takes only the first line of the text', () => {
        const chosen = pickNameFromAttributes({
            title: '',
            ariaLabel: '',
            text: 'report.pdf\n1.2 MB\n3 Sep 2026',
        });

        expect(chosen).toBe('report.pdf');
    });

    it('returns empty when nothing looks like a filename', () => {
        const chosen = pickNameFromAttributes({
            title: 'A section of my notebook',
            ariaLabel: 'Page 3 of 7',
            text: 'Click here to continue',
        });

        expect(chosen).toBe('');
    });

    it('tolerates missing fields rather than throwing', () => {
        // The DOM attributes are read with `|| ''` in the page, but a caller
        // using this directly should not have to know that.
        expect(pickNameFromAttributes({})).toBe('');
        expect(pickNameFromAttributes({ title: null, ariaLabel: undefined, text: '' })).toBe('');
    });

    it('exposes the preference order as data, not as control flow', () => {
        // Readable and testable as a preference, which is the point of lifting it
        // out of a chain of ifs.
        expect(ATTACHMENT_NAME_FIELDS).toEqual(['title', 'ariaLabel', 'text']);
    });
});

describe('the list is defined once', () => {
    const fs = require('fs-extra');
    const path = require('path');

    it('no longer appears written out in the scrapers', () => {
        // The regression this finding was about: three copies of the same 19
        // alternatives, in one file, with nothing keeping them equal.
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'scrapers.js'),
            'utf8'
        );

        const writtenOut = source
            .split('\n')
            .filter((line) => /docx\?\|xlsx\?/.test(line));

        expect(writtenOut).toEqual([]);
    });

    it('gets its pattern from the module rather than a local regex', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'scrapers.js'),
            'utf8'
        );

        expect(source).toMatch(/fileExtensionPatternSource\(\)/);
        expect(source).toMatch(/ATTACHMENT_NAME_FIELDS/);
    });
});
