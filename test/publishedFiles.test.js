const fs = require('fs-extra');
const path = require('path');

/**
 * Guards the published tarball against leaking real account identifiers.
 *
 * Two were found on the way to publishing 0.2.0, both pre-existing from the
 * initial commit and both in files npm ships:
 *
 *   - src/navigator.js  a JSDoc example URL containing the SharePoint tenant
 *                       subdomain, e.g. "<tenant>-my.sharepoint.com"
 *   - README.md         an --auth-file walkthrough naming an actual notebook
 *
 * Neither is a secret, but a tenant subdomain and a notebook name are personal
 * data, and npm is a public registry: once published, that version's tarball can
 * be downloaded forever. The project's stated policy is to strip all PII before
 * anything leaves the machine, and this test is what makes that policy hold for
 * the published package rather than for a single review pass.
 *
 * The file list is taken from package.json `files`, plus the four files npm always
 * includes, so the check follows the package as it is actually configured.
 */
const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Identifiers that must never appear in a published file. */
const FORBIDDEN = [
    'mobilutils',      // SharePoint tenant
    'mousquetaires',   // group tenant
    'john_pigeret',    // account name
    'pigueret',
];

/** Every file that npm would include, resolved from package.json. */
function publishedFiles() {
    const out = new Set([
        'package.json',
        'README.md',
        'LICENSE',
        'CHANGELOG.md',
    ]);

    for (const entry of pkg.files || []) {
        const abs = path.join(ROOT, entry);
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
            const walk = (dir) => {
                for (const name of fs.readdirSync(dir)) {
                    const full = path.join(dir, name);
                    if (fs.statSync(full).isDirectory()) walk(full);
                    else if (name.endsWith('.js')) out.add(path.relative(ROOT, full));
                }
            };
            walk(abs);
        } else if (fs.existsSync(abs)) {
            out.add(entry);
        }
    }
    return [...out].sort();
}

describe('published files carry no account identifiers', () => {
    const files = publishedFiles();

    it('resolves a plausible file list, so the checks below are not vacuous', () => {
        expect(files.length).toBeGreaterThan(10);
        expect(files).toContain('src/exporter.js');
        expect(files).toContain('README.md');
    });

    it.each(publishedFiles())('%s contains no tenant or account identifier', (rel) => {
        const text = fs.readFileSync(path.join(ROOT, rel), 'utf8').toLowerCase();
        for (const needle of FORBIDDEN) {
            expect({ file: rel, found: needle, at: text.indexOf(needle) })
                .toEqual({ file: rel, found: needle, at: -1 });
        }
    });

    it('the navigator example URL uses the documented placeholder', () => {
        // Pins the fix specifically, so a future edit cannot quietly reintroduce a
        // real host in a way the generic scan would only catch by luck.
        const text = fs.readFileSync(path.join(ROOT, 'src/navigator.js'), 'utf8');
        expect(text).toContain('COMPANYNAME-my.sharepoint.com');
    });

    it('the README example does not name a real notebook', () => {
        const text = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
        // Every --notebook example in the README should be a placeholder.
        const examples = [...text.matchAll(/--notebook\s+"([^"]+)"/g)].map((m) => m[1]);
        expect(examples.length).toBeGreaterThan(0);
        for (const name of examples) {
            expect({ name, placeholder: /^x$/i.test(name) || /my notebook/i.test(name) })
                .toEqual({ name, placeholder: true });
        }
    });
});

describe('no credential material is published', () => {
    it('the tarball file list contains no auth, log, dump or fixture paths', () => {
        const joined = publishedFiles().join('\n').toLowerCase();
        for (const forbidden of ['auth.json', 'logs/', 'dumps/', 'fixtures/', '.github', 'test/']) {
            expect(joined).not.toContain(forbidden);
        }
    });

    it('package.json declares no bundled dependencies that could ship a secret', () => {
        // Only real runtime dependencies should be there; a file: or link: entry
        // would pull local content into the tarball.
        for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
            expect({ name, spec }).toEqual({ name, spec });
            expect(spec).not.toMatch(/^(file|link|git\+)/);
        }
    });
});
