const fs = require('fs-extra');
const os = require('os');
const path = require('path');

/**
 * F-40: the auth file was only checked for existence.
 *
 * A truncated file, a saved HTML login page, or a file from another tool all
 * reached browser.newContext() and came back as an opaque Playwright error - after
 * the browser had been launched, which was then never closed, leaking a Chromium
 * process per attempt.
 *
 * playwright is mocked so the validation can be tested without launching a real
 * browser, and so "was the browser closed on failure?" is directly observable.
 */
jest.mock('playwright', () => ({
    chromium: { launch: jest.fn() },
}));

const { chromium } = require('playwright');
const { getAuthenticatedContextWithFile, readStorageState, buildContextOptions, logBrowserLocale, EXPORT_LOCALE } = require('../src/auth-context');

jest.mock('../src/utils/logger', () => ({
    warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn(),
    success: jest.fn(), step: jest.fn(), log: jest.fn(),
    getDumpDir: jest.fn(), getDumpDisplayPath: jest.fn(),
    setLevel: jest.fn(),
}));

const logger = require('../src/utils/logger');

/** Writes a file into a fresh temp dir and returns its path. */
function writeAuth(contents, { mode } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'));
    const file = path.join(dir, 'auth.json');
    fs.writeFileSync(file, contents, mode ? { mode } : undefined);
    return { file, dir };
}

/** A minimal but valid storage state. */
const VALID = JSON.stringify({
    cookies: [{ name: 'MUID', value: 'x', domain: '.live.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
    origins: [],
});

describe('readStorageState validation', () => {
    let dirs = [];
    afterEach(() => {
        for (const d of dirs) fs.removeSync(d);
        dirs = [];
    });

    const track = (result) => { dirs.push(result.dir); return result.file; };

    it('accepts a valid storage state and returns it', async () => {
        const file = track(writeAuth(VALID));
        const state = await readStorageState(file);
        expect(state.cookies).toHaveLength(1);
    });

    it('rejects a missing file with the path in the message', async () => {
        await expect(readStorageState('/nonexistent/auth.json')).rejects.toThrow(/not found|Could not read/);
    });

    it('rejects an empty file and says to re-authenticate', async () => {
        const file = track(writeAuth(''));
        await expect(readStorageState(file)).rejects.toThrow(/empty/i);
    });

    it('rejects a file that is not JSON', async () => {
        const file = track(writeAuth('this is not json'));
        await expect(readStorageState(file)).rejects.toThrow(/not valid JSON/);
    });

    // The most likely real cause: a browser "Save page as" of the login screen.
    it('recognises a saved HTML page and says so', async () => {
        const file = track(writeAuth('<!DOCTYPE html><html><body>Sign in</body></html>'));
        await expect(readStorageState(file)).rejects.toThrow(/looks like a saved web page/);
    });

    it('rejects a JSON array', async () => {
        const file = track(writeAuth('[1,2,3]'));
        await expect(readStorageState(file)).rejects.toThrow(/storage state object/);
    });

    it('names the missing keys when cookies or origins are absent', async () => {
        const noCookies = track(writeAuth(JSON.stringify({ origins: [] })));
        await expect(readStorageState(noCookies)).rejects.toThrow(/missing cookies/);

        const noOrigins = track(writeAuth(JSON.stringify({ cookies: [{}] })));
        await expect(readStorageState(noOrigins)).rejects.toThrow(/missing origins/);
    });

    // An expired login produces a structurally valid file with no cookies, which
    // used to sail through validation and fail confusingly much later.
    it('rejects a state with zero cookies as an expired login', async () => {
        const file = track(writeAuth(JSON.stringify({ cookies: [], origins: [] })));
        await expect(readStorageState(file)).rejects.toThrow(/no cookies|expired/i);
    });

    it('never leaks the cookie values into an error message', async () => {
        const secret = 'SUPER_SECRET_COOKIE_VALUE';
        const file = track(writeAuth(JSON.stringify({ cookies: 'not-an-array', origins: [], secret })));
        await expect(readStorageState(file)).rejects.not.toThrow(new RegExp(secret));
    });
});

describe('getAuthenticatedContextWithFile', () => {
    let dirs = [];
    let browser;

    beforeEach(() => {
        dirs = [];
        browser = { newContext: jest.fn().mockResolvedValue({ id: 'ctx' }), close: jest.fn().mockResolvedValue() };
        chromium.launch.mockReset().mockResolvedValue(browser);
        logger.warn.mockReset();
    });

    afterEach(() => {
        for (const d of dirs) fs.removeSync(d);
    });

    const track = (result) => { dirs.push(result.dir); return result.file; };

    it('requires a path', async () => {
        await expect(getAuthenticatedContextWithFile()).rejects.toThrow(/--auth-file/);
        expect(chromium.launch).not.toHaveBeenCalled();
    });

    it('rejects a bad file BEFORE launching a browser', async () => {
        const file = track(writeAuth('nonsense'));
        await expect(getAuthenticatedContextWithFile(file)).rejects.toThrow(/not valid JSON/);
        // The whole point: no orphaned Chromium process.
        expect(chromium.launch).not.toHaveBeenCalled();
    });

    it('does not leave a browser running when context creation fails', async () => {
        const file = track(writeAuth(VALID));
        browser.newContext.mockRejectedValue(new Error('revoked session'));

        await expect(getAuthenticatedContextWithFile(file)).rejects.toThrow(/Could not open a browser context/);
        expect(browser.close).toHaveBeenCalledTimes(1);
    });

    it('still reports the original cause when closing also fails', async () => {
        const file = track(writeAuth(VALID));
        browser.newContext.mockRejectedValue(new Error('revoked session'));
        browser.close.mockRejectedValue(new Error('already gone'));

        await expect(getAuthenticatedContextWithFile(file)).rejects.toThrow(/revoked session/);
    });

    it('returns browser and context on success', async () => {
        const file = track(writeAuth(VALID));
        const result = await getAuthenticatedContextWithFile(file);

        expect(result.browser).toBe(browser);
        expect(result.context).toEqual({ id: 'ctx' });
        expect(browser.close).not.toHaveBeenCalled();
    });

    it('passes headless through', async () => {
        const file = track(writeAuth(VALID));
        await getAuthenticatedContextWithFile(file, false);
        expect(chromium.launch).toHaveBeenCalledWith({ headless: false });
    });

    it('warns when the auth file is readable by other users', async () => {
        if (process.platform === 'win32') return;
        const file = track(writeAuth(VALID, { mode: 0o644 }));
        await getAuthenticatedContextWithFile(file);

        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/readable by other users/));
    });

    it('says nothing when the permissions are already tight', async () => {
        if (process.platform === 'win32') return;
        const file = track(writeAuth(VALID, { mode: 0o600 }));
        await getAuthenticatedContextWithFile(file);

        expect(logger.warn).not.toHaveBeenCalled();
    });

    // Advisory, not fatal: a legitimate export must not fail over a file mode.
    it('does not refuse to run because of loose permissions', async () => {
        if (process.platform === 'win32') return;
        const file = track(writeAuth(VALID, { mode: 0o666 }));
        await expect(getAuthenticatedContextWithFile(file)).resolves.toBeDefined();
    });
});

/**
 * F-33: the Office Online download menu is selected by UI text that exists in
 * English and French only. Playwright's `locale` defaults to the *system* locale,
 * so the same tool could work on one machine and fail on another with nothing in
 * the log to say why.
 */
describe('pinned browser locale', () => {
    beforeEach(() => {
        logger.info.mockReset();
        logger.debug.mockReset();
    });

    it('requests en-US', () => {
        expect(buildContextOptions('/x/auth.json').locale).toBe('en-US');
    });

    // The non-obvious half. Playwright turns `locale` into an Accept-Language
    // header for *browser* requests, but context.request - which downloads the
    // files - is a different client: BrowserContextAPIRequestContext copies
    // userAgent, extraHTTPHeaders, proxy and baseURL into its defaults and omits
    // locale. Only extraHTTPHeaders reaches it, so the header has to be set
    // explicitly or the downloads go out with no language at all.
    it('also sets Accept-Language in extraHTTPHeaders, where context.request inherits it', () => {
        const headers = buildContextOptions('/x/auth.json').extraHTTPHeaders;
        expect(headers['Accept-Language']).toMatch(/^en-US/);
    });

    it('keeps the storageState it was given', () => {
        expect(buildContextOptions('/x/auth.json').storageState).toBe('/x/auth.json');
    });

    it('hands the pinned options to newContext', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'));
        const file = path.join(dir, 'auth.json');
        fs.writeFileSync(file, VALID);
        const browser = { newContext: jest.fn().mockResolvedValue({ id: 'ctx' }), close: jest.fn() };
        chromium.launch.mockReset().mockResolvedValue(browser);

        await getAuthenticatedContextWithFile(file);
        expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({
            locale: EXPORT_LOCALE,
            extraHTTPHeaders: { 'Accept-Language': expect.stringMatching(/^en-US/) },
        }));

        fs.removeSync(dir);
    });

    it('reports the language the page actually came up in', async () => {
        const page = { evaluate: jest.fn().mockResolvedValue({ language: 'en-US', intl: 'en-US' }) };
        await logBrowserLocale(page);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('navigator.language=en-US'));
    });

    // A disagreement with the pinned locale is the diagnosis a failed selector
    // needs, so it has to be visible in the log and not swallowed.
    it('surfaces a language that differs from the one requested', async () => {
        const page = { evaluate: jest.fn().mockResolvedValue({ language: 'de-DE', intl: 'de-DE' }) };
        await logBrowserLocale(page);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('de-DE'));
    });

    // Diagnostics must never be the reason an export fails.
    it('never throws when the page cannot be evaluated', async () => {
        const page = { evaluate: jest.fn().mockRejectedValue(new Error('Target closed')) };
        await expect(logBrowserLocale(page)).resolves.toBeUndefined();
        expect(logger.info).not.toHaveBeenCalled();
    });
});
