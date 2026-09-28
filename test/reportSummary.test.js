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

    it('always states where the files went', () => {
        reportSummary(newStats(), null, '/out/My Notebook');
        expect(said()).toContain('/out/My Notebook');
    });
});

describe('newStats', () => {
    it('starts every counter at zero', () => {
        expect(newStats()).toEqual({
            totalPages: 0, totalAssets: 0, failedPages: 0, failedSections: 0, failedGroups: 0,
        });
    });

    it('returns a fresh object each time, never a shared default', () => {
        const a = newStats();
        a.totalPages = 5;
        expect(newStats().totalPages).toBe(0);
    });
});
