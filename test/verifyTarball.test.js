/**
 * The tarball gate, tested.
 *
 * This check used to be a `node -e` string inside `.github/workflows/npm-publish.yml`,
 * where a `#` comment sat inside a JavaScript array literal - not valid JavaScript -
 * and the step died with a syntax error before looking at a single file. The line
 * went in with ffa633b (2026-10-03); v0.3.7 published on 2026-10-01. So v0.4.0 was
 * the first release the gate ever ran on, and it failed.
 *
 * Nothing caught it because inline JavaScript inside YAML is not linted, not
 * imported by anything, and not executed until the one moment it cannot be fixed
 * cheaply. As a file it is all three.
 *
 * These tests are cheap on purpose: they exercise the *predicate* against planted
 * paths, so the interesting behaviour is testable without a slow `npm pack`, and so
 * the list cannot silently become empty - which would make every test below pass
 * vacuously, exactly as the broken gate did.
 */
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const { FORBIDDEN, findForbidden, readPackedFiles } = require('../scripts/verify-tarball');

describe('the list is not empty, and every entry says why', () => {
    it('has at least one rule', () => {
        // Without this, every other test in this file passes on an empty list -
        // which is precisely the shape of the bug this file exists to prevent.
        expect(FORBIDDEN.length).toBeGreaterThan(0);
    });

    it('explains each rule, so a refusal is actionable', () => {
        for (const { why } of FORBIDDEN) {
            expect(typeof why).toBe('string');
            expect(why.length).toBeGreaterThan(5);
        }
    });
});

describe('what it refuses', () => {
    it.each([
        ['auth.json', 'signed-in session state'],
        // The repo's own naming convention for session state. `^auth.*` missed it,
        // which is what this row is here for.
        ['msout-at-example-com.json', 'a differently named session-state file'],
        ['nested/dir/msout-at-example-com.json', 'the same, in a subdirectory'],
        ['logs/app.log', 'the run log'],
        ['logs/dumps/2026-10-04_21h23/debug_page_The Page.html', 'a DOM capture'],
        ['test/parser.test.js', 'test material'],
        ['test/fixtures/empty-canvas.html', 'a fixture'],
        ['.github/workflows/ci.yml', 'workflow definitions'],
        ['scripts/release-notes.js', 'release tooling'],
        ['certs/server.pem', 'a private key'],
        ['certs/server.p12', 'a certificate'],
    ])('%s', (file, _why) => {
        expect(findForbidden([file])).toHaveLength(1);
        expect(findForbidden([file])[0].file).toBe(file);
    });

    it('lets the real tarball through', () => {
        // Every file this release actually ships. If a future change adds a file
        // that trips a rule, this fails and says which one.
        expect(findForbidden([
            'CHANGELOG.md', 'LICENSE', 'NOTICE.md', 'README.md', 'package.json',
            'src/exporter.js', 'src/index.js', 'src/utils/logger.js',
            'src/diagnose-notebook.js', 'src/diagnose-notebook-newpage.js',
        ])).toEqual([]);
    });

    it('is not fooled by a name that merely resembles a forbidden one', () => {
        // `src/utils/logPaths.js` contains "log" and `src/notebookFrame.js` is fine;
        // the patterns are anchored, and this is what keeps them that way.
        expect(findForbidden(['src/utils/logPaths.js', 'src/naming.js'])).toEqual([]);
    });

    it('reports every offender, not just the first', () => {
        // A gate that stops at the first would need three runs to find three leaks.
        const leaked = findForbidden(['logs/app.log', 'test/parser.test.js', 'README.md']);
        expect(leaked.map((l) => l.file)).toEqual(['logs/app.log', 'test/parser.test.js']);
    });
});

describe('a report it cannot read is a failure, not a pass', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarball-'));
    });

    afterEach(() => fs.removeSync(dir));

    const write = (name, contents) => {
        const p = path.join(dir, name);
        fs.writeFileSync(p, contents);
        return p;
    };

    it('reads a well-formed report', () => {
        const p = write('ok.json', JSON.stringify([{ files: [{ path: 'README.md' }] }]));
        expect(readPackedFiles(p)).toEqual(['README.md']);
    });

    it('throws on an empty file list rather than passing it', () => {
        // The important one. An empty list sails through every filter, so a gate
        // that accepted one would report a clean tarball having seen nothing.
        const p = write('empty.json', JSON.stringify([{ files: [] }]));
        expect(() => readPackedFiles(p)).toThrow(/listed no files/i);
    });

    it('throws on unparseable JSON', () => {
        const p = write('bad.json', 'not json at all');
        expect(() => readPackedFiles(p)).toThrow(/could not parse/i);
    });

    it('throws on a report of the wrong shape', () => {
        const p = write('wrong.json', JSON.stringify({ files: [{ path: 'README.md' }] }));
        expect(() => readPackedFiles(p)).toThrow(/listed no files/i);
    });
});