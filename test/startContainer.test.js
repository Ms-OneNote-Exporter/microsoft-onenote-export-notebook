const { execFile } = require('child_process');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

/**
 * Behavioural tests for start-container.sh, with `docker` stubbed.
 *
 * The bug these guard (F-46) is a good example of why this file is tested at all:
 * the script created a container named `oneexp_$SESSIONGUID` while printing
 * instructions that told the user to run `docker exec one-$SESSIONGUID ...`. The
 * copy-pasted command could not work, and nothing caught it because the script was
 * never executed outside one machine - where it also pointed at a hardcoded
 * sibling checkout.
 */
const SCRIPT = path.resolve(__dirname, '..', 'start-container.sh');
const ROOT = path.resolve(__dirname, '..');

/**
 * Runs the script with a stubbed docker that records how it was called.
 *
 * @param {string[]} [args] - Arguments for start-container.sh
 * @param {Object} [env] - Extra environment (IMAGE, CONTAINER, OUTPUT_DIR, ...)
 * @returns {Promise<{code: number, stdout: string, stderr: string, calls: string[][], waitCode: string}>}
 */
function runScript(args = ['abc123', 'My Notebook'], env = {}) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'startc-'));
    const binDir = path.join(sandbox, 'bin');
    const outDir = path.join(sandbox, 'out');
    const logFile = path.join(sandbox, 'docker-calls.log');
    fs.ensureDirSync(binDir);
    fs.ensureDirSync(outDir);
    fs.writeFileSync(path.join(outDir, 'auth.json'), '{"cookies":[]}');

    // Records each argument on its own line, so a test can assert on the exact
    // flags passed rather than on human-readable output. (Arguments containing a
    // newline would break this, which none of the script's arguments do.)
    const stub = `#!/bin/sh
printf '%s\\n' "$@" >> "${logFile}"
if [ "$1" = "wait" ]; then echo "\${STUB_WAIT_CODE:-0}"; fi
exit 0
`;
    fs.writeFileSync(path.join(binDir, 'docker'), stub, { mode: 0o755 });

    return new Promise((resolve) => {
        execFile(
            'bash',
            [SCRIPT, ...args],
            {
                cwd: ROOT,
                env: {
                    ...process.env,
                    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
                    OUTPUT_DIR: outDir,
                    STUB_WAIT_CODE: '0',
                    ...env,
                },
            },
            (error, stdout, stderr) => {
                const raw = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
                const argv = raw.split('\n').filter((l) => l.length > 0);

                // Split the flat argv list back into per-invocation arrays on the
                // subcommand, so `calls[0]` is the args of `docker run` and so on.
                const calls = [];
                for (const arg of argv) {
                    if (arg === 'run' || arg === 'wait' || arg === 'logs' || arg === 'exec') {
                        calls.push([arg]);
                    } else {
                        calls[calls.length - 1].push(arg);
                    }
                }

                resolve({ code: error ? error.code : 0, stdout, stderr, calls, outDir });
                fs.removeSync(sandbox);
            }
        );
    });
}

/** The flags of the `docker run` invocation. */
const runCall = (calls) => calls.find((c) => c[0] === 'run');

describe('start-container.sh', () => {
    it('requires a session guid', async () => {
        const { code, stderr } = await runScript([]);
        expect(code).toBe(1);
        expect(stderr).toContain('SESSIONGUID is required');
    });

    it('requires a notebook name', async () => {
        const { code, stderr } = await runScript(['abc123']);
        expect(code).toBe(1);
        expect(stderr).toContain('Notebook name is required');
    });

    it('fails fast when there is no auth file, instead of starting a doomed container', async () => {
        const { code, stderr, calls } = await runScript(['abc123', 'NB'], {
            AUTH_FILE: '/nonexistent/auth.json',
        });
        expect(code).toBe(1);
        expect(stderr).toContain('no auth file');
        expect(calls).toHaveLength(0);
    });

    it('creates the container detached', async () => {
        const { calls } = await runScript();
        expect(runCall(calls)).toBeDefined();
        expect(runCall(calls)).toContain('--detach');
    });

    // Chromium crashes with Docker's default 64 MB of shared memory.
    it('passes --shm-size and --init for Chromium', async () => {
        const { calls } = await runScript();
        const run = runCall(calls);
        expect(run).toContain('--init');
        expect(run.some((a) => a.startsWith('--shm-size'))).toBe(true);
    });

    it('mounts the output directory at /data/output', async () => {
        const { calls } = await runScript();
        const run = runCall(calls);
        const volume = run.find((a) => a.includes(':'));
        expect(volume).toMatch(/:[0-9]*\/data\/output$/);
    });

    it('passes the session guid and notebook name through', async () => {
        const { calls } = await runScript(['abc123', 'My Notebook']);
        const run = runCall(calls);
        expect(run.slice(-2)).toEqual(['abc123', 'My Notebook']);
    });

    // F-46. The printed `docker exec` hint has to name the container that was
    // actually created, or the copy-pasted command cannot work.
    it('prints an exec hint naming the container it actually created', async () => {
        const { calls, stdout } = await runScript(['abc123', 'NB']);
        const nameIndex = runCall(calls).indexOf('--name');
        const createdName = runCall(calls)[nameIndex + 1];

        expect(createdName).toBeTruthy();
        expect(stdout).toContain(`docker exec ${createdName} `);
    });

    it('lets the container name be overridden', async () => {
        const { calls, stdout } = await runScript(['abc123', 'NB'], { CONTAINER: 'my-own-name' });
        const nameIndex = runCall(calls).indexOf('--name');
        expect(runCall(calls)[nameIndex + 1]).toBe('my-own-name');
        // And the hint still has to agree.
        expect(stdout).toContain('docker exec my-own-name ');
    });

    it('lets the image be overridden instead of hardcoding one', async () => {
        const { calls } = await runScript(['abc123', 'NB'], { IMAGE: 'ghcr.io/example/other:1' });
        expect(runCall(calls)).toContain('ghcr.io/example/other:1');
    });

    it('does not reference a sibling checkout path', async () => {
        // Checked against the executable lines only: the script's comments quote
        // the old hardcoded path in order to explain why it is gone, and that
        // explanation should not read as a violation of the rule it documents.
        const executable = fs.readFileSync(SCRIPT, 'utf8')
            .split('\n')
            .filter((l) => !l.trim().startsWith('#'))
            .join('\n');
        expect(executable).not.toMatch(/microsoft-onenote-exporter-docker/);
    });

    it('waits for the container and reports a non-zero exit', async () => {
        const { calls, stdout, stderr, code } = await runScript(['abc123', 'NB'], {
            STUB_WAIT_CODE: '7',
        });
        expect(calls.some((c) => c[0] === 'wait')).toBe(true);
        expect(stderr).toContain('status 7');
        // The script itself still succeeds - it reported the problem, it did not
        // become the problem.
        expect(code).toBe(0);
        expect(stdout).not.toContain('Container finished.');
    });

    it('reports success when the container exits cleanly', async () => {
        const { stdout } = await runScript(['abc123', 'NB']);
        expect(stdout).toContain('Container finished.');
    });
});
