const sanitize = require('sanitize-filename');

/**
 * Sanitises a OneNote name for use as a file or directory name, guaranteeing a
 * non-empty result.
 *
 * `sanitize-filename` legitimately returns '' for names made up entirely of
 * illegal characters or Windows-reserved words ('...', '..', '   ', 'CON').
 * `path.join(outputDir, '')` is just `outputDir`, so without a fallback such a
 * section would be written into its parent's directory and interleave with its
 * siblings; a page in that state would be written to a file named '.md'.
 *
 * @param {string} name - Raw name from OneNote
 * @param {string} fallback - Name to use when nothing usable survives
 * @returns {string} A non-empty, path-safe name
 */
function safeName(name, fallback) {
    const cleaned = sanitize(String(name ?? '').trim()).trim();
    return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Returns `name` with a ` (2)`, ` (3)`, ... suffix until it is not in `used`.
 * Mutates `used`, so each call site keeps one Set per directory for the whole
 * export and two sections that sanitise to the same string stop sharing a
 * directory.
 *
 * @param {string} name - Desired name
 * @param {Set<string>} used - Names already taken in this directory
 * @returns {string} A name not present in `used`
 */
function uniqueName(name, used) {
    if (!used.has(name)) {
        used.add(name);
        return name;
    }
    let counter = 2;
    while (used.has(`${name} (${counter})`)) {
        counter++;
    }
    const result = `${name} (${counter})`;
    used.add(result);
    return result;
}

module.exports = { safeName, uniqueName };
