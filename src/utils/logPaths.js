const os = require('os');
const path = require('path');

/**
 * Decides the log directory for a given package location.
 *
 * Split out from resolveLogDir so the install-layout decision can be tested
 * against paths that do not exist on the test machine - a global install cannot
 * be reproduced locally.
 *
 * @param {string} packageRoot - Absolute path of the package root
 * @returns {string} Absolute path to the directory holding app.log and dumps/
 */
function resolveLogDirFor(packageRoot) {
    const isGlobalInstall = packageRoot.split(path.sep).includes('node_modules');

    if (!isGlobalInstall) {
        return path.join(packageRoot, 'logs');
    }

    const xdgState = process.env.XDG_STATE_HOME;
    if (xdgState && xdgState.trim()) {
        return path.join(path.resolve(xdgState.trim()), 'microsoft-onenote-export-notebook');
    }

    const home = os.homedir();
    if (home) {
        return path.join(home, '.local', 'state', 'microsoft-onenote-export-notebook');
    }

    return path.join(os.tmpdir(), 'microsoft-onenote-export-notebook');
}

/**
 * Resolves where logs and HTML dumps are written.
 *
 * The previous code hardcoded `path.resolve(__dirname, '../../logs')`, which is
 * correct for a checkout but wrong for the install the README recommends:
 *
 *   npm install -g @msout/microsoft-onenote-export-notebook
 *
 * puts the package inside the global node_modules tree, so the logger was writing
 * to `<prefix>/lib/node_modules/@msout/…/logs/app.log` - inside node_modules,
 * where it is liable to be read-only, and wiped by the next reinstall. Anyone
 * following the documented install had their logs somewhere nobody would look.
 *
 * Precedence:
 *   1. ONENOTE_EXPORT_LOG_DIR  - explicit override, wins over everything
 *   2. a local checkout        - <package>/logs, which is gitignored and where a
 *                                developer expects to find it
 *   3. a global install        - XDG state dir, else ~/.local/state/<package>
 *   4. os.tmpdir()             - last resort, so logging never breaks an export
 *
 * @returns {string} Absolute path to the directory holding app.log and dumps/
 */
function resolveLogDir() {
    const override = process.env.ONENOTE_EXPORT_LOG_DIR;
    if (override && override.trim()) {
        return path.resolve(override.trim());
    }

    return resolveLogDirFor(path.resolve(__dirname, '..', '..'));
}

module.exports = { resolveLogDir, resolveLogDirFor };
