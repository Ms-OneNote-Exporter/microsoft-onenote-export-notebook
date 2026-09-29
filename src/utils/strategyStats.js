/**
 * Per-strategy counters for attachment downloads (F-32).
 *
 * The point of this module is a question nobody could answer before: is the
 * Direct strategy earning its cost? The first strategy tries a SharePoint cloud
 * page, waits up to 15s for a download event, and if none arrives navigates the
 * Office Online "Download a Copy" menu, which on a real run takes around 72s
 * before it either works or gives up. Every attachment pays that price before the
 * two cheap strategies are even tried. Nothing recorded whether the expensive
 * path was the one that won, so a strategy that never succeeds and a strategy
 * that always succeeds produced identical logs.
 *
 * Counters are per-run and reset by `newStrategyStats()`. They are plain data,
 * with no logger and no I/O, so the arithmetic is testable on its own and the
 * summary line is a pure function of them.
 *
 * The one design rule: `recordAttempt` is called when a strategy is *entered* and
 * `recordWin` when it produced the file, so `attempts - wins` is how often it ran
 * and handed the rest of the chain its turn. That is the number that says whether
 * it is worth running first, and it is only available if attempts are counted on
 * entry rather than on success.
 *
 * `recordWin` also bumps the attempt count if the win would otherwise exceed it,
 * so the invariant "wins never exceed attempts" holds however a caller sequences
 * the two calls. The chain records the attempt first, so a strategy that works
 * every time reports `n/n` and not `n+1/n`.
 */

/** The strategies, in the order downloadAttachment tries them. */
const STRATEGIES = ['direct', 'ui-click', 'fallback'];

/**
 * Human-facing names for the summary line. Deliberately the same words the
 * per-attempt log lines use ("Downloaded via Strategy: Direct"), so a reader
 * counting them by eye is not reading two vocabularies.
 */
const LABELS = {
    'direct': 'Direct (cloud page)',
    'ui-click': 'UI click',
    'fallback': 'Fallback (direct request)'
};

/**
 * A fresh, empty set of counters.
 *
 * @returns {{attempts: object, wins: object, failures: number}} Zeroed counters
 */
function newStrategyStats() {
    const attempts = {};
    const wins = {};
    for (const name of STRATEGIES) {
        attempts[name] = 0;
        wins[name] = 0;
    }
    return { attempts, wins, failures: 0 };
}

/**
 * Makes sure a strategy has a row in the counters, whatever it is called.
 *
 * An unknown name is a bug in a caller, not a reason to throw mid-export and
 * lose the rest of the run, so it gets a literal row and shows up in the summary
 * instead of vanishing.
 *
 * @param {object} stats - Counters from newStrategyStats()
 * @param {string} strategy - Strategy name
 * @returns {object} The same stats, for chaining
 */
function ensureSlot(stats, strategy) {
    if (stats.attempts[strategy] === undefined) {
        stats.attempts[strategy] = 0;
        stats.wins[strategy] = 0;
    }
    return stats;
}

/**
 * Records that a strategy was entered.
 *
 * Counted on entry rather than on success, because the number that decides
 * whether a strategy is worth its place is how often it ran and gave the rest of
 * the chain its turn. A strategy entered 40 times and won 0 has cost 40 round
 * trips; entered 40 times and won 40, it has justified every one of them.
 *
 * @param {object} stats - Counters from newStrategyStats()
 * @param {string} strategy - One of STRATEGIES
 * @returns {object} The same stats, for chaining
 */
function recordAttempt(stats, strategy) {
    ensureSlot(stats, strategy);
    stats.attempts[strategy]++;
    return stats;
}

/**
 * Records that a strategy produced the file.
 *
 * Counts the attempt too, but only when the win would otherwise exceed it. The
 * chain records the attempt on entry and then the win, so a strategy that works
 * every time must still report `n/n` rather than `n+1/n`. A caller that records
 * only the win gets a coherent pair rather than the impossible `1/0`, so the
 * invariant "wins never exceed attempts" holds however the two are called.
 *
 * @param {object} stats - Counters from newStrategyStats()
 * @param {string} strategy - One of STRATEGIES
 * @returns {object} The same stats, for chaining
 */
function recordWin(stats, strategy) {
    ensureSlot(stats, strategy);
    if (stats.wins[strategy] >= stats.attempts[strategy]) {
        stats.attempts[strategy]++;
    }
    stats.wins[strategy]++;
    return stats;
}

/**
 * Records an attachment that no strategy could fetch.
 *
 * @param {object} stats - Counters from newStrategyStats()
 * @returns {object} The same stats, for chaining
 */
function recordFailure(stats) {
    stats.failures++;
    return stats;
}

/**
 * Renders the counters as one summary line, or '' when there is nothing to say.
 *
 * Silent when no strategy was ever entered, because a notebook with no
 * attachments should not grow a line of zeroes. Otherwise every strategy is
 * named, including the ones that never ran, because "UI click: 0 of 0" is what
 * tells you a strategy is dead weight and "UI click" missing entirely reads as
 * an oversight.
 *
 * @param {object} stats - Counters from newStrategyStats()
 * @returns {string} The line, or '' when no strategy was attempted
 */
function formatStrategySummary(stats) {
    const attempted = Object.keys(stats.attempts).filter((name) => stats.attempts[name] > 0);
    if (attempted.length === 0) return '';

    const parts = [];
    for (const name of Object.keys(stats.attempts)) {
        const label = LABELS[name] || name;
        parts.push(`${label} ${stats.wins[name]}/${stats.attempts[name]}`);
    }

    return `Attachment downloads by strategy (wins/attempts): ${parts.join(', ')}` +
        (stats.failures > 0 ? `, ${stats.failures} could not be fetched at all` : '');
}

module.exports = {
    STRATEGIES,
    newStrategyStats,
    recordAttempt,
    recordWin,
    recordFailure,
    formatStrategySummary
};
