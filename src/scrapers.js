// NOTE: there is deliberately no `require('./utils/logger')` here. The DOM
// work in this file lives inside callbacks that Playwright serialises and runs
// in the browser, where a Node module is not in scope - calling the logger from
// there would throw. The consequence is that scraper diagnostics go to the
// browser console and never reach logs/app.log; the real fix is to return
// diagnostic data from evaluate() and log it on the Node side.
const { withRetry } = require('./utils/retry');

/**
 * Scrapes the list of sections and section groups from the current notebook view.
 * @param {object} frame - The Playwright frame object.
 * @returns {Promise<Array>} - List of items { id, name, type: 'section'|'group' }.
 */
async function getSections(frame, parentId = null) {
    return frame.evaluate((pid) => {
        const results = [];

        // Find the "root" of the search level
        let searchContainer = document.body;

        if (pid) {
            const parentNode = document.getElementById(pid);
            if (parentNode) {
                // Find the [role="group"] associated with this node.
                // In OneNote Web, it's often a sibling or nested below a wrapper.
                let groupContents = parentNode.querySelector('[role="group"]');

                if (!groupContents) {
                    // Check siblings of the parentNode or its ancestor (common row structure)
                    let current = parentNode;
                    // Walk up a few levels if needed to find the container that holds both header and group
                    for (let i = 0; i < 3 && current; i++) {
                        const siblingGroup = current.parentElement.querySelector(':scope > [role="group"]');
                        if (siblingGroup) {
                            groupContents = siblingGroup;
                            break;
                        }
                        // Or try next sibling directly
                        const next = current.nextElementSibling;
                        if (next && next.getAttribute('role') === 'group') {
                            groupContents = next;
                            break;
                        }
                        current = current.parentElement;
                    }
                }

                if (groupContents) {
                    searchContainer = groupContents;
                } else {
                    // Final fallback: look specifically for a container that looks like it belongs to us
                    const groupContainer = parentNode.closest('[class*="sectionGroupContainer"]');
                    const foundGroup = groupContainer ? groupContainer.querySelector('[role="group"]') : null;
                    if (foundGroup) {
                        searchContainer = foundGroup;
                    } else {
                        return [];
                    }
                }
            } else {
                return [];
            }
        }

        // Find all potential sections and groups in the container
        const allItems = Array.from(searchContainer.querySelectorAll('div[class*="sectionListItem"], div[class*="sectionGroup__groupItemWrap"]'));

        // Use parent-walking to find DIRECT children of this level
        const directItems = allItems.filter(item => {
            // Basic size check (ignore elements that are not rendered)
            if (item.offsetWidth === 0 && item.offsetHeight === 0) return false;

            // An item is a "direct child" if there is NO intermediate [role="group"] 
            // between it and the searchContainer.
            let p = item.parentElement;
            while (p && p !== searchContainer) {
                if (p.getAttribute('role') === 'group') return false;
                p = p.parentElement;
            }
            return true;
        });

        // Exclude breadcrumbs if at root
        const finalItems = directItems.filter(item => {
            if (!pid) {
                if (item.closest('[class*="Breadcrumb"]') || item.closest('[class*="breadcrumb"]')) return false;
            }
            return true;
        });

        finalItems.forEach(node => {
            if (!node.id) return;

            // Use classList for more robust class checking
            const isGroup = node.classList.contains('sectionGroup__groupItemWrap___L6X6Z') ||
                node.className.includes('sectionGroup__groupItemWrap');
            const id = node.id;
            let name = 'Unknown';

            if (isGroup) {
                const ariaLabel = node.getAttribute('aria-label');
                name = ariaLabel ? ariaLabel.split(', Section Group')[0].trim() : node.innerText.trim();
            } else {
                const ariaLabel = node.querySelector('.navItem')?.getAttribute('aria-label') || node.getAttribute('aria-label');
                name = ariaLabel ? ariaLabel.split(', Section')[0].trim() : node.innerText.trim();
            }

            results.push({ id, name, type: isGroup ? 'group' : 'section' });
        });


        return results;
    }, parentId);
}

/**
 * Scrapes the list of pages from the current section view.
 * @param {object} frame - The Playwright frame object.
 * @returns {Promise<Array>} - List of pages { id, name }.
 */
async function getPages(frame) {
    // Selector based on debug dump
    // Container: #PageList
    // Item: .pageNode -> .pageListItem
    // We can target .pageNode directly to get the ID from it, or .pageListItem
    // dump: <div class="pageNode" id="{UUID}{1}"> ... <div class="pageListItem"> ... aria-label="Untitled Page, Page..."

    const pages = await frame.$$eval('.pageNode', nodes => {
        return nodes.map(node => {
            const id = node.id;
            const listItem = node.querySelector('.pageListItem');
            let name = 'Untitled Page';

            if (listItem) {
                const navItem = listItem.querySelector('.navItem');
                if (navItem) {
                    let label = navItem.getAttribute('aria-label') || navItem.innerText.trim() || '';

                    // 1. Strip accessibility verbose suffix (e.g. ", Page. Selected...", ", Page. Select...")
                    // We look for ", Page." followed by "Select" logic
                    label = label.replace(/,\s*Page\.?\s*Select.*$/i, '');

                    // 2. Strip standard "page X of Y" suffix
                    // Matches: ", Page 1 of 3"
                    label = label.replace(/[,]?\s*Page\s+\d+\s+of\s+\d+\s*$/i, '');

                    name = label.trim();
                    if (!name) name = 'Untitled Page';
                }
            }
            return { id, name };
        });

    });
    return pages;
}

/**
 * Selects a section by ID with retry logic.
 * @param {object} frame 
 * @param {string} sectionId 
 */
async function selectSection(frame, sectionId) {
    return withRetry(async () => {
        const sectionSelector = `[id="${sectionId}"]`;
        const wrapper = await frame.$(sectionSelector);

        if (wrapper) {
            await wrapper.scrollIntoViewIfNeeded();

            // Try clicking the navItem inside first
            const navItem = await wrapper.$('.navItem');
            if (navItem) {
                await navItem.click();
            } else {
                // Fallback to clicking the wrapper itself
                await wrapper.click();
            }
        } else {
            throw new Error(`Section wrapper not found for ID: ${sectionId}`);
        }
    }, {
        maxAttempts: 3,
        initialDelayMs: 500,
        operationName: 'Select section',
        silent: true
    });
}

/**
 * Scrapes the content of the currently selected page.
 * @param {object} frame - The Playwright frame object.
 * @returns {Promise<object>} - { title, contentHtml }.
 */
async function getPageContent(frame) {
    return frame.evaluate(() => {
        // Find the main canvas/content area
        const canvas = document.querySelector('#OreoCanvas') ||
            document.querySelector('.canvasContainer') ||
            document.body;

        // OneNote stores content in "Outlines"
        const outlines = Array.from(canvas.querySelectorAll('.OutlineContainer'));

        // Sort outlines by their visual position (top, then left)
        // This prevents content flipping when DOM order doesn't match visual layout
        outlines.sort((a, b) => {
            const rectA = a.getBoundingClientRect();
            const rectB = b.getBoundingClientRect();

            // Use a small vertical threshold (10px) to treat items roughly on the same line
            if (Math.abs(rectA.top - rectB.top) > 10) {
                return rectA.top - rectB.top;
            }
            return rectA.left - rectB.left;
        });

        let title = '';
        let dateTime = '';

        // Prepare a clone for cleanup to avoid affecting the UI
        const contentDiv = document.createElement('div');

        outlines.forEach(outline => {
            const clone = outline.cloneNode(true);

            // Handle Title and DateTime specifically
            const isTitle = outline.querySelector('.TitleOutline');
            const isDateTime = outline.querySelector('.TitleDateTimeOutline');

            if (isTitle) {
                title = outline.innerText.trim();
                return; // Don't add to main content body
            }
            if (isDateTime) {
                // Join multiple lines (date and time) into one
                dateTime = outline.innerText.trim().replace(/\n/g, ' ').replace(/\s+/g, ' ');
                return; // Don't add to main content body
            }

            // Remove UI elements that shouldn't be in Markdown
            const toRemove = clone.querySelectorAll([
                '.DragHandle',
                '.OutlineResizeHandleContainer',
                '.OutlineResize',
                '.insertionHint',
                'button',
                'script',
                'style'
            ].join(','));

            toRemove.forEach(el => el.remove());

            contentDiv.appendChild(clone);
        });

        // Fallback for Title if not found in outlines
        if (!title) {
            const titleEl = document.querySelector('.pageTitle') ||
                document.querySelector('div[aria-label*="Page Title"]') ||
                document.querySelector('input[placeholder="Page Title"]');
            if (titleEl) {
                title = titleEl.value || titleEl.innerText || '';
            }
        }

        // If no outlines found, fallback to more generic selectors.
        //
        // `outlinesFound` is reported alongside so the caller can tell a real page
        // from this one. An empty canvas is not an empty page: it is a page that
        // has not finished rendering, and OneNote tears the old content down
        // before it builds the new, so there is a window in which the canvas holds
        // nothing at all. When that window is caught, `div[role="main"]` is a
        // landmark whose only content is its own accessible name - literally
        // "Page Contents" - and the fallback below wrote that as the page. A
        // 15-byte note was the result, and the run called it a success (F-61).
        if (outlines.length === 0) {
            const fallback = document.querySelector('div[role="main"]') || document.querySelector('#OneNoteContent');
            if (fallback) {
                const clone = fallback.cloneNode(true);
                contentDiv.appendChild(clone);
            }
        }


        const attachmentInfos = [];
        const internalLinks = [];
        const videoInfos = [];
        const embedInfos = [];

        // 1. Extract YouTube/Vimeo/Embeds
        const allIframes = Array.from(contentDiv.querySelectorAll('iframe'));
        allIframes.forEach(iframe => {
            const src = iframe.getAttribute('src') || '';
            if (src.includes('youtube.com') || src.includes('youtu.be') || src.includes('vimeo.com')) {
                const embedId = `embed_${embedInfos.length}`;
                embedInfos.push({ id: embedId, src, type: 'video' });
                iframe.setAttribute('data-embed-id', embedId);
            }
        });

        // 2. Extract Video elements
        const allVideos = Array.from(contentDiv.querySelectorAll('video'));
        allVideos.forEach(video => {
            let src = video.getAttribute('src');
            if (!src) {
                const source = video.querySelector('source');
                if (source) src = source.getAttribute('src');
            }
            if (src) {
                const videoId = `video_${videoInfos.length}`;
                videoInfos.push({ id: videoId, src });
                video.setAttribute('data-local-video', videoId);
            }
        });

        const isFileLink = (link) => {
            const href = link.getAttribute('href') || '';
            const text = link.innerText.trim();
            const title = link.getAttribute('title') || '';
            const ariaLabel = link.getAttribute('aria-label') || '';
            const className = (link.className || '').toLowerCase();
            const parentClass = (link.parentElement?.className || '').toLowerCase();

            // Explicitly skip internal navigation protocols
            if (href.startsWith('onenote:') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
                return { isFile: false, isCloud: false };
            }

            const isSharePoint = href.includes('sharepoint.com') || href.includes('1drv.ms') || href.includes('onedrive.live.com');

            // Extension check helper (cases like "file.pdf" or "file.pdf.xlsx")
            // Broadened to search ANYWHERE in string (handles ?web=1 or Doc2.aspx?file=...)
            const fileExtRegex = /\.(docx?|xlsx?|pptx?|pdf|txt|md|csv|zip|rar|7z|json|xml|log|png|jpe?g|gif|svg)(\?|&|$)/i;

            const isCloud = (className.includes('hyperlinkv2') || className.includes('cloudfile') || className.includes('onedrive') || parentClass.includes('cloudfile')) &&
                isSharePoint;

            // SharePoint/OneDrive specific document markers
            const isOfficeCloudDoc = isSharePoint && (
                href.includes('/:x:/') || href.includes('/:w:/') || href.includes('/:p:/') || // Excel, Word, PowerPoint markers
                href.includes('/Doc.aspx') || href.includes('/Doc2.aspx') ||
                href.includes('WopiFrame.aspx') ||
                href.includes('WopiFrame2.aspx')
            );

            // Check if it's a known attachment or looks like a file resource
            const isLocal = className.includes('attachment') ||
                className.includes('wacef') || // OneNote Web "File" class
                parentClass.includes('attachment') ||
                parentClass.includes('wacef') ||
                link.querySelector('img[src*="box43.png"]') || // OneNote icon for attachments
                className.includes('fileicon') ||
                fileExtRegex.test(title) ||
                fileExtRegex.test(ariaLabel) ||
                // Check text separately with truncation awareness
                fileExtRegex.test(text.split('\n')[0].trim()) ||
                fileExtRegex.test(href);

            return { isFile: isCloud || isLocal || isOfficeCloudDoc, isCloud: isCloud || isOfficeCloudDoc };
        };

        // 3. Process File Attachments and Internal Links
        const allPotentialLinks = Array.from(contentDiv.querySelectorAll('a, div[title], span[title], button[title]'));
        const realPotentialLinks = Array.from(canvas.querySelectorAll('a, div[title], span[title], button[title]'));

        const processedFileSignatures = new Set();
        const claimedFileOwners = new Set();

        /**
         * The element that *is* the file, as opposed to a piece of it.
         *
         * OneNote does not render a file attachment as a link. It renders a
         * container element holding several parts - an overlay, an icon, and a
         * visible filename label - and more than one of those parts matches the
         * attachment pattern above:
         *
         *     div.WACEFContainer[role=link][aria-label="report.pdf"]
         *       span.WACEFOverlay[title="report.pdf"]     <- the click target
         *       img.WACEFImage[title="report.pdf"]
         *       div.WACEFFilename[title="report.pdf"]    <- the label
         *
         * So one PDF was scraped as two attachments, which meant two download
         * attempts for the same bytes and two near-identical files on disk
         * (report.pdf and report_1.pdf). Worse, the duplicate is the one that
         * looks healthy: the click-target marker is placed by a fuzzy title
         * match that lands on the *other* candidate, so the first one was
         * reported as "Could not find clickable element" and could never be
         * fetched at all. A real run spent 30s a page proving it (F-60).
         *
         * So a candidate whose ancestor names the same file is a part of that
         * ancestor's attachment, not a file of its own, and is skipped. The test
         * is deliberately narrow: the ancestor must name THIS candidate's file.
         * Two different files that share markup shape have separate containers
         * and both survive, and a hyperlink the author added on purpose - a
         * SharePoint link to a file also attached above - names no ancestor at
         * all, so it remains its own attachment.
         *
         * @param {Element} el - A candidate that matched the attachment pattern
         * @returns {Element} The element that owns the file
         */
        const fileOwner = (el) => {
            const labelOf = (node) => (
                (node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('title'))) || ''
            ).trim().toLowerCase();
            const own = labelOf(el);
            // Nothing names this element, so nothing can own it either.
            if (!own) return el;

            let owner = null;
            for (let p = el.parentElement; p; p = p.parentElement) {
                const label = labelOf(p);
                if (label && (label === own || label.startsWith(own))) owner = p;
            }
            return owner || el;
        };

        /**
         * The element inside a file's container that actually shows the file's name.
         *
         * This exists because of a turndown rule that looks like it works and does
         * not. `data-local-file` becomes the Obsidian embed via a custom rule (see
         * parser.js), but turndown answers a *blank* node from its built-in blank
         * rule and never consults custom rules at all:
         *
         *     Rules.prototype.forNode = function (node) {
         *       if (node.isBlank) return this.blankRule
         *       ...
         *
         * OneNote's overlay is an empty element, so an id stamped on it produces no
         * embed, silently. Turning the attachment fixture through the real converter
         * shows it exactly:
         *
         *     Quarterly Report            <- id was on the empty overlay: no embed
         *     Meeting Notes               <- same
         *     [[assets/file_2.pdf]]       <- has text: embed
         *     [[assets/file_3.pdf]]       <- has text: embed
         *
         * So the element that carries the name has to carry the id. Before the
         * F-60 dedup this happened by luck: the overlay was scraped first and the
         * visible label second, and the *second* candidate's id was the one that
         * produced the embed. Deduplicating to a single attachment kept the first,
         * and the link went with it - the file downloaded and the note stopped
         * referring to it (F-63).
         *
         * @param {Element} owner - The container that owns the file
         * @returns {Element|null} The element showing the name, or null if none does
         */
        const fileLabel = (owner) => {
            if (!owner) return null;
            if ((owner.innerText || '').trim()) return owner;
            for (const c of owner.querySelectorAll('a, div[title], span[title], button[title]')) {
                if ((c.innerText || '').trim()) return c;
            }
            return null;
        };

        allPotentialLinks.forEach((link) => {
            const href = link.getAttribute('href') || '';
            const text = link.innerText.trim();
            const title = link.getAttribute('title') || '';

            const { isFile, isCloud } = isFileLink(link);

            if (isFile) {
                // F-60: several candidates can be one file. Keep the first, which
                // in OneNote's markup is the overlay - the part OneNote actually
                // makes clickable - and drop the rest.
                const owner = fileOwner(link);
                if (claimedFileOwners.has(owner)) return;
                claimedFileOwners.add(owner);

                // Deduplicate by href (if present) or by title+text
                const signature = href || (`${title}_${text}`);
                if (processedFileSignatures.has(signature)) return;
                processedFileSignatures.add(signature);

                const attachId = `file_${attachmentInfos.length}`;

                // Prioritize full names from attributes (OneNote Web often truncates link text)
                const ariaLabel = link.getAttribute('aria-label') || '';
                // Use strict regex to avoid matching truncated text like "...6P4" as an extension
                const fileExtRegex = /\.(docx?|xlsx?|pptx?|pdf|txt|md|csv|zip|rar|7z|json|xml|log|png|jpe?g|gif|svg)(\?|&|$)/i;

                let originalName = '';
                if (fileExtRegex.test(title)) originalName = title;
                else if (fileExtRegex.test(ariaLabel)) originalName = ariaLabel;
                else if (fileExtRegex.test(text.split('\n')[0].trim())) originalName = text.split('\n')[0].trim();

                // NOTE: this callback is serialised by Playwright and executed
                // inside the page, so the Node logger does NOT exist here and
                // console is the only thing available. See the eslint-disable
                // at the top of getPageContent.
                // eslint-disable-next-line no-console
                console.debug(
                    `[Scraper] attachment ${attachId} <${link.tagName}> ` +
                    `title="${title}" aria-label="${ariaLabel}" ` +
                    `text="${text.substring(0, 30)}" href="${href.substring(0, 50)}"`
                );

                if (!originalName || originalName === 'attached_file' || !fileExtRegex.test(originalName)) {
                    if (href) {
                        try {
                            const urlObj = new URL(href, 'https://example.com');
                            const fileParam = urlObj.searchParams.get('file') || urlObj.searchParams.get('FileName');
                            if (fileParam && fileExtRegex.test(fileParam)) {
                                originalName = fileParam;
                            } else {
                                // Try to find something that looks like a filename in the path
                                const pathParts = urlObj.pathname.split('/');
                                const lastPart = pathParts[pathParts.length - 1];
                                if (fileExtRegex.test(lastPart)) {
                                    originalName = lastPart;
                                } else {
                                    // Look for the extension earlier in the URL (SharePoint style)
                                    const match = href.match(/([^/]+\.(docx?|xlsx?|pptx?|pdf|txt|md|csv|zip|rar|7z|json|xml|log|png|jpe?g|gif|svg))(?:\?|&|$)/i);
                                    if (match) originalName = match[1];
                                }
                            }
                        } catch (e) {
                            // Fallback regex
                            const match = href.match(/([^/]+\.[a-zA-Z0-9]+)(?:\?|&|$)/);
                            if (match) originalName = match[1];
                        }
                    }
                }
                if (!originalName) originalName = 'attached_file';

                // eslint-disable-next-line no-console
                console.debug(`[Scraper] Detected attachment: ${originalName} (ID: ${attachId}, Type: ${link.tagName})`);
                attachmentInfos.push({ id: attachId, src: href, originalName: originalName, isCloud: isCloud });

                // The id goes on the element that SHOWS the name, not on whichever
                // part of the container happened to be scraped first (F-63). The
                // two are different jobs and F-60 conflated them: the overlay is
                // what OneNote makes clickable, and the label is what the reader
                // sees - and turndown renders an embed only for the second, because
                // an empty element never reaches a custom rule. Getting this wrong
                // is invisible in every count the summary reports: the file still
                // downloads, and only the note stops linking to it.
                const label = fileLabel(owner) || link;
                label.setAttribute('data-local-file', attachId);
                label.setAttribute('data-filename', originalName);

                // Tag the REAL element for clicking
                // Match by exact href first, then fuzzy href, then title, then fuzzy text
                let realLink = null;

                const normalize = (u) => {
                    try {
                        const url = new URL(u, 'https://example.com');
                        url.search = ''; // Strip query params for matching
                        return url.toString().toLowerCase();
                    } catch (e) { return (u || '').toLowerCase(); }
                };

                const normHref = normalize(href);

                if (href) {
                    realLink = realPotentialLinks.find(rl => rl.getAttribute('href') === href) ||
                               realPotentialLinks.find(rl => normalize(rl.getAttribute('href')) === normHref);
                }
                if (!realLink && title) {
                    realLink = realPotentialLinks.find(rl => rl.getAttribute('title') === title);
                }
                if (!realLink && text) {
                    const normText = text.toLowerCase().trim();
                    realLink = realPotentialLinks.find(rl => rl.innerText.toLowerCase().trim() === normText) ||
                               realPotentialLinks.find(rl => rl.innerText.toLowerCase().includes(normText));
                }

                if (realLink) {
                    // eslint-disable-next-line no-console
                    console.debug(`[Scraper] Successfully matched real element for ${attachId}`);
                    realLink.setAttribute('data-one-attach-id', attachId);
                } else {
                    // eslint-disable-next-line no-console
                    console.warn(`[Scraper] FAILED to match real element for ${attachId}. UI Click strategy will fail.`);
                }
                return;
            }

            // Detect Internal OneNote Links
            const isOneNoteUrl = href.includes('onenote.') ||
                href.includes('.officeapps.live.com') ||
                href.includes('.sharepoint.com') ||
                href.includes('view.aspx');

            const isInternal = !href ||
                href === '#' ||
                href.includes('onenote:') ||
                isOneNoteUrl ||
                (!href.startsWith('http') && !href.startsWith('//') && !href.startsWith('mailto:') && !href.startsWith('file:') && !href.startsWith('data:'));

            if (isInternal) {
                const linkId = `link_${internalLinks.length}`;
                internalLinks.push({ id: linkId, href, text });
                link.setAttribute('data-internal-link', linkId);
            }
        });

        // 4. Extract image info (including Printouts)
        const imageInfos = [];
        outlines.forEach(outline => {
            const originalImgs = Array.from(outline.querySelectorAll('img'));
            originalImgs.forEach((origImg) => {
                let src = origImg.getAttribute('src');
                if (src) {
                    if (!src.startsWith('data:')) {
                        // If the URL cannot be resolved we keep the original src
                        // and let the download attempt report the real problem.
                        // eslint-disable-next-line no-empty
                        try { src = new URL(src, window.location.href).href; } catch (e) { }
                    }

                    const srcLower = src.toLowerCase();
                    const className = (origImg.className || '').toLowerCase();
                    const parentClass = (origImg.parentElement?.className || '').toLowerCase();

                    // Detect Printouts
                    const isPrintout = parentClass.includes('printout') ||
                        className.includes('printout') ||
                        origImg.closest('[class*="Printout"]');

                    // UI patterns to exclude
                    const isMicrosoftUI = (srcLower.includes('static.microsoft') || srcLower.includes('officeonline')) &&
                        (srcLower.includes('/m2/') || srcLower.includes('/resources/'));

                    const isGenericIcon = srcLower.includes('one.png') ||
                        srcLower.includes('box42.png') ||
                        srcLower.includes('box43.png');

                    const width = origImg.offsetWidth || origImg.naturalWidth || 0;
                    const height = origImg.offsetHeight || origImg.naturalHeight || 0;

                    const hasUIClass = className.includes('handle') ||
                        className.includes('resize') ||
                        className.includes('insertionhint') ||
                        className.includes('one_');

                    const isOneNoteImage = srcLower.includes('getimage.ashx');
                    const isWACImage = className.includes('wacimage');

                    const isRealImage = isPrintout || (isOneNoteImage || isWACImage || (
                        !isMicrosoftUI && !isGenericIcon && !hasUIClass &&
                        (width > 10 || height > 10 || (width === 0 && !className))
                    ));

                    if (isRealImage) {
                        const id = `img_${imageInfos.length}`;
                        imageInfos.push({ id, src, isPrintout });

                        const clonedImgs = Array.from(contentDiv.querySelectorAll('img'));
                        const matchingClone = clonedImgs.find(c => c.getAttribute('src') === origImg.getAttribute('src') && !c.hasAttribute('data-local-src'));
                        if (matchingClone) {
                            matchingClone.setAttribute('data-local-src', id);
                            if (isPrintout) matchingClone.setAttribute('data-is-printout', 'true');

                            const alt = matchingClone.getAttribute('alt') || '';
                            if (alt.includes('\n') || alt.includes('ACCESSIBILITY') || alt.length > 300) {
                                const firstLine = alt.split('\n')[0].trim();
                                matchingClone.setAttribute('alt', (firstLine.length < 100 && !firstLine.includes('ACCESSIBILITY')) ? firstLine : '');
                            }
                        }
                    }
                }
            });
        });

        // Cleanup: remove skipped images
        Array.from(contentDiv.querySelectorAll('img')).forEach(img => {
            if (!img.hasAttribute('data-local-src')) img.remove();
        });

        return {
            title,
            dateTime,
            contentHtml: contentDiv.innerHTML,
            images: imageInfos,
            attachments: attachmentInfos,
            internalLinks: internalLinks,
            videos: videoInfos,
            embeds: embedInfos,
            // How many content outlines the canvas actually held. A page always
            // has at least a title outline, so zero means the canvas was empty -
            // the page had not rendered yet, not that it was blank. The caller
            // uses this to refuse to write a stub (F-61).
            outlinesFound: outlines.length
        };
    });
}

/**
 * Selects a page by ID with retry logic.
 * @param {object} frame 
 * @param {string} pageId 
 */
async function selectPage(frame, pageId) {
    return withRetry(async () => {
        const pageSelector = `[id="${pageId}"]`;
        const wrapper = await frame.$(pageSelector);
        if (wrapper) {
            await wrapper.scrollIntoViewIfNeeded();
            const navItem = await wrapper.$('.navItem');
            if (navItem) {
                await navItem.click();
            } else {
                await wrapper.click();
            }
        } else {
            throw new Error(`Page wrapper not found for ID: ${pageId}`);
        }
    }, {
        maxAttempts: 3,
        initialDelayMs: 500,
        operationName: 'Select page',
        silent: true
    });
}

/**
 * Reads the state of the canvas: how many content outlines it holds, and the
 * titles of the pages on it.
 *
 * Outlines alone cannot say which page is on screen. OneNote keeps the outgoing
 * page's outlines in the DOM after a click, so "something is rendered" is true
 * immediately and says nothing about *what*. Measured on the real notebook,
 * waiting only on outline count gave the wrong page's content for 16 of 19 pages,
 * and the run reported success.
 *
 * Every title is returned, not just the effective one, because the count is the
 * signal that matters. A page switch goes:
 *
 *     outlines=3  titles=[previous]               still the old page
 *     outlines=3  titles=[previous + previous]   the old page, cloned
 *     outlines=0  titles=[]                       torn down
 *     outlines=6  titles=[wanted + wanted]        the new page, cloned
 *     outlines=3  titles=[wanted]                 settled
 *
 * The requested title is already correct two steps early, and the content is
 * duplicated with it. Waiting for the title alone therefore scrapes the page
 * twice into one note. Waiting for a single title outline is what lands on the
 * settled state.
 *
 * @param {object} frame - The Playwright frame
 * @returns {Promise<{outlines: number, titles: string[]}>} Canvas state
 */
async function readCanvasState(frame) {
    return frame.evaluate(() => {
        // Same root as getPageContent, deliberately: if these two disagree about
        // which elements are the canvas, the wait can approve a page that the
        // scrape then reads differently.
        const canvas = document.querySelector('#OreoCanvas') ||
            document.querySelector('.canvasContainer') ||
            document.body;
        const outlines = canvas.querySelectorAll('.OutlineContainer');
        const titles = Array.from(outlines)
            .filter((o) => o.querySelector('.TitleOutline'))
            .map((o) => o.innerText.trim());

        if (titles.length === 0) {
            // Same fallback chain as getPageContent, for a page whose title is
            // not an outline.
            const el = document.querySelector('.pageTitle') ||
                document.querySelector('div[aria-label*="Page Title"]') ||
                document.querySelector('input[placeholder="Page Title"]');
            const text = el ? (el.value || el.innerText || '').trim() : '';
            if (text) titles.push(text);
        }

        // Media is counted because it arrives after the outlines do. OneNote
        // settles an image outline first and fills in its source a moment later,
        // so a scrape taken the instant the outlines stop changing finds a
        // picture with nothing to download. Measured on the real notebook:
        //
        //   outlines=3  img=16/15   outlines settled, one image still has no src
        //   outlines=3  img=16/16   the last image has loaded
        //
        // withNothing counts images that have no source at all, which is what
        // tells the caller the page is still filling in.
        const images = Array.from(canvas.querySelectorAll('img'));

        return {
            outlines: outlines.length,
            titles,
            images: images.length,
            imagesReady: images.filter((i) => i.getAttribute('src')).length
        };
    });
}

/**
 * Reads whether a section group is currently expanded.
 *
 * OneNote renders a group as a row carrying `aria-expanded`, and a `[role=group]`
 * container of children only while it is open. That makes the state readable,
 * which matters because selecting a group is a TOGGLE and not an action:
 *
 *     aria-expanded=false   click   ->  aria-expanded=true, children present
 *     aria-expanded=true    click   ->  aria-expanded=false, children gone
 *
 * So a second click to "retry" a group that had already expanded closes it again.
 * A real run lost eight pages to exactly that (F-62): the group was expanded,
 * the first read raced, the retry collapsed it, and the exporter reported success
 * with a whole subtree missing. Nothing should click a group without asking.
 *
 * @param {object} frame - The Playwright frame
 * @param {string} groupId - Id of the group row
 * @returns {Promise<boolean|null>} true/false, or null when the row is gone
 */
async function isGroupExpanded(frame, groupId) {
    return frame.evaluate((id) => {
        const row = document.getElementById(id);
        if (!row) return null;
        return row.getAttribute('aria-expanded') === 'true';
    }, groupId);
}

/**
 * Navigates back to the parent section group.
 * @param {object} frame 
 * @returns {Promise<boolean>} - True if clicked, false otherwise.
 */
async function navigateBack(frame) {
    // Selectors for the back button in the navigation pane
    const backSelectors = [
        'button[aria-label="Back"]',
        'button[title="Back"]',
        '.wacFlexBox__onoBreadcrumbPanel___MuqE6 button', // Class found in dump
        '.navigationPane__backButton', // Potential class
        'i[class*="arrow"][class*="left"]' // Fallback to icon
    ];

    for (const selector of backSelectors) {
        const btn = await frame.$(selector);
        if (btn) {
            await btn.click();
            return true;
        }
    }
    return false;
}

/**
 * Detects if the currently selected section is password protected (locked).
 * @param {object} frame - The Playwright frame object.
 * @returns {Promise<boolean>}
 */
async function isSectionLocked(frame) {
    return frame.evaluate(() => {
        const texts = [
            "Section Password Protected",
            "This section is password protected"
        ];

        // Find elements that contain the text
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
            const content = node.textContent;
            if (texts.some(t => content.includes(t))) {
                const parent = node.parentElement;
                if (!parent) continue;

                // Check visibility
                const style = window.getComputedStyle(parent);
                if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) continue;

                // Exclude navigation panes accurately
                // OneNote Web uses these classes/IDs for the left panes
                if (parent.closest('.sectionList') ||
                    parent.closest('.pagesContainer') ||
                    parent.closest('#NavPaneSectionList') ||
                    parent.closest('#PageList') ||
                    parent.closest('[class*="navItem"]') ||
                    parent.closest('[class*="pageListItem"]')) {
                    continue;
                }

                return true;
            }
        }
        return false;
    });
}

module.exports = {
    getSections,
    getPages,
    selectSection,
    getPageContent,
    selectPage,
    navigateBack,
    isSectionLocked,
    isGroupExpanded,
    readCanvasState
};
