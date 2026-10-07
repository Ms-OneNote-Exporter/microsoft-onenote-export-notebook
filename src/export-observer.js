/**
 * Export progress events, and the abort signal.
 *
 * A caller of `runExport()` currently learns that an export finished by awaiting
 * a promise. For an unattended export that is no use at all: a notebook takes
 * minutes, and the caller has no way to say *how far along* it is, no way to stop
 * it, and no way to log a line of its own that will still be in order later.
 *
 * Two additions, both optional:
 *
 * 1. `options.onEvent` — progress as it happens.
 * 2. `options.signal` — an `AbortSignal` that stops the walk, leaves what is on
 *    disk, and reports a partial run.
 *
 * ## The event set
 *
 *     export-started  { id, notebook }
 *     export-progress { id, progress: { pages, sections, assets } }
 *     export-log      { id, line }
 *     export-done     { id, notebook, pages, sections, assets }
 *     export-partial  { id, reason }     reason: 'aborted' | 'quota' | 'disk'
 *     export-aborted  { id }
 *
 * `progress` is an **object of counts, not a percentage**. Mid-run the
 * counts-so-far are known and the totals are not — a notebook's section list is
 * only partly enumerated at any moment, and pages inside an unopened section are
 * not counted at all — so a fraction is undefined. The counts are the honest
 * report, and they are what a caller can render as "N pages, M sections so far".
 *
 * `id` is **the caller's**, passed in via `options` and echoed on every event.
 * It is not generated here: this package does not know what a session, a job or a
 * user is, and a run identifier it invented would collide with the one the caller
 * is already using to correlate its own records.
 *
 * ## Why `export-aborted` is separate from `export-partial`
 *
 * `export-aborted` is the acknowledgement — *the stop was requested and honoured*.
 * `export-partial` is the outcome — *and here is what survived it*.
 *
 * Collapsing them would lose one or the other. A caller rendering a single
 * "aborted" banner cannot say how much of the notebook it actually got, and
 * someone whose export stopped on page 12 of 40 needs exactly that.
 *
 * ## Why an abort preserves what is on disk
 *
 * The work already done is real and re-running it is not free. An abort stops the
 * walk and keeps the vault as it stands.
 *
 * **Nothing is written into the vault to mark it partial, and that is deliberate.**
 * PLAN-v3 §5.2 puts partial labelling on the *artifact* and makes it
 * server-enforced — `X-Artifact-Partial: 1` on the response, `.partial.zip` as the
 * filename — so a partial vault is not mistakable for a complete one *even if the
 * UI is wrong*. A marker file in here would be a second labelling mechanism in the
 * wrong layer, and it would land inside the one directory a user actually opens.
 *
 * So the division is: this package reports what happened, and the caller that
 * builds and serves the artifact decides what to call it. What the caller needs in
 * order to do that is a reason it can act on — `quota` and `disk` are only
 * detectable from the serving side, which is why they are in `PARTIAL_REASONS`
 * here for the caller to emit rather than for this package to detect.
 */
const logger = require('./utils/logger');

/** Every event `runExport()` can emit, as a frozen list. */
const EXPORT_EVENT_TYPES = Object.freeze([
    'export-started',
    'export-progress',
    'export-log',
    'export-done',
    'export-partial',
    'export-aborted',
]);

/**
 * Why a run stopped without finishing.
 *
 * A closed set, because these are user-facing explanations and a new one has to
 * be written deliberately — the same reason the api keeps its own table closed.
 *
 * `'aborted'` is the only value this package emits. `'quota'` and `'disk'` belong
 * to the serving side: it is the only one that can see an HTTP 429 from OneNote
 * or read the free space on the volume, and this package cannot. They are listed
 * because the caller's mapping table is built against this union, and a reason it
 * has never heard of is one it will fold into a generic message.
 */
const PARTIAL_REASONS = Object.freeze(['aborted', 'quota', 'disk']);

/**
 * Wraps the caller's observer so a throwing or absent one cannot break an export.
 *
 * Same rule as the login observer, for the same reason: the observer is watching,
 * not participating. A bug in it must never cost someone the export they are
 * waiting on.
 */
function makeEmitter(onEvent) {
    if (typeof onEvent !== 'function') return () => {};
    return (type, payload) => {
        try {
            onEvent({ type, ...payload });
        } catch (error) {
            logger.warn(`onEvent observer threw for "${type}"; continuing.`, error);
        }
    };
}

/**
 * Whether the caller has asked the run to stop.
 *
 * `AbortSignal.aborted` is the whole contract, and reading it fresh at each
 * checkpoint is what makes an abort work even if it arrives mid-page: there is no
 * registered listener to leak, and nothing to unregister when the run ends.
 *
 * @param {AbortSignal} [signal]
 * @returns {boolean}
 */
function isAborted(signal) {
    return Boolean(signal && signal.aborted);
}

/**
 * Builds the observer for one export run.
 *
 * Exists so `runExport` does not grow: a test pins that function's length,
 * because it used to carry a 238-line duplicated export body and its whole
 * reason for being short is that it does not. Progress plumbing is wiring, and
 * wiring belongs next to the vocabulary it emits rather than inside the
 * orchestration.
 *
 * @param {object} options - the caller's `runExport` options
 * @returns {{id: string|null, emit: Function, isAborted: Function,
 *   onAbort: Function, wasAborted: Function, detach: Function}}
 */
function createExportObserver(options = {}) {
    const emit = makeEmitter(options.onEvent);
    const id = options.id ?? null;
    let aborted = false;

    // Attached here, detached by the caller's `finally`. The logger is a module
    // singleton, so a sink that outlived the run would send *this* run's lines to
    // whatever observer ran next.
    logger.setSink(({ message }) => emit('export-log', { id, line: String(message) }));

    return {
        id,
        emit,
        isAborted: () => isAborted(options.signal),
        onAbort: () => { aborted = true; },
        wasAborted: () => aborted,
        detach: () => logger.setSink(null)
    };
}

module.exports = {
    EXPORT_EVENT_TYPES,
    PARTIAL_REASONS,
    createExportObserver,
    makeEmitter,
    isAborted
};
