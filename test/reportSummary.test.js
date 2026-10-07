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
    setSink: jest.fn(),
}));

const logger = require('../src/utils/logger');
const { reportSummary, newStats, exitCodeForStats: exportCodeFor } = require('../src/exporter');

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

    it('does NOT announce a clean run when the section list was never found (F-77)', () => {
        // The exact shape of the live failure that produced the finding: every
        // counter at zero, so nothing here differs from the clean run above except
        // the flag. It must not be reported as a success, and it must say what is
        // wrong - an expired sign-in and an error page served instead of the
        // notebook look identical from inside, and both produce this.
        const stats = newStats();
        stats.notebookNotFound = true;
        reportSummary(stats, null, '/out/NB');

        expect(logger.success).not.toHaveBeenCalled();
        // The headline goes through `error`, not `warn`: this is a failed run, and
        // `said()` reads as everything the user was *told*, so it deliberately
        // omits `error`. Asserting the channel it actually uses.
        expect(logger.error).toHaveBeenCalled();
        expect(String(logger.error.mock.calls[0][0])).toMatch(/Nothing was exported/i);
        // Says which of the two causes to check, rather than leaving the user to
        // deduce it from an empty folder.
        expect(said()).toMatch(/sign-in/i);
        // And reassures about the thing that actually matters: an existing export
        // was not overwritten with nothing. Wording is precise - an *empty* notebook
        // folder is left behind, named after the error page's <title>.
        expect(said()).toMatch(/No notes or assets were written/i);
        expect(said()).toMatch(/untouched/i);
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
        //
        // `notebookNotFound` is listed with the counters because it is reported the
        // same way - it is read by reportSummary and by exitCodeForStats - even
        // though it is a flag rather than a tally. F-77.
        expect(newStats()).toEqual({
            totalPages: 0, totalAssets: 0, totalSections: 0,
            failedPages: 0, failedSections: 0, failedGroups: 0,
            failedAssets: 0,
            notebookNotFound: false,
        });
    });

    // The shape of the bug, and the shape of the fix.
    //
    // A run that found no sections has every counter at zero - exactly the shape a
    // complete export has. So the counters alone *cannot* tell them apart, which is
    // why there is a flag. This test states that inability rather than papering over
    // it: if a future change made the counters sufficient, this would fail and the
    // flag would be redundant.
    it('the counters alone cannot tell an empty export from a complete one', () => {
        const exportedNothing = newStats();
        const exportedEverything = { ...newStats(), totalPages: 24, totalAssets: 9 };

        const comparable = (s) => ({
            totalPages: s.totalPages, totalAssets: s.totalAssets,
            failedPages: s.failedPages, failedSections: s.failedSections,
            failedGroups: s.failedGroups, failedAssets: s.failedAssets,
        });

        // Every number agrees that both runs succeeded...
        expect(comparable(exportedNothing).failedPages).toBe(0);
        expect(exportCodeFor(exportedNothing)).toBe(0);
        expect(exportCodeFor(exportedEverything)).toBe(0);
        // ...and the flag is the only thing that does not.
        expect(exportedNothing.notebookNotFound).toBe(false);
    });

    it('reports a non-zero exit once the flag says no section list was found', () => {
        // Code 3, the same one a partial export uses: the run did not finish the job,
        // and a caller checking "did this fully succeed" should not have to learn a
        // fourth code.
        expect(exportCodeFor({ ...newStats(), notebookNotFound: true })).toBe(3);
    });

    it('returns a fresh object each time, never a shared default', () => {
        const a = newStats();
        a.totalPages = 5;
        expect(newStats().totalPages).toBe(0);
    });
});

describe('renaming an image to the format it really is (F-49)', () => {
    // The half of the format sniffer that reads bytes back off disk, against real
    // files.
    //
    // It is here because the first version of this did nothing and looked perfectly
    // healthy: it used `fs.open`, whose fs-extra promise form resolves to a bare file
    // descriptor rather than a FileHandle, so `handle.read` was undefined - and the
    // deliberate `catch` around it turned that into a debug line. Every image kept
    // its `.png` name, the export reported success, and the only trace was one debug
    // line per image in a log nobody reads at default level.
    //
    // "Never throws" is right for a filename. "Silently does nothing" is not, and
    // that is what a test is for.
    const fs = require('fs-extra');
    const os = require('os');
    const path = require('path');
    const exporter = require('../src/exporter');
    const realExtension = exporter.realImageExtensionForTest;

    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfmt-'));
    });

    afterEach(() => {
        fs.removeSync(dir);
    });

    const write = (name, hex) => {
        const p = path.join(dir, name);
        fs.writeFileSync(p, Buffer.from(hex, 'hex'));
        return p;
    };

    it('names a GIF gif, however the file was called', async () => {
        // The case from the real notebook: a GIF written as `…_img_1.png`.
        expect(await realExtension(write('claimed.png', '474946383961f201f20170000021f904'))).toBe('gif');
    });

    it('names a JPEG jpg and a WEBP webp', async () => {
        expect(await realExtension(write('a.png', 'ffd8ffe000104a464946'))).toBe('jpg');
        expect(await realExtension(write('b.png', '524946460000000057454250'))).toBe('webp');
    });

    it('answers null for a real PNG, so nothing is renamed to the name it has', async () => {
        expect(await realExtension(write('c.png', '89504e470d0a1a0a'))).toBeNull();
    });

    it('answers null for an unrecognised file rather than guessing', async () => {
        expect(await realExtension(write('d.png', '0001020304050607'))).toBeNull();
    });

    it('answers null for a file that is not there, without failing the export', async () => {
        expect(await realExtension(path.join(dir, 'missing.png'))).toBeNull();
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
