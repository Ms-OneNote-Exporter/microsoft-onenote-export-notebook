/**
 * F-32: per-strategy counters for attachment downloads.
 *
 * The question these exist to answer: is the Direct strategy earning its cost?
 * The first strategy tries a SharePoint cloud page, waits up to 15s for a
 * download event, and if none arrives drives the Office Online "Download a Copy"
 * menu - around 72s on a real run, paid by every attachment before the two cheap
 * strategies are even tried. Nothing recorded whether the expensive path was the
 * one that won, so a strategy that never succeeds and one that always succeeds
 * produced identical logs and there was no way to justify reordering or dropping
 * it.
 *
 * Pure data with no logger and no I/O, so the arithmetic and the summary wording
 * are testable on their own.
 */
const {
    STRATEGIES,
    newStrategyStats,
    recordAttempt,
    recordWin,
    recordFailure,
    formatStrategySummary,
} = require('../src/utils/strategyStats');

describe('strategy counters', () => {
    it('starts every strategy at zero', () => {
        const stats = newStrategyStats();

        for (const name of STRATEGIES) {
            expect(stats.attempts[name]).toBe(0);
            expect(stats.wins[name]).toBe(0);
        }
        expect(stats.failures).toBe(0);
    });

    it('does not share state between runs', () => {
        // A notebook with no attachments must not inherit the previous run's counts.
        const first = newStrategyStats();
        recordWin(first, 'direct');
        const second = newStrategyStats();

        expect(second.wins.direct).toBe(0);
        expect(first.wins.direct).toBe(1);
    });

    it('counts an attempt and a win separately', () => {
        const stats = newStrategyStats();
        recordAttempt(stats, 'ui-click');
        recordAttempt(stats, 'ui-click');
        recordWin(stats, 'ui-click');

        expect(stats.attempts['ui-click']).toBe(2);
        expect(stats.wins['ui-click']).toBe(1);
    });

    // A win is also an attempt, so recording one can never produce the impossible
    // "1/0" whichever order a caller uses.
    it('never reports more wins than attempts', () => {
        const onlyWin = newStrategyStats();
        recordWin(onlyWin, 'fallback');
        expect(onlyWin.wins.fallback).toBe(1);
        expect(onlyWin.attempts.fallback).toBe(1);

        const winThenAttempt = newStrategyStats();
        recordWin(winThenAttempt, 'fallback');
        recordAttempt(winThenAttempt, 'fallback');
        expect(winThenAttempt.wins.fallback).toBe(1);
        expect(winThenAttempt.attempts.fallback).toBe(2);
    });

    // The chain records the attempt on entry, so a strategy that works every time
    // must report n/n and not n+1/n.
    it('does not double-count an attempt for a strategy that always works', () => {
        const stats = newStrategyStats();
        for (let i = 0; i < 5; i++) {
            recordAttempt(stats, 'direct');
            recordWin(stats, 'direct');
        }

        expect(stats.attempts.direct).toBe(5);
        expect(stats.wins.direct).toBe(5);
    });

    // The number that decides whether a strategy is worth its place: how often it
    // ran and handed the rest of the chain its turn.
    it('shows a strategy that ran every time and never won', () => {
        const stats = newStrategyStats();
        recordAttempt(stats, 'direct');
        recordAttempt(stats, 'direct');
        recordAttempt(stats, 'direct');

        expect(formatStrategySummary(stats)).toContain('Direct (cloud page) 0/3');
    });

    it('counts an attachment no strategy could fetch', () => {
        const stats = newStrategyStats();
        // An attachment that failed was attempted first, so the shape is
        // attempts=1 per strategy and one more failure on top.
        recordAttempt(stats, 'direct');
        recordAttempt(stats, 'ui-click');
        recordAttempt(stats, 'fallback');
        recordFailure(stats);
        recordFailure(stats);

        expect(stats.failures).toBe(2);
        expect(formatStrategySummary(stats)).toContain('2 could not be fetched at all');
    });
});

describe('the strategy summary line', () => {
    // A notebook with no attachments should not grow a line of zeroes.
    it('says nothing when no strategy was ever entered', () => {
        expect(formatStrategySummary(newStrategyStats())).toBe('');
    });

    // "UI click 0/0" is what reveals dead weight. Omitting it reads as oversight.
    it('names every strategy, including the ones that never ran', () => {
        const stats = newStrategyStats();
        recordAttempt(stats, 'ui-click');
        recordWin(stats, 'ui-click');

        const line = formatStrategySummary(stats);
        expect(line).toContain('Direct (cloud page) 0/0');
        expect(line).toContain('UI click 1/1');
        expect(line).toContain('Fallback (direct request) 0/0');
    });

    it('says which number is which', () => {
        const stats = newStrategyStats();
        recordAttempt(stats, 'ui-click');
        recordWin(stats, 'ui-click');

        // wins/attempts, and the words are there to be read.
        expect(formatStrategySummary(stats)).toMatch(/wins\/attempts/);
    });

    it('omits the failure clause when nothing failed', () => {
        const stats = newStrategyStats();
        recordWin(stats, 'fallback');

        expect(formatStrategySummary(stats)).not.toContain('could not be fetched');
    });

    // An unknown name is a caller bug; losing the export over it would be worse.
    it('survives a strategy name it has never heard of', () => {
        const stats = newStrategyStats();
        recordAttempt(stats, 'telepathy');

        const line = formatStrategySummary(stats);
        expect(line).toContain('telepathy 0/1');
    });
});

describe('the counters are wired into the download chain', () => {
    jest.mock('../src/utils/logger', () => ({
        success: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(),
        debug: jest.fn(), step: jest.fn(), log: jest.fn(),
        getDumpDir: jest.fn(), getDumpDisplayPath: jest.fn(),
    }));

    const { downloadAttachment, getStrategyStats, resetStrategyStats } = require('../src/downloadStrategies');

    /**
     * A stand-in for the browser, built to reach a chosen point in the chain.
     *
     * Nothing here is the thing under test: the counters are. What matters is
     * that the fakes report the *shape* the real strategies look at, so the chain
     * takes the same path it takes against OneNote - a Direct strategy that either
     * finds a download event or does not, and a UI click that either finds its
     * click marker or does not.
     *
     * @param {object} opts
     * @param {boolean} opts.directWins - The cloud page serves a download
     * @param {boolean} [opts.clickable] - The [data-one-attach-id] marker exists
     * @returns {object} `{ frame, info, outputPath }`
     */
    const makeFrame = ({ directWins, clickable = false }) => {
        const saved = [];

        // The UI click strategy races a download event against a popup event on
        // the *editor* page, so this is where a click that works resolves.
        const editorPage = {
            context: () => context,
            waitForEvent: async (event) => (clickable && event === 'download'
                ? { saveAs: async (p) => saved.push(p) }
                : Promise.reject(new Error(`no ${event} event`))),
        };

        const context = {
            newPage: async () => ({
                // tryDirectDownload races a 15s download event against a
                // navigation. Resolving it is what "the cloud page served the file"
                // means to that function.
                waitForEvent: async () => (directWins
                    ? { saveAs: async (p) => saved.push(p) }
                    : Promise.reject(new Error('no download event'))),
                goto: async () => { },
                close: async () => { },
                isClosed: () => true,
            }),
            request: { get: async () => { throw new Error('no direct request'); } },
        };

        const frame = {
            page: () => editorPage,
            $: async () => null,
            $$eval: async () => [],
            evaluate: async () => ({}),
            // null means "marker never appeared", which the chain reports as a
            // permanent failure - no retry, so the test does not sit out a backoff.
            waitForSelector: async () => (clickable ? {
                scrollIntoViewIfNeeded: async () => { },
                dblclick: async () => { },
            } : null),
            waitForTimeout: async () => { },
            content: async () => '<html></html>',
        };

        return { frame, saved, info: { id: 'file_0', src: 'https://x.sharepoint.com/a.pdf', originalName: 'a.pdf' } };
    };

    beforeEach(() => resetStrategyStats());

    it('records a win for the strategy that produced the file', async () => {
        const { frame, saved, info } = makeFrame({ directWins: true });

        await expect(downloadAttachment(frame, info, '/tmp/a.pdf')).resolves.toBe(true);

        const stats = getStrategyStats();
        // The whole point: entered once, won once, and the two cheap strategies
        // were never reached.
        expect(stats.attempts.direct).toBe(1);
        expect(stats.wins.direct).toBe(1);
        expect(stats.attempts['ui-click']).toBe(0);
        expect(stats.failures).toBe(0);
        expect(saved).toEqual(['/tmp/a.pdf']);
    });

    it('records a strategy that ran and lost, even when a later one wins', async () => {
        // The finding this whole module exists for: Direct is entered, spends its
        // ~72s, and loses. Counted only on a win, that cost is invisible.
        const { frame, info } = makeFrame({ directWins: false, clickable: true });

        await downloadAttachment(frame, info, '/tmp/a.pdf');

        const stats = getStrategyStats();
        expect(stats.attempts.direct).toBe(1);
        expect(stats.wins.direct).toBe(0);
        expect(formatStrategySummary(stats)).toContain('Direct (cloud page) 0/1');
    });

    it('records a failure when no strategy can fetch the file', async () => {
        const { frame, info } = makeFrame({ directWins: false, clickable: false });

        await expect(downloadAttachment(frame, info, '/tmp/a.pdf')).resolves.toBe(false);

        const stats = getStrategyStats();
        expect(stats.failures).toBe(1);
        expect(stats.attempts.direct).toBe(1);
        expect(stats.wins.direct).toBe(0);
    });

    it('zeroes the counters on reset', async () => {
        const { frame, info } = makeFrame({ directWins: true });
        await downloadAttachment(frame, info, '/tmp/a.pdf');
        expect(getStrategyStats().wins.direct).toBe(1);

        resetStrategyStats();

        expect(getStrategyStats().wins.direct).toBe(0);
        expect(getStrategyStats().attempts.direct).toBe(0);
        expect(getStrategyStats().failures).toBe(0);
    });
});
