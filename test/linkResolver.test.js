const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { resolveInternalLinks } = require('../src/linkResolver');

/**
 * resolveInternalLinks rewrites the `[[text]]<!-- onenote-link:id -->`
 * placeholders that parser.js leaves behind. It is pure filesystem work - no
 * browser - so it can be tested directly against a temporary vault.
 */
describe('resolveInternalLinks', () => {
    let vault;

    beforeEach(() => {
        vault = fs.mkdtempSync(path.join(os.tmpdir(), 'onenote-links-'));
    });

    afterEach(() => {
        fs.removeSync(vault);
    });

    /** Writes `files` into the vault and resolves `map` against it. */
    const write = (files) => {
        for (const [rel, content] of Object.entries(files)) {
            fs.outputFileSync(path.join(vault, rel), content);
        }
    };

    const read = (rel) => fs.readFileSync(path.join(vault, rel), 'utf8');

    it('resolves a link by exact id and drops the marker', () => {
        write({ 'Section/Target.md': '# target\n' });
        const map = {
            '{AAAA-1111}{1}': { path: path.join(vault, 'Section', 'Target.md'), isDir: false, internalLinks: [] },
            '{BBBB-2222}{1}': {
                path: path.join(vault, 'Source.md'),
                isDir: false,
                internalLinks: [{ id: 'link_0', href: 'https://x/#{AAAA-1111}{1}', text: 'Go' }],
            },
        };
        fs.outputFileSync(path.join(vault, 'Source.md'), '[[Go]]<!-- onenote-link:link_0 -->');

        return resolveInternalLinks(map, vault).then(() => {
            expect(read('Source.md')).toBe('[[Section/Target|Go]]');
        });
    });

    // F-29: the old matcher used Object.keys().find(), so whichever id happened
    // to be registered first and appeared anywhere in the href won - silently
    // producing a link to the wrong page.
    it('picks the most specific id when several appear in one href', () => {
        write({ 'WRONG.md': '# wrong\n', 'RIGHT.md': '# right\n' });
        const map = {
            // Registered first, and a substring of the href, but not the target.
            'short-id': { path: path.join(vault, 'WRONG.md'), isDir: false, internalLinks: [] },
            '{BBBB-2222-BBBB-2222-BBBB-2222}{1}': { path: path.join(vault, 'RIGHT.md'), isDir: false, internalLinks: [] },
            '{AAAA-1111}{1}': {
                path: path.join(vault, 'Source.md'),
                isDir: false,
                internalLinks: [{
                    id: 'link_0',
                    href: 'https://onenote/BBBB-2222-BBBB-2222-BBBB-2222?ref=short-id',
                    text: 'Go',
                }],
            },
        };
        fs.outputFileSync(path.join(vault, 'Source.md'), '[[Go]]<!-- onenote-link:link_0 -->');

        return resolveInternalLinks(map, vault).then(() => {
            expect(read('Source.md')).toBe('[[RIGHT|Go]]');
        });
    });

    it('matches the cleaned UUID when the href omits the {n} suffix', () => {
        write({ 'Target.md': '# target\n' });
        const map = {
            '{12345678-1234-1234-1234-1234567890ab}{1}': { path: path.join(vault, 'Target.md'), isDir: false, internalLinks: [] },
            '{AAAA-1111}{1}': {
                path: path.join(vault, 'Source.md'),
                isDir: false,
                internalLinks: [{
                    id: 'link_0',
                    href: 'https://x/section-id={12345678-1234-1234-1234-1234567890ab}&end',
                    text: 'Go',
                }],
            },
        };
        fs.outputFileSync(path.join(vault, 'Source.md'), '[[Go]]<!-- onenote-link:link_0 -->');

        return resolveInternalLinks(map, vault).then(() => {
            expect(read('Source.md')).toBe('[[Target|Go]]');
        });
    });

    it('resolves an onenote: path link case-insensitively', () => {
        write({ 'My Section/My Page.md': '# page\n' });
        const map = {
            '{AAAA-1111}{1}': { path: path.join(vault, 'My Section', 'My Page.md'), isDir: false, internalLinks: [] },
            '{CCCC-3333}{1}': {
                path: path.join(vault, 'Source.md'),
                isDir: false,
                internalLinks: [{ id: 'link_0', href: 'onenote:my section.one#MY PAGE&x=1', text: 'Target' }],
            },
        };
        fs.outputFileSync(path.join(vault, 'Source.md'), '[[Target]]<!-- onenote-link:link_0 -->');

        return resolveInternalLinks(map, vault).then(() => {
            expect(read('Source.md')).toBe('[[My Section/My Page|Target]]');
        });
    });

    it('leaves the text but removes the marker when the target is unknown', () => {
        write({});
        const map = {
            '{AAAA-1111}{1}': {
                path: path.join(vault, 'Source.md'),
                isDir: false,
                internalLinks: [{ id: 'link_0', href: 'https://example.com/nowhere', text: 'Dead' }],
            },
        };
        fs.outputFileSync(path.join(vault, 'Source.md'), '[[Dead]]<!-- onenote-link:link_0 -->');

        return resolveInternalLinks(map, vault).then(() => {
            expect(read('Source.md')).toBe('[[Dead]]');
        });
    });

    // F-26: a link with no text used to resolve to [[path|]].
    it('uses the target name when the link has no text of its own', () => {
        write({ 'Section/Target.md': '# target\n' });
        const map = {
            '{AAAA-1111}{1}': { path: path.join(vault, 'Section', 'Target.md'), isDir: false, internalLinks: [] },
            '{BBBB-2222}{1}': {
                path: path.join(vault, 'Source.md'),
                isDir: false,
                internalLinks: [{ id: 'link_0', href: 'https://x/#{AAAA-1111}{1}', text: '' }],
            },
        };
        fs.outputFileSync(path.join(vault, 'Source.md'), '[[]]<!-- onenote-link:link_0 -->');

        return resolveInternalLinks(map, vault).then(() => {
            expect(read('Source.md')).toBe('[[Section/Target]]');
        });
    });

    it('does not link a page to itself', () => {
        write({ 'Self.md': '# self\n' });
        const map = {
            '{AAAA-1111}{1}': {
                path: path.join(vault, 'Self.md'),
                isDir: false,
                internalLinks: [{ id: 'link_0', href: 'https://x/#{AAAA-1111}{1}', text: 'Me' }],
            },
        };
        fs.outputFileSync(path.join(vault, 'Self.md'), '[[Me]]<!-- onenote-link:link_0 -->');

        return resolveInternalLinks(map, vault).then(() => {
            expect(read('Self.md')).toBe('[[Me]]');
        });
    });

    // F-30: path.relative yields backslashes on Windows and the result was
    // embedded verbatim, so every wikilink was malformed there. A literal
    // backslash in a filename reproduces the same shape on any platform.
    it('always emits forward slashes in the link path', () => {
        write({ 'Section/Weird\\Name.md': '# odd\n' });
        const map = {
            '{AAAA-1111}{1}': { path: path.join(vault, 'Section', 'Weird\\Name.md'), isDir: false, internalLinks: [] },
            '{BBBB-2222}{1}': {
                path: path.join(vault, 'Source.md'),
                isDir: false,
                internalLinks: [{ id: 'link_0', href: 'https://x/#{AAAA-1111}{1}', text: 'Go' }],
            },
        };
        fs.outputFileSync(path.join(vault, 'Source.md'), '[[Go]]<!-- onenote-link:link_0 -->');

        return resolveInternalLinks(map, vault).then(() => {
            const out = read('Source.md');
            expect(out).toBe('[[Section/Weird/Name|Go]]');
            expect(out).not.toContain('\\');
        });
    });

    it('leaves a file with no links untouched', () => {
        const content = '# nothing to do here\n';
        write({ 'Plain.md': content });
        const map = {
            '{AAAA-1111}{1}': { path: path.join(vault, 'Plain.md'), isDir: false, internalLinks: [] },
        };
        return resolveInternalLinks(map, vault).then(() => {
            expect(read('Plain.md')).toBe(content);
        });
    });
});
