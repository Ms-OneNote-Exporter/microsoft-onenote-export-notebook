const fs = require('fs-extra');
const path = require('path');

/**
 * Static assertions over the Docker build inputs.
 *
 * These run in CI, where no Docker daemon exists, so they cannot build the image.
 * They exist to catch the specific regressions that were found in review: the
 * image cloning `main` instead of containing the local code, an unpinned base, and
 * a missing .dockerignore that would sweep a live auth.json into the image.
 *
 * The image build itself was verified manually - it builds, contains the local
 * source, runs as uid 1000, and launches Chromium as that user.
 */
const ROOT = path.resolve(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');

/** All RUN/COPY/ENV/etc. instructions, in order. */
const instructions = () =>
    dockerfile
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));

/**
 * The Dockerfile with comments stripped.
 *
 * The file explains *why* the old `git clone` is gone, so the prohibition has to
 * be asserted against the instructions rather than the prose - otherwise the
 * explanation would fail the test that forbids the thing it explains.
 */
const code = () => instructions().join('\n');

describe('Dockerfile', () => {
    // F-44, High. The old image ran `git clone ... /app`, so it contained main at
    // build time and never the local working tree: a local fix could not be
    // container-tested, and the image silently disagreed with the checkout.
    it('does not clone the repository', () => {
        expect(code()).not.toMatch(/git\s+clone/);
    });

    it('does not install git at all', () => {
        const aptInstalls = instructions().filter((l) => l.includes('apt-get install'));
        for (const line of aptInstalls) {
            expect(line).not.toMatch(/\bgit\b/);
        }
    });

    it('copies the source in rather than fetching it', () => {
        expect(code()).toMatch(/^COPY src\/\s+\.\/src\/$/m);
    });

    it('uses npm ci so the lockfile is authoritative', () => {
        expect(code()).toMatch(/^RUN npm ci$/m);
        // `npm install` would rewrite the lockfile inside the image.
        expect(code()).not.toMatch(/^RUN npm install/m);
    });

    it('pins the base image to a patch release', () => {
        const from = instructions().find((l) => l.startsWith('FROM '));
        expect(from).toBeDefined();
        // A floating tag like `node:24-slim` floats; a patch tag does not. The
        // pattern is deliberately version-agnostic so a Node bump does not have
        // to touch this test.
        expect(from).toMatch(/^FROM node:\d+\.\d+\.\d+-\w+-slim$/);
    });

    it('runs as an unprivileged user', () => {
        const users = instructions().filter((l) => l.startsWith('USER '));
        expect(users.length).toBeGreaterThan(0);
        // The final USER decides the runtime identity.
        expect(users[users.length - 1]).toBe('USER node');
    });

    it('makes the log and output directories writable by that user', () => {
        // Otherwise the logger's ensureDirSync throws on startup for non-root.
        expect(code()).toMatch(/mkdir -p \/app\/logs \/app\/output/);
        expect(code()).toMatch(/chown -R node:node \/app\/logs \/app\/output/);
    });

    it('installs the Playwright browser for the runtime user', () => {
        expect(code()).toMatch(/^ENV PLAYWRIGHT_BROWSERS_PATH=/m);
        expect(code()).toMatch(/^RUN npx playwright install chromium$/m);
    });

    it('installs Chromium system dependencies', () => {
        expect(code()).toMatch(/npx playwright install-deps chromium/);
    });

    it('starts the local entrypoint, not a copied one at the root', () => {
        expect(code()).toMatch(/^ENTRYPOINT \["\/app\/entrypoint\.sh"\]$/m);
    });

    it('mentions the shm-size requirement somewhere, since it is a run flag', () => {
        // --shm-size cannot be set in the image; it has to be documented here or
        // passed by start-container.sh, or Chromium crashes on memory-heavy pages.
        // This one deliberately reads the comments: documentation is the point.
        expect(dockerfile).toMatch(/--shm-size/);
    });
});

describe('.dockerignore', () => {
    it('excludes the host node_modules', () => {
        expect(dockerignore).toMatch(/^node_modules\/$/m);
    });

    // The one that matters most: .gitignore already keeps auth.json out of git,
    // but a `COPY . .` would still have put a full-account credential in an image.
    it('excludes authentication state', () => {
        expect(dockerignore).toMatch(/^auth\.json$/m);
    });

    it.each(['output/', 'logs/', 'dumps/', 'diag-dumps/'])('excludes %s', (dir) => {
        expect(dockerignore).toMatch(new RegExp(`^${dir.replace('/', '\\/')}$`, 'm'));
    });

    it('excludes the git directory', () => {
        expect(dockerignore).toMatch(/^\.git\/$/m);
    });

    it('still allows the files the image needs', () => {
        expect(dockerignore).not.toMatch(/^src\/$/m);
        expect(dockerignore).not.toMatch(/^package\.json$/m);
        expect(dockerignore).not.toMatch(/^entrypoint\.sh$/m);
    });
});
