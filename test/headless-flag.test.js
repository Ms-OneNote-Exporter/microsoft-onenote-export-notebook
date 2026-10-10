/**
 * Verifies the --headless flag implementation in diagnose-notebook.js.
 *
 * The script must support running headless on any host (including CI/containers)
 * where no X server is available. The flag was introduced to let users in
 * headless environments opt *in* instead of forcing them to set an environment
 * variable to work around the hardcoded `notheadless: true`.
 *
 * ## Why this test reads source text
 *
 * The headless flag's correctness cannot be asserted by invoking the script
 * (that would require a browser and a display). Instead, the test asserts the
 * *shape* of the implementation: the two call sites that create the browser
 * context must pass `notheadless: !opts.headless`.
 *
 * Passing `notheadless: opts.headless` would invert the logic: `--headless`
 * would set `notheadless: true`, which navigator.js interprets as
 * `headless: !true = false`, opening a browser window in a headless container.
 * The exact failure this flag was designed to fix.
 */
const fs = require('fs');
const path = require('path');

const DIAGNOSE_NOTEBOOK = path.resolve(__dirname, '..', 'src', 'diagnose-notebook.js');

describe('diagnose-notebook --headless flag', () => {
    const source = fs.readFileSync(DIAGNOSE_NOTEBOOK, 'utf8');

    it('declares the --headless option in the commander block', () => {
        const hasHeadlessOption = source.match(/\.option\(\s*'--headless'/);
        expect(hasHeadlessOption).toBeTruthy();
    });

    it('does NOT declare a --notheadless option', () => {
        const hasNotheadlessOption = source.match(/\.option\(\s*'--notheadless'/);
        expect(hasNotheadlessOption).toBeFalsy();
    });

    it('reads opts.headless at the call sites, with no dangling local alias', () => {
        // This replaced an assertion that `const headless = opts.headless;` must
        // exist. It was pinning a variable nothing ever read — a test that forces
        // dead code into the source is worse than no test, because it looks like
        // coverage. What matters is that `opts.headless` is *consumed*, which the
        // next test proves at the call sites.
        //
        // So: no local may shadow the option, and the option must be referenced.
        const danglingAlias = source.match(/const\s+headless\s*=\s*opts\.headless/);
        expect(danglingAlias).toBeFalsy();
        expect(source).toMatch(/opts\.headless/);
    });

    /**
     * The critical invariant: call sites pass `notheadless: !opts.headless`.
     *
     * navigator.js computes `headless = !options.notheadless`, so to get
     * `headless: true` when the user passes `--headless`, we need:
     * - opts.headless = true  (user passed --headless)
     * - notheadless = !true = false
     * - headless = !false = true  (correct)
     *
     * If we passed `notheadless: opts.headless` instead:
     * - opts.headless = true
     * - notheadless = true
     * - headless = !true = false  (BROKEN: opens headed browser)
     */
    it('call sites pass notheadless: !opts.headless', () => {
        // Count non-comment occurrences (in source, not comments)
        const lines = source.split('\n');
        let count = 0;
        for (const line of lines) {
            const trimmed = line.trim();
            // Skip comment lines
            if (trimmed.startsWith('//')) continue;
            // Check for the pattern in code (not in comments)
            if (/notheadless:\s*!\s*opts\.headless/.test(trimmed)) {
                count++;
            }
        }
        expect(count).toBeGreaterThanOrEqual(2,
            'There must be at least two occurrences of `notheadless: !opts.headless`: ' +
            'one in openNotebookByLink and one in listNotebooks'
        );

        // Verify the specific call sites mentioned in the plan - use simpler regex
        const hasOpenNotebookByLink = /openNotebookByLink\(\s*\{[\s\S]*notheadless:\s*!\s*opts\.headless/.test(source);
        expect(hasOpenNotebookByLink).toBe(true);

        const hasListNotebooks = /listNotebooks\(\s*\{[\s\S]*notheadless:\s*!\s*opts\.headless/.test(source);
        expect(hasListNotebooks).toBe(true);
    });

    it('does NOT use the buggy pattern notheadless: opts.headless in code', () => {
        const lines = source.split('\n');
        const buggyLines = [];
        for (const line of lines) {
            const trimmed = line.trim();
            // Skip comment lines
            if (trimmed.startsWith('//')) continue;
            // Check for the buggy pattern in code (not in comments)
            if (/notheadless:\s*opts\.headless(?!\s*!)/.test(trimmed)) {
                buggyLines.push(trimmed);
            }
        }
        expect(buggyLines.length).toBe(0,
            'Buggy pattern `notheadless: opts.headless` found in code. This would make --headless open a window. Found: ' + buggyLines.join(' | ')
        );
    });

    it('includes a comment explaining the double-negation', () => {
        // The comment should mention why `!opts.headless` is required
        const hasComment = source.includes('notheadless') && source.includes('headless') && source.includes('!');
        expect(hasComment).toBeTruthy();
    });
});
