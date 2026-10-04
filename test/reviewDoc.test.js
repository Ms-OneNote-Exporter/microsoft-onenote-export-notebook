const fs = require('fs-extra');
const path = require('path');

/**
 * Guards REVIEW-CODE.md's own arithmetic.
 *
 * The register drifted for two reasons, both of them mine and both invisible to a
 * reader: a finding's status was updated in one row while a duplicate row kept the old
 * one, and a finding was listed as open in a summary table after a later commit had
 * fixed it. A document whose purpose is "what still needs doing" is worse than no
 * document if it cannot be trusted on that question, so the claims are now tested.
 *
 * The lesson is the same one F-21 taught: a tally nobody recomputes is a claim, not a
 * measurement.
 */
const DOC = path.join(__dirname, '..', 'REVIEW-CODE.md');
const doc = fs.readFileSync(DOC, 'utf8');
const lines = doc.split('\n');

/** The register table, from its heading to the severity scale beneath it. */
const register = (() => {
    const start = lines.findIndex((l) => l.startsWith('## 7. Findings register'));
    const end = lines.findIndex((l, i) => i > start && l.startsWith('Severity scale'));
    return lines.slice(start, end);
})();

/**
 * Every register row, expanded to one entry per finding.
 *
 * A row may bundle several findings that share a status - "F-03, F-04, ... F-11" is
 * one line and nine findings - so counting rows would undercount the register by
 * whatever the bundles hold.
 */
const findings = register
    .filter((line) => /^\|\s*\*{0,2}F-\d+/.test(line))
    .flatMap((line) => {
        const cells = line.split('|').slice(1, -1).map((c) => c.trim());
        const severity = cells[1].replace(/\*/g, '');
        const status = cells[cells.length - 1];
        return [...new Set(cells[0].match(/F-\d+/g))].map((id) => ({ id, severity, status }));
    });

/** The verdict a status cell leads with, which is the one that counts. */
const verdictOf = (status) => {
    const m = status.match(/^\**\s*(partly fixed|fixed by decision|closed by decision|fixed|reverted|corrected|disproved|open)\b/i);
    return m ? m[1].toLowerCase() : null;
};

const isClosed = (v) => v !== null && v !== 'open';

/**
 * Whether a finding may legitimately appear in the "still open" table.
 *
 * `open` obviously may, and so may `partly fixed` - the residual of a partial fix is
 * exactly what that table is for, and F-38's is one entry in it. What must never
 * appear is a finding the register calls outright fixed, reverted or corrected:
 * that is the F-35 error, where a commit had closed it and the summary had not
 * noticed.
 */
const mayBeListedOpen = (v) => v === 'open' || v === 'partly fixed';

function normaliseSeverity(s) {
    return ['Low', 'Info', 'Low/Info', 'High → Low'].includes(s) ? 'Low' : s;
}

describe('the findings register', () => {
    it('has no finding listed twice', () => {
        // The defect this file exists to prevent: F-22 and F-34 each had two rows
        // with contradictory statuses, and which one you believed depended on how far
        // down you read.
        const ids = findings.map((f) => f.id);
        const seen = new Set();
        const dupes = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));

        expect(dupes).toEqual([]);
    });

    it('gives every finding a status this test recognises', () => {
        // A status written in a form the document does not define is a status
        // nobody can query, which is how a tally stops being checkable.
        const unrecognised = findings
            .filter((f) => verdictOf(f.status) === null)
            .map((f) => ({ id: f.id, status: f.status.slice(0, 60) }));

        expect(unrecognised).toEqual([]);
    });

    // A "partly fixed" that does not say what is left is not a partial fix, it is a
    // quiet closure - which is how F-33 and F-23 would have been lost.
    it('makes every partial fix say what is still open', () => {
        const silentPartials = findings
            .filter((f) => verdictOf(f.status) === 'partly fixed')
            .filter((f) => !/\bopen\b|\bresidual\b|\bleft open\b|\bstill\b/i.test(f.status))
            .map((f) => f.id);

        expect(silentPartials).toEqual([]);
    });

    it('counts the findings the header claims', () => {
        const header = doc.match(/\*\*(\d+) findings:/);
        expect(header).not.toBeNull();

        expect(findings.length).toBe(Number(header[1]));
    });

    it('counts each severity the header claims', () => {
        const header = doc.match(/\*\*\d+ findings: ([^*]+)\*\*/)[1];
        const claimed = (sev) => {
            const m = header.match(new RegExp(`(\\d+) ${sev}`));
            return m ? Number(m[1]) : null;
        };

        const counted = findings.reduce((acc, f) => {
            const key = normaliseSeverity(f.severity);
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});

        expect(counted.Critical).toBe(claimed('Critical'));
        expect(counted.High).toBe(claimed('High'));
        expect(counted.Medium).toBe(claimed('Medium'));
        expect(counted.Low).toBe(claimed('Low/Info'));
    });
});

describe('the register renders as one table', () => {
    /**
     * The §7 register table, from its header to the severity scale beneath it.
     *
     * Scoped to §7 on purpose. §8a holds several *separate* tables, each with its
     * own header row, and a paragraph break between two of them is correct - so a
     * whole-file "no blank lines in tables" rule would be wrong.
     */
    const register = (() => {
        const start = lines.findIndex((l) => l.startsWith('| ID | Sev | Area'));
        const end = lines.findIndex((l, i) => i > start && l.startsWith('Severity scale'));
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        return { start, end, lines: lines.slice(start, end) };
    })();

    /**
     * Line numbers of blank lines that are followed by another row of this table.
     *
     * That is the whole failure: a blank line ends a table in GitHub-flavored
     * Markdown, so everything after it renders as literal pipe-text. A blank line
     * before the severity scale is fine and is not reported.
     */
    const breaksInRegister = (() => {
        const breaks = [];
        let pendingBlank = null;
        register.lines.forEach((line, i) => {
            if (line.trim() === '') {
                pendingBlank = i + 1;
                return;
            }
            if (pendingBlank !== null && line.startsWith('|')) breaks.push(pendingBlank);
            pendingBlank = null;
        });
        return breaks;
    })();

    it('has no blank line between its rows', () => {
        // One stray newline between the F-64 and F-65 rows, introduced 2026-09-28 in
        // c7a1677, split the register into two tables on GitHub: F-65 onwards
        // rendered as raw text, and so did every finding added after it. It went
        // unnoticed for a week with all nine tests in this file green, because they
        // count rows with a regex and cannot see how those rows render - the
        // document's arithmetic was checked and its rendering was not.
        expect(breaksInRegister).toEqual([]);
    });

    it('holds nothing but its header, its rows and one trailing blank', () => {
        // So the break cannot be "fixed" by deleting the offending region instead of
        // the newline: any content that is not a row is a failure here.
        const content = register.lines.filter((l) => l.trim() !== '');

        expect(content[0]).toBe('| ID | Sev | Area | One-line summary | Status |');
        expect(content[1]).toBe('|----|-----|------|------------------|--------|');
        expect(content.slice(2).every((l) => /^\|\s*\*{0,2}F-\d+/.test(l))).toBe(true);
        // Deliberately no row count here. This test asserted a hardcoded one and
        // failed the moment F-69 was added, which is the wrong way round: the
        // register grows by design, and a hand-written tally is a claim rather than
        // a measurement. Losing a row is already caught twice over, by the two tests
        // above comparing the rows against the header.
        expect(content.length).toBeGreaterThan(2);
    });

    it('ends the table with one blank line before the severity scale', () => {
        // Asserted because it is the one blank that is legitimate, and a future fix
        // that "tidies all the blank lines" would remove it and merge the table
        // into the severity-scale paragraph.
        expect(register.lines[register.lines.length - 1].trim()).toBe('');
    });
});

describe('the document still has all of its sections', () => {
    // Every other test in this file reads a *table*. None of them notices when the
    // prose around the tables is destroyed: a regex that was meant to remove one
    // bullet from the "still open" row ate 17 lines, taking the "Lesson worth
    // keeping" section, the "Next session, in priority order" heading and the first
    // three items of that list with it. All twelve register tests stayed green,
    // because what they check was still there and what was lost was not a table.
    //
    // The register's whole purpose is "what still needs doing". A document that has
    // quietly stopped answering that is worse than one that never existed, so the
    // sections themselves are asserted.
    it.each([
        ['## 0. Decisions taken', 'the decisions'],
        ['## 7. Findings register', 'the register'],
        ['### Fix ladder', 'the fix ladder'],
        ['## 8. Definition of done', 'the definition of done'],
        ['## 8a. Session log', 'the session log'],
        ['**Closed rather than fixed', 'the closed-rather-than-fixed note'],
        ['### Lesson worth keeping', 'the lesson worth keeping'],
        ['### Next session, in priority order', 'the priority list'],
        ['## 9. Open questions', 'the open questions'],
    ])('still has %s (%s)', (heading) => {
        expect(doc).toContain(heading);
    });

    it('still lists what is owed, and the list is not empty', () => {
        // The priority list is the section most likely to rot, because closing an
        // item is the one edit that always applies to it.
        const list = doc.slice(doc.indexOf('### Next session, in priority order'));
        const items = [...list.matchAll(/^\d+\. \*\*/gm)];
        expect(items.length).toBeGreaterThan(0);
        expect(list).toContain('Deliberately not scheduled');
    });
});

describe('the standing table agrees with the register', () => {
    /**
     * The §8a standing section, from the "State" table through the "Still open"
     * table. Both are read: the Medium residuals are named in the first, the
     * Low/Info tail in the second, and a partial fix that appears in neither is a
     * partial fix nobody is tracking.
     */
    const standingSection = (() => {
        const start = doc.indexOf('**Standing as of');
        expect(start).toBeGreaterThan(-1);
        return doc.slice(start, doc.indexOf('### Lesson worth keeping', start));
    })();

    /** Findings named in the "Still open" rows specifically. */
    const stillOpenIds = (() => {
        const start = doc.indexOf('| Sev | Still open |');
        if (start === -1) return [];
        const block = doc.slice(start, doc.indexOf('\n\n', start));
        return [...new Set(block.match(/F-\d+/g) || [])];
    })();

    it('lists no finding that the register calls fixed', () => {
        // The F-35 error: listed as open in the summary for several edits after the
        // commit that fixed it, because the register row and the summary were updated
        // by different hands at different times, and nothing reconciled them.
        const wronglyOpen = stillOpenIds.filter((id) => {
            const f = findings.find((x) => x.id === id);
            return f && !mayBeListedOpen(verdictOf(f.status));
        });

        expect(wronglyOpen).toEqual([]);
    });

    it('names every partial fix somewhere in the standing section', () => {
        // F-23, F-33 and F-38 are "partly fixed". A partial fix that the standing
        // section never mentions is a partial fix nobody is tracking, which is how a
        // residual quietly becomes permanent.
        //
        // The expected set is derived rather than written out. It used to be
        // `toEqual(['F-23', 'F-33', 'F-38'])`, which added nothing over the loop
        // below and failed the moment a fourth partial fix appeared legitimately -
        // a tripwire measuring churn, not correctness. The three long-standing ones
        // are still named explicitly, so a deletion is still caught.
        const partials = findings
            .filter((f) => verdictOf(f.status) === 'partly fixed')
            .map((f) => f.id);

        expect(partials.length).toBeGreaterThanOrEqual(3);
        for (const id of partials) {
            expect(standingSection).toContain(id);
        }
        // The two long-standing partials are still named explicitly, so a deletion is
        // still caught. F-38 used to be in this list and left it when its residual
        // closed - which is the list doing its job, and also why it is derived rather
        // than hardcoded.
        for (const id of ['F-23', 'F-33']) {
            expect(standingSection).toContain(id);
        }
    });

    it('does not claim zero open Critical or High while one exists', () => {
        const notFixed = (sev) => findings
            .filter((f) => normaliseSeverity(f.severity) === sev)
            .filter((f) => !isClosed(verdictOf(f.status)))
            .map((f) => f.id);

        expect(notFixed('Critical')).toEqual([]);
        expect(notFixed('High')).toEqual([]);
    });

    it('names at least one finding that is still open, so the table is not decorative', () => {
        // A guard against the opposite failure: reconciling the document by deleting
        // the tail would make every test above pass and the register a lie.
        expect(stillOpenIds.length).toBeGreaterThan(0);
    });
});
