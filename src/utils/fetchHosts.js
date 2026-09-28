/**
 * Host classification for URLs the tool fetches with the user's authenticated
 * session.
 *
 * ## Why this exists
 *
 * `downloadResource` performs `page.context().request.get(url)` using the browser
 * context that is signed in to OneDrive/SharePoint. The URL comes from page
 * content, so a link inside a shared notebook decides where an authenticated GET
 * is sent. A crafted link could therefore make the tool present the user's
 * credentials to an arbitrary host.
 *
 * ## Why it only warns
 *
 * The correct response would be an allowlist that refuses anything unexpected.
 * That was explicitly rejected: OneNote legitimately serves content from a range
 * of hosts (per-tenant `*.sharepoint.com`, `*.1drv.ms`, `onedrive.live.com`,
 * `*.officeapps.live.com`, sometimes regional or government tenants), and an
 * allowlist that is one host short silently stops downloading real attachments -
 * a far worse failure for the user than a theoretical exposure, and one that
 * would be very hard to diagnose from "the export produced no files".
 *
 * So this classifies and reports. Nothing is blocked. What it buys is that a
 * suspicious host shows up in the log next to the file it was fetching, so the
 * situation is visible rather than invisible.
 */

/** Hosts whose subdomains are all expected to serve OneNote content. */
const EXPECTED_HOST_SUFFIXES = [
    'sharepoint.com',
    'sharepoint.cn',
    'sharepointonline.com',
    '1drv.ms',
    'onedrive.live.com',
    'officeapps.live.com',
    // Note microsoftonline.com is NOT covered by microsoft.com - the editor popup
    // really does navigate through login.microsoftonline.com on the way to
    // SharePoint, and a test caught the omission.
    'microsoftonline.com',
    'office365.com',
    'microsoft.com',
    'windows.net',
    'office.com',
    'office.net',
];

/** Exact hosts, where subdomains would be too broad. */
const EXPECTED_HOSTS = new Set([
    'localhost',
    '127.0.0.1',
]);

/**
 * Extracts the hostname from a URL without throwing.
 *
 * @param {string} url - Absolute or relative URL
 * @returns {string|null} Lowercase hostname, or null when there is not one
 */
function hostnameOf(url) {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch (e) {
        return null;
    }
}

/**
 * Classifies a URL by where it points.
 *
 * @param {string} url - The URL about to be fetched
 * @returns {{host: string|null, expected: boolean, reason: string}}
 *   `expected` is false when the host is not one of the known OneNote hosts.
 *   `reason` explains the verdict in a form suitable for a log line.
 */
function classifyFetchTarget(url) {
    const trimmed = String(url || '').trim();

    // Inline payloads never touch the network, so they are always fine and have
    // no meaningful host.
    if (/^(data|blob):/i.test(trimmed)) {
        return { host: null, expected: true, reason: 'inline payload, no network request' };
    }

    const host = hostnameOf(trimmed);
    if (!host) {
        return { host: null, expected: false, reason: 'no hostname could be parsed from the URL' };
    }

    if (EXPECTED_HOSTS.has(host)) {
        return { host, expected: true, reason: 'known local host' };
    }

    const matchesSuffix = EXPECTED_HOST_SUFFIXES.some(
        (suffix) => host === suffix || host.endsWith(`.${suffix}`)
    );

    if (matchesSuffix) {
        return { host, expected: true, reason: 'known OneNote/SharePoint host' };
    }

    return {
        host,
        expected: false,
        reason: 'not a recognised OneNote, SharePoint or OneDrive host',
    };
}

module.exports = { classifyFetchTarget, EXPECTED_HOST_SUFFIXES };
