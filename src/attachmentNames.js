/**
 * Which strings count as filenames, and in what order a name is chosen.
 *
 * F-23. The extension list was written out three times inside one
 * `frame.evaluate()` callback, in the same file, with the same 19 alternatives.
 * Three copies is three chances for the lists to drift, and nothing tested any of
 * them: a rule this central to deciding what is an attachment was only ever
 * exercised by running an export.
 *
 * The duplication could not simply be deleted by moving this into a module,
 * because the code that uses it runs inside a callback Playwright serialises and
 * executes in the *browser*. A `require` there throws. So the list lives here, in
 * Node, is tested here, and reaches the page as a regex *source string* - the one
 * form of a regex that survives the trip - which the page rebuilds with
 * `new RegExp(source, 'i')`.
 *
 * That is a real constraint with a real cost: the list is testable, and the code
 * that rebuilds it in the page is three characters long and covered by the
 * fixture tests. The alternative - injecting the functions themselves as source
 * text and building them with `new Function` in the page - would make the logic
 * itself testable in Node, at the cost of running `eval` against a Microsoft
 * login page, which is not a trade worth making for a filename heuristic.
 */

/**
 * The file extensions OneNote attachments are recognised by.
 *
 * Chosen from what the scraper has actually seen, not from a general-purpose list:
 * a missing extension means an attachment is treated as a hyperlink and silently
 * not downloaded, while a spurious one means a hyperlink is treated as a file and
 * downloaded to no purpose. The two directions are not equally bad, which is why
 * the list errs towards recognition.
 *
 * `doc`/`docx`, `xls`/`xlsx` and `ppt`/`pptx` are both included rather than only
 * the modern ones - OneNote accepts either and a note from 2007 has the old one.
 *
 * **Audio and video were missing entirely** (F-70), which is the exact failure
 * this paragraph warns about. It did not stop the files being downloaded - an
 * attachment *chip* is recognised by its `WACEF*` class names whatever its
 * extension - so the damage was quieter and further down: the name had to pass
 * this list to be believed, so an `.mp4` and an `.mp3` were both written as
 * `assets/attached_file.bin`, and the note linked to that placeholder instead of
 * to the name OneNote was showing on the same line:
 *
 *     We added file : "Alerte-au-gogole_480p.mp4" as attachment
 *     [[assets/attached_file.bin]]
 *
 * One extension list therefore decides three separate things - whether something
 * counts as a file, what it is called, and what the note links to - and a gap in
 * it shows up in all three at once. Adding a type here also makes a plain
 * hyperlink to a file of that type count as an attachment rather than stay a
 * link, which is the direction this list is supposed to err in.
 */
const FILE_EXTENSIONS = [
    'doc', 'docx',
    'xls', 'xlsx',
    'ppt', 'pptx',
    'pdf', 'txt', 'md', 'csv',
    'zip', 'rar', '7z',
    'json', 'xml', 'log',
    'png', 'jpg', 'jpeg', 'gif', 'svg',
    // Audio. WebM is also a video container, and is listed with both because
    // OneNote accepts it in either role.
    'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'wma', 'aiff', 'amr',
    // Video.
    'mp4', 'm4v', 'mov', 'avi', 'wmv', 'mkv', 'webm', 'flv', '3gp', 'mpeg', 'mpg',
];

/**
 * The source of a regex that recognises a filename with one of those extensions.
 *
 * The trailing `(\?|&|$)` is what makes it strict. Without it, a truncated
 * OneNote label ending in a partial token - "...6P4" - can match, and the
 * scraper then believes it has a filename when it has three characters of one.
 * A filename only counts when the extension ends at a real boundary.
 *
 * Exported as source rather than as a RegExp because the page has to rebuild it,
 * and a RegExp is not serialisable across the evaluate boundary. Building the
 * string from the list is what guarantees the three former copies now share one
 * definition; the escaping is deliberately minimal because the list is composed
 * of literals and dots, and an unescaped `.` here is intentional - it is the
 * "any character" that lets `report.pdf.xlsx` match on the last extension.
 *
 * @returns {string} Source text for `new RegExp(source, 'i')`
 */
function fileExtensionPatternSource() {
    const alternatives = FILE_EXTENSIONS
        .map((ext) => ext.replace(/\./g, '\\.'))
        .join('|');
    return `\\.(?:${alternatives})(\\?|&|$)`;
}

/**
 * A ready-made matcher, for use in Node.
 *
 * The page builds its own from `fileExtensionPatternSource()`; this is the same
 * pattern as a RegExp for the tests and for anything on this side of the
 * boundary.
 *
 * @returns {RegExp} A fresh, case-insensitive filename matcher
 */
function fileExtensionPattern() {
    return new RegExp(fileExtensionPatternSource(), 'i');
}

/**
 * Whether a string looks like a filename with a known extension.
 *
 * @param {string} value - The candidate
 * @returns {boolean} True when a known extension ends at a real boundary
 */
function looksLikeFileName(value, pattern = fileExtensionPattern()) {
    return typeof value === 'string' && pattern.test(value);
}

/**
 * The order the visible attributes are consulted in.
 *
 * OneNote truncates link text aggressively - a long filename arrives as
 * "Complete_Paris_9th_Ar…" in the text while the full name sits in `title` or
 * `aria-label` - so the attributes that hold the whole string are tried before
 * the text that usually does not. The list is data rather than a sequence of
 * `if` statements so the preference can be read, and tested, as a preference.
 *
 * @type {string[]}
 */
const ATTACHMENT_NAME_FIELDS = ['title', 'ariaLabel', 'text'];

/**
 * Picks the best filename from the visible attributes of a candidate.
 *
 * Only the first line of `text` is considered. OneNote's rendered text for a
 * file includes the name, the size and the modified date on separate lines, and
 * "report.pdf 1.2 MB 3 Sep" is not a filename.
 *
 * @param {object} candidate - `{ title, ariaLabel, text }` from the DOM
 * @param {RegExp} [pattern] - A filename matcher
 * @returns {string} The chosen name, or '' when none of them looks like one
 */
function pickNameFromAttributes(candidate, pattern = fileExtensionPattern()) {
    for (const field of ATTACHMENT_NAME_FIELDS) {
        const value = (candidate[field] || '').split('\n')[0].trim();
        if (looksLikeFileName(value, pattern)) return value;
    }
    return '';
}

/**
 * The image formats this tool can name, keyed by the bytes that identify them.
 *
 * F-49. Images used to be written `.png` whatever they actually were, so a GIF in a
 * note became a file called `…_img_1.png` holding GIF data: the extension lied, and
 * anything that trusted it - a viewer, a converter, a search - had to sniff the file
 * itself to find out.
 *
 * Magic bytes rather than the URL or the response's content-type. A OneNote image
 * usually arrives through `getimage.ashx`, which carries no extension at all, and the
 * content-type is whatever the endpoint felt like returning - so the bytes are the
 * only thing here that is actually evidence.
 *
 * Ordered longest-match-first within each entry, and deliberately a *small* set: an
 * unrecognised image keeps the `.png` it has always had, which is a wrong name for an
 * exotic format but not a broken one. Obsidian renders by content anyway.
 */
const IMAGE_SIGNATURES = [
    { ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
    { ext: 'gif', ascii: 'GIF8' },
    { ext: 'bmp', bytes: [0x42, 0x4d] },
    { ext: 'tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
    { ext: 'tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
    { ext: 'ico', bytes: [0x00, 0x00, 0x01, 0x00] },
    // RIFF....WEBP - the format is at offset 8, not the start.
    { ext: 'webp', ascii: 'WEBP', offset: 8 },
    // ISO base media: ....ftyp<brand>
    { ext: 'avif', ascii: 'ftypavif', offset: 4 },
    { ext: 'heic', ascii: 'ftypheic', offset: 4 }
];

/**
 * The extension an image's own bytes say it has.
 *
 * @param {Buffer} bytes - The start of the file, at least 16 bytes
 * @returns {string|null} Extension without the dot, or null when unrecognised
 */
function imageExtensionFromBytes(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 4) return null;

    for (const sig of IMAGE_SIGNATURES) {
        const at = sig.offset || 0;
        // An entry is matched by bytes, by ascii, or by both - so the length that
        // matters is whichever it has. Reading `.length` off the wrong one throws
        // rather than falling through to the next format.
        const need = sig.bytes ? sig.bytes.length : sig.ascii.length;
        if (bytes.length < at + need) continue;
        if (sig.bytes && sig.bytes.every((b, i) => bytes[at + i] === b)) return sig.ext;
        if (sig.ascii && bytes.slice(at, at + sig.ascii.length).toString('latin1') === sig.ascii) return sig.ext;
    }

    // SVG is text, so it has no signature to compare against - but it does have a
    // document element, and reading the first few bytes is enough to find one.
    const head = bytes.slice(0, 200).toString('utf8').trimStart();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';

    return null;
}

module.exports = {
    FILE_EXTENSIONS,
    ATTACHMENT_NAME_FIELDS,
    fileExtensionPatternSource,
    fileExtensionPattern,
    looksLikeFileName,
    imageExtensionFromBytes,
    pickNameFromAttributes,
};
