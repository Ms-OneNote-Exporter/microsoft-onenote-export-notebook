const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const { resolveLogDir } = require('./logPaths');

/** Severity order, lowest first. A message is emitted if its level >= the threshold. */
const LEVELS = { debug: 10, info: 20, step: 20, success: 20, warn: 30, error: 40 };

/** Rotate app.log once it passes this size, so a long export cannot fill the disk. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

class Logger {
    constructor() {
        this.logDir = resolveLogDir();
        this.logFilePath = path.join(this.logDir, 'app.log');

        // Debug output was previously unconditional, so it always appeared on
        // stdout and in the log file. It is now off unless asked for.
        this.level = Logger._initialLevel();

        // Initialize dump directory name once per execution.
        //
        // Second granularity, not minute: two exports started inside the same
        // minute used to share one dump directory, so the second run's HTML and
        // screenshots overwrote the first's file by file. A bug report that says
        // "look in logs/dumps/<timestamp>" then points at whichever run happened to
        // be last, which is the opposite of what a dump is for.
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const hh = String(now.getHours()).padStart(2, '0');
        const min = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');

        // Format: YYYY-MM-DD_HHhMMmSS
        this.dumpSubDir = `${yyyy}-${mm}-${dd}_${hh}h${min}m${ss}`;

        // Ensure logs directory exists. Restricted permissions because the dump
        // files written next to app.log contain the authenticated DOM of a real
        // notebook: cookies, tenant hostnames and note content (F-48).
        this._ensurePrivateDir(this.logDir);
        this._tightenExistingLogFile();
        this._rotateIfLarge();
    }

    /**
     * Brings an existing app.log down to owner-only.
     *
     * Files this process creates are 0600 from the start, but a log written by an
     * earlier version - or before this fix existed - is still 0644, and
     * appendFileSync's `mode` only applies at creation. One chmod at startup is
     * enough to close that off.
     */
    _tightenExistingLogFile() {
        try {
            const stats = fs.statSync(this.logFilePath);
            if ((stats.mode & 0o077) !== 0) {
                fs.chmodSync(this.logFilePath, 0o600);
            }
        } catch (e) {
            // No log file yet, or chmod unsupported: not fatal.
        }
    }

    /**
     * Reads the initial threshold from the environment.
     *
     * ONENOTE_EXPORT_LOG_LEVEL accepts debug|info|warn|error. Unset means info,
     * which hides debug but keeps everything a user needs to follow an export.
     *
     * @returns {number} Numeric threshold
     */
    static _initialLevel() {
        const requested = (process.env.ONENOTE_EXPORT_LOG_LEVEL || '').trim().toLowerCase();
        return LEVELS[requested] ?? LEVELS.info;
    }

    /**
     * Creates a directory and forces owner-only permissions on it.
     *
     * fs.ensureDirSync honours the process umask, so on a permissive umask the
     * dumps would end up world-readable. chmod makes it explicit rather than
     * dependent on the environment.
     *
     * @param {string} dir - Directory to create
     */
    _ensurePrivateDir(dir) {
        fs.ensureDirSync(dir);
        try {
            fs.chmodSync(dir, 0o700);
        } catch (e) {
            // A filesystem that does not support chmod is not a reason to fail
            // an export; the warning below is enough.
        }
    }

    /**
     * Rotates app.log to app.log.1 when it grows past MAX_LOG_BYTES.
     *
     * Exports run unattended for hours and log every page, so without this the
     * log grows without bound.
     */
    _rotateIfLarge() {
        try {
            const stats = fs.statSync(this.logFilePath);
            if (stats.size <= MAX_LOG_BYTES) return;
            fs.moveSync(this.logFilePath, `${this.logFilePath}.1`, { overwrite: true });
        } catch (e) {
            // No log file yet, or it cannot be rotated: not fatal.
        }
    }

    /**
     * Raises or lowers the threshold at runtime.
     * @param {string} name - One of debug|info|warn|error
     */
    setLevel(name) {
        const level = LEVELS[(name || '').toLowerCase()];
        if (level !== undefined) {
            this.level = level;
        }
    }

    /**
     * True when a message at `level` should be emitted.
     * @param {string} level - Message level
     * @returns {boolean}
     */
    _enabled(level) {
        return (LEVELS[level] ?? LEVELS.info) >= this.level;
    }

    /**
     * Returns the absolute path to the current session's dump directory.
     * Ensures the directory exists, owner-only.
     * @returns {Promise<string>}
     */
    async getDumpDir() {
        const dumpDir = path.join(this.logDir, 'dumps', this.dumpSubDir);
        this._ensurePrivateDir(dumpDir);
        return dumpDir;
    }

    /**
     * Returns a user-friendly relative path for logging.
     * @returns {string}
     */
    getDumpDisplayPath() {
        return path.relative(process.cwd(), path.join(this.logDir, 'dumps', this.dumpSubDir)) || '.';
    }

    _getTimestamp() {
        const now = new Date();
        const day = String(now.getDate()).padStart(2, '0');
        const time = now.toTimeString().split(' ')[0];
        // The year and timezone are included because a long unattended run can
        // cross midnight, and two logs from different years otherwise look
        // identical (F-38).
        return `[${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${day} ${time}${tzOffset()}]`;
    }

    _stripColors(str) {
        // eslint-disable-next-line no-control-regex
        return str.replace(/\u001b\[[0-9;]*m/g, '');
    }

    _formatMessage(level, message, colorFunc = (m) => m) {
        const timestamp = this._getTimestamp();
        const coloredTimestamp = chalk.gray(timestamp);
        const levelTag = `[${level}]`;
        const coloredLevelTag = colorFunc(levelTag);

        // Handle multi-line messages
        let formattedMessage = '';
        if (typeof message === 'string' && message.includes('\n')) {
            formattedMessage = message.split('\n').map(line => `${coloredTimestamp} ${coloredLevelTag} ${line}`).join('\n');
        } else if (typeof message !== 'string') {
            // Handle objects/errors
            try {
                const stringified = JSON.stringify(message, null, 2);
                formattedMessage = `${coloredTimestamp} ${coloredLevelTag} ${stringified}`;
            } catch (e) {
                formattedMessage = `${coloredTimestamp} ${coloredLevelTag} [Complex Object]`;
            }
        } else {
            formattedMessage = `${coloredTimestamp} ${coloredLevelTag} ${message}`;
        }

        // Write to log file (no colors)
        const plainTimestamp = timestamp;
        const plainLevelTag = levelTag;
        let plainMessage = '';

        if (typeof message === 'string' && message.includes('\n')) {
            plainMessage = message.split('\n').map(line => `${plainTimestamp} ${plainLevelTag} ${line}`).join('\n');
        } else if (typeof message !== 'string') {
            try {
                const stringified = JSON.stringify(message, null, 2);
                plainMessage = `${plainTimestamp} ${plainLevelTag} ${stringified}`;
            } catch (e) {
                plainMessage = `${plainTimestamp} ${plainLevelTag} [Complex Object]`;
            }
        } else {
            plainMessage = `${plainTimestamp} ${plainLevelTag} ${message}`;
        }

        // Append to log file
        this._appendToLogFile(plainMessage + '\n');

        return formattedMessage;
    }

    /**
     * Appends one already-formatted, colour-free line to app.log.
     *
     * The log file is created 0600. It is not chmod-ed on every write because that
     * would be a syscall per log line; it is set once, when the file is created.
     *
     * @param {string} text - Line to append, newline included
     */
    _appendToLogFile(text) {
        try {
            const isNew = !fs.existsSync(this.logFilePath);
            fs.appendFileSync(this.logFilePath, text, { mode: 0o600 });
            if (isNew) {
                fs.chmodSync(this.logFilePath, 0o600);
            }
        } catch (e) {
            // Logging must never be the reason an export fails.
        }
    }

    /**
     * Registers a sink for every emitted line, as `({level, message})`.
     *
     * **This is how `runExport`'s `export-log` event gets its lines.** There is no
     * other path: the export logs from a dozen places in the walk, and threading an
     * emitter through each of them would be a wide change that rots the first time
     * someone adds a `logger.info` and forgets. Tapping the logger is one hook.
     *
     * The sink is called *after* the level check and *before* formatting, so it
     * sees the raw message — no timestamp, no colour escapes, nothing for a caller
     * to strip. A multi-line message arrives as one string; splitting it here would
     * invent line boundaries the exporter did not choose.
     *
     * A sink that throws is swallowed and removed. It is an observer, and an
     * observer's bug must never cost someone the export it is watching.
     *
     * @param {((entry: {level: string, message: unknown}) => void)|null} sink
     */
    setSink(sink) {
        this._sink = typeof sink === 'function' ? sink : null;
    }

    /** Forwards one already-filtered message to the sink, if there is one. */
    _toSink(level, message) {
        if (!this._sink) return;
        try {
            this._sink({ level, message });
        } catch (e) {
            this._sink = null;
            process.stderr.write(
                `[WARN] log sink threw; detached. ${e && e.message ? e.message : e}\n`
            );
        }
    }

    /** Generic log method for programmatic use */
    log(level, message) {
        const lv = (level || 'info').toLowerCase();
        if (this[lv] && typeof this[lv] === 'function') {
            this[lv](message);
        } else {
            this.info(message);
        }
    }

    info(message) {
        if (!this._enabled('info')) return;
        this._toSink('info', message);
        process.stdout.write(this._formatMessage('INFO', message, chalk.blue) + '\n');
    }

    warn(message) {
        if (!this._enabled('warn')) return;
        this._toSink('warn', message);
        process.stdout.write(this._formatMessage('WARN', message, chalk.yellow) + '\n');
    }

    error(message, error = null) {
        if (!this._enabled('error')) return;
        this._toSink('error', message);
        process.stderr.write(this._formatMessage('ERROR', message, chalk.red) + '\n');
        if (error) {
            if (error.stack) {
                const stack = chalk.red(error.stack);
                process.stderr.write(stack + '\n');
                // Also write stack to file
                try {
                    fs.appendFileSync(this.logFilePath, this._stripColors(stack) + '\n');
                } catch (e) {
                    // See _appendToLogFile.
                }
            } else {
                process.stderr.write(this._formatMessage('ERROR', error, chalk.red) + '\n');
            }
        }
    }

    success(message) {
        if (!this._enabled('success')) return;
        this._toSink('success', message);
        process.stdout.write(this._formatMessage('SUCCESS', message, chalk.green) + '\n');
    }

    debug(message) {
        if (!this._enabled('debug')) return;
        this._toSink('debug', message);
        process.stdout.write(this._formatMessage('DEBUG', message, chalk.gray) + '\n');
    }

    step(message) {
        if (!this._enabled('step')) return;
        this._toSink('step', message);
        process.stdout.write(this._formatMessage('STEP', message, chalk.magenta) + '\n');
    }
}

/**
 * Renders the local UTC offset, e.g. "+02:00", so timestamps in the log are
 * unambiguous across machines and daylight-saving changes.
 * @returns {string}
 */
function tzOffset() {
    // offsetMinutes is minutes behind UTC, hence the sign flip.
    const offsetMinutes = -new Date().getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMinutes);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    return `${sign}${hh}:${mm}`;
}

/**
 * The logger, built the first time something actually uses it.
 *
 * F-38. `module.exports = new Logger()` ran the constructor at require time, and
 * the constructor touches the filesystem: it resolves the log directory, creates
 * it, chmods an existing app.log and rotates it. So merely *importing* any module
 * that wants a logger - seven of them - could throw on a read-only or full disk,
 * and it did so before `main()` had a chance to report anything. An import is not a
 * reason to fail, and a diagnostic aid is the last thing that should be able to
 * take an export down.
 *
 * A getter would do, but every call site says `logger.warn(...)`, and rewriting
 * those to `logger().warn(...)` would touch seven files to fix a bug in one. The
 * Proxy keeps the call sites and defers only the construction.
 *
 * `LoggerClass` and `LEVELS` are answered from the target rather than from the
 * instance, so a caller that wants the class or the level names - a test, a future
 * tool - gets them without paying for a directory to be created.
 */
const LOGGER_API = { LoggerClass: Logger, LEVELS };

let loggerInstance = null;

module.exports = new Proxy(LOGGER_API, {
    get(target, prop, receiver) {
        if (typeof prop === 'string' && prop in target) {
            return Reflect.get(target, prop, receiver);
        }
        // `||=` rather than `??=`: a falsy instance is never a valid Logger, so the
        // retry costs nothing and the intent is "construct once, ever".
        const logger = (loggerInstance ||= new Logger());
        const value = logger[prop];

        // Bind only what the class provides, so `logger.warn` survives being pulled off
        // the object. A property *installed on the instance* - a test spy, or
        // anything else that patches the logger - is handed back unchanged.
        //
        // The test has to be "does the instance own it", not "is the name on the
        // prototype": an installed property shadows the prototype without removing
        // it, so `warn in Logger.prototype` stays true for a patched `warn` and the
        // spy comes back bound. That is not hypothetical - jest.spyOn() read the
        // value back through here and got `bound mockConstructor` with no `.mock`
        // on it, which broke seven tests in a file that had nothing to do with this.
        const installedLater = Object.prototype.hasOwnProperty.call(logger, prop);
        const isClassMember = !installedLater && prop in Logger.prototype;
        return (typeof value === 'function' && isClassMember) ? value.bind(logger) : value;
    },

    set(target, prop, value) {
        (loggerInstance ||= new Logger())[prop] = value;
        return true;
    },

    has(target, prop) {
        return prop in target || prop in (loggerInstance ||= new Logger());
    }
});
