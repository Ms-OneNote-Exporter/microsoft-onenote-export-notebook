const { openNotebook } = require('../src/navigator');

/**
 * Guards the F-20 fix: openNotebook must never click a notebook row whose name
 * is not the one that was selected.
 *
 * The row index is only meaningful within the table the row was found in, and
 * the notebooks page lists notebooks in more than one table, so a re-render
 * between listing and clicking can make the same index address a different
 * notebook. Exporting the wrong notebook silently is the worst outcome this tool
 * has, so the click is verified by name and refused otherwise.
 *
 * Only the listing page is faked: openNotebook subscribes for the popup before
 * clicking, and the assertions run before that subscription matters.
 */
describe('openNotebook row verification', () => {
    /**
     * Builds a fake listing page whose evaluate() locates a row the same way the
     * real one does: by tr.rowIndex, then reads the name from the sibling span.
     *
     * @param {Array<{rowIndex: number, name: string}>} rows - Rows in the fake table
     * @param {string} selector - The selector passed in
     * @returns {object} Fake Playwright page
     */
    const fakeListingPage = (rows) => ({
        evaluate: jest.fn(async (_fn, { idx, wantName }) => {
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
            for (const row of rows) {
                if (row.rowIndex !== idx) continue;
                if (wantName && norm(row.name) !== norm(wantName)) {
                    return { clicked: false, reason: `row ${idx} is "${row.name}", expected "${wantName}"` };
                }
                return { clicked: true, rowName: row.name };
            }
            return { clicked: false, reason: `no row with index ${idx}` };
        }),
    });

    const fakeContext = () => ({
        waitForEvent: jest.fn(() => {
            // Reject straight away: the popup is not what is under test, and a
            // never-settling promise would hang the suite. openNotebook turns
            // this into its "No new editor tab appeared" error, which is a clean
            // way to assert "the click was allowed" rather than "refused".
            const p = Promise.reject(new Error('fake: no popup'));
            // Mirrors the production code, which marks the subscription handled
            // so a refused click cannot leave an unhandled rejection behind.
            p.catch(() => {});
            return p;
        }),
    });

    it('throws instead of clicking when the row holds a different notebook', async () => {
        // Row 1 was "Other Notebook" when we listed, but the list re-sorted.
        const page = fakeListingPage([{ rowIndex: 1, name: 'Other Notebook' }]);

        await expect(openNotebook(page, fakeContext(), {}, 'notebook-row-1', 'My Notebook'))
            .rejects.toThrow(/Refusing to click/);
    });

    it('explains what it found and suggests --notebook-link', async () => {
        const page = fakeListingPage([{ rowIndex: 1, name: 'Other Notebook' }]);

        await expect(openNotebook(page, fakeContext(), {}, 'notebook-row-1', 'My Notebook'))
            .rejects.toThrow(/--notebook-link/);
    });

    it('throws when the row no longer exists at all', async () => {
        const page = fakeListingPage([{ rowIndex: 0, name: 'My Notebook' }]);

        await expect(openNotebook(page, fakeContext(), {}, 'notebook-row-7', 'My Notebook'))
            .rejects.toThrow(/Refusing to click/);
    });

    it('rejects a malformed notebook id before touching the page', async () => {
        const page = fakeListingPage([]);

        await expect(openNotebook(page, fakeContext(), {}, 'garbage', 'My Notebook'))
            .rejects.toThrow(/Unexpected notebook id format/);
        expect(page.evaluate).not.toHaveBeenCalled();
    });

    it('matches the name case- and whitespace-insensitively', async () => {
        const page = fakeListingPage([{ rowIndex: 2, name: '  my   notebook ' }]);

        // The click IS allowed, so the call proceeds and only fails later on the
        // (absent) popup. Asserting the failure is about the popup - not a
        // refusal - is what proves the name check accepted it.
        await expect(openNotebook(page, fakeContext(), {}, 'notebook-row-2', 'My Notebook'))
            .rejects.toThrow(/No new editor tab appeared/);
    });
});
