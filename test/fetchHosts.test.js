const path = require('path');
const { classifyFetchTarget } = require('../src/utils/fetchHosts');

/**
 * F-47: page-supplied URLs are fetched with the user's authenticated context.
 *
 * These tests pin the *classification* and the *reporting*, and - just as
 * importantly - pin that nothing is blocked, because an allowlist that is one host
 * short would silently stop downloading real attachments.
 */
describe('classifyFetchTarget', () => {
    it.each([
        ['https://mobilutils-my.sharepoint.com/personal/x/_layouts/15/Doc.aspx', 'tenant SharePoint'],
        ['https://contoso.sharepoint.com/sites/team', 'any SharePoint tenant'],
        ['https://tenant.sharepoint.cn/personal/x', 'SharePoint China'],
        ['https://api.onedrive.live.com/1/drive', 'OneDrive live'],
        ['https://euc-onenote.officeapps.live.com/o/onenoteframe.aspx', 'OneNote frame host'],
        ['https://login.microsoftonline.com/common/oauth2/authorize', 'Entra login'],
        ['https://res-1.cdn.office.net/files/x.png', 'Office CDN'],
        ['https://something.blob.core.windows.net/container/blob', 'Azure blob storage'],
        ['https://graph.microsoft.com/v1.0/me', 'Graph API'],
    ])('treats %s as expected (%s)', (url) => {
        expect(classifyFetchTarget(url).expected).toBe(true);
    });

    it.each([
        ['https://evil.example.com/payload.png', 'an unrelated host'],
        ['https://attacker.test/exfil', 'a .test domain'],
        ['http://198.51.100.7/x', 'a bare IP'],
    ])('flags %s as unexpected (%s)', (url) => {
        const verdict = classifyFetchTarget(url);
        expect(verdict.expected).toBe(false);
        expect(verdict.reason).toMatch(/not a recognised/);
    });

    // A naive endsWith('sharepoint.com') would let these through.
    it('does not accept a host that merely contains a known name', () => {
        for (const url of [
            'https://notsharepoint.com/x',
            'https://sharepoint.com.evil.test/x',
            'https://evil-sharepoint.com/x',
            'https://microsoft.com.evil.test/x',
        ]) {
            expect(classifyFetchTarget(url).expected).toBe(false);
        }
    });

    it('treats inline payloads as safe and gives them no host', () => {
        for (const url of ['data:image/png;base64,AAAA', 'blob:https://x/y']) {
            const verdict = classifyFetchTarget(url);
            expect(verdict.expected).toBe(true);
            expect(verdict.host).toBeNull();
        }
    });

    it('flags a URL with no parseable hostname rather than crashing', () => {
        const verdict = classifyFetchTarget('not a url at all');
        expect(verdict.expected).toBe(false);
        expect(verdict.reason).toMatch(/no hostname/);
    });

    it('handles an empty or missing URL without throwing', () => {
        expect(() => classifyFetchTarget('')).not.toThrow();
        expect(() => classifyFetchTarget(undefined)).not.toThrow();
        expect(() => classifyFetchTarget(null)).not.toThrow();
    });

    it('is case-insensitive about the host', () => {
        expect(classifyFetchTarget('https://MOBILUTILS-MY.SHAREPOINT.COM/x').expected).toBe(true);
    });
});

describe('the warning is emitted, and nothing is blocked', () => {
    // These need the logger mocked, so the module is required after the mock.
    let exporter;
    let logger;
    let downloadResource;

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../src/utils/logger', () => ({
            warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn(),
            success: jest.fn(), step: jest.fn(), log: jest.fn(),
            getDumpDir: jest.fn(), getDumpDisplayPath: jest.fn(), setLevel: jest.fn(),
        }));
        exporter = require('../src/exporter');
        logger = require('../src/utils/logger');
        downloadResource = exporter.downloadResourceForTest;
        exporter.__resetFetchHostWarnings();
    });

    afterEach(() => { jest.dofMock; jest.resetModules(); });

    /** A page whose request context records the URL it was asked for. */
    const fakePage = (requested) => ({
        context: () => ({
            request: {
                get: async (url) => {
                    requested.push(url);
                    return { ok: () => true, body: async () => Buffer.from('x') };
                },
            },
        }),
    });

    it('warns once for an unexpected host', () => {
        const requested = [];
        const fs = require('fs-extra');
        const os = require('os');
        const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fh-')), 'a.bin');

        return downloadResource(fakePage(requested), 'https://evil.example.com/a.bin', out).then(() => {
            const warnings = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
            expect(warnings).toMatch(/evil\.example\.com/);
            expect(warnings).toMatch(/signed-in session/);
        });
    });

    it('does NOT block the request', () => {
        const requested = [];
        const fs = require('fs-extra');
        const os = require('os');
        const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fh-')), 'a.bin');

        return downloadResource(fakePage(requested), 'https://evil.example.com/a.bin', out).then((ok) => {
            // The whole design decision: visible, not refused.
            expect(ok).toBe(true);
            expect(requested).toEqual(['https://evil.example.com/a.bin']);
        });
    });

    it('says nothing for a known SharePoint host', () => {
        const requested = [];
        const fs = require('fs-extra');
        const os = require('os');
        const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fh-')), 'a.bin');

        return downloadResource(fakePage(requested), 'https://x.sharepoint.com/a.bin', out).then(() => {
            expect(logger.warn).not.toHaveBeenCalled();
        });
    });

    it('warns once per host even when it appears many times', () => {
        const requested = [];
        const fs = require('fs-extra');
        const os = require('os');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-'));

        return Promise.all([1, 2, 3, 4, 5].map((i) =>
            downloadResource(fakePage(requested), 'https://evil.example.com/f.bin', path.join(dir, `f${i}.bin`))
        )).then(() => {
            const hostWarnings = logger.warn.mock.calls
                .map((c) => String(c[0]))
                .filter((m) => m.includes('evil.example.com'));
            expect(hostWarnings).toHaveLength(1);
            expect(requested).toHaveLength(5);
        });
    });
});