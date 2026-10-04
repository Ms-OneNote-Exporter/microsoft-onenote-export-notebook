/**
 * diagnose-notebook.js
 *
 * Diagnostic script: opens a specific OneNote notebook (by name or link),
 * waits for it to fully load, then dumps all frame URLs, screenshots,
 * and DOM analysis to help identify the correct CSS selectors for
 * section/page scraping.
 *
 * Usage:
 *   node src/diagnose-notebook.js --auth-file <path> --notebook <name>
 *   node src/diagnose-notebook.js --auth-file <path> --notebook-link <url>
 */
const fs = require('fs-extra');
const path = require('path');
const { program, InvalidArgumentError } = require('commander');
const { listNotebooks, openNotebook, openNotebookByLink } = require('./navigator');

/**
 * Rejects `--wait nonsense` at the point it is read.
 *
 * The old parser did `parseInt(get('--wait') || '15')`, which turned `--wait abc`
 * into NaN and then printed `Extra wait after open: NaNs` - a diagnostic that waits
 * for NaN seconds and says so. commander can do this in the parser it is given.
 *
 * @param {string} value - As typed
 * @returns {string} The whole seconds, as a string for commander
 */
function seconds(value) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 0) {
        throw new InvalidArgumentError('Expected a number of seconds.');
    }
    return String(n);
}

// F-43: this used to hand-roll `process.argv` - a `get(flag)` helper and a
// `if (!authFile) { console.error(...); process.exit(1) }` block at module scope -
// while `commander` is already a dependency and already does exactly this for
// src/index.js. The hand-rolled version reported a missing flag as exit 1, the same
// code as a genuine failure, and accepted `--notebook-link` with no value as if it
// had been given one.
program
    .name('diagnose-notebook')
    .description('Dump a notebook\'s frames, screenshot and DOM shape for selector work.')
    .requiredOption('--auth-file <path>', 'Path to authentication JSON file')
    .option('--notebook <name>', 'Notebook to open, by name')
    .option('--notebook-link <url>', 'Notebook to open, by its OneNote URL')
    .option('--wait <seconds>', 'Extra seconds to wait after the notebook opens', seconds, '15')
    .parse(process.argv);

const opts = program.opts();
const authFile = opts.authFile;
const notebookName = opts.notebook;
const notebookLink = opts.notebookLink;
const extraWait = Number.parseInt(opts.wait, 10);

// A usage error rather than a diagnostic result, and still at module scope: this is
// argument validation, and `diagnoseNotebook` below is where a real failure is
// reported. commander exits 1 for it, which is what this script always did - the
// improvement is the message and the strictness, not the code.
if (!notebookName && !notebookLink) {
    program.error('give either --notebook <name> or --notebook-link <url>');
}

const DUMP_DIR = path.resolve(__dirname, '../diag-dumps');

// CSS class fragments likely to appear in the section/page navigation panel
const SECTION_HINTS = [
    'sectionList', 'sectionGroup', 'sectionItem', 'navItem', 'pageList',
    'pageNode', 'notebook', 'section', 'nav', 'tree', 'panel', 'sidebar',
    'LeftNav', 'leftNav', 'leftpane', 'LeftPane', 'NavigationPane'
];

async function diagnoseNotebook() {
    await fs.ensureDir(DUMP_DIR);
    console.log(`[DIAG] Dump directory: ${DUMP_DIR}`);
    console.log(`[DIAG] Extra wait after open: ${extraWait}s`);

    let session;

    if (notebookLink) {
        console.log(`[DIAG] Opening notebook by link: ${notebookLink}`);
        session = await openNotebookByLink({ authFile, notebookLink, notheadless: true });
    } else {
        console.log('[DIAG] Listing notebooks to find:', notebookName);
        session = await listNotebooks({ authFile, notheadless: true, keepOpen: true });
        const { notebooks, browser, context, page } = session;
        console.log(`[DIAG] Found ${notebooks.length} notebooks.`);

        const nb = notebooks.find(n => n.name === notebookName);
        if (!nb) {
            console.error(`[DIAG] Notebook "${notebookName}" not found. Available:`, notebooks.map(n => n.name));
            await browser.close();
            // Thrown, not exited. F-43: this used to be `process.exit(1)` in the
            // middle of the function, which meant the code below it - and the
            // browser cleanup above - were unreachable to anything reading the file,
            // and a test could not exercise the path without killing the runner. The
            // handler at the bottom turns it back into a non-zero exit.
            throw new Error(`notebook "${notebookName}" is not in this account`);
        }

        console.log(`[DIAG] Opening notebook: ${nb.name} (id: ${nb.id})`);

        // openNotebook(listingPage, context, browser, notebookId) returns a NEW
        // session whose `page` is the editor tab the click opened. Keep that page:
        // the listing page has no section list, so every frame dump below would
        // otherwise be taken from the wrong document.
        session = await openNotebook(page, context, browser, nb.id, nb.name);
    }

    const { browser, page } = session;

    console.log(`[DIAG] Waiting ${extraWait} seconds for OneNote editor to fully load...`);
    await page.waitForTimeout(extraWait * 1000);

    // ── 1. Screenshot ────────────────────────────────────────────────────────
    const screenshotPath = path.join(DUMP_DIR, 'diag_notebook_screenshot.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`[DIAG] Screenshot: ${screenshotPath}`);

    // ── 2. List all frames ───────────────────────────────────────────────────
    const frames = page.frames();
    console.log(`\n[DIAG] === FRAMES (${frames.length}) ===`);
    for (const [i, f] of frames.entries()) {
        console.log(`  [${i}] url=${f.url().substring(0, 120)}`);
    }

    // ── 3. For each frame: dump HTML + find section-related classes ──────────
    for (const [i, f] of frames.entries()) {
        const frameLabel = `frame_${i}`;
        const frameUrl = f.url();

        let html = '';
        try {
            html = await f.content();
        } catch (e) {
            console.log(`  [${i}] Could not get content (${e.message})`);
            continue;
        }

        // Save HTML
        const htmlPath = path.join(DUMP_DIR, `diag_${frameLabel}.html`);
        await fs.writeFile(htmlPath, html);
        console.log(`\n  [${i}] url=${frameUrl.substring(0, 100)}`);
        console.log(`       HTML dumped: ${htmlPath} (${html.length} chars)`);

        // Evaluate DOM inside frame
        let analysis;
        try {
            analysis = await f.evaluate((hints) => {
                const result = {};

                // Find all classes in the document that contain any of the hint words
                const allClasses = new Set();
                document.querySelectorAll('*').forEach(el => {
                    if (el.className && typeof el.className === 'string') {
                        el.className.split(/\s+/).forEach(c => {
                            if (c && hints.some(h => c.toLowerCase().includes(h.toLowerCase()))) {
                                allClasses.add(c);
                            }
                        });
                    }
                });
                result.matchingClasses = [...allClasses].sort();

                // Find all ARIA roles
                result.roles = [...new Set(
                    Array.from(document.querySelectorAll('[role]')).map(e => e.getAttribute('role'))
                )].sort();

                // Find elements with IDs containing section/page hints
                result.hintIds = Array.from(document.querySelectorAll('[id]'))
                    .filter(el => hints.some(h => el.id.toLowerCase().includes(h.toLowerCase())))
                    .map(el => ({ id: el.id, tag: el.tagName, className: (el.className || '').substring(0, 80) }))
                    .slice(0, 30);

                // Body text snippet (to verify content is loaded)
                result.bodyText = document.body ? document.body.innerText.substring(0, 500) : '(no body)';

                return result;
            }, SECTION_HINTS);
        } catch (e) {
            console.log(`       Could not evaluate frame DOM: ${e.message}`);
            continue;
        }

        const analysisPath = path.join(DUMP_DIR, `diag_${frameLabel}_analysis.json`);
        await fs.writeFile(analysisPath, JSON.stringify(analysis, null, 2));

        console.log(`       Matching classes: ${analysis.matchingClasses.join(', ') || '(none)'}`);
        console.log(`       ARIA roles: ${analysis.roles.join(', ') || '(none)'}`);
        if (analysis.hintIds.length > 0) {
            console.log(`       IDs matching hints: ${analysis.hintIds.map(x => x.id).join(', ')}`);
        }
        console.log(`       Body text: ${analysis.bodyText.substring(0, 150).replace(/\n/g, ' ')}`);
    }

    // ── 4. Also check main page for specific selectors ───────────────────────
    console.log('\n[DIAG] === CHECKING KEY SELECTORS ON MAIN PAGE ===');
    const checkSelectors = [
        '.sectionList', '[class*="sectionList"]',
        '.sectionListItem', '[class*="sectionListItem"]',
        '.sectionGroup', '[class*="sectionGroup"]',
        '.navItem', '[class*="navItem"]',
        '.pageNode', '[class*="pageNode"]',
        '.pageList', '[class*="pageList"]',
        '[role="tree"]', '[role="treeitem"]',
        '[role="navigation"]',
        '#NavPaneSectionList', '#SectionList', '#PageList',
        '.LeftNav', '[class*="LeftNav"]',
        '[class*="leftNav"]', '[class*="leftpane"]',
    ];

    for (const sel of checkSelectors) {
        try {
            const count = await page.$$eval(sel, els => els.length);
            if (count > 0) {
                const samples = await page.$$eval(sel, (els) => els.slice(0, 3).map(el => ({
                    tag: el.tagName,
                    id: el.id || '',
                    class: (el.className || '').substring(0, 100),
                    text: (el.innerText || '').substring(0, 80).replace(/\n/g, ' '),
                })));
                console.log(`  ✓ ${sel} → ${count} elements`);
                samples.forEach((s, i) => console.log(`      [${i}] ${s.tag}#${s.id} .${s.class} "${s.text}"`));
            }
        } catch (e) {
            // ignore
        }
    }

    await browser.close();
    console.log('\n[DIAG] Done! Review files in:', DUMP_DIR);
}

diagnoseNotebook().catch(err => {
    console.error('[DIAG] Fatal error:', err.message);
    // `exitCode`, not `exit(1)`: the browser may still be closing, and killing the
    // process here would truncate whatever it was writing. Same reasoning as the
    // unhandled-rejection guard in src/index.js (F-56).
    process.exitCode = 1;
});
