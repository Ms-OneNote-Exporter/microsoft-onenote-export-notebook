const fs = require('fs-extra');
const path = require('path');

/**
 * Keeps the README's file listing honest.
 *
 * F-50: the "Project Structure" block named a project root
 * (`microsoft-onenote-export-notebook-playwright-js/`) that does not exist, and
 * omitted the two `diagnose-*` scripts, the three Docker files, the CI workflow,
 * every test file and three of the five utils. It had drifted silently because
 * nothing compared it to the tree.
 *
 * This is a deliberately cheap structural check, not a documentation linter: it
 * only verifies that every file the README claims to describe exists, that the
 * stale root name is gone, and that the CLI options table lists every option the
 * program actually defines.
 */
const ROOT = path.resolve(__dirname, '..');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const indexJs = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');

/** Every tracked file, minus the things a README never lists. */
const listed = (rel) => readme.includes(rel);

describe('README project structure', () => {
    // The README shows a directory tree, so a file under src/ appears by its
    // basename beneath a `src/` node rather than as a full path. Assert the
    // basename is mentioned and that the containing directory node exists.
    it.each([
        'index.js', 'auth-context.js', 'config.js', 'navigator.js', 'exporter.js',
        'scrapers.js', 'parser.js', 'linkResolver.js', 'downloadStrategies.js',
        'diagnose-notebook.js', 'diagnose-notebook-newpage.js',
    ])('describes src/%s', (file) => {
        expect(fs.existsSync(path.join(ROOT, 'src', file))).toBe(true);
        expect(readme).toContain(file);
    });

    it.each([
        'logger.js', 'retry.js', 'logPaths.js', 'fetchHosts.js', 'naming.js',
    ])('describes src/utils/%s', (file) => {
        expect(fs.existsSync(path.join(ROOT, 'src', 'utils', file))).toBe(true);
        expect(readme).toContain(file);
    });

    it('has tree nodes for the directories that hold them', () => {
        expect(readme).toMatch(/src\//);
        expect(readme).toMatch(/utils\//);
    });

    it.each([
        'Dockerfile', 'entrypoint.sh', 'start-container.sh', 'CHANGELOG.md',
        '.github/workflows/ci.yml',
        // The publish workflow is listed for the same reason as the others: the
        // README tree is meant to describe the repository, and a release path
        // that only exists in .github/ is exactly the sort of thing a reader
        // needs to be told about.
        '.github/workflows/npm-publish.yml',
        // As is the workflow that repairs the Releases panel, since a maintainer
        // looking for how releases are made should find both halves of the answer.
        '.github/workflows/release-backfill.yml',
    ])('describes %s', (file) => {
        expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
        expect(listed(file)).toBe(true);
    });

    it('describes the release-notes script the publish workflow calls', () => {
        // Not decoration: npm-publish.yml runs `node scripts/release-notes.js`, so
        // a tree that omits it documents a repository whose release step names a
        // file nobody can find.
        expect(fs.existsSync(path.join(ROOT, 'scripts', 'release-notes.js'))).toBe(true);
        expect(readme).toContain('release-notes.js');
        expect(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'npm-publish.yml'), 'utf8'))
            .toContain('node scripts/release-notes.js');
    });

    it('does not claim a project root that does not exist', () => {
        // The old block was headed with a directory name from a previous repo.
        expect(readme).not.toMatch(/microsoft-onenote-export-notebook-playwright-js/);
        expect(readme).toMatch(/^microsoft-onenote-export-notebook\/$/m);
    });
});

describe('README options table', () => {
    /** Long and short flags declared on the export subcommand. */
    const declaredOptions = [...indexJs.matchAll(/\.option\(\s*'([^']+)'/g)].map((m) => m[1]);

    it('finds the option declarations to compare against', () => {
        expect(declaredOptions.length).toBeGreaterThan(5);
    });

    it.each(declaredOptions.map((o) => o.replace(/^[-\w]+,\s*/, '').replace(/[<>].*$/, '').trim()))
    ('documents the %s option', (flag) => {
        // -v, --verbose is declared as one string; compare on the long form.
        const longForm = declaredOptions.find((o) => o.includes(flag)) || flag;
        const canonical = longForm.includes('--') ? longForm.match(/--[\w-]+/)[0] : flag;
        expect(readme).toContain(canonical);
    });

    it('documents the required auth-file option', () => {
        expect(readme).toContain('--auth-file');
    });
});

describe('README documents the behaviours that changed in 0.2.0', () => {
    it('documents the exit codes, including the container asymmetry', () => {
        expect(readme).toMatch(/##\s*Exit codes/);
        // The asymmetry is the surprising part, so it must be written down.
        expect(readme).toMatch(/entrypoint\.sh[\s\S]{0,200}exits `0`/);
    });

    it('documents where logs live for a global install', () => {
        expect(readme).toMatch(/XDG_STATE_HOME/);
        expect(readme).toMatch(/ONENOTE_EXPORT_LOG_DIR/);
    });

    it('warns that debug output is off by default', () => {
        expect(readme).toMatch(/off by default/i);
    });

    it('warns that dumps are sensitive', () => {
        expect(readme).toMatch(/sensitive/i);
    });
});
