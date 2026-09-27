const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

/**
 * Creates a configured TurndownService instance with OneNote-specific rules
 * @returns {TurndownService} Configured Turndown instance
 */
function createMarkdownConverter() {
    const td = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced'
    });
    td.use(gfm);

    // Rule to handle images with our custom data-local-src attribute (Obsidian style)
    td.addRule('localImages', {
        filter: (node) => node.nodeName === 'IMG' && node.getAttribute('data-local-src'),
        replacement: (content, node) => {
            const localId = node.getAttribute('data-local-src');
            return `![[assets/${localId}.png]]`;
        }
    });

    // Rule for local file attachments (Obsidian style)
    td.addRule('localFiles', {
        filter: (node) => node.getAttribute('data-local-file'),
        replacement: (content, node) => {
            const localName = node.getAttribute('data-local-file');
            // If localName already has a dot, use it directly (it's the full final name)
            if (localName.includes('.')) {
                return `[[assets/${localName}]]`;
            }
            // Otherwise try to append extension from filename attribute
            const originalName = node.getAttribute('data-filename') || node.innerText.trim() || 'file';
            const ext = originalName.includes('.') ? originalName.split('.').pop() : 'bin';
            return `[[assets/${localName}.${ext}]]`;
        }
    });

    // Rule for internal cross-links
    td.addRule('internalLinks', {
        filter: (node) => node.nodeName === 'A' && node.getAttribute('data-internal-link'),
        replacement: (content, node) => {
            const linkId = node.getAttribute('data-internal-link');
            // OneNote renders plenty of links as a bare icon with no text. Using
            // the href as the placeholder keeps the link resolvable, and the
            // marker lets linkResolver swap in the real target and name.
            const text = node.innerText.trim() || node.getAttribute('href') || 'link';
            // Use a specific marker for post-processing
            return `[[${text}]]<!-- onenote-link:${linkId} -->`;
        }
    });

    // Rule for YouTube/Vimeo embeds
    td.addRule('embeds', {
        filter: (node) => node.nodeName === 'IFRAME' && node.getAttribute('data-embed-id'),
        replacement: (content, node) => {
            const src = node.getAttribute('src');
            // Convert embed URLs back to watch URLs if possible
            let url = src;
            if (src.includes('youtube.com/embed/')) {
                url = src.replace('youtube.com/embed/', 'youtube.com/watch?v=');
            } else if (src.includes('player.vimeo.com/video/')) {
                url = src.replace('player.vimeo.com/video/', 'vimeo.com/');
            }
            return `\n\n[Video Link](${url})\n\n`;
        }
    });

    // Rule for local videos with data-local-video (Obsidian style)
    td.addRule('localVideos', {
        filter: (node) => node.nodeName === 'VIDEO' && node.getAttribute('data-local-video'),
        replacement: (content, node) => {
            const localId = node.getAttribute('data-local-video');
            // exporter.js derives the extension from the video URL and rewrites
            // this attribute to the final file name, extension included. Only
            // fall back to .mp4 when nothing carries one, otherwise every
            // non-mp4 video exported a dead link.
            const fileName = localId.includes('.') ? localId : `${localId}.mp4`;
            return `\n\n![[assets/${fileName}]]\n\n`;
        }
    });

    // Rule for Strikethrough (OneNote specific)
    td.addRule('strikethrough', {
        filter: (node) => {
            const classes = typeof node.className === 'string' ? node.className : '';
            const style = node.getAttribute('style') || '';
            return classes.includes('Strikethrough') || style.includes('text-decoration: line-through');
        },
        replacement: (content) => `~~${content}~~`
    });

    // Rule to ignore OneNote table junk (resize handles, hover UI, etc.)
    td.addRule('ignoreTableJunk', {
        filter: (node) => {
            const classes = node.className || '';
            // REMOVED 'RelativeElementContainer' as it often wraps images we want to keep
            // REMOVED 'role="presentation"' as it is used for image containers
            return classes.includes('TableHover') ||
                classes.includes('TableInsertRowGap') ||
                classes.includes('TableColumnHandle') ||
                classes.includes('TableColumnWidthSpacer') ||
                classes.includes('TableColumnResizeHandle');
        },
        replacement: () => ''
    });

    // Rule for OutlineContainer to ensure block separation
    td.addRule('outlines', {
        filter: (node) => typeof node.className === 'string' && node.className.includes('OutlineContainer'),
        replacement: (content) => `\n\n${content}\n\n`
    });

    // Ensure table cells are treated as such even with weird roles
    td.addRule('tableCells', {
        filter: (node) => (node.nodeName === 'TD' || node.nodeName === 'TH') ||
            (node.getAttribute('role') === 'rowheader' || node.getAttribute('role') === 'columnheader'),
        replacement: function (content) {
            // Trim and ensure no newlines inside cells for GFM compat, then
            // escape any literal pipe. An unescaped '|' silently adds a column
            // and shifts every cell after it, so a note containing "a | b" was
            // being corrupted. The lookbehind skips a pipe that is already
            // escaped. Known limit: Turndown has already escaped any literal
            // backslash by the time content reaches here, so source text that
            // is literally `\|` still ends up with an odd number of
            // backslashes. That is vanishingly rare in a table cell and not
            // worth contorting the rule for.
            const text = content.replace(/\s+/g, ' ').trim().replace(/(?<!\\)\|/g, '\\|');
            return '| ' + text + ' ';
        }
    });

    // We need a custom table row rule because OneNote doesn't always use standard table structures
    td.addRule('tableRow', {
        filter: 'tr',
        replacement: function (content, node) {
            let result = content + '|\n';
            // If it's the first row, add the GFM separator
            const isFirstRow = node === node.parentElement.firstElementChild;
            if (isFirstRow) {
                const cells = node.querySelectorAll('td, th, [role*="header"]');
                result += '|' + Array.from(cells).map(() => ' --- ').join('|') + '|\n';
            }
            return result;
        }
    });

    // Custom table rule to just wrap the content
    td.addRule('table', {
        filter: 'table',
        replacement: function (content) {
            return '\n\n' + content + '\n\n';
        }
    });

    return td;
}

module.exports = { createMarkdownConverter };
