const fs = require('fs-extra');
const path = require('path');

/**
 * OneNote DOM ids are UUID-based ('{1234...-...}{1}'); section and group ids
 * likewise. Anything much shorter is not a page identity - it is a fragment
 * that can occur by accident inside some query parameter - so it must never be
 * allowed to win a match.
 */
const MIN_ID_LENGTH = 20;

/**
 * True when an id is shaped like a real OneNote page/section/group id.
 *
 * @param {string} id - Candidate id from the map
 * @returns {boolean}
 */
function isPlausibleId(id) {
    if (!id || id === 'undefined' || id === 'null') return false;
    // A braced DOM id is trusted whatever its length.
    if (/^\{.+\}.*$/.test(id)) return true;
    const cleanId = id.replace(/^\{/, '').split('}')[0];
    return cleanId.length >= MIN_ID_LENGTH;
}

/**
 * Scores how well a pageId matches a link href. Higher is better; 0 means no
 * match.
 *
 * Ids appear in OneNote hrefs in several shapes: the raw DOM id
 * ('{UUID}{1}'), the bare UUID, or the UUID URL-encoded. Scoring them instead
 * of taking the first hit matters: `Object.keys(map).find(...)` used to return
 * whichever id happened to be registered first and appeared anywhere in the
 * href, so a short id that was merely a substring of some query parameter could
 * win and silently link to the wrong page.
 *
 * @param {string} id - Candidate page/section/group id from the map
 * @param {string} href - The link's href
 * @returns {number} Match score, 0 for no match
 */
function scoreId(id, href) {
    if (!isPlausibleId(id) || !href) return 0;

    // 1. Exact DOM id, including any {n} suffix - the strongest signal.
    if (href.includes(id)) return 300 + id.length;

    // 2. URL-encoded exact id.
    if (href.includes(encodeURIComponent(id))) return 200 + id.length;

    // 3. The bare UUID behind '{UUID}{n}'.
    const cleanId = id.replace(/^\{/, '').split('}')[0];
    if (cleanId.length >= MIN_ID_LENGTH && href.includes(cleanId)) return 100 + cleanId.length;

    return 0;
}

/**
 * Finds the map key that best matches a link href.
 *
 * @param {Object} pageIdMap - Map of page/section ids to their metadata
 * @param {string} href - The link's href
 * @returns {string|undefined} The best matching id, if any
 */
function findTargetById(pageIdMap, href) {
    let bestId;
    let bestScore = 0;

    for (const id of Object.keys(pageIdMap)) {
        const score = scoreId(id, href);
        if (score > bestScore) {
            bestScore = score;
            bestId = id;
        }
    }

    return bestId;
}

/**
 * Turns a filesystem path into a vault-relative Obsidian link path.
 * Obsidian always uses forward slashes, but path.relative yields backslashes on
 * Windows, which produced broken links there.
 *
 * @param {string} from - Directory to make the path relative to
 * @param {string} to - Target file or directory
 * @returns {string} Relative path using forward slashes
 */
function toLinkPath(from, to) {
    return path.relative(from, to).split(path.sep).join('/').replace(/\\/g, '/');
}

/**
 * Resolves internal OneNote links to Obsidian wikilinks
 * @param {Object} pageIdMap - Map of page IDs to their metadata
 * @param {string} outputBase - Base output directory (notebook root)
 * @returns {Promise<{resolved: number, unresolved: number}>} Counts for the run summary
 */
async function resolveInternalLinks(pageIdMap, outputBase) {
    let resolved = 0;
    let unresolved = 0;

    for (const [pageId, info] of Object.entries(pageIdMap)) {
        if (info.isDir) continue;

        let content = await fs.readFile(info.path, 'utf8');
        let modified = false;

        for (const link of info.internalLinks || []) {
            // Try to find the target item (page, section, or group) in our map
            let targetId = findTargetById(pageIdMap, link.href);

            // 3. Fallback: Path-based matching for onenote: links
            // Example page: onenote:Group\Section.one#Page&...
            // Example section: onenote:Section.one#section-id={...}&end
            if (!targetId && link.href && link.href.includes('onenote:')) {
                const parts = link.href.split('#');
                if (parts.length > 1) {
                    try {
                        const hierarchy = decodeURIComponent(parts[0].replace('onenote:', '').replace(/\\/g, '/')).replace(/\.one$/, '');
                        const fragment = decodeURIComponent(parts[1]);

                        let fullTargetPath;
                        if (fragment.startsWith('section-id=')) {
                            // Link to a section/folder
                            fullTargetPath = hierarchy.toLowerCase();
                        } else {
                            // Link to a page
                            const pageName = fragment.split('&')[0];
                            fullTargetPath = hierarchy ? `${hierarchy}/${pageName}`.toLowerCase() : pageName.toLowerCase();
                        }

                        targetId = Object.keys(pageIdMap).find(id => {
                            const info = pageIdMap[id];
                            const relToVault = toLinkPath(outputBase, info.path).replace(/\.md$/, '').toLowerCase();
                            // Match either the full path or just the end (if sections are deeply nested)
                            return relToVault === fullTargetPath || relToVault.endsWith('/' + fullTargetPath);
                        });
                    } catch (e) {
                        // Ignore parsing errors
                    }
                }
            }

            if (targetId && targetId !== pageId) {
                const targetInfo = pageIdMap[targetId];

                // Use path relative to the Output Base (Notebook Root)
                // This creates "Absolute in Vault" style links: [[Group/Section/Page]]
                const relPath = toLinkPath(outputBase, targetInfo.path);

                // Avoid .md extension for Wikilinks to files
                const cleanPath = targetInfo.isDir ? relPath : relPath.replace(/\.md$/, '');

                // A link OneNote rendered without any text (a bare icon, say)
                // must not produce an empty alias: fall back to the target name.
                const text = (link.text || '').trim();
                const replacement = text ? `[[${cleanPath}|${text}]]` : `[[${cleanPath}]]`;

                // IMPORTANT: Use a non-capturing group for the bracketed text because
                // Turndown might have escaped characters (like _ to \_) inside it.
                // We target the unique onenote-link ID instead.
                const placeholderRegex = new RegExp(`\\[\\[.*?\\]\\]<!-- onenote-link:${link.id} -->`, 'g');

                if (placeholderRegex.test(content)) {
                    content = content.replace(placeholderRegex, replacement);
                    modified = true;
                    resolved++;
                    continue;
                }
            }

            unresolved++;
        }

        // Cleanup: Remove any remaining onenote-link comments (for links that weren't resolved)
        // Also remove the comments for successfully resolved links if the regex above didn't catch them all (it should have replaced the whole block)
        // But specifically for UNRESOLVED links, we want to keep the text but remove the comment.
        // The structure for unresolved is likely: [[Link Text]]<!-- onenote-link:id -->
        // We just want to remove the comment part globally.
        if (content.includes('<!-- onenote-link:')) {
            content = content.replace(/<!-- onenote-link:.*? -->/g, '');
            modified = true;
        }

        if (modified) {
            await fs.writeFile(info.path, content);
        }
    }

    return { resolved, unresolved };
}

module.exports = { resolveInternalLinks };
