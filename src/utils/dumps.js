const fs = require('fs-extra');
const path = require('path');
const defaultLogger = require('./logger');

/**
 * How long a screenshot may take before it is given up on.
 *
 * A screenshot is diagnostics. It must never be the reason an export hangs, so
 * it gets a deadline of its own rather than Playwright's default (30s) plus a
 * retry that could double it.
 */
const SCREENSHOT_TIMEOUT_MS = 30000;

/**
 * Writes one HTML debug dump, and a PNG of the same screen next to it.
 *
 * Every `--dodump` site in the exporter goes through here, for two reasons that
 * are easy to get wrong when the call is repeated at each site:
 *
 *  - `--screenshot` is honoured in exactly one place, so "each HTML dump has a
 *    screenshot beside it" holds by construction rather than by remembering to
 *    add a second write;
 *  - the PNG is derived from the HTML's own base name (`debug_page_X.html` ->
 *    `debug_page_X.png`), so a dump and its screenshot can never drift apart.
 *
 * Playwright has `screenshot()` on a Page but not on a Frame, and most of these
 * dumps come from a Frame - the OneNote notebook is an iframe. So a frame dump is
 * screenshotted through the page that owns it, which is also the more useful
 * image: it shows the notebook as a user saw it, section list and canvas
 * together, rather than an isolated document fragment.
 *
 * Neither write can fail the export: dumps are diagnostics, and a full disk or a
 * tab that closed mid-run must not turn into a failed export. A failure is
 * reported and the run carries on.
 *
 * @param {import('playwright').Page|import('playwright').Frame|object} target
 *   The page or frame whose HTML is being dumped. Must have `content()`.
 * @param {string} baseName - File name without extension, e.g. `debug_page_Notes`
 * @param {object} [options] - Export options; honours `dodump` and `screenshot`
 * @param {object} [log] - Logger; defaults to the application logger
 * @returns {Promise<{html: string, screenshot: string|null}|null>} What was
 *   written, or null when `dodump` is off.
 */
async function writeDebugDump(target, baseName, options = {}, log = defaultLogger) {
    if (!options.dodump) return null;

    let dumpDir;
    try {
        dumpDir = await log.getDumpDir();
    } catch (e) {
        log.warn(`Could not create the dump directory, so ${baseName}.html was not written: ${e.message}`);
        return null;
    }

    const htmlPath = path.join(dumpDir, `${baseName}.html`);
    try {
        await writeDumpFile(htmlPath, await target.content());
    } catch (e) {
        log.warn(`Could not write ${baseName}.html: ${e.message}`);
        return null;
    }

    if (!options.screenshot) {
        return { html: htmlPath, screenshot: null };
    }

    const screenshotPath = path.join(dumpDir, `${baseName}.png`);
    try {
        await writeDumpFile(screenshotPath, await screenshotOf(target));
        log.warn(`Screenshot saved to ${displayDumpPath(log, screenshotPath)}`);
    } catch (e) {
        // The HTML is already on disk, so the run is not lost - but say plainly
        // that the image is missing, or a bug report sent with "the screenshot
        // is blank/absent" has nothing to work with.
        log.warn(
            `Could not screenshot ${baseName} (${e.message}). ` +
            'The HTML dump was still written; the export continues.'
        );
        return { html: htmlPath, screenshot: null };
    }

    return { html: htmlPath, screenshot: screenshotPath };
}

/**
 * The page that owns `target`, which is what can actually take a screenshot.
 *
 * A Playwright Frame has `page()` and no `screenshot()`; a Page is the other way
 * round. `NotebookSession` (the exporter's frame proxy, src/notebookFrame.js)
 * answers `page()` too, and resolves it to the live frame's owner rather than to
 * a stale reference, which is what makes this work after OneNote replaces its
 * frame mid-run.
 *
 * `page()` is therefore asked FIRST, and that order is the fix rather than a
 * style preference. The session's proxy forwards *any* property it does not
 * implement as a method call (see notebookFrame.js), so asking a session for
 * `screenshot` returns a function - the frame behind it has no screenshot of its
 * own to call. Sniffing for `screenshot` first therefore reported the session as
 * "already a page", and the capture then went through the session's forwarding to
 * a method that does not exist on a Frame and resolved to `undefined`.
 *
 * That failure was silent and total. Every `--dodump` site in processSections
 * passes the session rather than a Frame (src/exporter.js), so every page and
 * group dump wrote its HTML and then failed its PNG with an
 * `fs.writeFile(path, undefined)` TypeError swallowed into a per-page warning. A
 * real run on 2026-10-03 (`--dodump --screenshot`) produced 30 HTML dumps and 2
 * PNGs - the two whose targets were a real Page and a real Frame, which is exactly
 * the pair this function can tell apart. Only `page()` survives the proxy: a Page
 * has no `page()` method at all, so asking costs nothing and cannot misfire.
 *
 * @param {object} target
 * @returns {import('playwright').Page|null}
 */
function ownerPageOf(target) {
    if (!target) return null;

    // Frame-shaped, and the exporter's session with it.
    if (typeof target.page === 'function') {
        let owner = null;
        try {
            owner = target.page();
        } catch (e) {
            // Asking a dead frame for its page throws; the caller turns this into
            // a warning, which is the honest outcome.
            return null;
        }
        // A Frame that names no page is detached, and a session with no page has
        // nothing to capture either. Falling through to the checks below would
        // only re-classify the session as a Page it is not.
        return owner || null;
    }

    // No page(): it can only be a Page, which can screenshot itself.
    if (typeof target.screenshot === 'function') return target;

    return null;
}

/**
 * Captures the viewport of the page showing `target`.
 *
 * Viewport rather than `fullPage`: the OneNote editor is a virtual canvas that
 * can be tens of thousands of pixels tall, and a full-page capture of one is
 * large enough to be useless and slow enough to matter on a long export. What a
 * bug report needs is what the screen looked like at the moment of the dump.
 *
 * @param {object} target
 * @returns {Promise<Buffer>}
 */
async function screenshotOf(target) {
    const page = ownerPageOf(target);
    if (!page) {
        throw new Error('no page is available to screenshot (the frame may have been detached)');
    }

    if (typeof page.screenshot !== 'function') {
        // The resolution above can still land on something that cannot capture
        // itself. Name it, rather than letting `page.screenshot is not a function`
        // stand as the whole explanation.
        throw new Error(
            `${describeTarget(page)} has no screenshot() of its own - only a page can be ` +
            'captured, so a frame has to be captured through the page that owns it'
        );
    }

    const image = await page.screenshot({ fullPage: false, timeout: SCREENSHOT_TIMEOUT_MS });

    // A successful capture is image bytes. Anything else means the object asked was
    // not really a page that can screenshot itself - and the proxy is exactly that
    // trap, answering "yes" to a screenshot() feature check it cannot honour. Saying
    // so here names the cause, where letting it through turned every failure into an
    // `fs.writeFile` TypeError about a "data" argument, which says nothing about the
    // notebook and nothing about the code.
    if (!Buffer.isBuffer(image) || image.length === 0) {
        throw new Error(
            `the capture returned ${image === undefined ? 'no image data' : 'an unusable result'} ` +
            `instead of image data, so ${describeTarget(page)} cannot be screenshotted`
        );
    }

    return image;
}

/**
 * What `target` is, for an error message.
 *
 * Names the class, so the warning can be traced to the code that handed in the
 * wrong kind of object: `NotebookSession` in a screenshot message *is* the whole
 * diagnosis. A plain object says nothing, so it is not dressed up as a name.
 *
 * @param {object} target
 * @returns {string}
 */
function describeTarget(target) {
    const name = target && target.constructor && target.constructor.name;
    const generic = !name || name === 'Object' || name === 'Function';
    return generic ? 'the target' : `the ${name}`;
}

/**
 * Writes a dump file owner-only, and tightens it if it already existed.
 *
 * `mode` on writeFile only applies at creation, so a dump whose name was reused
 * by an earlier run (the dump directory is per-minute, so this does happen)
 * would keep whatever permissions it had. F-48 established that these files
 * carry the authenticated DOM of a real notebook, so they are 0600 like app.log.
 *
 * @param {string} filePath
 * @param {string|Buffer} data
 * @returns {Promise<void>}
 */
async function writeDumpFile(filePath, data) {
    await fs.writeFile(filePath, data, { mode: 0o600 });
    try {
        await fs.chmod(filePath, 0o600);
    } catch (e) {
        // A filesystem without POSIX permissions is not a reason to fail.
    }
}

/**
 * A relative path for the log line, so it is readable on the user's machine.
 * @param {object} log
 * @param {string} filePath
 * @returns {string}
 */
function displayDumpPath(log, filePath) {
    try {
        const dir = log.getDumpDisplayPath();
        return dir ? path.join(dir, path.basename(filePath)) : filePath;
    } catch (e) {
        return filePath;
    }
}

module.exports = {
    writeDebugDump,
    // Exported for tests: the target resolution is the part that is easy to get
    // wrong (a Frame has no screenshot of its own), and it is pure.
    ownerPageOf,
    SCREENSHOT_TIMEOUT_MS
};