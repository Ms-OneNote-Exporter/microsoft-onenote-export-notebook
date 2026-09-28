const path = require('path');
const { safeName, uniqueName } = require('../src/utils/naming');

describe('safeName', () => {
    it('keeps an ordinary name unchanged', () => {
        expect(safeName('Meeting notes', 'fallback')).toBe('Meeting notes');
    });

    it('strips characters that are illegal in a path', () => {
        expect(safeName('Notes/2024', 'fallback')).toBe('Notes2024');
    });

    // F-14: sanitize-filename returns '' for these, and path.join(dir, '') is
    // just dir, so the section used to be written into its parent.
    it.each([
        ['...', 'three dots'],
        ['..', 'two dots'],
        ['   ', 'only whitespace'],
        ['', 'empty string'],
        [null, 'null'],
        [undefined, 'undefined'],
    ])('falls back for %j (%s) instead of returning an empty name', (input) => {
        const result = safeName(input, 'Untitled section');
        expect(result).toBe('Untitled section');
        expect(result.length).toBeGreaterThan(0);
    });

    it('falls back for a Windows-reserved device name', () => {
        expect(safeName('CON', 'Untitled section')).toBe('Untitled section');
        expect(safeName('LPT1', 'Untitled section')).toBe('Untitled section');
    });

    it('never produces a path that escapes or collapses its parent', () => {
        const parent = '/tmp/vault/Notebook';
        for (const name of ['...', '..', '   ', 'CON', '/', 'a/b/../..']) {
            const dir = path.join(parent, safeName(name, 'Untitled section'));
            expect(path.dirname(dir)).toBe(parent);
        }
    });

    it('trims surrounding whitespace that would make an awkward filename', () => {
        expect(safeName('  spaced  ', 'x')).toBe('spaced');
    });
});

describe('uniqueName', () => {
    it('returns the name unchanged when it is free', () => {
        const used = new Set();
        expect(uniqueName('Notes', used)).toBe('Notes');
        expect(used.has('Notes')).toBe(true);
    });

    it('suffixes a second claim on the same name', () => {
        const used = new Set();
        uniqueName('Notes', used);
        expect(uniqueName('Notes', used)).toBe('Notes (2)');
    });

    it('keeps counting past an existing suffix', () => {
        const used = new Set(['Notes', 'Notes (2)']);
        expect(uniqueName('Notes', used)).toBe('Notes (3)');
    });

    it('does not hand out the same name twice', () => {
        const used = new Set();
        const names = ['A', 'A', 'A', 'B', 'A'].map((n) => uniqueName(n, used));
        expect(new Set(names).size).toBe(names.length);
    });
});
