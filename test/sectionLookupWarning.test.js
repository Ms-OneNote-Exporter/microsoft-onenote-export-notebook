/**
 * F-22's residual: the wording of the warning that fires when a section lookup
 * comes back empty.
 *
 * This is the only evidence a reader has that a whole subtree went missing, and
 * the old text was a guess - "If this group is not really empty, its sections were
 * skipped" - in a message whose whole job is to say what happened. getSections now
 * reports why, and each reason has a different remedy: a group that has not
 * expanded wants a re-run, a stale id is a scraper bug worth a dump, and a group
 * that is genuinely empty wants silence.
 *
 * Pure, so none of this needs a browser.
 */
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

const { emptyLookupWarning } = require('../src/exporter');

describe('emptyLookupWarning', () => {
    // A group with no sections is legal in OneNote. Warning about it teaches people
    // to ignore the warnings that matter, so this is the one case that says nothing.
    // Nearly unreachable in the real flow - the caller has already failed a group
    // that yielded nothing (F-62) - but answering it honestly is the point.
    it('says nothing about a group that is genuinely empty', () => {
        expect(emptyLookupWarning('group-1', 'empty')).toBe('');
    });

    // The common real case: the row is there, its contents are not yet.
    it('blames an unexpanded group for having no sections', () => {
        const warning = emptyLookupWarning('group-1', 'no-container');

        expect(warning).toMatch(/group-1/);
        expect(warning).toMatch(/not finished expanding/i);
    });

    // A stale id means OneNote re-rendered under us - a different problem.
    it('blames a re-render when the group is gone from the DOM', () => {
        const warning = emptyLookupWarning('group-1', 'no-parent');

        expect(warning).toMatch(/group-1/);
        expect(warning).toMatch(/re-render/i);
        expect(warning).toMatch(/--dodump/);
    });

    // The two failures read differently on purpose, so someone can tell which
    // remedy applies without reading the code.
    it('tells the two failure reasons apart', () => {
        expect(emptyLookupWarning('g', 'no-container')).not.toBe(emptyLookupWarning('g', 'no-parent'));
    });

    it('always says the pages were skipped, so the consequence is not implied', () => {
        for (const reason of ['no-container', 'no-parent']) {
            expect(emptyLookupWarning('g', reason)).toMatch(/skipped/i);
        }
    });

    it('warns when the whole notebook came back empty', () => {
        expect(emptyLookupWarning(null, 'no-parent')).toMatch(/top level/i);
    });

    it('warns at the top level even with no reason, rather than staying silent', () => {
        // No parent id means an empty notebook is the only explanation, but a
        // silently empty export is exactly what this whole finding is about.
        expect(emptyLookupWarning(null, null)).toMatch(/No sections or groups found/);
    });

    // A group lookup that found nothing for a reason we do not recognise must not
    // fall through to silence or to the wrong explanation. It gets the stale-id
    // wording, which at least tells the reader to re-run and to keep a dump.
    it('assumes the worst for a reason it does not recognise', () => {
        expect(emptyLookupWarning('group-1', 'something-new')).toMatch(/no sections/);
    });
});
