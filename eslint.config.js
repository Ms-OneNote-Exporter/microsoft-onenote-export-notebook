/**
 * ESLint flat configuration.
 *
 * Scope: defect detection, not style. Formatting is deliberately NOT enforced here
 * (no Prettier) so that `npm run lint` stays a signal about correctness rather than
 * taste, and so the review never produces drive-by reformatting diffs.
 */

const nodeGlobals = {
    require: 'readonly',
    module: 'writable',
    exports: 'writable',
    process: 'readonly',
    console: 'readonly',
    Buffer: 'readonly',
    __dirname: 'readonly',
    __filename: 'readonly',
    URL: 'readonly',
    URLSearchParams: 'readonly',
    TextEncoder: 'readonly',
    TextDecoder: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    setImmediate: 'readonly',
    queueMicrotask: 'readonly',
    global: 'readonly',
    structuredClone: 'readonly',
    fetch: 'readonly',
};

const jestGlobals = {
    describe: 'readonly',
    it: 'readonly',
    test: 'readonly',
    expect: 'readonly',
    beforeEach: 'readonly',
    afterEach: 'readonly',
    beforeAll: 'readonly',
    afterAll: 'readonly',
    jest: 'readonly',
};

const browserGlobals = {
    // These appear only inside callbacks that Playwright serialises and executes in
    // the page/frame (frame.evaluate / page.evaluate). They do not exist in Node, so
    // without this block every DOM access is reported as an undefined variable.
    document: 'readonly',
    window: 'readonly',
    Node: 'readonly',
    NodeFilter: 'readonly',
    NodeList: 'readonly',
    Element: 'readonly',
    HTMLElement: 'readonly',
    getComputedStyle: 'readonly',
    location: 'readonly',
    MutationObserver: 'readonly',
};

module.exports = [
    {
        ignores: ['node_modules/**', 'logs/**', 'output/**', 'dumps/**', 'test/fixtures/**'],
    },
    {
        // Files that scrape the DOM: their evaluate() callbacks run in the browser.
        files: ['src/scrapers.js', 'src/navigator.js', 'src/diagnose-*.js'],
        languageOptions: {
            globals: { ...nodeGlobals, ...browserGlobals },
        },
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: nodeGlobals,
        },
        linterOptions: {
            reportUnusedDisableDirectives: true,
        },
        rules: {
            // --- correctness ---
            'no-undef': 'error',
            'no-unused-vars': ['error', {
                args: 'after-used',
                argsIgnorePattern: '^_',
                caughtErrors: 'none',
            }],
            'no-cond-assign': 'error',
            'no-constant-condition': ['error', { checkLoops: false }],
            'no-dupe-keys': 'error',
            'no-dupe-args': 'error',
            'no-duplicate-case': 'error',
            'no-unreachable': 'error',
            'no-func-assign': 'error',
            'no-self-compare': 'error',
            'no-unsafe-negation': 'error',
            'use-isnan': 'error',
            'valid-typeof': 'error',

            // --- silent-failure hunting: this is the point of the config ---
            // Empty catch blocks hide failures. Empty *arrow* bodies are allowed
            // because `.catch(() => { })` is an intentional, readable no-op here.
            'no-empty': ['error', { allowEmptyCatch: false }],
            'no-empty-function': ['error', { allow: ['arrowFunctions'] }],
            'no-useless-catch': 'error',
            'no-throw-literal': 'error',
            'no-return-await': 'warn',

            // --- correctness of string/regex work (this codebase rewrites HTML
            //     with dynamically built RegExps, so these matter) ---
            'no-control-regex': 'error',
            'no-useless-escape': 'error',
            'no-invalid-regexp': 'error',
            'prefer-regex-literals': ['error', { disallowRedundantWrapping: true }],

            // --- correctness of object/array access ---
            'no-prototype-builtins': 'error',
            'no-array-constructor': 'error',
            'guard-for-in': 'error',

            // --- modern-but-safe JS ---
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'no-var': 'error',
            'prefer-const': ['error', { destructuring: 'all' }],
            'no-else-return': 'warn',
            'no-lonely-if': 'error',

            // --- hygiene ---
            'no-debugger': 'error',
            'no-alert': 'error',
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error',
        },
    },
    {
        // Library code must go through the logger, not write to the console
        // directly: console output bypasses logs/app.log entirely.
        files: ['src/**/*.js'],
        ignores: ['src/diagnose-*.js'],
        rules: {
            'no-console': 'warn',
        },
    },
    {
        // Diagnostic scripts are throwaway developer tooling run by hand from a
        // terminal; their console output is the intended interface.
        files: ['src/diagnose-*.js'],
        rules: {
            'no-console': 'off',
            'no-process-exit': 'off',
        },
    },
    {
        files: ['test/**/*.js'],
        languageOptions: {
            globals: { ...nodeGlobals, ...jestGlobals },
        },
        rules: {
            'no-console': 'off',
        },
    },
];
