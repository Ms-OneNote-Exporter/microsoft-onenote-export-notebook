const logger = require('./utils/logger');
const { getAuthenticatedContextWithFile } = require('./auth-context');
const { ONENOTE_URL } = require('./config');
const fs = require('fs-extra');
const path = require('path');

/**
 * Detects the Microsoft Defender / MCAS "Use Edge Browser" interstitial
 * (URL pattern: *.access.mcas.ms/aad_login) and dismisses it by:
 *  1. Checking "Hide this notification for all apps for one week"
 *  2. Clicking "Continue in current browser"
 *
 * Safe to call even when the page is NOT the MCAS interstitial — it will
 * simply return false immediately.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} true if the interstitial was detected and dismissed
 */
async function dismissMcasInterstitial(page) {
    const url = page.url();
    if (!url.includes('access.mcas.ms')) {
        return false;
    }

    logger.warn('Detected Microsoft Defender MCAS interstitial — dismissing...');

    try {
        await page.waitForSelector('#skip-disclaimer-checkbox', { timeout: 10000 }).catch(() => { });

        const checkbox = await page.$('#skip-disclaimer-checkbox');
        if (checkbox) {
            const isChecked = await checkbox.isChecked();
            if (!isChecked) {
                await checkbox.check();
                logger.debug('MCAS: checked "Hide this notification for all apps for one week".');
            }
        } else {
            logger.warn('MCAS: could not find the "Hide" checkbox.');
        }

        const continueBtn = await page.$('#hiddenformSubmitBtn');
        if (continueBtn) {
            logger.debug('MCAS: clicking "Continue in current browser"...');
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { }),
                continueBtn.click()
            ]);
            logger.success('MCAS interstitial dismissed.');

            try {
                await page.waitForLoadState('networkidle', { timeout: 45000 });
            } catch (e) {
                logger.warn('MCAS post-dismiss network idle timeout — continuing anyway...');
            }
            return true;
        }

        logger.warn('MCAS: could not find "Continue in current browser" submit button.');
    } catch (e) {
        logger.warn(`MCAS interstitial dismissal failed: ${e.message}`);
    }

    return false;
}

/**
 * Lists available OneNote notebooks.
 * Uses authentication state loaded from options.authFile.
 * Uses the new onenote.cloud.microsoft/notebooks page selector.
 *
 * @param {object} options
 * @param {string} options.authFile - Path to auth.json
 * @param {boolean} [options.notheadless] - Run in visible browser mode
 * @param {boolean} [options.dodump] - Dump HTML for debugging
 * @param {boolean} [options.keepOpen] - Keep browser open and return session object
 * @returns {Promise<Array|object>} Array of notebooks, or session object when keepOpen=true
 */
async function listNotebooks(options = {}) {
    logger.info('Connecting to OneNote...');

    const headless = !options.notheadless;
    logger.debug(`Launching browser (headless: ${headless})...`);

    const { browser, context } = await getAuthenticatedContextWithFile(options.authFile, headless);

    try {
        const page = await context.newPage();

        logger.info(`Navigating to notebooks list: ${ONENOTE_URL}`);
        await page.goto(ONENOTE_URL);

        try {
            logger.debug('Waiting for page content (domcontentloaded)...');
            await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
        } catch (e) {
            logger.warn('Page load timeout/warning, proceeding to scrape anyway...');
        }

        logger.info('Waiting for page to fully settle after redirects...');
        try {
            await page.waitForLoadState('networkidle', { timeout: 45000 });
        } catch (e) {
            logger.warn('Network idle timeout — continuing anyway...');
        }

        await dismissMcasInterstitial(page);

        // Wait for the notebook table to appear.
        // The new onenote.cloud.microsoft/notebooks page renders notebooks as a plain
        // <table> where each notebook row (<tr>) contains in its first <td>:
        //   <img alt="Classic Notebook"> <span>Notebook Name</span>
        // We scope to 'tr img[...]' to exclude the sidebar nav item (which also has
        // this img but outside a table row and produces a false "Notebooks" entry).
        logger.info('Waiting for notebook list to render...');
        const NOTEBOOK_IMG_SELECTOR = 'tr img[alt="Classic Notebook"]';
        try {
            await page.waitForSelector(NOTEBOOK_IMG_SELECTOR, { state: 'attached', timeout: 60000 });
            logger.success('Notebook list detected in DOM.');
        } catch (e) {
            logger.warn(`Notebook img selector not found within timeout: ${e.message}`);
        }

        if (options.dodump) {
            const dumpDir = await logger.getDumpDir();
            const displayPath = logger.getDumpDisplayPath();
            logger.warn(`Dumping main page content to ${displayPath}/debug_page_dump.html...`);
            const content = await page.content();
            await fs.writeFile(path.join(dumpDir, 'debug_page_dump.html'), content);
        }

        let notebooks = [];
        const maxRetries = 5;

        for (let i = 0; i < maxRetries; i++) {
            logger.debug(`Attempt ${i + 1}/${maxRetries} to scrape notebook list...`);

            notebooks = await page.evaluate((imgSelector) => {
                const imgs = Array.from(document.querySelectorAll(imgSelector));

                return imgs.map((img, idx) => {
                    const nameSpan = img.nextElementSibling;
                    if (!nameSpan) return null;

                    const name = nameSpan.innerText.trim();
                    if (!name) return null;

                    const tr = img.closest('tr');
                    const trIndex = tr ? tr.rowIndex : idx;

                    return {
                        name,
                        url: 'click-to-open',
                        id: `notebook-row-${trIndex}`
                    };
                }).filter(n => n && n.name);
            }, NOTEBOOK_IMG_SELECTOR);

            if (notebooks.length > 0) {
                logger.success(`Found ${notebooks.length} notebooks!`);
                break;
            }

            if (i < maxRetries - 1) {
                logger.debug('No notebooks found yet, waiting 3 seconds...');
                await page.waitForTimeout(3000);
            }
        }

        // Deduping by name (new page may show duplicates in Recent vs All sections)
        const uniqueNotebooks = [];
        const seenNames = new Set();
        for (const nb of notebooks) {
            if (!seenNames.has(nb.name)) {
                seenNames.add(nb.name);
                uniqueNotebooks.push(nb);
            }
        }

        if (options.keepOpen) {
            // Also expose context so callers can pass it to openNotebook()
            return { notebooks: uniqueNotebooks, browser, context, page, scrapeTarget: page };
        }

        await browser.close();
        return uniqueNotebooks;

    } catch (e) {
        logger.error('Error listing notebooks:', e);
        await browser.close();
        throw e;
    }
}

/**
 * Opens a notebook by clicking on it in the notebooks list page.
 *
 * Clicking a notebook row in the new onenote.cloud.microsoft/notebooks page
 * opens the OneNote editor in a NEW popup/tab (SharePoint-hosted, e.g.
 * COMPANYNAME-my.sharepoint.com/.../Doc.aspx).
 *
 * This function:
 *  1. Subscribes to context.on('page') BEFORE clicking
 *  2. Clicks the notebook row
 *  3. Waits for the new popup page to appear and fully load
 *  4. Returns { browser, page: editorPage, context }
 *
 * @param {import('playwright').Page} listingPage
 * @param {import('playwright').BrowserContext} context
 * @param {import('playwright').Browser} browser
 * @param {string} notebookId - "notebook-row-N"
 * @param {string} [expectedName] - Notebook name to verify before clicking
 * @returns {Promise<{ browser, page, context }>}
 */
async function openNotebook(listingPage, context, browser, notebookId, expectedName) {
    logger.info('Opening notebook...');

    const match = notebookId.match(/notebook-row-(\d+)/);
    if (!match) {
        throw new Error(`Unexpected notebook id format: ${notebookId}`);
    }
    const rowIndex = parseInt(match[1], 10);

    // Subscribe to new-page events BEFORE the click
    const newPagePromise = context.waitForEvent('page', { timeout: 60000 });

    // The click below can throw (that is the point of the name check). If it
    // does, nothing ever awaits newPagePromise and Playwright's 60s timeout
    // would resurface as an unhandled rejection in the user's log. Mark it
    // handled now; awaiting it later still observes the rejection.
    newPagePromise.catch(() => {});

    logger.debug(`Clicking notebook row ${rowIndex}${expectedName ? ` (expecting "${expectedName}")` : ''}...`);

    // rowIndex is only meaningful relative to the table the row was found in, and
    // the notebooks page shows the same notebook in more than one table (Recent
    // and All). If the list re-rendered or re-sorted between listing and clicking,
    // the same index can address a different row - which used to mean silently
    // opening, and exporting, the WRONG notebook. So match on the name and refuse
    // to click unless the row really is the one that was selected.
    const outcome = await listingPage.evaluate(({ idx, imgSel, wantName }) => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const imgs = Array.from(document.querySelectorAll(imgSel));

        for (const img of imgs) {
            const tr = img.closest('tr');
            if (!tr || tr.rowIndex !== idx) continue;

            const nameSpan = img.nextElementSibling;
            const rowName = nameSpan ? nameSpan.innerText.trim() : '';

            if (wantName && norm(rowName) !== norm(wantName)) {
                return { clicked: false, reason: `row ${idx} is "${rowName}", expected "${wantName}"` };
            }

            if (nameSpan) { nameSpan.click(); } else { tr.click(); }
            return { clicked: true, rowName };
        }

        return { clicked: false, reason: `no row with index ${idx}` };
    }, { idx: rowIndex, imgSel: 'tr img[alt="Classic Notebook"]', wantName: expectedName || null });

    if (!outcome.clicked) {
        // Do NOT fall back to clicking blindly: opening the wrong notebook is
        // worse than failing, and the user can retry with --notebook-link.
        throw new Error(
            `Refusing to click notebook row ${notebookId}: ${outcome.reason}. ` +
            'The notebook list may have changed since it was listed; re-run, or use ' +
            '--notebook-link <url> to open it directly.'
        );
    }

    logger.success(`Notebook row clicked (${outcome.rowName || 'name unknown'})! Waiting for editor tab to open...`);

    // Wait for the new page (OneNote editor on SharePoint) to appear
    let editorPage;
    try {
        editorPage = await newPagePromise;
        logger.success(`Editor tab opened: ${editorPage.url().substring(0, 100)}`);
    } catch (e) {
        throw new Error(`No new editor tab appeared within 60s after clicking notebook: ${e.message}`);
    }

    // Wait for the editor to fully load
    logger.info('Waiting for OneNote editor to load (domcontentloaded)...');
    try {
        await editorPage.waitForLoadState('domcontentloaded', { timeout: 60000 });
    } catch (e) {
        logger.warn('Editor domcontentloaded timeout — continuing...');
    }

    logger.info('Waiting for OneNote editor network idle...');
    try {
        await editorPage.waitForLoadState('networkidle', { timeout: 60000 });
    } catch (e) {
        logger.warn('Editor network idle timeout — continuing...');
    }

    logger.success(`Notebook editor loaded! Final URL: ${editorPage.url().substring(0, 100)}`);
    logger.info('Will wait 10 seconds to let the OneNote section list fully render...');
    await editorPage.waitForTimeout(10000);

    return { browser, page: editorPage, context };
}

/**
 * Opens a notebook directly by navigating to its full URL.
 * Uses authentication state loaded from options.authFile.
 *
 * @param {object} options  - { authFile, notheadless, dodump, notebookLink, ... }
 * @returns {{ browser, page, context, notebookName }}
 */
async function openNotebookByLink(options = {}) {
    const url = options.notebookLink;
    if (!url) throw new Error('openNotebookByLink: options.notebookLink is required');

    logger.info(`Opening notebook directly via link: ${url}`);

    const headless = !options.notheadless;
    logger.debug(`Launching browser (headless: ${headless})...`);

    const { browser, context } = await getAuthenticatedContextWithFile(options.authFile, headless);

    try {
        const page = await context.newPage();

        logger.info('Navigating to notebook URL...');
        await page.goto(url);

        try {
            await page.waitForLoadState('domcontentloaded', { timeout: 60000 });
        } catch (e) {
            logger.warn('Page load timeout, proceeding anyway...');
        }

        logger.info('Waiting for page to fully settle after redirects...');
        try {
            await page.waitForLoadState('networkidle', { timeout: 60000 });
        } catch (e) {
            logger.warn('Network idle timeout — continuing anyway...');
        }

        await dismissMcasInterstitial(page);

        logger.info('Waiting 10 seconds for dynamic content to render...');
        await page.waitForTimeout(10000);

        if (options.dodump) {
            const dumpDir = await logger.getDumpDir();
            const displayPath = logger.getDumpDisplayPath();
            logger.warn(`Dumping page content to ${displayPath}/debug_notebook_link.html...`);
            const content = await page.content();
            await fs.writeFile(path.join(dumpDir, 'debug_notebook_link.html'), content);
        }

        // Try to extract the notebook name from the page title or URL
        let notebookName = 'Notebook';
        try {
            const title = await page.title();
            if (title && title.trim()) {
                notebookName = title.replace(/ ?[-–|] ?Microsoft OneNote.*$/i, '').trim() || notebookName;
            }
        } catch (e) {
            logger.warn('Could not read page title, using default name.');
        }

        logger.success(`Notebook opened (name detected: "${notebookName}")`);

        return { browser, context, page, scrapeTarget: page, notebookName };
    } catch (e) {
        logger.error('Failed to open notebook by link:', e);
        await browser.close();
        throw e;
    }
}

module.exports = {
    listNotebooks,
    openNotebook,
    openNotebookByLink
};
