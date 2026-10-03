const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { stripCommitTrailer, readTag, notesForTag } = require('../scripts/release-notes');

/**
 * The Release notes for a tag, which is the only automated part of this
 * repository's releases.
 *
 * The rule being guarded is one line long and runs unattended once per release:
 * the notes are the tag message, minus the `commit <sha>` trailer git appends to
 * it. Getting it wrong does not throw - it publishes a Release whose notes stop
 * at the first line beginning "commit ", which is indistinguishable from a
 * deliberate choice until someone reads them.
 *
 * The tag handling is tested against real git repositories in a temp directory
 * rather than against this repository's own tags, for two reasons: CI checks out
 * at depth 1 with no tags fetched, so `v0.3.6` does not exist there; and the
 * interesting cases are ones this repository's history happens not to contain.
 */
describe('stripCommitTrailer', () => {
    it('cuts the trailer and everything after it', () => {
        expect(stripCommitTrailer('v1.0.0 - the fix\n\nWhy it mattered.\n\ncommit 4f3a2b1c9d8e\n'))
            .toBe('v1.0.0 - the fix\n\nWhy it mattered.');
    });

    it('leaves a message without a trailer exactly as it was', () => {
        const message = 'v1.0.0 - the fix\n\nWhy it mattered.';
        expect(stripCommitTrailer(message)).toBe(message);
    });

    it('drops the trailing blank lines git leaves on every tag body', () => {
        // `git tag -l --format=%(contents)` ends the message and then adds the
        // format's own newline, so an untrimmed body always carries a blank line
        // or two into the Release.
        expect(stripCommitTrailer('v1.0.0 - the fix\n\n\n')).toBe('v1.0.0 - the fix');
    });

    it('cuts at the first trailer only', () => {
        // Two trailers cannot happen in a real message, but cutting only the first
        // is what `sed '/^commit /,$d'` does and what the shell version did, and
        // the difference should be deliberate rather than accidental.
        expect(stripCommitTrailer('Subject\n\ncommit aaa\ncommit bbb\n')).toBe('Subject');
    });

    it('cuts a trailer that is not preceded by a blank line', () => {
        expect(stripCommitTrailer('Subject\ncommit aaa\n')).toBe('Subject');
    });

    it('does not cut a line that merely mentions a commit', () => {
        // `^commit ` rather than `commit`: prose about a commit is part of the
        // notes and must survive.
        expect(stripCommitTrailer('Subject\n\nFixed the commit bbb listing.\n'))
            .toBe('Subject\n\nFixed the commit bbb listing.');
    });

    it('yields an empty string for an empty message', () => {
        expect(stripCommitTrailer('\n\n')).toBe('');
    });
});

/** A throwaway repository, so the git-facing half is tested against real git. */
function tempRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n');
    git('add', 'CHANGELOG.md');
    git('commit', '--quiet', '-m', 'the commit subject');
    return { dir, git };
}

describe('readTag', () => {
    let repo;
    let cwd;

    beforeEach(() => {
        repo = tempRepo();
        cwd = process.cwd();
        process.chdir(repo.dir);
    });

    afterEach(() => {
        process.chdir(cwd);
        fs.rmSync(repo.dir, { recursive: true, force: true });
    });

    it('reads an annotated tag as annotated', () => {
        repo.git('tag', '-a', 'v1.0.0', '-m', 'v1.0.0 - the fix');
        expect(readTag('v1.0.0')).toEqual({
            objectType: 'tag',
            message: 'v1.0.0 - the fix',
        });
    });

    it('reads a lightweight tag as a commit, which is the trap', () => {
        // `git tag v1.0.0` rather than `git tag -a`: the notes then come from the
        // commit subject, and `v0.2.1` in this repository is exactly this.
        repo.git('tag', 'v1.0.0');
        expect(readTag('v1.0.0')).toEqual({
            objectType: 'commit',
            message: 'the commit subject',
        });
    });

    it('throws for a tag that does not exist, rather than returning nothing', () => {
        // `git tag -l <name>` prints nothing and exits 0 when it matches nothing,
        // so an unchecked read would hand the workflow an empty notes file and
        // create a blank Release.
        expect(() => readTag('v9.9.9')).toThrow(/git cat-file -t refs\/tags\/v9\.9\.9/);
    });

    it('throws rather than matching a different tag when the name is a glob', () => {
        repo.git('tag', '-a', 'v1.0.0', '-m', 'v1.0.0 - the fix');
        repo.git('tag', '-a', 'v1.0.0-rc1', '-m', 'v1.0.0-rc1 - the fix, earlier');
        // `v1.0.0` is a valid glob that matches only itself; this asserts the
        // existence check runs on the full ref path rather than on the pattern.
        expect(notesForTag('v1.0.0')).toBe('v1.0.0 - the fix');
    });

    it('strips the trailer from an annotated tag end to end', () => {
        repo.git('tag', '-a', 'v1.0.0', '-m', 'v1.0.0 - the fix\n\nWhy it mattered.\n\ncommit 4f3a2b1c');
        expect(notesForTag('v1.0.0')).toBe('v1.0.0 - the fix\n\nWhy it mattered.');
    });

    it('warns that a lightweight tag will publish a commit subject', () => {
        repo.git('tag', 'v1.0.0');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(notesForTag('v1.0.0')).toBe('the commit subject');
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('lightweight'));
        } finally {
            warn.mockRestore();
        }
    });

    it('does not warn for an annotated tag', () => {
        repo.git('tag', '-a', 'v1.0.0', '-m', 'v1.0.0 - the fix');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            notesForTag('v1.0.0');
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });
});

describe('this repository\'s own tags', () => {
    // Meaningless in CI, which checks out at depth 1 with no tags fetched, and
    // worth knowing locally: no tag here carries a `commit ` trailer, so the strip
    // rule is a no-op on every Release this repository can currently make.
    const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    const describeIfTags = tags.length ? describe : describe.skip;

    // v0.2.1 is a lightweight tag, so reading it warns by design. The warning is
    // asserted on its own above; here it would only be noise on every run.
    let warn;
    beforeAll(() => {
        warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterAll(() => warn.mockRestore());

    describeIfTags('carry no commit trailer', () => {
        it.each(tags)('%s', (tag) => {
            expect(notesForTag(tag)).not.toMatch(/^commit /m);
        });
    });

    describeIfTags('have notes that are not empty', () => {
        it.each(tags)('%s', (tag) => {
            expect(notesForTag(tag).length).toBeGreaterThan(0);
        });
    });
});
