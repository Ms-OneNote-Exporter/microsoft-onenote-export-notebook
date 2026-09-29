const fs = require('fs-extra');
const http = require('http');
const os = require('os');
const path = require('path');

/**
 * F-33: the pinned browser locale, verified against real Chromium.
 *
 * The mocked test in authContext.test.js proves the *options object* is right.
 * This one proves what Playwright then does with it, which is the part that was
 * not obvious and is the reason the header is set twice:
 *
 * - `locale` reaches the page (navigator.language, Accept-Language on browser
 *   requests) but NOT context.request;
 * - `extraHTTPHeaders` reaches both, and context.request is the client that
 *   downloads every file.
 *
 * A local HTTP server stands in for Microsoft. No credentials, no network.
 */

jest.mock('../src/utils/logger', () => ({
    success: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(),
    debug: jest.fn(), step: jest.fn(), log: jest.fn(),
    getDumpDir: jest.fn(), getDumpDisplayPath: jest.fn(),
}));

const logger = require('../src/utils/logger');
const { chromium } = require('playwright');
const { buildContextOptions, logBrowserLocale } = require('../src/auth-context');

/** Records the Accept-Language of every request, keyed by path. */
function startServer() {
    const seen = new Map();
    const server = http.createServer((req, res) => {
        seen.set(req.url, req.headers['accept-language']);
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>stub</title>ok');
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${server.address().port}`,
            seen,
            close: () => new Promise((done) => server.close(done)),
        }));
    });
}

describe('locale pinning, against real Chromium', () => {
    let browser;
    let server;
    let dir;
    let online = true;

    beforeAll(async () => {
        try {
            browser = await chromium.launch({ headless: true });
            server = await startServer();
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-'));
            // A storage state has to exist: newContext() parses it.
            fs.writeFileSync(
                path.join(dir, 'auth.json'),
                JSON.stringify({ cookies: [], origins: [] })
            );
        } catch (e) {
            online = false;
            console.warn(`Skipping locale tests: Chromium unavailable (${e.message.split('\n')[0]})`);
        }
    }, 60000);

    afterAll(async () => {
        if (browser) await browser.close();
        if (server) await server.close();
        if (dir) fs.removeSync(dir);
    });

    const maybe = (name, fn) => (online ? it(name, fn) : it.skip(name, fn));

    // The baseline: what a German or French machine does today. This is the case
    // the English-only Office Online selectors fail on.
    maybe('a de-DE context reports de-DE to the page', async () => {
        const context = await browser.newContext({ locale: 'de-DE' });
        const page = await context.newPage();
        await page.goto(`${server.url}/unpinned-page`);

        expect(await page.evaluate(() => navigator.language)).toBe('de-DE');
        expect(server.seen.get('/unpinned-page')).toBe('de-DE');

        await context.close();
    });

    // The claim under test, and the reason locale alone is not enough.
    maybe('locale alone does NOT reach context.request', async () => {
        const context = await browser.newContext({ locale: 'de-DE' });
        await context.request.get(`${server.url}/unpinned-api`);

        expect(server.seen.get('/unpinned-api')).toBeUndefined();

        await context.close();
    });

    maybe('the shipped options make the page English', async () => {
        const context = await browser.newContext(buildContextOptions(path.join(dir, 'auth.json')));
        const page = await context.newPage();
        await page.goto(`${server.url}/pinned-page`);

        expect(await page.evaluate(() => navigator.language)).toBe('en-US');
        expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().locale)).toBe('en-US');
        expect(server.seen.get('/pinned-page')).toMatch(/^en-US/);

        await context.close();
    });

    // This is the one that matters: the file downloads go out through this client.
    maybe('the shipped options also make context.request English', async () => {
        const context = await browser.newContext(buildContextOptions(path.join(dir, 'auth.json')));
        await context.request.get(`${server.url}/pinned-api`);

        expect(server.seen.get('/pinned-api')).toMatch(/^en-US/);

        await context.close();
    });

    maybe('logBrowserLocale names the language that disagreed with the request', async () => {
        const context = await browser.newContext({ locale: 'de-DE' });
        const page = await context.newPage();
        await page.goto(`${server.url}/mismatch`);

        logger.info.mockClear();
        await logBrowserLocale(page);

        // An account that renders German is exactly the case a failed
        // download-menu selector needs to be able to explain.
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('de-DE'));

        await context.close();
    });
});
