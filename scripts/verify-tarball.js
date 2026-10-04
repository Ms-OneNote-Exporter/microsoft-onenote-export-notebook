#!/usr/bin/env node
/**
 * Refuse to publish a tarball carrying anything it should not.
 *
 * Publishing to a public registry is irreversible and the tarball is immutable
 * and public forever, so this runs as a gate before `npm publish` rather than as
 * a review convention.
 *
 * **Why this is a file and not a `node -e` string inside the workflow.**
 *
 * It was one, and it had never run successfully. A `#` comment inside the array
 * literal - where every other entry used `//` - is not valid JavaScript, so the
 * whole step died with
 *
 *     /^scripts\//,           # release tooling, used by this workflow only
 *                                ^
 *     Expected ',', got 'ident'
 *
 * before it looked at a single file. The line went in with `ffa633b` (2026-10-03);
 * v0.3.7 published on 2026-10-01, so **v0.4.0 was the first release this gate
 * ever ran on, and it failed.** Every release since that commit shipped without
 * the check.
 *
 * Nothing caught it because inline JavaScript inside YAML is not linted, not
 * imported by anything, and not executed until the one moment it cannot be fixed
 * cheaply. As a real file it is linted, unit-tested, and runnable locally - which
 * is the only reason to believe a guard is guarding anything.
 *
 * Usage:
 *   node scripts/verify-tarball.js            # packs, then verifies
 *   node scripts/verify-tarball.js --json FILE  # verifies a `npm pack --json` report
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');

/**
 * Paths a published tarball must never contain, and why each is refused.
 *
 * @type {Array<{pattern: RegExp, why: string}>}
 */
const FORBIDDEN = [
    // Session state. Two patterns, because "auth" is not in the filename.
    //
    // The old rule was `^auth.*\.json$`, which reads as though it catches any
    // signed-in session state and does not. The file this project itself uses is
    // `msout-at-phttp-com.json` - microsoft-webauth's `<service>-at-<tenant>.json`
    // convention - which contains no "auth" at all and sailed straight through.
    //
    // It lives in `~/.microsoft-webauth/`, outside the repository, so nothing could
    // actually have shipped it. The point is that the rule claimed to catch session
    // state and would not have caught the one on this machine. Both patterns are
    // checked against the real published file list, so neither can quietly start
    // refusing something the package legitimately ships.
    { pattern: /auth.*\.json$/i, why: 'signed-in session state' },
    { pattern: /-at-.+\.json$/i, why: 'microsoft-webauth session state (<service>-at-<tenant>.json)' },
    { pattern: /^logs\//, why: 'app.log and the --dodump DOM captures' },
    { pattern: /^dumps\//, why: 'debug captures' },
    { pattern: /^test\//, why: 'test material' },
    { pattern: /^fixtures\//, why: 'test fixtures' },
    { pattern: /^\.github\//, why: 'workflow definitions' },
    { pattern: /^scripts\//, why: 'release tooling, used by the workflow only' },
    { pattern: /\.pem$/i, why: 'a private key' },
    { pattern: /\.p12$/i, why: 'a certificate' }
];

/**
 * Which of the given paths are forbidden, with the reason for each.
 *
 * Exported so it can be tested against planted files rather than only against a
 * real `npm pack`, which is slow and would pass vacuously if the list were empty.
 *
 * @param {string[]} files - Paths as they appear in the tarball
 * @returns {Array<{file: string, why: string}>} One entry per refused path
 */
function findForbidden(files) {
    return files.flatMap((file) => FORBIDDEN
        .filter(({ pattern }) => pattern.test(file))
        .map(({ why }) => ({ file, why })));
}

/**
 * The paths in an `npm pack --json` report.
 *
 * @param {string} json - The report text
 * @param {string} source - Where it came from, for the error message
 * @returns {string[]} The paths in the tarball
 * @throws when it is unparseable or empty. Both mean the gate did not do its job,
 *   and a gate that cannot see anything must not pass.
 */
function packedFilesFrom(json, source) {
    let parsed;
    try {
        parsed = JSON.parse(json);
    } catch (err) {
        throw new Error(`Could not parse the npm pack report${source}: ${err.message}`);
    }

    const files = parsed?.[0]?.files?.map((f) => f.path);
    if (!Array.isArray(files) || files.length === 0) {
        // Deliberately an error rather than a pass. An empty list sails through
        // every filter above, which is how a check becomes decorative.
        throw new Error(`The npm pack report${source} listed no files; refusing to treat that as clean.`);
    }
    return files;
}

/**
 * Reads the `npm pack --json` report GitHub Actions writes.
 *
 * @param {string} reportPath - Path to the JSON report
 * @returns {string[]} The paths in the tarball
 */
function readPackedFiles(reportPath) {
    return packedFilesFrom(fs.readFileSync(reportPath, 'utf8'), ` at ${reportPath}`);
}

function main(argv) {
    const reportPath = argv.includes('--json')
        ? argv[argv.indexOf('--json') + 1]
        : null;

    let files;
    if (reportPath) {
        files = readPackedFiles(reportPath);
    } else {
        const report = execFileSync('npm', ['pack', '--dry-run', '--json'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'inherit'],
            maxBuffer: 16 * 1024 * 1024
        });
        files = packedFilesFrom(report, '');
    }

    const leaked = findForbidden(files);

    if (leaked.length > 0) {
        console.error('Refusing to publish. The tarball contains:');
        for (const { file, why } of leaked) {
            console.error(`  ${file}  (${why})`);
        }
        process.exitCode = 1;
        return;
    }

    console.log(`Tarball is clean: ${files.length} files`);
    for (const file of files) console.log(`  ${file}`);
}

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
    }
}

module.exports = { FORBIDDEN, findForbidden, readPackedFiles };