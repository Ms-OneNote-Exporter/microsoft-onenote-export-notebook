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

module.exports = {
    FILE_EXTENSIONS,
    ATTACHMENT_NAME_FIELDS,
    fileExtensionPatternSource,
    fileExtensionPattern,
    looksLikeFileName,
    pickNameFromAttributes,
};
