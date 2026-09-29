const fs = require('fs-extra');
const path = require('path');
const Logger = require('./utils/logger');
const { withRetry, permanent } = require('./utils/retry');
const { newStrategyStats, recordAttempt, recordWin, recordFailure } = require('./utils/strategyStats');

/**
 * Counters for this run's attachment downloads, filled in as strategies win or
 * fail so the summary can say which one earned its cost (F-32). See
 * utils/strategyStats for why the Direct strategy needs that evidence.
 *
 * Deliberately module-level rather than threaded through downloadAttachment: it
 * is one value for the whole process, the export is single-threaded, and adding
 * a ninth parameter to a function that already takes a frame, an info object and
 * a path would be a worse trade than a small, resettable singleton. The tests
 * call resetStrategyStats() so a suite cannot inherit another's counts.
 */
let strategyStats = newStrategyStats();

/**
 * The counters for this run.
 * @returns {object} The live counters, held by reference
 */
function getStrategyStats() {
    return strategyStats;
}

/** Zeroes the counters, for the next run or for a test. */
function resetStrategyStats() {
    strategyStats = newStrategyStats();
}

/**
 * Strategy 1: URL Transformation (Direct Download)
 * For SharePoint-style URLs, we use a temporary page/tab to handle the complex 
 * authentication redirect chain natively in the browser.
 */
async function tryDirectDownload(page, url, outputPath) {
    if (!url.includes('sharepoint.com') && !url.includes('onedrive.live.com') && !url.includes('1drv.ms')) {
        return false;
    }

    Logger.info(`      [Strategy: Direct] Attempting Cloud Page Navigation...`);

    const separator = url.includes('?') ? '&' : '?';
    const downloadUrl = url + (url.includes('download=1') ? '' : separator + 'download=1');

    const context = page.context();
    const tempPage = await context.newPage();

    try {
        // SharePoint authentication redirects can be slow
        // We'll race the direct download against a timer
        const downloadPromise = tempPage.waitForEvent('download', { timeout: 15000 }).catch(() => null);

        await tempPage.goto(downloadUrl).catch(e => {
            if (!e.message.includes('Download is starting') && !e.message.includes('navigation was aborted')) {
                throw e;
            }
        });

        const download = await downloadPromise;
        if (download) {
            await download.saveAs(outputPath);
            Logger.debug(`      [Strategy: Direct] Successfully captured download from cloud page.`);
            await tempPage.close().catch(() => { });
            return true;
        }

        // FALLBACK: If no download triggered automatically, the browser probably landed on a viewer
        Logger.info(`      [Strategy: Direct] No auto-download. Attempting Office Online manual sequence...`);
        if (await handleOfficeOnlineDownload(tempPage, outputPath)) {
            return true;
        }
    } catch (e) {
        Logger.debug(`      Cloud page download sequence failed: ${e.message}`);
    } finally {
        if (!tempPage.isClosed()) await tempPage.close().catch(() => { });
    }
    return false;
}

/**
 * Fallback for Office Online (Excel/Word/PowerPoint)
 * Navigates the "File" menu to trigger a download copy.
 */
async function handleOfficeOnlineDownload(page, outputPath) {
    try {
        // 0. Handle MCAS interstitial if it appears in the new tab
        const mcasBtn = await page.$('#hiddenformSubmitBtn');
        if (mcasBtn) {
            Logger.info(`      [Office Online] Detected MCAS interstitial in new tab, dismissing...`);
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { }),
                mcasBtn.click()
            ]);
            await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => { });
        }

        // SharePoint/Office Online can be very slow to load
        Logger.debug(`      [Office Online] Waiting for page/ribbon to initialize...`);
        await page.waitForTimeout(5000);

        // Office Online often puts everything in a frame named 'WacFrame'
        let target = page;
        const frames = page.frames();
        const wacFrame = frames.find(f => f.name().includes('WacFrame') || f.url().includes('WacFrame'));
        if (wacFrame) {
            Logger.debug(`      [Office Online] Switching to WacFrame...`);
            target = wacFrame;
        }

        // 1. Find and click "File"
        // Try common selectors for the File menu across multiple languages
        const fileBtnSelectors = [
            'button:has-text("File")',
            'button:has-text("Fichier")',
            '#FileMenu',
            '#file-menu-id',
            '[data-automation-id="FileMenu"]',
            '[data-automation-id="file-menu"]',
            'text=/^(File|Fichier)$/'
        ];

        let fileBtn = null;
        for (const selector of fileBtnSelectors) {
            fileBtn = target.locator(selector).first();
            if (await fileBtn.isVisible()) break;
            fileBtn = null;
        }

        if (!fileBtn) {
            // Last ditch: look for the button by role
            fileBtn = target.getByRole('button', { name: /File|Fichier/i }).first();
        }

        await fileBtn.waitFor({ state: 'visible', timeout: 20000 });
        await fileBtn.click();
        Logger.debug(`      [Office Online] Clicked "File"`);

        // 2. Click "Save As" or "Create a Copy"
        Logger.info('Will wait 2 seconds to let the File menu load.');
        await page.waitForTimeout(2000);

        const saveAsPatterns = [/Save as/i, /Create a Copy/i, /Enregistrer sous/i, /Créer une copie/i];
        let saveAsItem = null;
        for (const pattern of saveAsPatterns) {
            saveAsItem = target.getByRole('menuitem', { name: pattern }).or(target.getByText(pattern)).first();
            if (await saveAsItem.isVisible()) break;
            saveAsItem = null;
        }

        if (!saveAsItem) {
            throw new Error('Could not find "Save As" or "Create a Copy" menu item');
        }

        await saveAsItem.click();
        Logger.debug(`      [Office Online] Clicked "Save As / Create a Copy"`);

        // 3. Click "Download a Copy"
        Logger.info('Will wait 2 seconds to let the Save As / Create a Copy menu load properly');
        await page.waitForTimeout(2000);
        const downloadPatterns = [/Download a Copy|Télécharger une Copie|Download a copy|Télécharger une copie/i];
        let finalDownloadItem = null;
        for (const pattern of downloadPatterns) {
            finalDownloadItem = target.getByRole('menuitem', { name: pattern }).or(target.getByText(pattern)).first();
            if (await finalDownloadItem.isVisible()) break;
            finalDownloadItem = null;
        }

        if (!finalDownloadItem) {
            // Fallback for some versions where it's a simple button or link
            finalDownloadItem = target.locator('button:has-text("Download"), a:has-text("Download"), button:has-text("Télécharger"), a:has-text("Télécharger")').first();
        }

        // Start waiting for download before clicking. The promise is marked handled
        // immediately: anything between here and the `await` below can throw (the
        // item may never become visible, or the click may fail), and if that
        // happens nothing awaits this promise, so its 45s timeout would surface
        // later as an unhandled rejection. Awaiting it still observes rejection.
        const downloadPromise = page.waitForEvent('download', { timeout: 45000 });
        downloadPromise.catch(() => { });

        await finalDownloadItem.waitFor({ state: 'visible', timeout: 10000 });
        await finalDownloadItem.click({ force: true });
        Logger.debug(`      [Office Online] Clicked "Download a Copy" submenu`);

        // 4. Handle confirmation dialog if it appears (Office Online overlay)
        try {
            Logger.debug(`      [Office Online] Waiting for confirmation dialog to appear...`);
            Logger.info('Will wait 3 seconds to let the confirmation dialog load properly');
            await page.waitForTimeout(3000); // Give it time to animate in

            const selectors = [
                '#DialogActionButton',
                '[data-unique-id="DialogActionButton"]',
                'button:has-text("Download a copy")',
                '.fui-Button:has-text("Download a copy")',
                'button[aria-label="Download a copy"]'
            ];

            let confirmationBtn = null;
            // Check top-level page AND the frame target
            for (const selector of selectors) {
                const btnPage = page.locator(selector).filter({ visible: true }).first();
                if (await btnPage.isVisible({ timeout: 1000 }).catch(() => false)) {
                    confirmationBtn = btnPage;
                    Logger.debug(`      [Office Online] Found button on top-level page via ${selector}`);
                    break;
                }
                if (target !== page) {
                    const btnTarget = target.locator(selector).filter({ visible: true }).first();
                    if (await btnTarget.isVisible({ timeout: 1000 }).catch(() => false)) {
                        confirmationBtn = btnTarget;
                        Logger.debug(`      [Office Online] Found button in WacFrame via ${selector}`);
                        break;
                    }
                }
            }

            if (confirmationBtn) {
                Logger.info(`      [Office Online] Confirmation dialog detected, clicking "Download a copy" button...`);
                await confirmationBtn.click();
            } else {
                Logger.debug(`      [Office Online] No confirmation button found after searching page and frame.`);
                // Diagnostic dump
                try {
                    const dumpDir = await Logger.getDumpDir();
                    const timestamp = new Date().getTime();
                    await fs.writeFile(path.join(dumpDir, `debug_office_online_${timestamp}.html`), await page.content());
                    if (target !== page) {
                        await fs.writeFile(path.join(dumpDir, `debug_office_online_frame_${timestamp}.html`), await target.content());
                    }
                    Logger.debug(`      [Office Online] Diagnostic dumps saved to logs/dumps.`);
                } catch (dumpErr) {
                    // Ignore dump errors
                }
            }
        } catch (e) {
            Logger.debug(`      [Office Online] Error while checking for confirmation: ${e.message}`);
        }

        const download = await downloadPromise;
        await download.saveAs(outputPath);
        Logger.success(`      [Strategy: Direct] Successfully captured download via Office Online manual UI.`);
        return true;
    } catch (e) {
        Logger.debug(`      Office Online manual sequence failed: ${e.message}`);
        return false;
    }
}

/**
 * Strategy 2: Physical Click
 * Triggers a download by clicking the element in the browser.
 */
async function tryUIClick(contentFrame, attachId, outputPath) {
    const page = contentFrame.page();
    const selector = `[data-one-attach-id="${attachId}"]`;

    // Wait for the element to be present
    const link = await contentFrame.waitForSelector(selector, { state: 'attached', timeout: 5000 }).catch(() => null);
    if (!link) {
        // Reported as a permanent condition by the caller: nothing re-navigates or
        // re-renders between retry attempts, so if the marker is not in the DOM
        // now it will not be on the next try either. A real run showed three
        // identical warnings ~8s apart per attachment for exactly this case.
        Logger.warn(`      [Strategy: UI Click] Could not find clickable element for ${attachId}`);
        return { ok: false, elementMissing: true };
    }

    Logger.info(`      [Strategy: UI Click] Triggering double click and waiting for download event...`);
    try {
        await link.scrollIntoViewIfNeeded();

        // Listen for BOTH download and popup with a generous timeout
        const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
        const popupPromise = page.waitForEvent('popup', { timeout: 30000 }).catch(() => null);

        // Perform double click (some OneNote elements need it)
        await link.dblclick({ force: true, delay: 200 });

        // Check for "Download" confirmation dialog (DOM-based)
        // OneNote often shows a "Download File" modal with a "Download" button
        try {
            // OneNote often shows a "Download File" modal with a "Download" button
            // We search broadly for a Download button in the page or frame
            //const downloadBtnSelector = 'button[name="Download"], button[aria-label="Download"], button:has-text("Download"), .ms-Button--primary:has-text("Download")';
            const downloadBtnSelector = 'button[name="Download"], button[aria-label="Download"], button:has-text("Download"), .ms-Button--primary:has-text("Download")';

            // Wait a moment for dynamic UI to react
            Logger.info('Will wait 2 seconds to let the confirmation dialog load.');
            await page.waitForTimeout(2000);

            // Using locators to find visible button
            const btn = page.locator(downloadBtnSelector).filter({ visible: true }).first();
            const btnInFrame = contentFrame.locator(downloadBtnSelector).filter({ visible: true }).first();

            if (await btn.isVisible()) {
                Logger.info(`      [Strategy: UI Click] Found confirmation button on page, clicking...`);
                await btn.click();
            } else if (await btnInFrame.isVisible()) {
                Logger.info(`      [Strategy: UI Click] Found confirmation button in frame, clicking...`);
                await btnInFrame.click();
            }
        } catch (e) {
            // Not a silent skip any more: this catch is why a real failure here
            // was invisible for hours. A 2026-09-28 run spent 90s per attachment
            // re-running this path and never once logged why the confirmation was
            // not clicked, because the exception explaining exactly that was
            // thrown away here.
            Logger.debug(`      [Strategy: UI Click] Confirmation handling threw: ${e.message.split('\n')[0]}`);
        }

        // Race the events
        const result = await Promise.race([
            downloadPromise.then(d => d ? { type: 'download', value: d } : { type: 'timeout' }),
            popupPromise.then(p => p ? { type: 'popup', value: p } : { type: 'timeout' }),
            new Promise(r => setTimeout(() => r({ type: 'timeout' }), 10000))
        ]);

        if (result.type === 'download') {
            await result.value.saveAs(outputPath);
            return { ok: true, elementMissing: false };
        } else if (result.type === 'popup') {
            const popup = result.value;
            const popupUrl = popup.url();

            // If the popup opened a viewer, try forcing download there
            if (popupUrl.includes('sharepoint.com') || popupUrl.includes('onedrive.live.com')) {
                const separator = popupUrl.includes('?') ? '&' : '?';
                const forcedUrl = popupUrl + (popupUrl.includes('download=1') ? '' : separator + 'download=1');

                try {
                    // Start navigation and wait for download in parallel with higher timeout
                    const [download] = await Promise.all([
                        page.waitForEvent('download', { timeout: 30000 }),
                        popup.goto(forcedUrl).catch(e => {
                            if (!e.message.includes('Download is starting') && !e.message.includes('navigation was aborted')) {
                                throw e;
                            }
                        })
                    ]);
                    await download.saveAs(outputPath);
                    await popup.close().catch(() => null);
                    return { ok: true, elementMissing: false };
                } catch (e) {
                    await popup.close().catch(() => null);
                }
            } else {
                await popup.close().catch(() => null);
            }
        }
    } catch (e) {
        Logger.debug(`      UI click strategy failed for ${attachId}: ${e.message}`);
    }
    // The element existed and was clicked, so this failure is worth retrying.
    return { ok: false, elementMissing: false };
}

/**
 * Main dispatcher for attachment downloads
 */
async function downloadAttachment(contentFrame, info, outputPath) {
    return withRetry(async () => {
        const page = contentFrame.page();
        const context = page.context();

        // 1. Try direct download (Cloud Page Navigation for SharePoint/OneDrive)
        //    Counted on entry, not on success: "entered 40 times, won 0" is the
        //    finding, and it is invisible if the count only happens on a win.
        recordAttempt(strategyStats, 'direct');
        if (await tryDirectDownload(page, info.src, outputPath)) {
            recordWin(strategyStats, 'direct');
            Logger.success(`      [Success] Downloaded via Strategy: Direct (Cloud Page)`);
            return true;
        }

        // 2. Try UI click
        recordAttempt(strategyStats, 'ui-click');
        const uiResult = await tryUIClick(contentFrame, info.id, outputPath);
        if (uiResult.ok) {
            recordWin(strategyStats, 'ui-click');
            Logger.success(`      [Success] Downloaded via Strategy: UI Click`);
            return true;
        }

        // 3. Fallback: direct request on the original URL (non-forced)
        if (info.src) {
            recordAttempt(strategyStats, 'fallback');
            Logger.info(`      [Strategy: Fallback] Attempting direct request...`);
            try {
                const response = await context.request.get(info.src, { timeout: 30000 });
                if (response.ok()) {
                    const contentType = response.headers()['content-type'] || '';
                    if (!contentType.includes('text/html')) {
                        await fs.writeFile(outputPath, await response.body());
                        recordWin(strategyStats, 'fallback');
                        Logger.success(`      [Success] Downloaded via Strategy: Fallback`);
                        return true;
                    }
                }
            } catch (e) {
                Logger.debug(`      Fallback direct request failed: ${e.message}`);
            }
        }

        recordFailure(strategyStats);
        const error = new Error(`All download strategies failed for ${info.originalName}`);

        // A missing clickable element is the one case where retrying is provably
        // pointless: no re-navigation or re-render happens between attempts, and
        // both other strategies do not depend on that element. Everything else
        // keeps the full retry budget, which the log shows is load-bearing for
        // the attachments that do succeed.
        if (uiResult.elementMissing) {
            throw permanent(error, 'clickable element never appeared in the DOM');
        }

        throw error;
    }, {
        maxAttempts: 3,
        initialDelayMs: 2000, // Longer delay for SharePoint redirects
        // A wall-clock budget, not just an attempt count. The three strategies
        // below each cost 10-15 seconds when they fail, so three attempts of
        // everything is ~90s per file, and a page with several attachments turns
        // a working export into one that looks hung. 30s per attachment is enough
        // for the strategy that actually works - the UI click downloads in about
        // 4s - and bounds the damage from the ones that never will.
        maxElapsedMs: 30000,
        operationName: `Download attachment ${info.originalName}`,
        silent: true
    }).catch(e => {
        Logger.error(`      Error: ${e.message}`);
        return false;
    });
}

module.exports = {
    downloadAttachment,
    // Exported so the export's summary can report them, and so tests can assert
    // the counters rather than parsing log output.
    getStrategyStats,
    resetStrategyStats
};
