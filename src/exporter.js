const { Select } = require('enquirer');
const logger = require('./utils/logger');
const { listNotebooks, openNotebook, openNotebookByLink } = require('./navigator');
const { getSections, getPages, selectSection, selectPage, getPageContent, navigateBack, isSectionLocked } = require('./scrapers');
const { createMarkdownConverter } = require('./parser');
const { resolveInternalLinks } = require('./linkResolver');
const { withRetry, permanent } = require('./utils/retry');
const { classifyFetchTarget } = require('./utils/fetchHosts');
const { createNotebookSession, NotebookUnavailableError } = require('./notebookFrame');
const readline = require('readline');
const fs = require('fs-extra');
const path = require('path');

const { downloadAttachment } = require('./downloadStrategies');
const { safeName, uniqueName } = require('./utils/naming');

// Reads a blob: URL from inside the page and returns it as base64.
//
// A blob: URL is not a network address: it only resolves in the document that
// created it, so Playwright's APIRequestContext (which only speaks http/https)
// rejects it with `Protocol "blob:" not supported`. OneNote uses blob: URLs for
// images it renders inline - printouts especially - so they have to be read
// through the page itself: fetch, then FileReader to get bytes out.
//
// @param {import('playwright').Page} page - Page that owns the blob
// @param {string} url - The blob: URL
// @returns {Promise<Buffer>} The blob's bytes
async function readBlobInPage(page, url) {
    const dataUrl = await page.evaluate(async (blobUrl) => {
        const response = await fetch(blobUrl);
        if (!response.ok) throw new Error(`blob fetch failed: ${response.status}`);

        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('FileReader failed'));
            reader.readAsDataURL(blob);
        });
    }, url);

    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        throw new Error('Page did not return a data URL for the blob');
    }

    const commaAt = dataUrl.indexOf(',');
    if (commaAt === -1) {
        throw new Error('Malformed data URL returned for the blob');
    }
    return Buffer.from(dataUrl.slice(commaAt + 1), 'base64');
}

/** Hosts already warned about, so one notebook cannot flood the log. */
const warnedFetchHosts = new Set();

/**
 * Warns when a page-supplied URL points somewhere unexpected.
 *
 * The request is still made: refusing would risk silently dropping legitimate
 * attachments from a host not on the list (see src/utils/fetchHosts.js for why an
 * allowlist was rejected). The point is that it becomes visible.
 *
 * @param {string} url - The URL about to be fetched with the authenticated context
 * @returns {void}
 */
function warnOnUnexpectedHost(url) {
    const { host, expected, reason } = classifyFetchTarget(url);
    if (expected || !host || warnedFetchHosts.has(host)) return;

    warnedFetchHosts.add(host);
    logger.warn(
        `Fetching "${host}", which is ${reason}. This request is made with your ` +
        'signed-in session, so it carries your OneDrive/SharePoint credentials. ' +
        'If you did not expect this, check the note for external links.'
    );
}

// Download a resource (image, video) via HTTP request with retry logic
// options.timeout  - HTTP request timeout in ms (default 60 000)
// options.onError  - optional (msg) => void callback called on final failure
async function downloadResource(page, url, outputPath, options = {}) {
    const { timeout = 60000, onError } = options;
    return withRetry(async () => {
        if (url.startsWith('data:')) {
            const matches = url.match(/^data:([A-Za-z+/-]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                const buffer = Buffer.from(matches[2], 'base64');
                await fs.writeFile(outputPath, buffer);
                return true;
            }
            // Not a base64 data URL. Decoding it as base64 would silently write
            // garbage, so fail loudly instead of producing a corrupt asset.
            // Retrying cannot change a malformed URL, so mark it permanent.
            throw permanent(
                new Error(`Unsupported data: URL (not base64): ${url.substring(0, 60)}…`),
                'malformed data: URL'
            );
        }

        // The request context speaks http/https only. blob: is handled below;
        // every other scheme (about:, ftp:, mailto:, a bare relative path) fails
        // identically on each attempt and used to burn the whole backoff.
        if (!/^https?:/i.test(url) && !url.startsWith('blob:')) {
            const protocol = (url.match(/^([a-z][a-z0-9+.-]*):/i) || [, 'none'])[1];
            throw permanent(
                new Error(`Unsupported URL protocol "${protocol}:": ${url.substring(0, 60)}…`),
                `unsupported protocol ${protocol}:`
            );
        }

        if (url.startsWith('blob:')) {
            await fs.writeFile(outputPath, await readBlobInPage(page, url));
            return true;
        }

        warnOnUnexpectedHost(url);

        const response = await page.context().request.get(url, { timeout });
        if (response.ok()) {
            await fs.writeFile(outputPath, await response.body());
            return true;
        }
        throw new Error(`Failed to download resource (HTTP ${response.status()}): ${url.substring(0, 100)}...`);

    }, {
        maxAttempts: 3,
        initialDelayMs: 1000,
        operationName: `Download resource`,
        silent: true
    }).catch((e) => {
        const shortUrl = url.substring(0, 80) + '…';
        const msg = `Download failed (${e.message.split('\n')[0]}): ${shortUrl}`;
        logger.error(msg);
        if (onError) onError(msg);
        return false;
    });
}

/**
 * True only when a human can actually answer a prompt.
 *
 * Containers, CI runners and service workers have no TTY attached. In that
 * situation `readline` and `enquirer` do not error — they wait forever, so an
 * unattended export hangs silently instead of failing. Every interactive branch
 * below is guarded with this.
 *
 * @returns {boolean}
 */
function hasTty() {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function waitForEnter(message) {
    if (!hasTty()) {
        return Promise.reject(new Error(
            'Refusing to wait for keyboard input: no terminal is attached to stdin. ' +
            'Re-run with --nopassasked to skip password-protected sections, ' +
            'or --non-interactive to fail fast on any prompt.'
        ));
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        rl.question(message, () => {
            rl.close();
            resolve();
        });
    });
}

/**
 * Statistics for one export run.
 *
 * The `failed*` counters exist because every per-item error is caught and the
 * run continues: without them a partially-failed export is indistinguishable
 * from a clean one.
 *
 * @returns {{totalPages: number, totalAssets: number, failedPages: number, failedSections: number, failedGroups: number}}
 */
function newStats() {
    return { totalPages: 0, totalAssets: 0, failedPages: 0, failedSections: 0, failedGroups: 0 };
}

async function processSections(contentFrame, outputDir, td, options, pageIdMap, processedItems = new Set(), parentId = null, stats = newStats()) {
    const sections = await getSections(contentFrame, parentId);
    if (sections.length === 0 && parentId) {
        // Inside a group, an empty result usually means the group container could
        // not be located, not that the group is empty. At debug level this made a
        // whole subtree disappear from the export without a word.
        logger.warn(
            `No items found inside group ${parentId}. If this group is not really empty, ` +
            'its sections were skipped - re-run with --dodump and check logs/dumps.'
        );
    } else if (sections.length === 0) {
        logger.warn('No sections or groups found at the top level. The notebook may be empty, or the OneNote DOM may have changed.');
    } else {
        logger.info(`Found ${sections.length} items at current level.`);
    }

    // Directory names already claimed at THIS level. Two sections can sanitise
    // to the same string ('A/B' and 'A:B' both become 'AB'), and without this
    // they would share one directory and interleave their pages and assets.
    const usedDirNames = new Set();

    for (const item of sections) {
        if (processedItems.has(item.id)) continue;

        if (item.type === 'group') {
            const groupName = uniqueName(safeName(item.name, 'Untitled group'), usedDirNames);
            const groupDir = path.join(outputDir, groupName);
            await fs.ensureDir(groupDir);

            // Map the Group ID to its directory for internal links
            pageIdMap[item.id] = { path: groupDir, isDir: true };
            processedItems.add(item.id);

            try {
                logger.info(`Entering group: ${item.name}`);
                await selectSection(contentFrame, item.id);
                logger.info('Will wait 5 seconds to let the document load properly');
                // Extra wait for the tree to expand
                await contentFrame.waitForTimeout(5000);

                if (options.dodump) {
                    const dumpDir = await logger.getDumpDir();
                    const dumpPath = path.join(dumpDir, `debug_group_${safeName(item.name, 'group')}.html`);
                    await fs.writeFile(dumpPath, await contentFrame.content());
                }
                await processSections(contentFrame, groupDir, td, options, pageIdMap, processedItems, item.id, stats);
                logger.info(`Returning from group: ${item.name}`);

                // navigateBack() frequently finds no control and returns false -
                // that is the NORMAL case, not a failure. Selection is done by
                // absolute [id="..."] selector, and OneNote keeps the whole section
                // tree in one DOM, so the next sibling is still reachable without
                // navigating back. An earlier version of this code threw here and
                // aborted every group on that basis, losing whole subtrees; a real
                // run (2026-09-28) showed 2 of 2 groups hitting it while still
                // exporting all 15 pages. So: note it and carry on.
                const wentBack = await navigateBack(contentFrame);
                if (!wentBack) {
                    logger.debug(
                        `No "Back" control found after "${item.name}"; continuing ` +
                        '(sections are selected by id, so this is harmless)'
                    );
                }

                logger.info('Will wait 3 seconds to let the frame load properly');
                await contentFrame.waitForTimeout(3000);
            } catch (e) {
                // A tab that is gone ends the whole walk. Catching it here would
                // keep the loop going and produce one "Failed to process group"
                // per remaining group, all repeating the same cause.
                if (e instanceof NotebookUnavailableError) throw e;

                stats.failedGroups++;
                logger.error(`Failed to process group ${item.name}:`, e);
            }
            continue;
        }

        // Processing regular Section
        try {
            await selectSection(contentFrame, item.id);
        } catch (e) {
            // See the group handler above: a dead tab is not one bad section.
            if (e instanceof NotebookUnavailableError) throw e;

            stats.failedSections++;
            logger.error(`Failed to select section ${item.name}:`, e);
            continue;
        }

        logger.info('Will wait 3 seconds to let the section load properly');
        await contentFrame.waitForTimeout(3000);

        // Check for password protection
        let isLocked = await isSectionLocked(contentFrame);

        // If locked, wait another 2s and re-check to avoid transition glitches from previous sections
        if (isLocked) {
            logger.info('Will wait 2 seconds to let the section frame load properly');
            await contentFrame.waitForTimeout(2000);
            isLocked = await isSectionLocked(contentFrame);
        }

        const baseSectionName = safeName(item.name, 'Untitled section');

        const isHeadless = !options.notheadless;
        if (isLocked && (options.nopassasked || isHeadless)) {
            if (isHeadless && !options.nopassasked) {
                logger.warn(`Section "${item.name}" is password protected.`);
                logger.warn(`The browser is running in headless mode, which means you cannot interact with it to unlock the section manually.`);
                logger.warn(`Acting as if --nopassasked was set: skipping this section.`);
            } else {
                logger.warn(`Section "${item.name}" appears password protected. Skipping as requested.`);
            }
            const protectedDir = path.join(outputDir, baseSectionName + ' [passProtected]');
            await fs.ensureDir(protectedDir);
            processedItems.add(item.id);
            continue;
        }

        const sectionDir = path.join(outputDir, uniqueName(baseSectionName, usedDirNames));
        await fs.ensureDir(sectionDir);

        // Map the Section ID to its directory for internal links
        pageIdMap[item.id] = { path: sectionDir, isDir: true };

        logger.step(`[Section] ${item.name}`);
        processedItems.add(item.id);

        while (isLocked) {
            if (!hasTty()) {
                throw new Error(
                    `Section "${item.name}" is password protected and cannot be unlocked without a terminal. ` +
                    'Re-run with --nopassasked to skip password-protected sections.'
                );
            }
            logger.warn(`Section "${item.name}" is password protected.`);
            logger.info('Please switch to the browser window, unlock the section manually, and then return here.');
            await waitForEnter('Press ENTER here once the section is unlocked to continue...');

            // Re-verify
            await contentFrame.waitForTimeout(2000);
            isLocked = await isSectionLocked(contentFrame);
            if (isLocked) {
                logger.error('Section still appears to be locked. Please try again.');
            }
        }

        const pages = await getPages(contentFrame);
        logger.info(`Found ${pages.length} pages. Starting extraction...`);

        // Track used filenames in this section to handle collisions
        const usedNames = new Set();

        // This section's assets/ directory. Every page in the section shares it,
        // so name reservations have to be shared too.
        const assetDir = path.join(sectionDir, 'assets');

        // Asset file names already claimed in this section's assets/ directory.
        // This is a within-run reservation, and it is what stops two attachments
        // that sanitise to the same name in one page from colliding.
        //
        // It deliberately does NOT consult the filesystem. It used to, which meant
        // re-running an export into the same output folder found the previous run's
        // files and wrote report.pdf_1, report.pdf_2, ... instead of refreshing
        // them, so a vault filled with near-duplicates after a few runs. Overwrite
        // is the default now: a name is claimed once per run, so a re-run replaces
        // the file with the current version. Files from a previous run that no
        // longer correspond to anything in the notebook are left alone - nothing
        // deletes them - which is why exportContent warns when the target folder
        // already exists.
        const usedAssetNames = new Set();

        /**
         * Picks an asset path, counting around names claimed earlier in this run.
         * @param {string} base - Desired file name without extension
         * @param {string} ext - File extension
         * @returns {string} Absolute path to write
         */
        const getUniqueAssetPath = (base, ext) => {
            const name = safeName(base, 'file');
            let candidate = `${name}.${ext}`;
            let counter = 1;
            while (usedAssetNames.has(candidate)) {
                candidate = `${name}_${counter++}.${ext}`;
            }
            usedAssetNames.add(candidate);
            return path.join(assetDir, candidate);
        };

        for (const pageInfo of pages) {
            // Deduplicate pages too
            if (processedItems.has(pageInfo.id)) continue;
            processedItems.add(pageInfo.id);

            logger.info(`Exporting: ${pageInfo.name} ...`);

            try {
                await selectPage(contentFrame, pageInfo.id);
                logger.info('Will wait 3 seconds for page to render');
                await contentFrame.waitForTimeout(3000);

                if (options.dodump) {
                    const dumpDir = await logger.getDumpDir();
                    const pageDumpPath = path.join(dumpDir, `debug_page_${safeName(pageInfo.name, 'page')}.html`);
                    await fs.writeFile(pageDumpPath, await contentFrame.content());
                }

                const content = await getPageContent(contentFrame);

                // Determine unique filename
                const baseName = safeName(pageInfo.name, 'Untitled');
                let sanitizedNoteName = baseName;
                let collisionCount = 1;
                while (usedNames.has(sanitizedNoteName)) {
                    sanitizedNoteName = `${baseName}_${collisionCount++}`;
                }
                usedNames.add(sanitizedNoteName);
                const totalAssets = (content.images?.length || 0) +
                    (content.attachments?.length || 0) +
                    (content.videos?.length || 0);

                let updatedHtml = content.contentHtml || '';
                let assetCounter = 1;

                // Rename and Download Resources
                let savedResources = 0;

                if (totalAssets > 0) {
                    await fs.ensureDir(assetDir);

                    // 1. Process Images (including Printouts)
                    for (const imgInfo of content.images || []) {
                        const finalBaseName = `${sanitizedNoteName}_img_${assetCounter++}`;
                        const imgPath = path.join(assetDir, `${finalBaseName}.png`);

                        updatedHtml = updatedHtml.replace(new RegExp(`data-local-src="${imgInfo.id}"`, 'g'), `data-local-src="${finalBaseName}"`);

                        const success = await downloadResource(contentFrame.page(), imgInfo.src, imgPath);
                        if (success) {
                            savedResources++;
                            logger.debug(`[Asset] Saved IMAGE to: ${path.relative(process.cwd(), imgPath)}`);
                        }
                    }

                    // 2. Process Attachments
                    for (const attachInfo of content.attachments || []) {
                        const originalName = attachInfo.originalName || 'file';
                        const baseName = originalName.includes('.') ? originalName.substring(0, originalName.lastIndexOf('.')) : originalName;
                        const ext = originalName.includes('.') ? originalName.split('.').pop() : 'bin';

                        const filePath = getUniqueAssetPath(baseName, ext);
                        const finalFileName = path.basename(filePath);

                        const escapedId = attachInfo.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        updatedHtml = updatedHtml.replace(
                            new RegExp(`data-local-file="${escapedId}"( data-filename="[^"]*")?`, 'g'),
                            `data-local-file="${finalFileName}" data-filename="${finalFileName}"`
                        );

                        const success = await downloadAttachment(contentFrame, attachInfo, filePath);
                        if (success) {
                            savedResources++;
                            logger.debug(`[Asset] Saved ATTACHMENT to: ${path.relative(process.cwd(), filePath)}`);
                        }
                    }

                    // 3. Process Videos
                    for (const videoInfo of content.videos || []) {
                        let ext = 'mp4';
                        if (videoInfo.src) {
                            try {
                                const urlObj = new URL(videoInfo.src);
                                const pathname = urlObj.pathname;
                                const potentialExt = pathname.split('.').pop();
                                if (potentialExt && potentialExt.length < 5 && /^[a-z0-9]+$/i.test(potentialExt)) {
                                    ext = potentialExt;
                                }
                            } catch (e) {
                                // Fallback
                            }
                        }

                        const finalBaseName = `${sanitizedNoteName}_video_${assetCounter++}`;
                        const finalFileName = `${finalBaseName}.${ext}`;
                        const filePath = path.join(assetDir, finalFileName);

                        // Stamp the FINAL file name, extension included: the
                        // Markdown rule links to this attribute verbatim, so
                        // leaving the extension off produced a dead link for
                        // every video that was not an .mp4.
                        updatedHtml = updatedHtml.replace(
                            new RegExp(`data-local-video="${videoInfo.id}"`, 'g'),
                            `data-local-video="${finalFileName}"`
                        );

                        const success = await downloadResource(contentFrame.page(), videoInfo.src, filePath);
                        if (success) {
                            savedResources++;
                            logger.debug(`[Asset] Saved VIDEO to: ${path.relative(process.cwd(), filePath)}`);
                        }
                    }
                }

                const markdown = td.turndown(updatedHtml);
                const fileName = sanitizedNoteName + '.md';
                const filePath = path.join(sectionDir, fileName);

                // Store page in map for cross-linking (relative to output base)
                pageIdMap[pageInfo.id] = {
                    path: filePath,
                    internalLinks: content.internalLinks,
                    isDir: false
                };

                const finalContent = `${content.dateTime}\n\n${markdown}`;

                await fs.writeFile(filePath, finalContent);
                stats.totalPages++;
                stats.totalAssets += savedResources;
                logger.success(`Saved (${savedResources} assets)`);

            } catch (e) {
                // Ditto: without this, a tab that dies on page 12 of 40 fails
                // pages 12-40 one by one, and the run takes minutes to give up on
                // something that cannot recover.
                if (e instanceof NotebookUnavailableError) throw e;

                stats.failedPages++;
                logger.error(`Failed to export ${pageInfo.name}:`, e);
            }
        }
    }
}

/**
 * Prints the end-of-run summary.
 *
 * A run in which items failed must not be announced with a bare "Export
 * complete!": every per-item error is caught so the export can continue, which
 * means a partial result used to look exactly like a clean one - and the
 * process exited 0 either way.
 *
 * @param {object} stats - Page/asset/failure counters
 * @param {{resolved: number, unresolved: number}} linkStats - Link resolution counts
 * @param {string} outputBase - Directory the notebook was written to
 * @param {string|null} [stoppedFor] - Why the walk ended early, if it did
 */
function reportSummary(stats, linkStats, outputBase, stoppedFor = null) {
    const failures = stats.failedPages + stats.failedSections + stats.failedGroups;

    if (failures === 0 && !stoppedFor) {
        logger.success('Export complete!');
    }

    if (stoppedFor) {
        // Never "Export complete!" for a run that was cut short. The counters are
        // there so a partial run cannot look like a clean one, and a tab that
        // disappeared is the most partial a run can be.
        logger.warn(`Export stopped early - ${stoppedFor}.`);
        logger.warn('  The totals below are what was written; the rest of the notebook was not exported.');
    }

    if (failures > 0) {
        logger.warn(`Export finished with errors - ${failures} item(s) could not be exported.`);
        if (stats.failedGroups) logger.warn(`  Groups   failed: ${stats.failedGroups}`);
        if (stats.failedSections) logger.warn(`  Sections failed: ${stats.failedSections}`);
        if (stats.failedPages) logger.warn(`  Pages    failed: ${stats.failedPages}`);
        logger.warn('  See the errors above and logs/app.log for details.');
    }

    logger.info(`Total Pages: ${stats.totalPages}`);
    logger.info(`Total Assets: ${stats.totalAssets}`);
    if (linkStats) {
        logger.info(`Internal links: ${linkStats.resolved} resolved, ${linkStats.unresolved} unresolved`);
    }
    logger.info(`Files saved in: ${outputBase}`);
}

/**
 * Locates the OneNote content frame inside an editor page.
 *
 * OneNote renders the notebook inside an iframe (onenoteframe.aspx on
 * officeapps.live.com), identified by holding `.sectionList`. The frames are
 * probed in turn because several may be cross-origin or already detached.
 *
 * Also handed to the notebook session as its lookup function, so a frame that
 * OneNote replaces during a reload can be found again - see notebookFrame.js.
 *
 * @param {import('playwright').Page} rootPage - Page whose frames to search
 * @param {object} [options] - Export options (honours `dodump`)
 * @returns {Promise<import('playwright').Frame|null>} The content frame, or null
 */
async function findContentFrame(rootPage, options = {}) {
    const frames = rootPage.frames();

    for (const f of frames) {
        try {
            const hasSections = await f.$('.sectionList');
            if (!hasSections) continue;

            logger.success(`Found content frame (navigation): ${f.url()}`);

            if (options.dodump) {
                const dumpDir = await logger.getDumpDir();
                const displayPath = logger.getDumpDisplayPath();
                logger.warn(`Dumping content frame HTML to ${displayPath}/debug_notebook_content.html...`);
                await fs.writeFile(path.join(dumpDir, 'debug_notebook_content.html'), await f.content());
            }
            return f;
        } catch (e) {
            // A frame can be cross-origin or already detached, in which case
            // probing it throws. That is expected while walking the frame list, so
            // keep going - but say so, because a frame we could not inspect is a
            // frame we might have missed.
            logger.debug(`Skipped an unreadable frame (${frames.length} total): ${e.message}`);
        }
    }

    return null;
}

/**
 * Warns when the notebook's output folder already has content in it.
 *
 * The export overwrites by default: a re-run replaces each file with the current
 * version rather than writing `report.pdf_1`, `report.pdf_2` and so on. That is
 * the useful behaviour for a re-export, and it is what was asked for - but it
 * should not happen silently, because a folder full of Markdown is someone's
 * notes.
 *
 * One caveat worth stating: files from a previous run that no longer correspond
 * to anything in the notebook are NOT removed. Deleting them automatically would
 * risk destroying hand-edits, so the stale files stay. Say so rather than let
 * someone assume the folder is now a mirror of the notebook.
 *
 * @param {string} outputBase - The notebook's output directory
 * @returns {boolean} True when the folder already existed with content
 */
function warnIfOutputExists(outputBase) {
    let entries;
    try {
        entries = fs.readdirSync(outputBase);
    } catch (e) {
        // Does not exist yet, or is unreadable: nothing to warn about.
        return false;
    }

    if (entries.length === 0) {
        return false;
    }

    logger.warn(`Output folder already exists: ${outputBase}`);
    logger.warn('  Existing Markdown and assets in it will be overwritten by this run.');
    logger.warn('  Files from a previous run that are no longer in the notebook are left in place,');
    logger.warn('  so this is a merge, not a clean mirror. Remove the folder first for a clean export.');
    return true;
}

/**
 * Runs the export against an already-open content frame.
 *
 * This is the half of `runExport` that used to be duplicated between the
 * --notebook-link fast path and the list-and-click path. Both are now one call.
 * The duplication was not cosmetic: the two copies had already drifted - one had
 * a 10s wait for `.sectionList` and a debug log for unreadable frames, the other
 * 15s and a silent empty catch - so a fix applied to one path silently missed
 * the other.
 *
 * @param {object} params
 * @param {import('playwright').Frame} params.contentFrame - Frame holding the notebook
 * @param {string} params.notebookName - Used for the output directory name
 * @param {object} params.options - Export options
 * @param {import('playwright').Page} [params.page] - Page hosting that frame, so a
 *   frame OneNote replaces can be found again. Omitted only by tests, which hand in
 *   a frame that stays put.
 * @param {Function} [params.findFrame] - `(page) => Frame|null`, used to re-locate it
 * @returns {Promise<object>} Export statistics
 * @throws {NotebookUnavailableError} If the editor tab goes away mid-export
 */
async function exportContent({ contentFrame, notebookName, options, page = null, findFrame = findContentFrame }) {
    const baseDir = options.exportDir || path.resolve(__dirname, '../output');
    const outputBase = path.resolve(baseDir, safeName(notebookName, 'Notebook'));

    // Checked before the directory is created, so an existing-but-empty folder
    // does not produce a warning.
    warnIfOutputExists(outputBase);

    await fs.ensureDir(outputBase);
    const td = createMarkdownConverter();

    // Every Playwright call below goes through this handle rather than through the
    // frame object that was found once, up front. That object expires: OneNote
    // replaces its WOPI frame on a reload, and the tab or its renderer can die
    // outright. Holding the page instead means a replaced frame is re-found and
    // the walk continues, and a dead tab ends the run with a stated cause instead
    // of a Playwright error raised from inside getSections().
    const notebook = createNotebookSession({ page, frame: contentFrame, find: findFrame });

    logger.info('Scanning sections...');
    try {
        // Check the tab first: if the editor is already gone, say so here rather
        // than letting the section-list wait report a dead tab as a slow DOM.
        await notebook.frame();
        await notebook.waitForSelector('.sectionList', { timeout: 15000 });
    } catch (e) {
        if (e instanceof NotebookUnavailableError) throw e;

        // Only a timeout means the DOM is slow. Anything else - a frame that went
        // away mid-wait, say - has a different cause, and calling all of them a
        // timeout sent the reader looking in the wrong place: a real 15s timeout
        // and an instant failure of a closed tab produced the same line.
        logger.warn(
            e.name === 'TimeoutError'
                ? 'Timeout waiting for .sectionList, trying to scrape anyway...'
                : `Could not confirm the section list is rendered (${String(e.message).split('\n')[0]}) - trying to scrape anyway...`
        );
    }

    const pageIdMap = {};
    const stats = newStats();

    let stopped = null;
    try {
        await processSections(notebook, outputBase, td, options, pageIdMap, new Set(), null, stats);
    } catch (e) {
        if (!(e instanceof NotebookUnavailableError)) throw e;

        // The walk stops, but the run still has to say what it managed to write:
        // summarising and fixing up links is filesystem work, and someone whose
        // tab died on page 12 of 40 needs to know those 12 are on disk. The error
        // itself is re-thrown below, so the run still ends as a failure.
        logger.warn('The OneNote editor tab went away, so the export stopped where it was.');
        stopped = e;
    }

    logger.info('Resolving internal links...');
    const linkStats = await resolveInternalLinks(pageIdMap, outputBase);

    reportSummary(stats, linkStats, outputBase, stopped ? 'the OneNote editor tab went away' : null);
    if (stopped) throw stopped;
    return stats;
}

/**
 * Main export function.
 *
 * @param {object} options
 * @param {string} options.authFile - Path to auth.json (required)
 * @param {string} [options.notebook] - Pre-select notebook by name
 * @param {string} [options.notebookLink] - Export directly by URL
 * @param {string} [options.exportDir] - Output directory (default: ./output)
 * @param {boolean} [options.notheadless] - Visible browser
 * @param {boolean} [options.dodump] - HTML debug dumps
 * @param {boolean} [options.nopassasked] - Skip password-protected sections
 * @returns {Promise<{totalPages: number, totalAssets: number}>} Export statistics
 * @throws {Error} If the export fails for any reason. The error is deliberately
 *   NOT swallowed: callers (and therefore the process exit code) must be able to
 *   tell a failed export from an empty one.
 */
async function runExport(options = {}) {
    let session;

    try {
        // ── Fast path: --notebook-link skips the listing entirely ────────────
        if (options.notebookLink) {
            logger.info('Notebook link provided — skipping notebook listing.');
            session = await openNotebookByLink(options);

            const notebookName = session.notebookName || 'Notebook';
            logger.info(`Exporting notebook: ${notebookName}`);

            logger.info('Will wait 10 seconds to let the OneNote content frame to load properly');
            await session.page.waitForTimeout(10000);

            const contentFrame = await findContentFrame(session.page, options) || session.page;
            if (contentFrame === session.page) {
                logger.warn('Could not auto-detect content frame. Using main page as fallback...');
            }

            // The `await` is the fix, and it is not a stylistic choice.
            //
            // `return somePromise` inside a `try` that has a `finally` does NOT
            // wait for that promise: the finally block runs the moment the return
            // expression is evaluated, and only then is the returned value
            // resolved. Writing `return exportContent(...)` therefore ran
            // `browser.close()` *before the export had made a single DOM call* -
            // which is exactly what happened on every run since 2807715 collapsed
            // the two paths into this helper (2026-09-28, six runs in a row:
            // `Found content frame` then, a second later, `Target page, context
            // or browser has been closed` out of getSections, with the browser
            // window sitting there fully rendered).
            //
            // Before that commit the tail was inlined and ended with `return
            // stats` - a value, not a promise - so the finally ran at the right
            // time and the same notebook exported all 19 pages at 12:17.
            //
            // Worth knowing: the project's own `no-return-await` rule does NOT
            // flag this, because it exempts `return await` inside a
            // try/finally for exactly this reason. So nothing in the toolchain
            // objects here, and the only thing standing between this and the
            // regression is a test - see test/runExportLifecycle.test.js.
            return await exportContent({ contentFrame, notebookName, options, page: session.page });
        }
        // ────────────────────────────────────────────────────────────────────

        logger.info('Fetching notebooks...');
        session = await listNotebooks({ ...options, keepOpen: true });

        const { notebooks } = session;

        if (notebooks.length === 0) {
            logger.warn('No notebooks have been found.');
            logger.warn('Remember: you can export a notebook by using the --notebook-link <url> option.');

            // A caller that named a notebook asked for a specific export. Finding
            // nothing is a failure for them, not a clean no-op, so it must not
            // exit 0 and look like a successful run.
            if (options.notebook) {
                throw new Error(
                    `Notebook "${options.notebook}" was not found: the notebook list came back empty. ` +
                    'Check the name, or use --notebook-link <url>.'
                );
            }
            return;
        }

        let selectedNotebook;

        if (options.notebook) {
            logger.info(`Auto-selecting notebook: "${options.notebook}"...`);
            selectedNotebook = notebooks.find(nb => nb.name === options.notebook);

            if (!selectedNotebook) {
                throw new Error(`Notebook "${options.notebook}" not found in list. Available: ${notebooks.map(n => n.name).join(', ')}`);
            }
        } else {
            if (!hasTty()) {
                throw new Error(
                    'Refusing to show the notebook picker: no terminal is attached to stdin. ' +
                    'Pass --notebook <name> or --notebook-link <url> to run unattended ' +
                    '(or --non-interactive to turn this into a startup error).'
                );
            }

            const prompt = new Select({
                name: 'notebook',
                message: 'Select a notebook to export:',
                choices: notebooks.map(nb => nb.name)
            });

            const answer = await prompt.run();
            selectedNotebook = notebooks.find(nb => nb.name === answer);
        }

        if (selectedNotebook) {
            logger.info(`You selected: ${selectedNotebook.name}`);

            // openNotebook now returns { browser, page: editorPage, context }
            // The editorPage is the new SharePoint OneNote editor tab (popup)
            const editorSession = await openNotebook(
                session.page,    // listing page
                session.context, // browser context (to capture the popup)
                session.browser, // browser
                selectedNotebook.id,
                selectedNotebook.name // verified before clicking, so a re-sorted
                                      // list cannot open the wrong notebook
            );

            const editorPage = editorSession.page;
            logger.success('Successfully entered notebook.');
            logger.success(`Editor URL: ${editorPage.url().substring(0, 100)}`);

            logger.info('Looking for OneNote content frame in editor...');
            const contentFrame = await findContentFrame(editorPage, options) || editorPage;
            if (contentFrame === editorPage) {
                logger.warn('Could not auto-detect content frame. Using editor page as fallback...');
            }

            // `await` here for the same reason as in the --notebook-link branch:
            // a bare `return` of the promise would run the finally - and so close
            // the browser - before the export started. See the long comment there.
            return await exportContent({
                contentFrame,
                notebookName: selectedNotebook.name,
                options,
                page: editorPage,
            });
        }

        // Only reachable when the notebook picker produced no selection, which
        // cannot happen: the picker either yields a notebook or throws.
        throw new Error('Export finished without selecting a notebook.');

    } finally {
        if (session && session.browser) {
            logger.debug('Closing browser...');
            await session.browser.close();
        }
    }
}

module.exports = {
    runExport,
    hasTty,
    reportSummary,
    newStats,
    // Exported for tests only: the asset pipeline (data:, blob:, http) is the
    // part most likely to regress and it cannot be reached from outside.
    downloadResourceForTest: downloadResource,
    // Exported for tests: the host classifier and the per-run warning memory, so a
    // test can assert both the verdict and that the warning is emitted once.
    classifyFetchTarget,
    __resetFetchHostWarnings: () => warnedFetchHosts.clear(),
    // Exported for tests: the shared half of an export, so the whole pipeline can
    // be run against a fixture without navigating to a real notebook.
    exportContent,
    findContentFrame,
};
