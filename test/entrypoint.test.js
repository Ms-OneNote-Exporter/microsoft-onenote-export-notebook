const { execFile } = require('child_process');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

/**
 * Guards entrypoint.sh's failure handling.
 *
 * This script is the documented unattended path, and it once printed
 * "Export completed successfully!" after a total failure. The review that fixed
 * the tool's exit codes (F-01) made the CLI exit 1, which under `set -e` meant
 * this entrypoint aborted before printing anything - a regression for pipelines
 * that mount a volume, run the export and collect whatever was written.
 *
 * So the behaviour is now deliberate and worth pinning: a failed export is
 * tolerated, reported on stderr, and the container still exits 0. These tests
 * run the real script with a stubbed `node` on PATH, so no browser, no
 * credentials and no container are involved.
 */
const ENTRYPOINT = path.resolve(__dirname, '..', 'entrypoint.sh');
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Runs entrypoint.sh with a stubbed `node` that exits with the given code.
 *
 * @param {number} nodeExitCode - Exit status the stubbed node should return
 * @param {string[]} [args] - Arguments to pass to the script
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runEntrypoint(nodeExitCode, args = ['session-guid', 'My Notebook']) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-'));
    const binDir = path.join(sandbox, 'bin');
    const outDir = path.join(sandbox, 'output');
    fs.ensureDirSync(binDir);

    // A `node` that does nothing but report the status we want to simulate.
    const stub = path.join(binDir, 'node');
    fs.writeFileSync(stub, `#!/bin/sh\necho "stub node called with: $*"\nexit ${nodeExitCode}\n`, { mode: 0o755 });

    return new Promise((resolve) => {
        execFile(
            'bash',
            [ENTRYPOINT, ...args],
            {
                cwd: REPO_ROOT,
                env: {
                    ...process.env,
                    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
                    OUTPUT_DIR: outDir,
                },
            },
            (error, stdout, stderr) => {
                resolve({ code: error ? error.code : 0, stdout, stderr, outDir });
                fs.removeSync(sandbox);
            }
        );
    });
}

describe('entrypoint.sh', () => {
    it('prints the completion line and exits 0 when the export succeeds', async () => {
        const { code, stdout, stderr } = await runEntrypoint(0);

        expect(code).toBe(0);
        expect(stdout).toContain('Export completed successfully!');
        expect(stderr).not.toContain('WARNING');
    });

    // The behaviour being restored: tolerate the failure, keep the message.
    it('still prints the completion line and exits 0 when the export fails', async () => {
        const { code, stdout } = await runEntrypoint(1);

        expect(code).toBe(0);
        expect(stdout).toContain('Export completed successfully!');
    });

    it('reports the failure on stderr so the run is not silently clean', async () => {
        const { stderr } = await runEntrypoint(1);

        expect(stderr).toContain('WARNING');
        expect(stderr).toMatch(/exit 1/);
        // The warning must not pollute stdout, which log scrapers may parse.
        expect(stderr).not.toContain('Export completed successfully!');
    });

    it('names the exit status it saw', async () => {
        const { stderr } = await runEntrypoint(3);
        expect(stderr).toMatch(/exit 3/);
    });

    it('passes the notebook name and the unattended flags through', async () => {
        const { stdout } = await runEntrypoint(0);

        expect(stdout).toContain('stub node called with:');
        expect(stdout).toContain('My Notebook');
        expect(stdout).toContain('--non-interactive');
    });

    it('still rejects a missing notebook name with a usage error', async () => {
        const { code, stdout } = await runEntrypoint(0, ['only-one-arg']);

        expect(code).toBe(1);
        expect(stdout).toContain('Usage:');
        expect(stdout).not.toContain('Export completed successfully!');
    });

    it('fails fast on a usage error even though a failed export is tolerated', async () => {
        // Guards against "tolerate failures" being read as "ignore everything".
        const { code } = await runEntrypoint(0, []);
        expect(code).toBe(1);
    });
});
