const fs = require('fs-extra');
const os = require('os');
const path = require('path');

/**
 * F-36/F-37/F-38/F-48: the logger wrote to a hardcoded path, logged everything
 * including debug, never rotated, and left authenticated DOM dumps readable by
 * other users on the machine.
 *
 * The logger is a module-level singleton created on require, so each test
 * re-requires it with jest.resetModules() and a fresh temp log dir.
 */

const LOG_ENV = 'ONENOTE_EXPORT_LOG_DIR';
const LEVEL_ENV = 'ONENOTE_EXPORT_LOG_LEVEL';

/** Creates a temp log dir and points the logger at it. */
function freshLogger(env = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
    for (const key of [LOG_ENV, LEVEL_ENV]) {
        delete process.env[key];
    }
    // Must actually redirect the logger, otherwise it writes to the repository's
    // real logs/app.log - which both pollutes the working tree and makes the
    // permission assertions below meaningless, since that file already exists.
    Object.assign(process.env, { [LOG_ENV]: dir }, env);
    jest.resetModules();
    const logger = require('../src/utils/logger');
    return { logger, dir };
}

/** Captures writes to stdout/stderr for the duration of `fn`. */
async function captureOutput(fn) {
    const out = [];
    const err = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
    try {
        await fn();
    } finally {
        process.stdout.write = realOut;
        process.stderr.write = realErr;
    }
    return { out: out.join(''), err: err.join('') };
}

describe('log directory resolution (F-37)', () => {
    let saved;

    beforeEach(() => {
        saved = { log: process.env[LOG_ENV], level: process.env[LEVEL_ENV] };
    });

    afterEach(() => {
        if (saved.log === undefined) delete process.env[LOG_ENV];
        else process.env[LOG_ENV] = saved.log;
        if (saved.level === undefined) delete process.env[LEVEL_ENV];
        else process.env[LEVEL_ENV] = saved.level;
    });

    it('honours ONENOTE_EXPORT_LOG_DIR above everything else', () => {
        const { resolveLogDir } = require('../src/utils/logPaths');
        process.env[LOG_ENV] = '/tmp/somewhere-else';
        expect(resolveLogDir()).toBe('/tmp/somewhere-else');
    });

    it('resolves a relative override to an absolute path', () => {
        const { resolveLogDir } = require('../src/utils/logPaths');
        process.env[LOG_ENV] = 'relative-logs';
        expect(path.isAbsolute(resolveLogDir())).toBe(true);
    });

    it('ignores a blank override', () => {
        const { resolveLogDir } = require('../src/utils/logPaths');
        process.env[LOG_ENV] = '   ';
        expect(resolveLogDir()).not.toContain('   ');
    });

    // The bug: a global install resolves __dirname to
    // <prefix>/lib/node_modules/@msout/<pkg>/src/utils, so the old hardcoded
    // ../../logs landed inside node_modules.
    it('never writes inside node_modules, whatever the install layout', () => {
        for (const layout of [
            '/usr/lib/node_modules/@msout/microsoft-onenote-export-notebook/src/utils',
            '/opt/homebrew/lib/node_modules/@msout/microsoft-onenote-export-notebook/src/utils',
            '/home/u/.nvm/versions/node/v20/lib/node_modules/pkg/src/utils',
        ]) {
            process.env[LOG_ENV] = '';
            delete process.env[LOG_ENV];
            // Simulate by asking the module to judge a given __dirname.
            const dir = require('../src/utils/logPaths').resolveLogDirFor(layout);
            expect(dir).not.toContain('node_modules');
            expect(path.isAbsolute(dir)).toBe(true);
        }
    });

    it('uses the package logs dir for a plain checkout', () => {
        const { resolveLogDir } = require('../src/utils/logPaths');
        const dir = resolveLogDir();
        // In this repo there is no node_modules in the package path.
        expect(dir.endsWith(path.join('microsoft-onenote-export-notebook', 'logs')) ||
               dir.endsWith('logs')).toBe(true);
    });
});

describe('logger levels (F-36)', () => {
    let dir;

    afterEach(() => {
        if (dir) fs.removeSync(dir);
        delete process.env[LOG_ENV];
        delete process.env[LEVEL_ENV];
    });

    it('hides debug by default', async () => {
        const created = freshLogger();
        dir = created.dir;
        const { out } = await captureOutput(() => created.logger.debug('should not appear'));
        expect(out).not.toContain('should not appear');
    });

    it('shows debug when the level is set to debug', async () => {
        const { logger } = freshLogger({ [LEVEL_ENV]: 'debug' });
        const { out } = await captureOutput(() => logger.debug('now visible'));
        expect(out).toContain('now visible');
    });

    it('setLevel switches verbosity at runtime', async () => {
        const { logger } = freshLogger();

        let out = (await captureOutput(() => logger.debug('quiet please'))).out;
        expect(out).not.toContain('quiet please');

        logger.setLevel('debug');
        out = (await captureOutput(() => logger.debug('now please'))).out;
        expect(out).toContain('now please');
    });

    it('quiet hides info but keeps warnings and errors', async () => {
        const { logger } = freshLogger();
        logger.setLevel('warn');

        const { out, err } = await captureOutput(() => {
            logger.info('routine chatter');
            logger.success('all good');
            logger.warn('something odd');
            logger.error('something bad');
        });

        expect(out).not.toContain('routine chatter');
        expect(out).not.toContain('all good');
        expect(out).toContain('something odd');
        expect(err).toContain('something bad');
    });

    it('ignores an unknown level name', () => {
        const { logger } = freshLogger();
        const before = logger.level;
        logger.setLevel('nonsense');
        expect(logger.level).toBe(before);
    });

    it('still writes suppressed messages to nothing at all', async () => {
        const { logger } = freshLogger();
        const logFile = logger.logFilePath;
        await captureOutput(() => {
            logger.debug('hidden from stdout AND file');
            logger.warn('visible');
        });
        const contents = fs.readFileSync(logFile, 'utf8');
        expect(contents).not.toContain('hidden from stdout AND file');
        expect(contents).toContain('visible');
    });
});

describe('log file hygiene', () => {
    let dir;

    afterEach(() => {
        if (dir) fs.removeSync(dir);
        delete process.env[LOG_ENV];
        delete process.env[LEVEL_ENV];
    });

    it('creates the log directory owner-only (F-48)', () => {
        const created = freshLogger();
        const { logger } = created;
        dir = created.dir;
        expect(fs.existsSync(logger.logDir)).toBe(true);
        // POSIX only; skip the assertion where it does not apply.
        if (process.platform !== 'win32') {
            const mode = fs.statSync(logger.logDir).mode & 0o777;
            expect(mode).toBe(0o700);
        }
    });

    it('creates the log file owner-only', async () => {
        const { logger } = freshLogger();
        await captureOutput(() => logger.info('first line'));
        if (process.platform !== 'win32') {
            const mode = fs.statSync(logger.logFilePath).mode & 0o777;
            expect(mode).toBe(0o600);
        }
    });

    it('tightens a pre-existing world-readable log file', async () => {
        // A log written by an earlier version is still 0644, and appendFileSync's
        // `mode` option only applies at creation - so without a startup chmod the
        // old exposure would persist forever.
        const { logger } = freshLogger();
        fs.writeFileSync(logger.logFilePath, 'old content\n', { mode: 0o644 });
        expect(fs.statSync(logger.logFilePath).mode & 0o077).toBeGreaterThan(0);

        jest.resetModules();
        require('../src/utils/logger');

        if (process.platform !== 'win32') {
            expect(fs.statSync(logger.logFilePath).mode & 0o777).toBe(0o600);
        }
    });

    it('creates the dump directory owner-only (F-48)', async () => {
        const { logger } = freshLogger();
        const dumpDir = await logger.getDumpDir();
        expect(fs.existsSync(dumpDir)).toBe(true);
        if (process.platform !== 'win32') {
            const mode = fs.statSync(dumpDir).mode & 0o777;
            expect(mode).toBe(0o700);
        }
    });

    it('never throws when the log directory cannot be written', () => {
        // A read-only location must not take the export down with it.
        const { logger } = freshLogger();
        logger.logFilePath = '/proc/definitely-not-writable/app.log';
        expect(() => logger.info('this must not throw')).not.toThrow();
    });
});

describe('timestamps (F-38)', () => {
    let dir;

    afterEach(() => {
        if (dir) fs.removeSync(dir);
        delete process.env[LOG_ENV];
        delete process.env[LEVEL_ENV];
    });

    it('includes the year and a timezone offset', async () => {
        const { logger } = freshLogger();
        const { out } = await captureOutput(() => logger.info('stamped'));
        // e.g. [2026-09-28 10:12:07+02:00]
        expect(out).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]/);
    });
});
