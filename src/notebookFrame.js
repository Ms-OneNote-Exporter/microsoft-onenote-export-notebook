const logger = require('./utils/logger');

/**
 * How hard to try to re-attach to the notebook after OneNote replaces its frame,
 * and how long to wait between attempts.
 *
 * The wait is not decoration: a reload does not create the new frame
 * instantly, and looking again immediately would declare the notebook gone
 * during a reload that is about to finish.
 */
const RECOVERY_ATTEMPTS = 3;
const RECOVERY_DELAY_MS = 2000;

/**
 * Playwright failures that mean "not right now" rather than "never".
 *
 * Every one of them is answered the same way: forget the frame, look at the page
 * again, and run the call against whatever is live. `frame()` decides whether
 * that is possible - when the page itself is gone it raises
 * NotebookUnavailableError instead, so a closed tab is never mistaken for a
 * frame that needs a moment.
 */
const TRANSIENT_FRAME_ERRORS = [
    'Target page, context or browser has been closed',
    'Execution context was destroyed',
    'Execution context is not available',
    'Frame was detached',
    'frame was detached',
    'Target closed'
];

/**
 * Raised when the OneNote editor tab is no longer there to be scraped.
 *
 * Its whole purpose is to replace Playwright's
 * "Target page, context or browser has been closed" at the point of failure.
 * That message says what the automation saw; it does not say what happened, and
 * it arrives with a stack pointing into Playwright rather than at the tab the
 * user was watching. This one names the cause and what to do about it.
 */
class NotebookUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NotebookUnavailableError';
    }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const firstLine = (message) => String(message || '').split('\n')[0];

/**
 * Playwright methods that hand back an object the caller keeps using.
 *
 * These have to be passed through **synchronously**. `locator()` returns a
 * Locator whose `filter()`, `first()` and `isVisible()` are chained straight off
 * it, and `$()` returns an ElementHandle; wrapping either in a promise breaks
 * the chain, because a promise has none of those methods. That mistake was in
 * the first version of this file and it was expensive to find: every chained
 * call in the download strategies threw `locator(...).filter is not a function`,
 * the exception was swallowed by a `catch` around the confirmation handling, and
 * the visible symptom was OneNote's download dialog sitting open forever with
 * the export crawling. A live run then looked exactly like a pre-existing
 * product bug, and was reported as one before the cause was found.
 *
 * Everything not listed here is awaited by its caller, so it goes through the
 * retrying path instead.
 */
const CHAINED_FRAME_METHODS = new Set([
    'locator',
    'getByRole',
    'getByText',
    'getByLabel',
    'getByPlaceholder',
    'getByAltText',
    'getByTitle',
    'getByTestId',
    'frame',
    'first',
    'last',
    'nth',
]);

/**
 * True when this frame can still be called.
 *
 * `isDetached()` is the reliable signal - Playwright sets it the moment a frame
 * is removed or navigated away - and the page check covers the whole-tab case,
 * where the frame object survives as a husk. `isClosed()` is checked too because
 * the exporter falls back to handing the *page* in when no content frame can be
 * found, and a closed page has to count as dead here for the same reason.
 * Anything that throws while being asked about itself is treated as unusable:
 * there is no safe way to keep using an object that cannot say whether it is
 * alive.
 *
 * @param {import('playwright').Frame|import('playwright').Page|null} frame
 * @returns {boolean}
 */
function frameIsUsable(frame) {
    if (!frame) return false;
    try {
        if (typeof frame.isDetached === 'function' && frame.isDetached()) return false;
        if (typeof frame.isClosed === 'function' && frame.isClosed()) return false;
        const page = typeof frame.page === 'function' ? frame.page() : null;
        if (page && typeof page.isClosed === 'function' && page.isClosed()) return false;
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * True when the page holding the notebook is still open.
 * @param {import('playwright').Page|null} page
 * @returns {boolean}
 */
function pageIsAlive(page) {
    if (!page) return false;
    try {
        return !(typeof page.isClosed === 'function' && page.isClosed());
    } catch (e) {
        return false;
    }
}

/**
 * @param {Error} error
 * @returns {boolean} True when the error is worth re-running the call for
 */
function isTransientFrameError(error) {
    const message = (error && error.message) || '';
    return TRANSIENT_FRAME_ERRORS.some((needle) => message.includes(needle));
}

/**
 * A live handle on the OneNote notebook.
 *
 * The exporter used to look the notebook frame up once and then pass that one
 * object around for the whole run. That object is not a durable handle: OneNote's
 * editor re-creates its WOPI frame when the page reloads, and the tab, its
 * renderer or the whole browser can go away at any moment. A real run
 * (2026-09-28) lost the frame within a second of finding it, and the run ended
 * there - the next DOM call failed inside a frame reference nothing could
 * repair, so the section walk could not continue, could not report what had
 * gone wrong, and could not even close the browser on the way out.
 *
 * This holds the page instead and resolves the frame on demand, which turns
 * those two outcomes into the only two there should be:
 *
 *   - the page is alive, the frame was replaced  -> find the new one, say so, carry on;
 *   - the page is gone                            -> NotebookUnavailableError, with a
 *                                                    cause and an instruction.
 *
 * The instance forwards unknown properties to the live frame as method calls
 * (`evaluate`, `$`, `$$eval`, `waitForSelector`, `locator`, ...), so the export
 * code keeps talking to something that quacks like a Playwright Frame and no
 * caller has to know that frames expire.
 */
class NotebookSession {
    /**
     * @param {object} params
     * @param {import('playwright').Page|null} params.page - Page that hosts the notebook
     * @param {import('playwright').Frame|null} params.frame - Frame found so far, if any
     * @param {Function|null} [params.find] - `(page) => Frame|null`, used to re-locate the notebook
     * @param {object} [params.log] - Logger; defaults to the application logger
     */
    constructor({ page, frame, find, log } = {}) {
        this._page = page || null;
        this._frame = frame || null;
        this._find = typeof find === 'function' ? find : null;
        this._log = log || logger;
        this._death = null;
        this._watchPage();
    }

    /**
     * Records why the page went away, if it goes away.
     *
     * "The tab was closed" and "the renderer crashed" need different advice, and
     * by the time a call fails there is no way to tell them apart from the error
     * alone - both arrive as the same TargetClosedError. The events fire once, in
     * order, and the first one seen is the real cause.
     *
     * `browser.on('disconnected')` is watched too, for the third possibility:
     * the browser process going away, which closes every page without any of
     * them firing 'close'.
     */
    _watchPage() {
        const page = this._page;
        if (!page) return;

        if (typeof page.on === 'function') {
            page.on('crash', () => { this._death = this._death || 'crashed'; });
            page.on('close', () => { this._death = this._death || 'closed'; });
        }

        let browser = null;
        try {
            browser = typeof page.browser === 'function' ? page.browser() : null;
        } catch (e) {
            // Asking a dead page for its browser can throw; the diagnostic below
            // will say so, and there is nothing to watch.
            this._log.debug(`Could not read the browser of the editor page: ${firstLine(e.message)}`);
        }
        if (browser && typeof browser.on === 'function') {
            browser.on('disconnected', () => { this._death = this._death || 'browser-gone'; });
        }
    }

    /**
     * What Playwright can still see of the target, as one readable line.
     *
     * Added because the error Playwright raises for every one of these cases is
     * the same sentence - "Target page, context or browser has been closed" -
     * whether the tab was closed, the renderer crashed, the browser died, or the
     * page was quietly swapped for another one. On 2026-09-28 that message was
     * all there was, and the run was still fully visible in a browser window,
     * which the message cannot explain. This is the state that can still be read
     * at the moment of failure, and it is the difference between a fixable
     * recovery and a mystery.
     *
     * URLs are truncated to origin + path: the query of a SharePoint page
     * carries the tenant and the document id, and this line is diagnostics, not
     * a record of the notebook.
     *
     * @returns {string}
     */
    _state() {
        const short = (url) => {
            try {
                const u = new URL(url);
                return `${u.origin}${u.pathname}`.slice(0, 80);
            } catch (e) {
                return String(url || '').slice(0, 80);
            }
        };

        const parts = [];
        try {
            const page = this._page;
            parts.push(`death=${this._death || 'none observed'}`);

            if (!page) {
                parts.push('page=none');
            } else {
                parts.push(`pageClosed=${page.isClosed()}`);

                let browser = null;
                try {
                    browser = typeof page.browser === 'function' ? page.browser() : null;
                } catch (e) {
                    parts.push('browser=<unreadable>');
                }
                if (browser) {
                    try {
                        parts.push(`browserConnected=${browser.isConnected()}`);
                    } catch (e) {
                        parts.push('browserConnected=<unreadable>');
                    }
                }

                const context = typeof page.context === 'function' ? page.context() : null;
                if (context) {
                    parts.push(`contextPages=${context.pages().length}`);
                    parts.push(`openPages=[${context.pages().map((p) => short(p.url())).join(' ; ')}]`);
                }
            }

            parts.push(`frameDetached=${this._frame ? String(this._frame.isDetached()) : 'no frame'}`);
        } catch (e) {
            parts.push(`stateUnavailable=${firstLine(e.message)}`);
        }

        return parts.join(' ');
    }

    /**
     * The page that owns the notebook, for asset downloads and new tabs.
     *
     * Prefers the live frame's own page, because that is the one whose cookies and
     * session the download has to use; falls back to the page it was given.
     *
     * @returns {import('playwright').Page|null}
     */
    page() {
        if (frameIsUsable(this._frame) && typeof this._frame.page === 'function') {
            const owner = this._frame.page();
            if (owner) return owner;
        }
        return this._page;
    }

    /**
     * Returns a frame that can be called right now, re-locating it if needed.
     *
     * @returns {Promise<import('playwright').Frame>}
     * @throws {NotebookUnavailableError} When the editor tab is gone for good
     */
    async frame() {
        if (frameIsUsable(this._frame)) return this._frame;

        if (!pageIsAlive(this._page)) throw this._unavailable();
        if (!this._find) throw this._unavailable('and the frame that held the notebook went with it');

        for (let attempt = 1; attempt <= RECOVERY_ATTEMPTS; attempt++) {
            const found = await this._tryFind();
            if (frameIsUsable(found)) {
                this._frame = found;
                this._log.info('The OneNote notebook frame was replaced by a page reload - re-attached and continuing.');
                return found;
            }
            if (attempt < RECOVERY_ATTEMPTS) await delay(RECOVERY_DELAY_MS);
        }

        throw this._unavailable(
            `and no replacement frame appeared within ${(RECOVERY_ATTEMPTS * RECOVERY_DELAY_MS) / 1000} seconds`
        );
    }

    /**
     * Runs `find` defensively: a lookup helper that throws means "not found
     * this time", not "the export is over".
     * @returns {Promise<import('playwright').Frame|null>}
     */
    async _tryFind() {
        try {
            return await this._find(this._page);
        } catch (e) {
            this._log.debug(`Looking for the notebook frame failed: ${firstLine(e.message)}`);
            return null;
        }
    }

    /**
     * The frame to use for a call that has to answer synchronously.
     *
     * A frame that OneNote replaced cannot be re-found here: finding one means
     * probing pages, which is asynchronous, and these callers are mid-chain. So
     * this returns the frame it has and lets Playwright's own "frame was
     * detached" error surface - the caller's retry then goes through frame(),
     * which can re-find it. When the *page* is gone there is nothing to retry
     * into, so that is reported properly instead.
     *
     * @returns {import('playwright').Frame|import('playwright').Page}
     */
    _peek() {
        if (frameIsUsable(this._frame)) return this._frame;
        if (!pageIsAlive(this._page)) throw this._unavailable();
        if (this._frame) return this._frame;
        throw this._unavailable('and the notebook frame is no longer available to search');
    }

    /**
     * Runs one exporter call against a live frame, re-resolving and retrying the
     * handful of failures that a reload or a detached frame can cause.
     *
     * Retrying is safe for everything routed through here: the calls are DOM
     * reads, navigation clicks, and sleeps. Re-clicking a section is what
     * selectSection() already does on its own retries, and re-reading a page is
     * free.
     *
     * @param {string} method - Playwright Frame method name
     * @param {Array} args - Arguments for it
     * @returns {Promise<*>}
     */
    async _call(method, args) {
        let lastError;

        for (let attempt = 1; attempt <= RECOVERY_ATTEMPTS; attempt++) {
            // Throws NotebookUnavailableError, rather than retrying forever, when
            // the page itself is gone.
            const frame = await this.frame();
            const fn = frame[method];
            if (typeof fn !== 'function') return fn;

            try {
                return await fn.apply(frame, args);
            } catch (e) {
                if (!isTransientFrameError(e) || attempt === RECOVERY_ATTEMPTS) throw e;

                lastError = e;
                // Drop the handle: on the next pass frame() has to look at the
                // page again, which is the only way to find out whether this was a
                // frame that was replaced or a tab that died.
                this._frame = null;
                this._log.debug(
                    `${method}() failed (${firstLine(e.message)}) - the notebook frame is being looked up again.`
                );
                await delay(RECOVERY_DELAY_MS);
            }
        }

        throw lastError;
    }

    /**
     * Builds the error a caller sees when the editor is gone.
     *
     * @param {string} [detail] - Extra clause, e.g. why no replacement appeared
     * @returns {NotebookUnavailableError}
     */
    _unavailable(detail) {
        // Read the state BEFORE composing the message, so what is reported is
        // what was true at the moment of failure rather than a moment later.
        const state = this._state();
        this._log.debug(`OneNote target state at failure: ${state}`);

        // Describes the situation, not the automation: someone reading this has a
        // notebook and a browser, not a stack trace. The technical detail belongs
        // in `error.state` and the debug line above, which is where a bug report
        // can point at it.
        const cause = {
            crashed: 'the OneNote editor tab crashed (its renderer stopped)',
            closed: 'the OneNote editor tab was closed',
            'browser-gone': 'the browser was closed or stopped responding'
        }[this._death] || 'the OneNote editor tab is no longer available';

        const advice = this._death === 'crashed'
            ? 'This is usually the browser running out of memory on a heavy OneNote page: close other tabs and re-run, or re-run with fewer sections.'
            : 'Re-run the export - it overwrites what it wrote, so nothing is duplicated and nothing is lost.';

        const error = new NotebookUnavailableError(
            `${cause}${detail ? `, ${detail}` : ''}, so the export cannot continue. ${advice}`
        );
        // Kept on the error, so the log, a test and anyone reading a stack can all
        // see the same evidence instead of re-deriving it.
        error.state = state;
        return error;
    }
}

/**
 * Wraps a page and its notebook frame in a handle that survives the frame being
 * replaced.
 *
 * @param {object} [params] - See {@link NotebookSession}
 * @returns {NotebookSession} Usable anywhere a Playwright Frame was expected
 */
function createNotebookSession(params = {}) {
    const session = new NotebookSession(params);

    return new Proxy(session, {
        get(target, prop, receiver) {
            // Own and prototype members are the real implementation. Symbols fall
            // through too, so console.log() and friends still describe the session.
            if (typeof prop !== 'string' || prop in target) {
                return Reflect.get(target, prop, receiver);
            }

            // Methods whose result the caller keeps using must come back as the
            // real Playwright object, not a promise - see CHAINED_FRAME_METHODS.
            if (CHAINED_FRAME_METHODS.has(prop)) {
                const frame = target._peek();
                const member = frame[prop];
                return typeof member === 'function' ? member.bind(frame) : member;
            }

            // Everything else is awaited by its caller, so the retrying path is
            // safe and worth having.
            //
            // Note what this makes the session answer to a *feature* check: any
            // property name at all comes back as a function, including names a
            // Frame does not have (`screenshot`, for one - only a Page can take
            // one). Code that decides "is this a Page?" by asking whether
            // `target.screenshot` is a function is therefore told yes about a
            // frame-backed session, calls it, gets `undefined` back from a method
            // that does not exist (see _call), and has to explain that later. Ask
            // the session for `page()` instead - it is answered for real, and a
            // Playwright Page has no `page()` method, so the check cannot misfire.
            // src/utils/dumps.js (ownerPageOf) is the case that got this wrong.
            return (...args) => target._call(prop, args);
        }
    });
}

module.exports = {
    NotebookUnavailableError,
    NotebookSession,
    createNotebookSession,
    frameIsUsable,
    pageIsAlive,
    isTransientFrameError
};
