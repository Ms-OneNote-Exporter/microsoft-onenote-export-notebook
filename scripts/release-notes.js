const { execFileSync } = require('child_process');

/**
 * Release notes for a tag, read out of the tag's own object.
 *
 * A tag in this repository is the release: npm-publish.yml publishes it to the
 * registry, and nothing created the matching GitHub Release. Seven tags reached
 * npm between v0.2.1 and v0.3.7 and the Releases panel stayed empty, so the one
 * place a reader can go to find out what shipped had nothing to show.
 *
 * The notes are the tag message, because the tag message is already written by
 * hand for each release and there is nothing to keep in sync - no notes file to
 * forget to update, no second copy of the changelog to drift.
 *
 * This is a module with a CLI rather than a `git tag | sed` line inside the
 * workflow, because the one rule in it has to be provable: it runs unattended
 * once per release, and getting it wrong publishes a Release whose notes are
 * truncated at the first line that happens to begin with "commit ".
 *
 *   node scripts/release-notes.js v0.3.6 > notes.md
 *
 * Notes go to stdout and diagnostics go to stderr, so redirecting stdout to a
 * file captures the notes and nothing else.
 */

/**
 * A line beginning `commit ` is the trailer git appends to a tag message when
 * the tag was cut from a merge or by a script; everything from it onwards is
 * bookkeeping rather than prose.
 */
const COMMIT_TRAILER = /^commit /m;

/**
 * Cut the `commit <sha>` trailer, and anything after it, from a tag message.
 *
 * @param {string} message Raw `%(contents)` for a tag.
 * @returns {string} The message without its trailer, and without the trailing
 *   blank lines git leaves at the end of every tag body.
 */
function stripCommitTrailer(message) {
    const trailer = message.search(COMMIT_TRAILER);
    const body = trailer === -1 ? message : message.slice(0, trailer);
    return body.replace(/\s+$/, '');
}

/**
 * What git holds for one tag: its object type and its unsigned message.
 *
 * `%(contents)` is the tag message for an annotated tag, but the *commit*
 * message for a lightweight one, because a lightweight tag is a ref and nothing
 * more. `git tag v1.2.3` where `git tag -a v1.2.3` was meant therefore yields a
 * commit subject - a merge request title, often - as the release notes, and no
 * error anywhere. `objectType` is what makes that visible.
 *
 * @param {string} tag Tag name, e.g. 'v0.3.6'.
 * @returns {{objectType: string, message: string}} 'tag' or 'commit', and the
 *   message with trailers left in.
 * @throws if the tag does not exist, or this is not a git repository.
 */
function readTag(tag) {
    // `git tag -l <name>` treats <name> as a glob and prints nothing, exit 0, when
    // it matches nothing. Reading the object type first turns a typo into a thrown
    // error instead of a Release whose notes are empty or, worse, another tag's.
    const objectType = run(['cat-file', '-t', `refs/tags/${tag}`]);
    return { objectType, message: run(['tag', '-l', '--format=%(contents)', tag]) };
}

/**
 * Notes for one tag: its message, minus the trailer.
 *
 * @param {string} tag Tag name, e.g. 'v0.3.6'.
 * @returns {string} Markdown for the Release body.
 */
function notesForTag(tag) {
    const { objectType, message } = readTag(tag);
    if (objectType === 'commit') {
        // A warning, not an error: the Release is still better made than skipped,
        // and its notes can be edited afterwards. Failing here would block an
        // already-published version on the strength of how its tag was cut.
        console.warn(
            `Warning: ${tag} is a lightweight tag, so its message is the commit's, ` +
            'not a written changelog. Its Release notes will be a commit subject.'
        );
    }
    return stripCommitTrailer(message);
}

/**
 * Run git in the current working directory and return its trimmed stdout.
 *
 * stderr is captured rather than inherited, so a failing git command reaches the
 * caller inside the error below - and therefore the workflow log - as one line
 * naming the command, the tag and git's own reason, instead of printing to the
 * console and then being repeated in the error.
 *
 * @param {string[]} args Arguments after `git`.
 * @returns {string} Trimmed stdout.
 * @throws with git's own stderr in the message, so the workflow log says which
 *   tag was being read.
 */
function run(args) {
    try {
        return execFileSync('git', args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 8 * 1024 * 1024,
        }).trim();
    } catch (err) {
        const why = (err.stderr || '').trim() || err.message;
        throw new Error(`git ${args.join(' ')} failed in ${process.cwd()} (exit ${err.status}): ${why}`);
    }
}

module.exports = { stripCommitTrailer, readTag, notesForTag };

if (require.main === module) {
    const tag = process.argv[2];
    if (!tag) {
        console.error('Usage: node scripts/release-notes.js <tag>');
        process.exitCode = 1;
    } else {
        try {
            const notes = notesForTag(tag);
            if (!notes) {
                // Empty notes are not worth failing a release over - a Release can
                // have its notes typed in by hand - but going quiet about it is how a
                // panel of blank Releases happens.
                console.warn(`Warning: ${tag} has an empty message, so its Release will have no notes.`);
            }
            process.stdout.write(`${notes}\n`);
        } catch (err) {
            console.error(err.message);
            process.exitCode = 1;
        }
    }
}
