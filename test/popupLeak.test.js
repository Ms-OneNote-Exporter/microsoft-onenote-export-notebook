const fs = require('fs-extra');
const http = require('http');
const os = require('os');
const path = require('path');

/**
 * The popup the UI-click strategy leaks, in a real browser.
 *
 * One double-click on an attachment makes OneNote do two things at once: start the
 * download *and* open a viewer tab. The strategy races a `download` event against a
 * `popup` event, and every branch that used the popup closed it - but the download
 * branch did not, and neither did the case where the popup arrived after the race
 * had already been decided.
 *
 * That leak is not a small thing. The browser context is shared with the whole
 * export, so every leaked tab keeps rendering for the rest of the run, on a machine
 * already running OneNote, a browser and a scraper. A notebook with forty
 * attachments leaves forty tabs behind.
 *
 * Reproduced here rather than asserted from the source, because the failure mode is
 * a *race*: the popup and the download both arrive, and which one wins is timing.
 * The fixture below makes the download win, which is the branch that leaked.
 */
jest.mock('../src/utils/logger', () => ({
    success: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(),
    debug: jest.fn(), step: jest.fn(), log: jest.fn(),
    getDumpDir: jest.fn(), getDumpDisplayPath: jest.fn(),
}));

const { chromium } = require('playwright');
const { tryUIClickForTest } = require('../src/downloadStrategies');

/**
 * A page whose attachment element opens a viewer tab *and* starts a download on the
 * same double-click, exactly as OneNote does.
 */
const FIXTURE = `<!doctype html>
<html><body>
  <div id="chip" data-one-attach-id="att-1">report.pdf</div>
  <a id="dl" download="report.pdf"
     href="data:application/octet-stream;base64,JVBERi0xLjQK"></a>
  <script>
    document.getElementById('chip').addEventListener('dblclick', () => {
      // The viewer tab first, so it exists by the time the download resolves.
      window.open('/viewer.html', '_blank');
      setTimeout(() => document.getElementById('dl').click(), 30);
    });
  </script>
</body></html>`;

describe('the popup the UI-click strategy opens', () => {
    // Optimistically true, so the tests below are *registered*. Whether the flag is
    // right is decided in beforeAll, which runs after collection - so a flag read at
    // registration time is always its initial value. Mine started as `undefined`,
    // which meant every test was silently skipped and the suite reported green with
    // nothing in it.
    let online = true;
    let browser;
    let server;
    let origin;
    let page;
    let outDir;

    beforeAll(async () => {
        try {
            browser = await chromium.launch({ headless: true });
        } catch (e) {
            online = false;
            console.warn(`Skipping popup test: Chromium unavailable (${e.message.split('\n')[0]})`);
            return;
        }

        server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(req.url === '/viewer.html' ? '<html><body>viewer</body></html>' : FIXTURE);
        });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        origin = `http://127.0.0.1:${server.address().port}`;

        page = await browser.newPage();
        await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
        outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-'));
    }, 60000);

    afterAll(async () => {
        if (outDir) fs.removeSync(outDir);
        if (server) await new Promise((r) => server.close(r));
        if (browser) await browser.close();
    });

    // The timeout has to be forwarded. Dropping it makes a test that legitimately
    // waits out the strategy's own 5s selector timeout die at jest's 5s default -
    // which is the same millisecond, so the failure reads as a hang.
    const itBrowser = (name, fn, timeout) => (online ? it(name, fn, timeout) : it.skip(name, fn, timeout));

    itBrowser('is closed when the download wins the race', async () => {
        // The leak as it actually happened: both events fire, the download is
        // awaited first, and the popup - already open, and already paid for - was
        // left for the rest of the run.
        const outPath = path.join(outDir, 'report.pdf');
        const result = await tryUIClickForTest(page.mainFrame(), 'att-1', outPath);

        expect(result.ok).toBe(true);
        expect(fs.existsSync(outPath)).toBe(true);

        // The closer is handed to the popup promise rather than awaited, so give it
        // the moment it needs before looking.
        await new Promise((r) => setTimeout(r, 1500));

        const openPages = browser.contexts().flatMap((c) => c.pages());
        const viewerTabs = openPages.filter((p) => p.url().includes('viewer.html'));
        expect(viewerTabs).toHaveLength(0);
    }, 60000);

    itBrowser('reports a missing element rather than opening anything', async () => {
        // The other half of the contract: an attach id that is not in the DOM must not
        // be retried as if re-rendering might fix it.
        const result = await tryUIClickForTest(page.mainFrame(), 'no-such-id', path.join(outDir, 'x.pdf'));
        expect(result).toEqual({ ok: false, elementMissing: true });
    }, 30000);
});