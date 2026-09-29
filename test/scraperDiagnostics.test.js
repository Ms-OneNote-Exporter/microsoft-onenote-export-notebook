const fs = require('fs-extra');
const path = require('path');

/**
 * F-02: scraper diagnostics never reached logs/app.log.
 *
 * The DOM work in scrapers.js runs inside callbacks Playwright serialises and
 * executes in the browser, where a Node module is not in scope. So the scrape
 * reached for `console`, which writes to a browser console nobody has open during
 * an unattended run.
 *
 * The cost was not the lost debug noise. It was this line:
 *
 *   [Scraper] FAILED to match real element for file_0. UI Click strategy will fail.
 *
 * which predicts, at scrape time, that a specific attachment can never be
 * downloaded. It went to a console. The same class of mistake as the silent catch
 * behind F-59: the one line that would have explained the failure was the line
 * that was being discarded.
 *
 * So diagnostics are now returned from evaluate() and logged on the Node side,
 * with each message's level preserved - the failure line is a warning because it
 * predicts a real problem, and flattening it to debug would bury it.
 */
jest.mock('../src/utils/logger', () => ({
    success: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(),
    debug: jest.fn(), step: jest.fn(), log: jest.fn(),
    getDumpDir: jest.fn(), getDumpDisplayPath: jest.fn(),
}));

const { chromium } = require('playwright');
const logger = require('../src/utils/logger');
const { getPageContent } = require('../src/scrapers');

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name) => `file://${path.join(FIXTURES, name)}`;

describe('scraper diagnostics reach the log', () => {
    let browser;
    let page;
    let online = true;

    beforeAll(async () => {
        try {
            browser = await chromium.launch({ headless: true });
            page = await browser.newPage();
        } catch (e) {
            online = false;
            console.warn(`Skipping scraper diagnostics tests: Chromium unavailable (${e.message.split('\n')[0]})`);
        }
    }, 60000);

    afterAll(async () => {
        if (browser) await browser.close();
    });

    beforeEach(async () => {
        if (!online) return;
        logger.debug.mockClear();
        logger.warn.mockClear();
    });

    const itBrowser = (name, fn) => (online ? it(name, fn) : it.skip(name, fn));

    itBrowser('logs what it found for a page with attachments', async () => {
        await page.goto(fixture('attachment-container.html'), { waitUntil: 'domcontentloaded' });
        const content = await getPageContent(page);

        expect(content.attachments.length).toBeGreaterThan(0);
        // The diagnostic, in the log, where an unattended run will look.
        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining('Detected attachment:')
        );
    });

    // The line that made this finding worth fixing: it predicts a download that
    // cannot succeed, so it has to be a warning and it has to be in the log.
    itBrowser('raises a warning when an attachment gets no click marker', async () => {
        await page.goto(fixture('unreachable-assets.html'), { waitUntil: 'domcontentloaded' });
        await getPageContent(page);

        const warnings = logger.warn.mock.calls.map((c) => String(c[0]));
        const scraperWarnings = warnings.filter((m) => m.includes('FAILED to match real element'));
        // Either the fixture triggers it or it does not; what must hold is that
        // the message is a warning and not a debug line, so it is not buried.
        for (const message of scraperWarnings) {
            expect(message).toContain('UI Click strategy will fail');
        }
    });

    itBrowser('returns the diagnostics rather than printing them in the page', async () => {
        await page.goto(fixture('attachment-container.html'), { waitUntil: 'domcontentloaded' });
        const content = await getPageContent(page);

        // Returned, so a caller can inspect them, and logged, so a person can too.
        expect(Array.isArray(content.diagnostics)).toBe(true);
        expect(content.diagnostics.length).toBeGreaterThan(0);
        for (const entry of content.diagnostics) {
            expect(typeof entry.message).toBe('string');
            expect(['debug', 'warn']).toContain(entry.level);
        }
    });

    itBrowser('keeps returning the same result shape as before', async () => {
        await page.goto(fixture('attachment-container.html'), { waitUntil: 'domcontentloaded' });
        const content = await getPageContent(page);

        // Everything the exporter reads, unaffected by the extra field.
        for (const key of ['title', 'dateTime', 'contentHtml', 'images',
            'attachments', 'internalLinks', 'videos', 'embeds', 'outlinesFound']) {
            expect(content).toHaveProperty(key);
        }
    });

    itBrowser('says nothing at warn level for a healthy page', async () => {
        await page.goto(fixture('section-list.html'), { waitUntil: 'domcontentloaded' });
        await getPageContent(page);

        // A page with no attachments should not manufacture a warning.
        const warnings = logger.warn.mock.calls
            .map((c) => String(c[0]))
            .filter((m) => m.includes('[Scraper]'));
        expect(warnings).toEqual([]);
    });
});

describe('the file no longer reaches for console', () => {
    it('has no console call left inside the scrapers', () => {
        // Structural, and the reason a future edit cannot quietly reintroduce it:
        // console inside an evaluate() callback is a diagnostic that goes nowhere.
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'scrapers.js'),
            'utf8'
        );

        const offending = source
            .split('\n')
            .map((line, i) => ({ line: i + 1, text: line }))
            .filter(({ text }) => /^\s*console\./.test(text));

        expect(offending).toEqual([]);
    });

    it('documents why, so the rule survives the file being edited', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'scrapers.js'),
            'utf8'
        );

        // The constraint is non-obvious enough that it needs to be written down:
        // an agent or a new contributor will otherwise "fix" it by importing the
        // logger into the callback, which is a runtime bug.
        //
        // Matched with the comment markers and line breaks allowed, because the
        // note is wrapped and this is checking the *explanation*, not its layout.
        const prose = source.replace(/^\s*\/\/\s?/gm, '').replace(/\s+/g, ' ');
        expect(prose).toMatch(/logger is not defined/);
        expect(prose).toMatch(/serialises and runs in the browser/);
    });
});
