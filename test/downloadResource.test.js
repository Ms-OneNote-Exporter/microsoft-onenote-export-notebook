const fs = require('fs-extra');
const http = require('http');
const os = require('os');
const path = require('path');

/** Starts a throwaway HTTP server; resolves with { url, close }. */
const startServer = (handler) => new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
    }));
});

/**
 * Guards the two asset-pipeline fixes found from a real run on 2026-09-28.
 *
 * downloadResource is loaded through exporter.js, which pulls in Playwright; the
 * logger is mocked so the assertions are about bytes on disk and control flow,
 * not about log formatting.
 */
jest.mock('../src/utils/logger', () => ({
    success: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(),
    debug: jest.fn(), step: jest.fn(), log: jest.fn(),
    getDumpDir: jest.fn(), getDumpDisplayPath: jest.fn(),
}));

const logger = require('../src/utils/logger');

// downloadResource is module-private, so reach it the way production does:
// through a real browser page. blob: handling is the part under test, and that
// genuinely needs Chromium, so these tests launch it and are skipped when the
// browser is not installed.
const { chromium } = require('playwright');
const { downloadResourceForTest } = require('../src/exporter');

const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

describe('downloadResource', () => {
    let browser;
    let context;
    let page;
    let dir;
    let online = true;

    beforeAll(async () => {
        try {
            browser = await chromium.launch({ headless: true });
            context = await browser.newContext();
            page = await context.newPage();
        } catch (e) {
            online = false;
            console.warn(`Skipping downloadResource tests: Chromium unavailable (${e.message.split('\n')[0]})`);
        }
    }, 60000);

    afterAll(async () => {
        if (browser) await browser.close();
    });

    beforeEach(() => {
        if (!online) return;
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
        jest.clearAllMocks();
    });

    afterEach(() => {
        if (dir) fs.removeSync(dir);
    });

    const maybe = (name, fn) => (online ? it(name, fn) : it.skip(name, fn));

    // The reported failure was:
    //   apiRequestContext.get: Protocol "blob:" not supported. Expected "http:"
    // repeated 3x per image, because withRetry retried a permanent error.
    maybe('reads a blob: URL through the page instead of the request context', async () => {
        await page.goto('about:blank');
        const dataUrl = `data:image/png;base64,${PNG_1x1.toString('base64')}`;
        const blobUrl = await page.evaluate(async (src) => {
            const blob = await (await fetch(src)).blob();
            return URL.createObjectURL(blob);
        }, dataUrl);

        expect(blobUrl.startsWith('blob:')).toBe(true);

        const out = path.join(dir, 'from-blob.png');
        await expect(downloadResourceForTest(page, blobUrl, out)).resolves.toBe(true);

        expect(fs.readFileSync(out).equals(PNG_1x1)).toBe(true);
        // The protocol error must not have been logged.
        expect(logger.error).not.toHaveBeenCalled();
    });

    maybe('still handles a base64 data: URL', async () => {
        const out = path.join(dir, 'from-data.png');
        const url = `data:image/png;base64,${PNG_1x1.toString('base64')}`;

        await expect(downloadResourceForTest(page, url, out)).resolves.toBe(true);
        expect(fs.readFileSync(out).equals(PNG_1x1)).toBe(true);
    });

    maybe('fails loudly on a non-base64 data: URL instead of writing garbage', async () => {
        const out = path.join(dir, 'bad.png');
        // Previously this returned false silently, or worse, decoded as base64.
        await expect(downloadResourceForTest(page, 'data:image/svg+xml,<svg/>', out)).resolves.toBe(false);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Unsupported data: URL'));
    });

    maybe('downloads an ordinary http(s) resource', async () => {
        // A real local server, because context.route() intercepts browser
        // traffic only - it does not apply to context.request.get(), which is
        // what the http path uses.
        const server = await startServer((req, res) => {
            if (req.url === '/x.png') {
                res.writeHead(200, { 'Content-Type': 'image/png' });
                res.end(PNG_1x1);
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('nope');
            }
        });

        const out = path.join(dir, 'from-http.png');
        await expect(downloadResourceForTest(page, `${server.url}/x.png`, out)).resolves.toBe(true);
        expect(fs.readFileSync(out).equals(PNG_1x1)).toBe(true);
        await server.close();
    });

    maybe('reports failure and does not leave a file behind on HTTP error', async () => {
        const server = await startServer((req, res) => {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('nope');
        });

        const out = path.join(dir, 'missing.png');
        await expect(downloadResourceForTest(page, `${server.url}/404.png`, out)).resolves.toBe(false);
        expect(fs.existsSync(out)).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('HTTP 404'));
        await server.close();
    });
});
