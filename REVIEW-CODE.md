# Code Quality Review — Plan

**Target:** `@msout/microsoft-onenote-export-notebook` v0.1.1
**Branch:** `feat/code-review-by-spacebunny`
**Reviewer:** SpaceBunny
**Status:** Plan approved — Phases 0-2 in progress

## 0. Decisions taken (2026-09-27)

| Question | Decision |
|---|---|
| Deliverable | **Review *and* fix** on this branch. P0/P1 fixes land as separate commits here. |
| Depth | **Full seven-dimension sweep** (D1-D7), including Docker and docs. |
| Tooling | **In scope.** ESLint config, GitHub Actions workflow, and a first batch of real tests may be added. |
| Test fixtures | **Sanitised real dumps**, collected in `dumps/20260927/` and catalogued in `dumps/20260927/INDEX.md` (one line per file: `STEP {n}: {file}, {comment}`). |
| STEP numbering | **Pipeline stage.** `STEP n` identifies the export stage that wrote the file (table in `INDEX.md`); several files may share a STEP. |
| Sanitisation depth | **Heavy — strip all PII.** Cookies/tokens, tenant + `sharepoint`/`onedrive` hostnames, tenant GUIDs, account e-mail, and note/section/page titles. |
| Raw dumps in git? | **No.** `dumps/` is gitignored; only sanitised `test/fixtures/` are committed, with `INDEX.md` documenting the mapping. |
| `npm test` baseline | **Add `--passWithNoTests` for now** so the script is green pre-tests; drop the flag once real tests land. |

Commit convention on this branch: `review:`, `fix(P0):`, `fix(P1):`, `test:`, `chore(tooling):`
prefixes, one concern per commit, no drive-by reformatting.

---

## 1. Aim

Assess the code quality of this tool and produce a prioritised, evidence-backed findings
report. The bar is "would I trust this with my own notebook data and run it unattended in
CI overnight": correctness of the export, failure visibility, testability, and operational
safety.

**Success =** a findings list where every item has `file:line` evidence, a severity, a
concrete recommendation, and a rough fix size — plus a remediation ladder for anything
Critical/High.

## 2. In scope / out of scope

| In scope | Out of scope |
|---|---|
| All of `src/` (12 files, ~2.8k LOC) | Feature requests (e.g. `--resume`, Graph API) |
| `Dockerfile`, `entrypoint.sh`, `start-container.sh` | Redesigning the scraping approach (browser automation is a deliberate choice, see README) |
| `package.json` metadata, scripts, dependency hygiene | Upstream dependency internals (only flag usage bugs) |
| Test strategy, lint/CI/tooling gaps | Legal/licensing review (NOTICE.md + `docs/` evidence PDF already handled well) |
| README accuracy vs actual behaviour | Performance *profiling* against a live notebook (no credentials here) |

## 3. Baseline facts (measured, not assumed)

- 12 JS files, 2 821 LOC. No TypeScript, no build step, CommonJS.
- `jest` is a devDependency and `npm test` exists, but **there are zero test files** and no
  `test`/`tests`/`__tests__` directory.
- **No ESLint, no Prettier, no `.editorconfig`, no `engines` field, no `.github/` CI.**
- Largest file `src/scrapers.js` (657 LOC), then `src/exporter.js` (549),
  `src/downloadStrategies.js` (381), `src/navigator.js` (352).
- 18 × `waitForTimeout` (fixed sleeps totalling minutes of pure waiting per export).
- 4 × `console.*` in `src/scrapers.js` bypass the logger; 52 more in the two `diagnose-*`
  scripts (which ship to npm because `files: ["src/"]`).
- Confirmed dead code: `USER_DATA_DIR` (config.js), `content.embeds` (produced, never
  consumed), `tryNetworkInterception` (never called), `downloadResource`'s `onError` option
  (no caller passes it), `displayPath` in `exporter.js:116,217`.
- Only on-disk artefacts available for testing: `logs/app.log` and 3 sample `.md` outputs
  in `output/`. **No HTML fixtures** — these must be created (sanitised) to enable offline
  tests.
- Local `node` is not on the non-interactive `PATH`; use
  `export PATH=/opt/homebrew/bin:$PATH` (v20 present) for any tooling run.

## 4. Review dimensions

| # | Dimension | What "good" looks like here |
|---|---|---|
| D1 | **Correctness** | Export produces the right files/links; failures are never silent |
| D2 | **Error handling & exit codes** | Non-zero exit on failure; no swallowed exceptions; no lying success messages |
| D3 | **Architecture & duplication** | Single flow per concern; no 90-line copy-paste; clear module boundaries |
| D4 | **Testability** | Business logic separable from Playwright; pure functions unit-testable |
| D5 | **Robustness of scraping** | Selectors/heuristics defensible, documented, and covered by fixtures |
| D6 | **Operational safety** | Docker/CI correctness, unattended behaviour, resource limits, security/privacy |
| D7 | **Maintainability & docs** | Naming, JSDoc accuracy, dead code, README matches reality |

## 5. Phased plan

Each phase ends with a written finding in this file. Effort: S ≈ <1h, M ≈ half a day, L ≈
multi-day (mostly remediation, not review).

### Phase 0 — Harness setup (S) — **DONE**
- Local toolchain: Node **v26.10.0**, npm **11.19.1** (not on the default non-interactive
  `PATH`; prefix commands with `export PATH=/opt/homebrew/bin:$PATH`).
- `node --check` passes on all 13 tracked JS files.
- `npm ls --depth=0` resolves cleanly: chalk 4.1.2, commander 14.0.3, enquirer 2.4.1,
  fs-extra 11.3.6, playwright 1.61.1, sanitize-filename 1.6.4, turndown 7.2.4,
  turndown-plugin-gfm 1.0.2, jest 29.7.0.
- **`npm test` is currently RED**: `npx jest` → "No tests found, exiting with code 1".
  Any CI wired up as-is would fail on day one — the `--passWithNoTests` question is a real
  decision, not a detail.
- **Exit criteria met:** reproducible command set recorded below.

**Command set for this review**
```bash
export PATH=/opt/homebrew/bin:$PATH
npm ci                 # clean install
npx jest               # tests (red until Phase 5)
node --check <file>    # per-file syntax
npm run lint           # added in Phase 1
```

### Phase 1 — Static & automated sweep (S)
- ESLint (flat config, `eslint.config.js`, recommended + `no-console` off for
  `diagnose-*`) to surface: empty catch blocks, unused vars, assignment-in-condition
  (`scrapers.js:621`), unescaped regex construction, `no-prototype-builtins`.
- Grep-driven dead-code and duplication inventory (extend §3).
- Dependency audit: `npm audit`, check that each of the 8 runtime deps is actually used.
  - Verify: `enquirer` (used), `chalk`, `commander`, `fs-extra`, `playwright`,
    `sanitize-filename`, `turndown`, `turndown-plugin-gfm` — flag any unused.
- **Exit criteria:** machine-generated list reconciled into the report.

### Phase 1 — Static & automated sweep (S) — **DONE**

**Tooling added:** `eslint@9.39.5` (devDependency) + `eslint.config.js` (flat config) +
`npm run lint`. Scope is deliberately *defect detection, not style* — no Prettier — so lint
stays a correctness signal and the review produces no drive-by reformatting.

Config decisions worth recording:
- `no-empty` with `allowEmptyCatch: false` and `no-empty-function` allowing only arrow
  bodies: this is the "silent failure" rule that matters most here, while
  `.catch(() => { })` stays a readable no-op.
- `no-console: warn` for `src/**` but off for `src/diagnose-*.js` (console *is* the
  interface of a script you run by hand from a terminal).
- A browser-globals override for `scrapers.js` / `navigator.js` / `diagnose-*.js`, because
  their `evaluate()` callbacks are serialised into the page — without it every DOM access
  is a false `no-undef`.
- Dropped `prefer-template`, `object-shorthand`, `dot-notation`, `no-implicit-coercion`:
  they produced 22 of 29 warnings and contradicted the config's stated purpose.

**Result: 26 errors, 9 warnings.** Machine-confirmed findings:

| ID | Sev | Location | Finding |
|----|-----|----------|---------|
| F-02 | Medium | `scrapers.js:1` + `:380,410,443,446` | `logger` is imported and **never used**; the file logs via `console.*` instead. This is the root cause of the 4 console calls, not an independent issue — and it means scraper diagnostics never reach `logs/app.log`. Fixing the import fixes the cause. |
| F-03 | Low | `scrapers.js:621` | `while (node = walker.nextNode())` — assignment in condition (`no-cond-assign`). |
| F-04 | Low | `exporter.js:391`, `scrapers.js:478` | Two empty `catch (e) { }` blocks that swallow errors with no log at all. |
| F-05 | Low | `exporter.js:116,217` | `displayPath` assigned, never used (dead code). |
| F-06 | Low | `downloadStrategies.js:323-327` | `tryNetworkInterception` is dead: never called, always returns `false`, 3 unused params. |
| F-07 | Low | `diagnose-notebook.js:16` | `logger` imported, never used. |
| F-08 | Low | `parser.js:111` | `node` param unused in the `tableCells` replacement. |
| F-09 | Info | 10 × `prefer-const` | `let` where `const` suffices (`exporter.js`, `scrapers.js`, `downloadStrategies.js:35`, `linkResolver.js:81`). |
| F-10 | Info | `exporter.js:22`, `scrapers.js:397,403` | Unnecessary `\/` escapes in regex literals (harmless). |
| F-11 | Info | 4 × `no-return-await` | Redundant `await` on returned promises (`scrapers.js:10,191,612`, `exporter.js`). |

Dead-code inventory confirmed by tooling, beyond ESLint:
- `config.js:11,17` — `USER_DATA_DIR` exported, never imported anywhere.
- `scrapers.js:274,282` (`embedInfos`) — `content.embeds` is produced and returned but no
  consumer ever reads it; the `embeds` turndown rule in `parser.js:52` keys off
  `data-embed-id` in the HTML instead.
- `exporter.js:19,47` — `downloadResource`'s `onError` option has no caller; `timeout` is
  never overridden from its 60 000 default.

- **Exit criteria met:** machine-generated list reconciled into the report.

### Phase 2 — Correctness deep-dive, module by module (L)

Walk each file against D1/D2/D5, writing findings as we go.

- `src/index.js` — CLI contract, exit codes, option mapping.
- `src/exporter.js` — traversal, asset pipeline, filename collisions, stats.
- `src/navigator.js` — notebook identity, popup handling, MCAS dismissal.
- `src/scrapers.js` — the four large `frame.evaluate` blocks, heuristics.
- `src/parser.js` — turndown rules vs the HTML the scraper actually produces.
- `src/linkResolver.js` — link matching correctness.
- `src/downloadStrategies.js` — strategy chain, resource leaks, timeouts.
- `src/utils/*` — logger side effects, retry semantics.
- **Method:** for each, trace one realistic end-to-end path (a page with 2 images, 1
  attachment, 1 video, 1 internal link) on paper and record where the data would be lost,
  misnamed, or dropped. Then propose a unit test that would have caught it.
- **Exit criteria:** every module has ≥1 finding or an explicit "no material issues" note.

### Phase 3 — Architecture & duplication (M)
- Map the duplicated `--notebook-link` vs `--notebook` flow in `runExport`
  (`exporter.js:364-423` vs `426-537`).
- Assess `processSections`' 8 positional parameters and the mutable default `stats` object.
- Module boundary check: does `exporter.js` know too much about Playwright internals?
  Should asset naming live in its own unit?
- **Exit criteria:** a short "target shape" section (not a full redesign) with the 3
  highest-leverage extractions.

### Phase 4 — Security, privacy & operational safety (M)
- `auth.json` handling: file permissions, `storageState` validation, error clarity.
- URL fetching with the authenticated context (`exporter.js:31`) — an authenticated GET to
  a host chosen by page content; assess and document.
- `--dodump` writes full authenticated DOM HTML to `logs/dumps` (default mode 0644) —
  sensitivity of that content.
- Images always saved as `.png` regardless of real format; no content-type validation.
- Docker: base image pinning, `npm install` vs `npm ci`, running as root, missing
  `.dockerignore`, `git clone` of `main` at build time (image never contains local code),
  missing `--init` and `/dev/shm` sizing (classic Chromium-in-Docker failure), and
  `entrypoint.sh`'s unconditional "Export completed successfully!".
- `start-container.sh`: container-name mismatch (`oneexp_$SESSIONGUID` created vs
  `one-$SESSIONGUID` printed), hardcoded sibling-repo path and image name, foreground
  `docker run` described as "detached".
- **Dump sanitisation policy** (blocking input to Phase 5): the raw captures in
  `dumps/20260927/` contain authenticated DOM, tenant hostnames and personal note titles.
  Decide and apply the scrub list (cookies/tokens, `onedrive`/`sharepoint` hostnames,
  tenant GUIDs, e-mail addresses, note/section names if required) before anything is
  committed or fed to CI.
- **Exit criteria:** a security/ops section with severity-ranked items.

### Phase 5 — Test strategy & tooling plan (M)
- **Unit (no browser):** `utils/retry`, `utils/logger`, `parser` (golden HTML → Markdown),
  `linkResolver`, filename/asset-naming helpers, and the attachment heuristics from
  `scrapers.js` once extracted into a pure module.
- **Fixture-based (primary):** sanitise the real captures catalogued in
  `dumps/20260927/INDEX.md` into committed fixtures under `test/fixtures/`, then drive
  `getSections`/`getPages`/`getPageContent` against a minimal fake `frame` implementing
  `evaluate/$/$$eval`. This is the single highest-value test investment: it covers D4 and
  protects the most brittle code. Each fixture keeps a back-reference to its `INDEX.md`
  STEP so a dump can be re-derived when the DOM changes.
- **Golden output:** convert the 3 existing `output/**/*.md` files into expected-output
  fixtures.
- **Tooling (approved):** ESLint flat config, `engines: { node: ">=18" }`, GitHub Actions
  running lint + test, `npm ci` in Docker, optional `husky`/`lint-staged`.
- **Exit criteria:** ordered test backlog (what to write first, expected effort, what bug
  it guards).

### Phase 6 — Report & remediation ladder (S + fix time)
- Consolidate all findings into this file using the format in §7.
- Propose a fix ladder: **P0** correctness/silent-failure fixes → **P1** robustness & test
  harness → **P2** refactors/dead code → **P3** docs/tooling polish.
- Decide with the user whether P0/P1 land as commits on this branch or as separate PRs.

## 6. Module review checklist (working notes)

| File | Primary concerns to verify |
|---|---|
| `index.js` | `.version('1.0.0')` contradicts `package.json` `0.1.1`; `options.outputDir → options.exportDir` remap; `--non-interactive` exit 2 path; no `--help` examples |
| `exporter.js` | Errors caught and logged but never rethrown ⇒ **CLI exits 0 on failure**; duplicated link/non-link flow; 8-arg `processSections`; mutable default `stats`; regex-based HTML rewriting of `data-local-*` attrs; 18 fixed sleeps; no failure accounting; rerun/collision behaviour; `sanitize()` returning `""` |
| `navigator.js` | Notebook identity is a **row index** (`notebook-row-N`) — the click re-queries by `rowIndex` without re-verifying the name, so a re-sorted list can open the wrong notebook silently; duplicated dedupe logic; `openNotebook` leaks the listing page |
| `scrapers.js` | 657 LOC of untestable `evaluate` logic; `fileExtRegex` duplicated 3×; O(n²) link→element matching; images matched to clones by `src` (order-dependent, can mis-map); `console.*` bypassing the logger; `return []` silently dropping a whole subgroup; `while (node = walker.nextNode())` |
| `parser.js` | Video rule hardcodes `.mp4` while `exporter.js` picks the extension dynamically ⇒ **broken links for non-mp4**; table cells don't escape `|`; `ignoreTableJunk` reads `node.className` without a `typeof` guard (SVG ⇒ TypeError); image `alt` discarded; first-row-as-header assumption |
| `linkResolver.js` | Substring ID matching over all IDs (O(n·m), false positives); `path.relative` yields `\` on Windows ⇒ broken Obsidian links; case-folding vs case-sensitive FS; unresolved links never reported; second full read/write pass over every file |
| `downloadStrategies.js` | `tryNetworkInterception` dead; `withRetry` wraps the whole 3-strategy chain ⇒ up to 9 UI sequences per attachment with 30s+ waits; dangling `downloadPromise` can reject unhandled; popups/temp pages leak on the error path; hardcoded EN/FR menu strings; no per-strategy success stats; Office Online `Accept-Language` never set |
| `utils/logger.js` | `appendFileSync` on every line; no level gating (`debug` always printed); unbounded `logs/app.log` with no rotation; log path resolves **inside `node_modules`** for a global install; `ensureDirSync` side effect at require time; timestamp lacks year/timezone; minute-granularity dump dir collides across runs |
| `utils/retry.js` | No jitter; no abort/cancellation; `silent: true` hides all diagnostics in production paths; unreachable trailing `throw` |
| `auth-context.js` | No `storageState` validation (corrupt file ⇒ cryptic Playwright error); no auth.json permission check; no locale/`Accept-Language`/viewport; browser not closed if context creation fails |
| `config.js` | `USER_DATA_DIR` exported, never used |
| `diagnose-*.js` | `diagnose-notebook.js:66` calls `openNotebook(page, scrapeTarget, nb.id)` against a **4-parameter** signature ⇒ `notebookId` undefined ⇒ guaranteed TypeError; hand-rolled arg parsing instead of commander; `process.exit` inside functions; shipped in the npm tarball |
| `Dockerfile` | `git clone`s `main` at build time (local code never in the image, unpinned); `npm install` not `npm ci`; runs as root; no `.dockerignore`; missing `--init` and `/dev/shm` sizing for Chromium |
| `entrypoint.sh` | Prints "Export completed successfully!" regardless of the underlying exit code (compounded by the exit-0 bug) |
| `start-container.sh` | Container-name mismatch; hardcoded `../microsoft-onenote-exporter-docker/...`; foreground `docker run` labelled "detached" |

## 7. Findings format

| ID | Severity | Location | Problem | Evidence | Recommendation | Fix size | Fixed? |
|----|----------|----------|---------|----------|----------------|----------|-------|
| F-01 | Critical | `exporter.js:539-546` | `runExport` swallows all errors, so `index.js`'s catch never fires and **the process exits 0 on a failed export** | `catch { logger.error(...) }` with no rethrow; `entrypoint.sh` runs under `set -e` | Rethrow / return a result object; map to exit codes (0 ok, 1 failure, 2 usage) | S | ☐ |

Severity scale: **Critical** = silent data loss/false success/security · **High** = wrong
output or hangs · **Medium** = maintainability/perf/portability · **Low** = polish.

## 8. Definition of done

1. Every file in §6 has findings or an explicit clean note.
2. Every finding has `file:line` evidence — no speculation presented as fact.
3. P0 findings are either fixed on this branch or converted to linked issues.
4. A prioritised test backlog exists with a "write this first" recommendation.
5. README inaccuracies found during the review are listed (fix or document).
6. Residual risk that cannot be verified without live OneNote credentials is stated
   explicitly rather than assumed away.

## 9. Open questions

Resolved on 2026-09-27 — see §0. Still open:

1. **P0 fix boundaries.** The exit-code fix (F-01) changes the CLI contract — a failed
   export will start returning non-zero. Confirm that is acceptable for anyone currently
   relying on the always-zero behaviour (e.g. the Docker service), or whether it needs a
   release note / version bump.
2. **Scope of the internal refactors.** Removing the duplicated notebook-link flow and
   extracting asset naming are Medium-sized changes to the export hot path. Confirm they
   are wanted on this branch rather than deferred to a follow-up.
