const { chromium } = require('playwright');
const fs = require('fs-extra');
const path = require('path');
const logger = require('./utils/logger');

/** Storage states for different tenants look the same; these keys must be present. */
const REQUIRED_KEYS = ['cookies', 'origins'];

/**
 * Checks that a file looks like a Playwright storageState before handing it to
 * the browser.
 *
 * The previous code only checked that the path existed, so a truncated download,
 * a stray HTML error page saved as auth.json, or a file from a different tool all
 * reached `browser.newContext()` and surfaced as an opaque Playwright error deep
 * in the stack. Worse, the browser had already been launched by then and was
 * never closed, leaking a Chromium process per attempt.
 *
 * @param {string} authFilePath - Path to the storageState JSON
 * @returns {Promise<{cookies: Array, origins: Array}>} The parsed state
 * @throws {Error} With an actionable message when the file is unusable
 */
async function readStorageState(authFilePath) {
    let raw;
    try {
        raw = await fs.readFile(authFilePath, 'utf8');
    } catch (e) {
        throw new Error(`Could not read the authentication file ${authFilePath}: ${e.message}`);
    }

    if (!raw.trim()) {
        throw new Error(
            `The authentication file ${authFilePath} is empty. ` +
            'Re-create it with microsoft-webauth.'
        );
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        // A login page saved instead of JSON is the most likely cause, so say so.
        const looksLikeHtml = /^\s*</.test(raw);
        throw new Error(
            `The authentication file ${authFilePath} is not valid JSON` +
            (looksLikeHtml ? ' - it starts with "<", so it looks like a saved web page rather than a storage state.' : '.') +
            ' Re-create it with microsoft-webauth.'
        );
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(
            `The authentication file ${authFilePath} does not contain a storage state object. ` +
            'Re-create it with microsoft-webauth.'
        );
    }

    const missing = REQUIRED_KEYS.filter((key) => !Array.isArray(parsed[key]));
    if (missing.length) {
        throw new Error(
            `The authentication file ${authFilePath} is missing ${missing.join(' and ')} ` +
            '(a Playwright storage state needs both). Re-create it with microsoft-webauth.'
        );
    }

    if (parsed.cookies.length === 0) {
        throw new Error(
            `The authentication file ${authFilePath} contains no cookies, so it carries no ` +
            'signed-in session. The login probably expired - re-create it with microsoft-webauth.'
        );
    }

    return parsed;
}

/**
 * Warns when a file granting full account access is readable by other users.
 *
 * Advisory only: refusing to run would be worse than warning, since a legitimate
 * export should not fail because of a file mode.
 *
 * @param {string} authFilePath - Path to the storage state
 */
function warnOnLoosePermissions(authFilePath) {
    if (process.platform === 'win32') return;
    try {
        const mode = fs.statSync(authFilePath).mode & 0o777;
        if (mode & 0o077) {
            logger.warn(
                `The authentication file ${authFilePath} is readable by other users ` +
                `(mode ${mode.toString(8).padStart(3, '0')}). It grants full account access; ` +
                `consider: chmod 600 ${path.basename(authFilePath)}`
            );
        }
    } catch (e) {
        // Permission introspection is best-effort.
    }
}

/**
 * Creates a Playwright browser context using authentication state from a file.
 *
 * The file is validated before the browser is launched, and the browser is closed
 * if context creation fails, so a bad auth file no longer leaves a Chromium
 * process behind.
 *
 * @param {string} authFilePath - Path to the auth.json file containing storageState
 * @param {boolean} headless - Whether to run browser in headless mode
 * @returns {Promise<{ browser: import('playwright').Browser, context: import('playwright').BrowserContext }>}
 */
async function getAuthenticatedContextWithFile(authFilePath, headless = true) {
    if (!authFilePath) {
        throw new Error('No authentication file was given. Pass --auth-file <path to auth.json>.');
    }

    if (!(await fs.pathExists(authFilePath))) {
        throw new Error(`Authentication file not found: ${authFilePath}`);
    }

    // Validate first: launching a browser only to reject the file wastes seconds
    // and, before this, leaked the process.
    await readStorageState(authFilePath);
    warnOnLoosePermissions(authFilePath);

    const browser = await chromium.launch({ headless });
    try {
        const context = await browser.newContext({ storageState: authFilePath });
        return { browser, context };
    } catch (e) {
        // newContext can still fail (a revoked session, a Playwright version
        // mismatch). Do not leave the browser running.
        try {
            await browser.close();
        } catch (closeError) {
            // Nothing useful to do if closing also fails.
        }
        throw new Error(`Could not open a browser context with ${authFilePath}: ${e.message}`);
    }
}

module.exports = { getAuthenticatedContextWithFile, readStorageState };
