/**
 * Guards the end-of-run summary (F-17).
 *
 * Every per-item error inside processSections is caught so the export can
 * continue, so without an explicit failure count in the summary a partial export
 * is reported exactly like a clean one. The logger is mocked so the assertions
 * are about what the user is told, not about stdout formatting.
 */
// The logger module exports the singleton instance directly via
// `module.exports = new Logger()`, so the mock must be the object itself, not a
// { default: ... } wrapper.
jest.mock('../src/utils/logger', () => ({
    success: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    step: jest.fn(),
    log: jest.fn(),
    getDumpDir: jest.fn(),
    getDumpDisplayPath: jest.fn(),
}));

const logger = require('../src/utils/logger');
const { reportSummary, newStats } = require('../src/exporter');

/** All text the logger was asked to print, flattened. */
const said = () => [].concat(
    ...['success', 'warn', 'info'].map((lvl) => logger[lvl].mock.calls.map((c) => String(c[0])))
).join('\n');

describe('reportSummary', () => {
    beforeEach(() => jest.clearAllMocks());

    it('announces a clean run', () => {
        reportSummary(newStats(), { resolved: 3, unresolved: 0 }, '/out/NB');

        expect(logger.success).toHaveBeenCalledWith('Export complete!');
        expect(logger.warn).not.toHaveBeenCalled();
        expect(said()).toContain('Total Pages: 0');
    });

    it('does NOT announce a clean run when items failed', () => {
        const stats = newStats();
        stats.totalPages = 7;
        stats.failedPages = 2;
        reportSummary(stats, null, '/out/NB');

        expect(logger.success).not.toHaveBeenCalled();
        expect(said()).toMatch(/finished with errors/i);
        expect(said()).toContain('Pages    failed: 2');
    });

    it('reports each failure category that occurred', () => {
        const stats = newStats();
        stats.failedGroups = 1;
        stats.failedSections = 3;
        stats.failedPages = 4;
        reportSummary(stats, null, '/out/NB');

        const out = said();
        expect(out).toContain('Groups   failed: 1');
        expect(out).toContain('Sections failed: 3');
        expect(out).toContain('Pages    failed: 4');
        expect(out).toContain('8 item(s)');
    });

    it('surfaces link resolution counts so silent breakage is visible', () => {
        reportSummary(newStats(), { resolved: 12, unresolved: 3 }, '/out/NB');
        expect(said()).toContain('12 resolved, 3 unresolved');
    });

    // F-32: which download strategy did the work, and how often the expensive one
    // was entered and lost. This is the only evidence for reordering the chain.
    it('reports which download strategy won, and how often the others were entered', () => {
        const { resetStrategyStats, getStrategyStats } = require('../src/downloadStrategies');
        const { recordAttempt, recordWin } = require('../src/utils/strategyStats');
        resetStrategyStats();

        const stats = getStrategyStats();
        recordAttempt(stats, 'direct');
        recordAttempt(stats, 'direct');
        recordWin(stats, 'ui-click');

        reportSummary(newStats(), null, '/out/NB');

        const out = said();
        expect(out).toContain('wins/attempts');
        expect(out).toContain('Direct (cloud page) 0/2');
        expect(out).toContain('UI click 1/1');
        resetStrategyStats();
    });

    it('says nothing about strategies when no attachment was fetched', () => {
        const { resetStrategyStats } = require('../src/downloadStrategies');
        resetStrategyStats();

        reportSummary(newStats(), null, '/out/NB');

        // A line of zeroes on every run of a notebook with no attachments is noise.
        expect(said()).not.toContain('wins/attempts');
    });

    it('always states where the files went', () => {
        reportSummary(newStats(), null, '/out/My Notebook');
        expect(said()).toContain('/out/My Notebook');
    });

    it('does not mention failed assets when there were none', () => {
        // A warning that appears unconditionally is a warning nobody reads, and
        // this one would otherwise sit under every successful export.
        reportSummary(newStats(), null, '/out/NB');
        expect(said()).not.toContain('failed:');
    });

    it('counts failed assets instead of passing them over in the total', () => {
        // "Total Assets: 12" next to a page whose notice lists two missing files
        // reads as a complete export. This is the F-01 shape one level down: the
        // number is true and it still misleads.
        const stats = { ...newStats(), totalPages: 19, totalAssets: 12, failedAssets: 2 };
        reportSummary(stats, null, '/out/NB');

        const out = said();
        expect(out).toContain('Assets   failed: 2');
        expect(out).toContain('Total Assets: 12 (2 could not be downloaded)');
    });

    it('still says Export complete! when only assets failed', () => {
        // Nothing is missing from the vault, so the run did complete. The exit code
        // agrees; the wording has to as well, or a clean run is mislabelled.
        const stats = { ...newStats(), totalPages: 19, totalAssets: 12, failedAssets: 2 };
        reportSummary(stats, null, '/out/NB');
        expect(said()).toContain('Export complete!');
    });
});

describe('newStats', () => {
    it('starts every counter at zero', () => {
        // Pinned exactly, on purpose: a counter added here and not in the
        // comparison is a counter nothing reports, which is the F-01 shape.
        expect(newStats()).toEqual({
            totalPages: 0, totalAssets: 0, failedPages: 0, failedSections: 0, failedGroups: 0,
            failedAssets: 0,
        });
    });

    it('returns a fresh object each time, never a shared default', () => {
        const a = newStats();
        a.totalPages = 5;
        expect(newStats().totalPages).toBe(0);
    });
});

describe('the exit code a finished export reports', () => {
    // F-01, residual. The original finding was that `runExport` swallowed every
    // error and a failed export exited 0. That was fixed. What was left is the
    // same defect one level down: a run that lost pages, sections or groups
    // printed "N item(s) could not be exported" and still exited 0, so a CI job
    // went green over a vault with holes in it.
    const { exitCodeForStats } = require('../src/exporter');

    const withFailures = (o) => ({ ...newStats(), ...o });

    it('is 0 for a clean run', () => {
        expect(exitCodeForStats(newStats())).toBe(0);
        expect(exitCodeForStats(withFailures({ totalPages: 19, totalAssets: 12 }))).toBe(0);
    });

    it('is 3 when a page is missing from the vault', () => {
        expect(exitCodeForStats(withFailures({ failedPages: 1 }))).toBe(3);
    });

    it('is 3 when a section or group is missing', () => {
        expect(exitCodeForStats(withFailures({ failedSections: 2 }))).toBe(3);
        expect(exitCodeForStats(withFailures({ failedGroups: 1 }))).toBe(3);
    });

    it('is 0 for failed assets alone, because the note says which are missing', () => {
        // The deliberate half of the severity split. Downloads fail routinely, so
        // a code that is always set stops being read; and the note carrying the
        // link also carries a notice naming the file that is not there (F-64).
        expect(exitCodeForStats(withFailures({ totalAssets: 12, failedAssets: 2 }))).toBe(0);
    });

    it('is 3 even when most of the run succeeded', () => {
        // The case that motivated the fix: a good export with a hole in it must
        // not read as clean just because most of it worked.
        expect(exitCodeForStats(withFailures({
            totalPages: 11, totalAssets: 3, failedGroups: 1
        }))).toBe(3);
    });
});
