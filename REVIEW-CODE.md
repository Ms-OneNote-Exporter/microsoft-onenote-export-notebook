# Code Quality Review — Plan

**Target:** `@msout/microsoft-onenote-export-notebook` — reviewed at v0.1.1, reconciled
at v0.3.5
**Branch:** started on `feat/code-review-by-spacebunny`; the fixes are on `main` as one
PR per finding (#19–#22 for the last four) and the original branch is merged
**Reviewer:** SpaceBunny
**Status:** **All Critical and High fixed. All Medium fixed, or fixed with a limit that
is argued in the register rather than assumed.** The Low/Info tail and the untriaged
§6 items are open — they are listed in §8a, and the ladder in §7 is kept as the record
of the order the work actually landed in.

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
| F-02 | Medium | `scrapers.js:1` + `:380,410,443,446` | **Corrected:** the `console.*` calls are inside `frame.evaluate()` callbacks running in the browser, where the Node logger does not exist. Real defect: those diagnostics never reach `logs/app.log`. See Phase 2 note. |
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

### Phase 2 — Correctness deep-dive, module by module (L) — **DONE (JS logic); browser paths pending fixtures**

Method: every claim below was either executed against the real modules or traced to exact
lines. Scripts live outside the repo (scratch dir) and are described, not committed.
One hypothesis was **disproved** by running it — see F-19.

**`index.js`**
- F-12 (Low) `.version('1.0.0')` at `index.js:9` contradicts `package.json` `0.1.1`.
  `onenote-export-nb --version` reports a version that does not exist. Fix: read
  `package.json`, or use `.version(require('../package.json').version)`.
- F-13 (Low) `options.outputDir → options.exportDir` remap at `index.js:24-26` leaks the
  CLI flag name into the library API. `runExport` should read `outputDir` directly.

**`exporter.js`**
- **F-01 (Critical) — exit code 0 on every failure.** `runExport` wraps its whole body in
  `try { ... } catch (e) { logger.error('Export failed:', e); }` (`exporter.js:539-546`)
  and never rethrows or sets a failure result, so `index.js:43-46` (`process.exit(1)`) is
  unreachable. *Evidence:* ran `runExport({ authFile: '/nonexistent/auth.json' })` — it
  logged `ERROR Export failed: Authentication file not found` and **resolved normally with
  `process.exitCode === undefined`, i.e. the process exits 0.** Consequences:
  `entrypoint.sh` (runs under `set -e`) prints "Export completed successfully!" after a
  total failure; any CI job or wrapper sees success. This is the single most damaging defect
  in the tool because it disables every other safety net.
- F-14 (High) — `sanitize()` returning `''` collapses the section directory into its
  parent. *Evidence:* `sanitize('...')`, `sanitize('   ')`, `sanitize('..')` and
  `sanitize('CON')` all return `''`; `path.join(outputDir, '')` is `outputDir`, so such a
  section's pages are written into the notebook root and merged with sibling sections
  (`exporter.js:99-100, 152, 169`). Needs a fallback name (e.g. `Untitled section`).
- F-15 (Medium) — two sections whose titles sanitise to the same string (e.g. `A/B` and
  `A:B` → `AB`) share one directory and silently interleave their pages and assets. Page
  names get a `usedNames` collision counter (`exporter.js:228-231`) but section/group
  directory names get none.
- F-16 (Medium) — re-running an export into the same `--output-dir` duplicates assets:
  `getUniqueAssetPath` (`exporter.js:247-255`) disambiguates by probing `fs.existsSync`, so
  the second run writes `report.pdf_1`, `_2`, … instead of refreshing. Content is not lost
  but the vault fills with near-duplicates. Needs an explicit overwrite/resume policy.
- F-17 (Medium) — no failure accounting. Every per-item `catch` logs and continues
  (`exporter.js:125-127, 340-342`), `stats` tracks only `totalPages`/`totalAssets`, and
  combined with F-01 a partially-failed export is indistinguishable from a clean one.
- F-18 (Low) — `getPageContent` returns `title`, but the filename comes from
  `pageInfo.name` (`exporter.js:225`); `title` is never used. Conversely `content.dateTime`
  is prepended unconditionally (`exporter.js:333`), so pages without a date outline start
  with two blank lines.
- F-19 (Low, disproved hypothesis) — `parser.js`'s `ignoreTableJunk` reads `node.className`
  without the `typeof` guard its two sibling rules use (`parser.js:79, 103`), which *looks*
  like a guaranteed `TypeError` on any inline SVG. **Ran it:** Turndown parses the HTML in
  Node via `@mixmark-io/domino` 2.2.0, and domino returns `svg.className` as a **string**
  (`typeof === 'string'`), so the crash is unreachable today. Recorded as latent fragility
  only — it would become a real per-page failure if Turndown ever ran in a browser context
  or against a pre-parsed DOM. Kept in the register so the asymmetry is not mistaken for
  an oversight.

**`navigator.js`**
- F-20 (High) — **notebook identity is a table row index, and the click never re-checks the
  name.** `listNotebooks` derives `id: 'notebook-row-' + tr.rowIndex` from a `<tr>` inside
  whichever table the notebook was found in (`navigator.js:147-154`), then dedupes by name
  keeping the *first* occurrence (`navigator.js:170-177`). `openNotebook` later re-queries
  every `tr img[alt="Classic Notebook"]` on the page and clicks the first row whose
  `rowIndex` matches, with no name comparison (`navigator.js:226-238`). The notebooks page
  shows notebooks in more than one table (the code itself notes a sidebar "Recent" false
  positive at `navigator.js:109-113`), and `rowIndex` is relative to *its own* table. If the
  list re-renders or re-sorts between listing and clicking — or if the same index exists in
  two tables — the tool opens **a different notebook than the user selected, and exports it
  without complaint.** *Verification status:* traced from code, not yet reproduced (needs a
  live DOM). This is precisely what the `dumps/20260927/` **STEP 1** capture is for.
- F-21 (**was Medium — WRONG, corrected 2026-09-28**) — I originally recorded that
  `navigateBack`'s `false` return was ignored and that traversal "silently continues
  against the wrong tree", then "fixed" it by throwing. **A real export run disproved
  it.** `navigateBack` returns `false` in the *normal* case — 2 of 2 groups hit it — and
  the export still produced all 15 pages and 16 assets, because sections are selected by
  absolute `[id="..."]` selector and OneNote keeps the entire section tree in one DOM, so
  the next sibling is reachable without navigating back. My throw aborted both groups and
  double-counted the failures (4 reported for 2 groups). Reverted to log-and-continue in
  `4e8d065`. The observation is not worthless, but only as trivia: the code should stop
  *pretending* to navigate back when it cannot — find a durable selector or stop calling
  it — not abort on it.

**`scrapers.js`**
- F-02 (Medium, **finding corrected during remediation**) — originally recorded as
  "unused `logger` import; route the 4 `console.*` calls through the logger".
  Implementing that would have been a **runtime bug**: those calls sit inside
  `frame.evaluate()` callbacks, which Playwright serialises and executes *in the
  browser*, where a Node module is not in scope — `logger.debug(...)` there throws
  `logger is not defined` and kills page extraction. The `console.*` calls are
  unavoidable, not careless. The real, smaller defect is that these diagnostics can
  never reach `logs/app.log`; the correct fix is to return diagnostic data from
  `evaluate()` and log it on the Node side. The misleading unused import is now removed
  and the constraint is documented at the top of the file.
- F-22 (Medium) — the group lookup returns `[]` when no container is found
  (`scrapers.js:52, 57`), and the caller only logs at `debug` level when a `parentId` is
  present (`exporter.js:89-93`). An entire section group and its subtree can vanish from the
  export with no warning at default log level.
- F-23 (Medium) — attachment heuristics are 20+ inline conditions inside
  `frame.evaluate` (`scrapers.js:302-346`), untestable without a browser, and
  `fileExtRegex` is **duplicated three times** in one function (`scrapers.js:319, 372, 397`).
  This is the highest-value extraction target in the codebase.

**`parser.js`**
- F-24 (High) — **video links are broken for every non-mp4 file.** The rule hardcodes
  `.mp4` (`parser.js:72`) while `exporter.js:294-310` derives the extension from the URL and
  writes e.g. `Note_video_1.mov`. *Evidence:*
  `turndown('<video data-local-video="Note_video_1" src=".../clip.mov"></video>')` →
  `![[assets/Note_video_1.mp4]]`, pointing at a file that does not exist.
- F-25 (High) — **a `|` inside a table cell corrupts the whole GFM table.** The cell rule
  strips newlines but never escapes pipes (`parser.js:108-115`). *Evidence:*
  `<td>a | b</td>` → `| a | b |`, i.e. a phantom extra column. *Fix:* escape `|` as `\|`
  inside cells. This silently changes note content, so it is a data-fidelity bug.
- F-26 (Medium) — links with no text produce `[[]]`, and after resolution an Obsidian link
  with an empty alias. *Evidence:* `turndown('<a data-internal-link="link_0" …> </a>')` →
  `[[]]`; end-to-end through `resolveInternalLinks` → `[[Section/Target|]]`. Should fall back
  to the target page/section name.
- F-27 (Low) — image `alt` text is discarded (`parser.js:16-22`); `![[assets/x.png|alt]]`
  would survive round-tripping into Obsidian.
- F-28 (Low) — `parser.js:118-130` assumes the first element child of a table is a header
  row and injects the `---` separator there; OneNote tables that begin with a spacer element
  produce a wrong header row.

**`linkResolver.js`**
- F-29 (High) — **links can silently resolve to the wrong page.** Target selection is
  `Object.keys(pageIdMap).find(...)` with substring matching and no specificity ordering
  (`linkResolver.js:19-40`), so the *first registered* id contained anywhere in the href
  wins. *Evidence:* with `'short-id'` registered before `'{BBBB-2222-…}{1}'` and an href of
  `…/BBBB-2222-…?ref=short-id`, the link resolved to **`[[WRONG|Go]]` — the wrong file.**
  Fix: prefer the longest/most specific id match, and require an exact id or cleaned-UUID
  match rather than a bare substring.
- F-30 (Medium) — Windows separators leak into wikilinks. `path.relative` output is embedded
  verbatim (`linkResolver.js:81-84`). *Evidence:* `path.win32.relative('C:\\vault\\Notebook',
  'C:\\vault\\Notebook\\Group\\Section\\Page.md')` → `Group\Section\Page.md`, giving
  `[[Group\Section\Page]]` where Obsidian needs `/`. Normalise with `.split(path.sep).join('/')`.
- F-31 (Low) — the function returns `void` and reports nothing. Unresolved links are
  silently reduced to plain text (evidence: `[[Dead]]`, comment stripped, no warning), so
  link-resolution quality is invisible to the user. Return counts and log them.

**`downloadStrategies.js`**
- F-32 (Medium) — **one failing attachment can block for ~7 minutes.** `withRetry`
  (`maxAttempts: 3`) wraps the *entire* three-strategy chain (`downloadStrategies.js:333-372`),
  so a hopeless attachment runs up to 9 full chains. Worst-case waits per chain ≈ 72s
  (Direct/Office Online) + 30s (UI click) + 30s (HTTP fallback) ⇒ ~396s, plus 2s/4s backoff.
  There is no per-attachment time budget and no way to cap it. A notebook with a few dead
  links will crawl.
- F-33 (Medium) — Office Online menu automation is hardcoded to English and French
  (`downloadStrategies.js:88-146`) and `auth-context.js` never sets `Accept-Language` or
  `locale`, so the Office UI language is whatever the server infers. Any other locale fails
  every selector and burns the full timeout chain.
- F-34 (Low) — `handleOfficeOnlineDownload` creates `downloadPromise` at line 150 and can
  throw before awaiting it (line 152-153), leaving a 45s timer to reject with no handler
  ⇒ unhandled rejection noise. Same pattern at `tryDirectDownload:27` is safe (`.catch`ed).
- F-35 (Low) — no per-strategy success statistics, so there is no way to tell whether the
  Direct strategy is earning its ~72s.

**`utils/logger.js`**
- F-36 (Medium) — **no level gating.** `debug` writes to stdout and to `logs/app.log` on
  every call (`logger.js:139-141`) with no `--verbose` switch, so debug noise is always in
  the user's face and the log grows without bound. There is also no rotation or size cap.
- F-37 (Medium) — **the log path is wrong for the documented install method.** The README's
  primary instruction is `npm install -g @msout/microsoft-onenote-export-notebook`, but
  `logFilePath` resolves relative to `__dirname` (`logger.js:8`), i.e.
  `<global-prefix>/lib/node_modules/@msout/microsoft-onenote-export-notebook/logs/app.log`
  — inside `node_modules`, where it is liable to be read-only or wiped by a reinstall.
  Should be XDG/`os.homedir()` based or configurable.
- F-38 (Low) — the constructor calls `fs.ensureDirSync` as an import side effect
  (`logger.js:22`), so merely `require`ing any module can throw on a read-only filesystem.
  Timestamps (`logger.js:25-31`) carry no year or timezone, so logs are ambiguous across
  midnight and across DST. `dumpSubDir` has minute granularity, so two runs in the same
  minute share a dump directory.

**`utils/retry.js`**
- F-39 (Low) — sound in principle, but `silent: true` (used by every production call site)
  suppresses the final error too, so a retried-and-failed operation is invisible unless the
  caller logs it. No jitter (thundering herd is irrelevant here, so minor) and no
  cancellation. The trailing `throw lastError` (`retry.js:56`) is unreachable.

**`auth-context.js`**
- F-40 (Medium) — a corrupt or wrong-shaped `auth.json` is not validated; `newContext`
  throws an opaque Playwright error. No permission check on a file that grants full account
  access. No `locale`/`Accept-Language`/viewport (see F-33), and if `newContext` throws the
  already-launched browser is never closed ⇒ leaked Chromium process.

**`config.js`** — F-41 (Low) `USER_DATA_DIR` exported, never imported.

**`diagnose-*.js`**
- F-42 (High) — **`diagnose-notebook.js` is broken and cannot run.** Line 66 calls
  `openNotebook(page, scrapeTarget, nb.id)` but the signature is
  `(listingPage, context, browser, notebookId)` — 4 parameters. *Evidence:* calling
  `openNotebook({}, {}, 'notebook-row-0')` throws
  `TypeError: Cannot read properties of undefined (reading 'match')` at `navigator.js:216`.
  The tool offered for "find the right selectors" is itself broken, which matters because
  the whole scraping layer depends on hand-verified selectors.
- F-43 (Low) — both scripts hand-roll argument parsing (commander is already a dependency),
  use `process.exit` inside functions, and ship inside the npm tarball via
  `files: ["src/"]`.

**Docker / entrypoint**
- F-44 (High) — the image never contains the local code: `Dockerfile:8` runs
  `git clone …/microsoft-onenote-export-notebook.git /app`, so the build pulls `main` from
  GitHub and silently ignores the working tree. Local changes cannot be container-tested.
  Also unpinned (neither base image nor clone ref), `npm install` instead of `npm ci`, runs
  as root, no `.dockerignore`, and no `--init` or `/dev/shm` sizing — the latter two are the
  classic cause of Chromium crashing or leaving zombies in containers.
- F-45 (Medium) — `entrypoint.sh:33` prints "Export completed successfully!"
  unconditionally, which is only safe once F-01 is fixed; it should assert the exit status.
- F-46 (Medium) — `start-container.sh`: creates `oneexp_$SESSIONGUID` (line 38) but the
  instructions printed on lines 35 and 45 tell the user to `docker exec one-$SESSIONGUID`;
  it also hardcodes `../microsoft-onenote-exporter-docker/dckr_output_$SESSIONGUID` and the
  image name, and calls a foreground `docker run` "detached mode" (no `-d`).

**Security & privacy (D6)**
- F-47 (Medium) — `downloadResource` performs an authenticated `GET` against a URL taken
  from page content (`exporter.js:31`) using the logged-in browser context. A crafted link
  in a shared notebook could therefore make the tool issue authenticated requests to an
  arbitrary host. Worth an allowlist of `*.sharepoint.com` / `*.1drv.ms` / OneNote hosts, or
  at minimum an explicit documented warning.
- F-48 (Medium) — `--dodump` writes full authenticated DOM to `logs/dumps/**` at the
  default 0644, and those dumps can contain tokens, tenant hostnames and note content.
  Should be created 0600 with a warning printed once.
- F-49 (Low) — images are always written with a `.png` extension regardless of the real
  format (`exporter.js:260`), and downloads are not validated against `content-type`
  (contrast the HTML guard that *does* exist at `downloadStrategies.js:356`).

**Documentation (D7)**
- F-50 (Low) — the README "Project Structure" block shows a different project root
  (`microsoft-onenote-export-notebook-playwright-js/`), omits both `diagnose-*` scripts and
  all Docker files, and does not mention `logs/app.log` (see F-37) or the 0644 dump
  sensitivity.

### Phase 2b — Findings from the first real export run (2026-09-28)

The user ran two real exports against `NoteBook_Attachments`. The second one exposed four
things no amount of code reading had found, which is the argument for running the tool:

- **F-51 (High, fixed `4e8d065`) — `blob:` image URLs could never be downloaded.**
  ```
  [ERROR] Download failed (apiRequestContext.get: Protocol "blob:" not supported.
          Expected "http:"): blob:https://euc-onenote.officeapps.live.com/c316bae8-…
  ```
  Three times per image, then silently dropped. A `blob:` URL is not a network address: it
  resolves only in the document that created it, and Playwright's `APIRequestContext`
  speaks http/https only. OneNote uses blob URLs for inline images and printouts, so
  **every printout-style image was being lost** while the page still reported success.
  Fixed by reading the blob through the page (`fetch` + `FileReader` → base64 → Buffer) in
  `readBlobInPage`, with a browser-backed test.
- **F-52 (Medium, fixed `4e8d065`) — same-named attachments overwrote each other.**
  `getUniqueAssetPath` probed the filesystem with `existsSync`, so two attachments sharing a
  name *in the same page* both resolved to the same path (neither file existed when the
  second was planned) and the second clobbered the first. The log shows the confusing
  version of this: `…_nosl.docx` reported as failed, then a later duplicate landing on the
  unsuffixed name. Names are now reserved as they are planned, per section.
- **F-32 (partly fixed `b77417f`)** — the retry multiplication was visible in the run:
  `[Strategy: UI Click] Could not find clickable element for file_1` three times, ~7–9s
  apart, per attachment, then `ERROR: All download strategies failed`. Fixed the provable
  half: `withRetry` now honours `error.permanent`, and the one case that cannot change
  between attempts — a clickable element that never appears in the DOM, when nothing
  re-navigates or re-renders — no longer burns the backoff. `maxAttempts` is deliberately
  **unchanged**, because the same log shows the retry is load-bearing for the attachments
  that *do* succeed. The remaining cost (retrying genuinely transient cloud failures) is
  still unbounded per attachment and is left for a time-budget design.
- **F-53 (Low, fixed `4e8d065`)** — a non-base64 `data:` URL returned `false` silently (or,
  in the base64 branch, would have written garbage). It now fails with a stated reason.
- Also noted, no action yet: the first invocation was interrupted with `^C` during the
  10s settle wait and the `finally` block closed the browser correctly, so Ctrl-C behaves;
  and the editor popup legitimately starts at `login.microsoftonline.com` before redirecting
  to the SharePoint `Doc.aspx` frame, which is expected rather than a mis-parse.

- **Exit criteria met:** every module in §6 has findings or an explicit clean note.

### Phase 2c — Findings from the live DOM capture (2026-09-28)

Captured the real OneNote UI (STEP 1–4) into `dumps/20260927/` and derived de-identified
fixtures in `test/fixtures/`. Two of the three findings cut *against* my own earlier work:

- **F-20 is not reachable as I described it.** I reported that a notebook row index could
  collide across tables and cause the wrong notebook to be exported. The capture shows
  **exactly one table** of notebook rows on the list page (14 rows, 13 notebooks, `rowIndex`
  starting at 1). So the cross-table mechanism does not occur. The name verification added in
  `d878ceb` is therefore **defense-in-depth, not a proven bug fix**, and the register has been
  corrected to say so. Keeping it is still right — the index is derived from a rendered table
  that can re-render between listing and clicking, and duplicate notebook names *do* occur
  (two rows were both `John @ MOBILUTILS`) — but I should not have presented a mechanism I had
  not observed as if it were established.
- **F-19-style discipline paid off again.** My first `page-list.html` fixture used a label
  shaped `<name>, page 2 of 5, Page.` and two tests failed. Rather than "fixing" the code, I
  checked the capture: that shape **does not occur**. The real labels are
  `…, Page. Select to open page contents.` and `…, Page. Selected. Press Ctrl + F6 to …`, and
  the existing code handles both. The fixture was wrong, not the tool. Recorded as a fragility
  note below rather than a speculative fix.
- **New, confirmed from the capture:** section ids are plain UUIDs, page ids are `{uuid}{n}`,
  and **group ids are URL-encoded absolute SharePoint folder URLs**. All are comfortably over
  the 20-character `MIN_ID_LENGTH` that `linkResolver.js` uses to reject accidental substring
  matches, which validates that guard against real data.

Fixtures commit only structure: names, UUIDs, CSS-module hashes and tenant strings are
placeholders, and `test/scrapers.fixture.test.js` asserts that no tenant or account identifier
survives, so a future raw capture pasted in unscrubbed fails the suite.

### Phase 2d — A run that died on its first DOM call (2026-09-28)

Six runs of

```
node src/index.js export --notebook "My Notebook" --auth-file … --notheadless --nopassasked
```

all reached the same line and all died a second later:

```
[SUCCESS] Found content frame (navigation): https://…/onenoteframe.aspx?…
[INFO]    Scanning sections...
[WARN]    Timeout waiting for .sectionList, trying to scrape anyway...
frame.evaluate: Target page, context or browser has been closed
    at getSections (src/scrapers.js:15:18)
    at processSections (src/exporter.js:187:28)
    at exportContent (src/exporter.js:654:11)
```

**F-58 (High, the actual cause) — the export closed its own browser before it started.**

`runExport` ends with a `finally` that closes the browser. Returning a *promise*
from inside a `try` that has a `finally` does not wait for it — the `finally`
runs as soon as the return expression is evaluated:

```js
try { return doTheWork(); }       finally { await browser.close(); }  // close() runs FIRST
try { return await doTheWork(); } finally { await browser.close(); }  // close() runs after
```

`runExport` ended with `return exportContent({ … })`, so every run killed the
browser it was about to use, and a race decided whether the export got one
section in before the browser went. Confirmed three ways, none of which required
guessing:

- the log ordering, with `--verbose`: `Found content frame` → `Closing browser…`
  → `Scanning sections…`, i.e. the `finally` ran *between* finding the frame and
  the first DOM call;
- a five-line script reproducing the semantics above;
- the timestamp arithmetic: the `[WARN] Timeout waiting for .sectionList` is
  stamped the same second as `Scanning sections...` and the wait allows 15s,
  while the suite's real timeouts take the full 15s. A `waitForSelector` against
  a closed target fails *instantly*, which is why the "timeout" was instant.

**When it arrived.** The last good run was 12:17 (19 pages). The regression is
`2807715` at 13:34, "collapse the duplicated half of runExport into one shared
path". Before it, the click path had the tail inlined and ended with `return
stats` — a *value*, so the `finally` ran at the right time. The extraction turned
that into `return exportContent(…)`, and the commit's own test could not see it:
`exportContent` is tested directly, never through `runExport`, so nothing ever
exercised the `finally`. That is the same class of blind spot as the drift the
commit was fixing, in the opposite direction — and the lesson for the next
extraction here is that a `return` at the end of a `try` is part of the function's
contract, not a detail of the code being moved.

Nothing in the toolchain objects, which is why it survived five runs:
`no-return-await` is enabled in `eslint.config.js`, and it deliberately **exempts**
`return await` inside a `try`/`finally` (verified against the installed ESLint
9.39.5, not assumed), so both forms lint clean. I had assumed the opposite and
written that claim into a comment and the CHANGELOG before checking; the test is
the only guard that actually works here.

**F-56 (High) — the failure was reported as a Node crash.** Closing the browser
rejects one of Playwright's own internal promises, which nothing awaited, so Node
killed the process with an unhandled rejection before the CLI's handler could
run: no `Export failed` in the log, no summary, and an exit status unrelated to
the export. Reproduced with a real browser: closing a *page* does not produce it,
closing the *context* does. `program.parse()` also returns a promise the CLI
discarded, so any rejection from the command could escape the same way.

### What I got wrong first, and what corrected it

I first read this as the browser or the tab dying, and wrote that up — the log
showed no crash report, so the honest position at the time was "a closed or
crashed target, cause unknown", and `notebookFrame.js` was built to make that
survivable rather than to prevent it.

**A screenshot of the user's browser at the moment of the failure disproved it.**
The editor tab was open, fully rendered, showing the notebook: section list,
page list, page content. `Target page, context or browser has been closed` is not
something a live, working tab can be asked for. A `--dodump` capture agreed — a
929 KB frame with the complete section list, written one second *before* the
failure. So the target was not dying, and a "crashed renderer" reading (which I
had also floated, and which no macOS crash report supports) was wrong too.

I then added a diagnostic that reads the target's state at the moment of failure
and re-ran it against the real notebook:

```
[DEBUG] waitForSelector() failed (frame.waitForSelector: Target page, context or browser has been closed)
[DEBUG] OneNote target state at failure: death=closed pageClosed=true contextPages=0 openPages=[] frameDetached=no frame
```

`contextPages=0` — not one page left in the context, including the notebook list
page that nothing had closed. That is a closed *browser*, and the only thing in
this codebase that closes one is that `finally`. The screenshot is what turned
"a plausible story" into "no, the tool did this", and it is the reason the fix
below is `return await` rather than anything about frames.

**Kept anyway, because both are real defects this hunt exposed** (not causes of
it):

- **F-55 (High)** — the export pinned one `Frame` object for the whole run. A
  Playwright frame is not a durable handle: OneNote re-creates its
  `onenoteframe.aspx` frame on a reload (`newsession=1`,
  `wdredirectionreason=Force_SingleStepBoot` are in that URL for this reason),
  and a tab or renderer can go at any moment. `notebookFrame.js` now holds the
  page and resolves the frame per call, re-finding a replaced one and reporting a
  dead tab with its cause. A browser test swaps the notebook iframe mid-export
  and asserts the export still finishes; it fails in 67 ms without the change.
- **F-57 (Medium)** — the `.sectionList` wait reported every failure as a
  timeout, which is what sent me looking for a slow DOM instead of a closed
  browser.

The lesson is the one Phase 2b and 2c keep earning: a log line is not a cause.
The cost of this one was a fix aimed at the wrong layer, written with more
confidence than the evidence supported — corrected above rather than quietly
replaced, because "I was wrong and here is what showed me" is the part worth
keeping.

### The same mistake again, one layer down (the download dialog)

With F-58 fixed the export ran, and it then appeared to hang on OneNote's
"Download File" confirmation: the modal open on screen, `Will wait 2 seconds to
let the confirmation dialog load.` logged on every attempt, and neither
`Found confirmation button on page` nor `…in frame` ever printed. I wrote that
up as **F-59, a pre-existing product defect**, on the strength of a live
diagnosis: 6 attempts, 0 selector matches, a modal that blocked the page.

It was not a product defect. It was **F-58's own session proxy**, which wrapped
every method in a promise:

```js
contentFrame.locator(sel).filter({ visible: true }).first()
//   → TypeError: locator(...).filter is not a function
```

A promise has no `.filter`. The exception was thrown inside a `catch` that
discarded it, so the confirmation was never clicked, the modal stayed, and the
export crawled — a self-inflicted bug presenting with the exact signature of the
one I had just spent the day fixing. Two things had to be true for this to be so
misleading, and both are now fixed:

- **the silent catch is gone.** It logged nothing, so the one line that would
  have said `locator(...).filter is not a function` never reached the log. This
  is the same defect class as F-04/F-34, and `no-empty` does not catch a catch
  with a comment in it.
- **the diagnosis was tested against the old code instead of argued about.** One
  run of the same call with a raw `Frame` settled it in three seconds —
  `Found confirmation button in frame, clicking...` → `Downloaded via Strategy:
  UI Click`, 324 KB. Everything I had written about OneNote's dialog was wrong:
  the button is `#DialogActionButton` in the OneNote frame, it appears in 690ms,
  the existing English selector matches it, and it works.

What I should have done at the first "0 matches" was to print the exception
instead of writing a paragraph about it. The cost of not doing that was a
finding, a CHANGELOG entry and a README section describing a defect in the
product that did not exist — all of it now removed, and the time budget (F-32)
that came out of it kept.

`NotebookSession` now passes through the methods whose result callers chain off
(`locator`, `$`, `getBy*`, …) as the real Playwright object, and only routes
awaited calls through the retrying path. `test/notebookFrame.test.js` uses the
exact call shape from `downloadStrategies.js`, so it cannot come back quietly.

### The same mistake, third time, on a fix I had already called verified (F-61)

The user reported a page exported as the two words "Page Contents". The file was
fifteen bytes: `\n\nPage Contents`, with no date line, which is the proof that
the scraper had found no content outlines and fallen back to the `div[role=main]`
landmark. The cause was a fixed `waitForTimeout(3000)` between clicking a page
and scraping it, so the fix was to wait for the content instead of the clock.

**The first version of that fix was worse than the bug it replaced, and I shipped
it into a verification run before noticing.** It waited for `.OutlineContainer`
to exist. OneNote does not clear the canvas when you click a page, so the outgoing
page's outlines are still there and that condition is true *immediately*. The run
exported 19 pages in eight seconds, and the content was catastrophic:

```
   5 w | Section S1-Note1.md                 (was 5)
   5 w | Section S1-Note1w Table.md           (was 206)
  25 w | Note w linktopage.md                 ┐
  25 w | Note with SectionLink.md             ├ the same 25 words, three times
  23 w | SectionS2-Note1wPic.md               ┘
```

A probe over the real notebook settled it — 16 of 19 pages were showing the
*previous* page's title. Replacing a race with a condition that is trivially true
is not a fix, and the reason the stub existed in the first place is that nobody
checked what the condition meant.

**The second version was wrong too, in the opposite direction.** It waited for
the canvas title to equal the requested page. That is necessary and not
sufficient: OneNote *clones* whichever page is on screen while it transitions, so

```
[previous] -> [previous + previous] -> [] -> [wanted + wanted] -> [wanted]
```

The title is already correct at `[wanted + wanted]`, and `getPageContent` scrapes
every outline it finds, so the export produced pages with their content **twice**
— the 206-word table page came out as 406. A third measurement found images load
one step *after* the outlines settle (`outlines=3 img=16/15` → `outlines=3
img=16/16`), so two of nineteen pages were losing their picture with no error.

The shipped fix therefore requires three things at once: the requested title,
exactly one copy of it, and two consecutive identical readings. The lesson is the
one from F-59 with a sharper edge — **the wait is the part of this codebase most
able to produce a silent wrong answer, because a wait that returns early is
indistinguishable from a wait that worked.** The reference run for this notebook
existed and was byte-comparable; comparing against it is what caught all three.

What actually made this diagnosable was measuring the transition rather than
reasoning about it. Each of the three wrong versions was plausible, and each was
wrong in a way that reasoning about the code could not have revealed.


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

### Phase 5 — Test strategy & tooling plan (M) — **test harness DONE; fixtures blocked on dumps**

**Landed:** ESLint flat config (`npm run lint`, now **0 errors / 0 warnings**), GitHub
Actions workflow (`.github/workflows/ci.yml`: `npm ci` → lint → test → CLI smoke test
asserting `--version`, `--help` and a non-zero exit for a usage error), and **53 tests**
across 5 suites:

| Suite | Covers |
|-------|--------|
| `test/parser.test.js` | Turndown rules: video extension, pipe escaping, empty links, attachments, embeds, table furniture |
| `test/linkResolver.test.js` | Id specificity, cleaned-UUID matching, `onenote:` fallback, self-links, forward slashes, unresolved links |
| `test/naming.test.js` | `safeName` fallbacks (incl. `...`, `..`, `CON`, `null`), `uniqueName` collision counting |
| `test/retry.test.js` | Success/retry/give-up, final-error propagation, exponential backoff and cap |
| `test/reportSummary.test.js` | Clean run vs failed run messaging, per-category counts, link counts, fresh stats object |

Every data-fidelity fix (F-24, F-25, F-26, F-29) was written as a test **first**, watched
fail against the old code, and only then fixed. `--passWithNoTests` has been dropped now
that real tests exist.

**Still to do once `dumps/20260927/` is populated** (scrubbed per the §0 decisions):
- Convert the raw captures into committed fixtures under `test/fixtures/`, each carrying a
  back-reference to its `INDEX.md` STEP.
- Drive `getSections` / `getPages` / `getPageContent` against a minimal fake `frame`
  implementing `evaluate/$/$$eval` — the highest-value remaining investment, since it covers
  D4 and protects the most brittle code (F-22, F-23).
- Reproduce or refute **F-20** (wrong-notebook risk) against the STEP 1 notebooks-list DOM.
- Turn the 3 sample files in `output/**/*.md` into golden expected-output fixtures.

- **Exit criteria:** ordered test backlog exists (above); fixture half blocked on input.

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

## 7. Findings register

**74 findings: 1 Critical, 18 High, 24 Medium, 31 Low/Info.** Full evidence for each
is in the Phase 2 section above; this table is the index. Four more (F-55, F-56, F-57,
F-58) came out of a real run and are written up in Phase 2d, which also records the
diagnosis I got wrong first, and F-60 through F-65 came out of a second one. F-66 came
out of a third — a real run of the then-unreleased `--screenshot` flag, reported by the
person running it, which is the first finding here that a user's own run found rather
than this review. That run also produced F-67 through F-74: three recorded open, five fixed.

**Every Critical and High is fixed. Every Medium is fixed or fixed with a stated
and argued limit — except F-67**, which a real run found on 2026-10-03 and which is
open; see the standing table in §8a. What remains open is that one, the Low/Info
tail and the untriaged items in §6.

| ID | Sev | Area | One-line summary | Status |
|----|-----|------|------------------|--------|
| F-51 | **High** | `exporter.js:31` | `blob:` image URLs cannot be fetched by the request context ⇒ every inline/printout image silently lost | **fixed** `4e8d065` |
| F-52 | Medium | `exporter.js:332` | Same-named attachments overwrite each other (filesystem probe instead of reserving planned names) | **fixed** `4e8d065` |
| F-53 | Low | `exporter.js:22` | Non-base64 `data:` URL failed silently / could write garbage | **fixed** `4e8d065` |
| F-01 | **Critical** | `exporter.js:539` | Failed export exits 0 — `runExport` swallows every error, disabling all failure detection | **fixed** `4a5e4ce`. **Residual also fixed** — see F-65 |
| F-20 | High → **Low** | `navigator.js:147,226` | Notebook identity is a row index; the click never re-verified the name | **corrected**: the capture shows ONE table of notebook rows, so the cross-table collision does not occur. Name verification retained as defense-in-depth `d878ceb` |
| F-24 | High | `parser.js:72` | Video wikilinks hardcode `.mp4` while files are written with the URL's real extension | **fixed** `a306c9d` |
| F-25 | High | `parser.js:113` | Unescaped `|` in table cells silently adds phantom columns | **fixed** `a306c9d` |
| F-29 | High | `linkResolver.js:19` | Substring id matching with no specificity ordering ⇒ links resolve to the **wrong page** | **fixed** `a306c9d` |
| F-44 | High | `Dockerfile:8` | Image `git clone`s `main` from GitHub; local code is never in the image | **fixed** (image rebuilt and verified: contains local source, runs as uid 1000, Chromium launches) |
| F-42 | High | `diagnose-notebook.js:66` | Diagnostic script calls a 4-param function with 3 args ⇒ guaranteed TypeError | **fixed** `c35c3b5` |
| F-14 | High | `exporter.js:99,152,169` | `sanitize()` returning `''` collapses a section into its parent directory | **fixed** `4a5e4ce` |
| F-12 | Low | `index.js:9` | `--version` reported 1.0.0 while `package.json` says 0.1.1 | **fixed** `98347e8` |
| F-15 | Medium | `exporter.js:169` | Sections with equal sanitised names share one directory | **fixed** `a306c9d` |
| F-17 | Medium | `exporter.js:87,340` | No failure accounting: partial exports look clean | **fixed** `a306c9d` |
| F-26 | Medium | `parser.js:41` | Text-less internal links become `[[]]` → `[[path|]]` | **fixed** `a306c9d` |
| F-30 | Medium | `linkResolver.js:81` | Windows `\` separators break Obsidian wikilinks | **fixed** `a306c9d` |
| F-31 | Low | `linkResolver.js:10` | Resolver returns `void`; unresolved links are invisible | **fixed** `a306c9d` |
| F-02 | Medium | `scrapers.js` | **Corrected, then fixed.** The original finding said "route the 4 `console.*` calls through the logger", which would have been a runtime bug: they sit inside browser-context `evaluate()` callbacks where a Node module is not in scope. The real defect was the destination — a browser console nobody has open | **fixed** — the diagnostics are collected in the page and **returned**, then logged on the Node side, with each message's level preserved. The `FAILED to match real element` line is a warning because it predicts a download that cannot succeed, and it now reaches `logs/app.log` |
| F-21 | Low | `exporter.js:122` | ~~`navigateBack` failure ignored ⇒ traversal continues against the wrong tree~~ — **disproved by a real run**; the throw I added broke the export. Reverted `4e8d065`. | reverted |
| F-22 | Medium | `scrapers.js:52` | A missing group container made a whole subtree vanish at default log level | **fixed** `d878ceb` (warning added) and again in `985ac08` — `getSections` now returns `{ items, reason }` (`no-parent` / `no-container` / `empty`) and `emptyLookupWarning` names the remedy. A genuinely empty group is now silent, which was the one case where the old message was pure noise |
| F-32 | Medium | `downloadStrategies.js:333` | Up to 9 strategy chains per attachment ⇒ ~7 min for one dead link | **fixed** — `withRetry` gained `maxElapsedMs`; an attachment is capped at 30s of wall clock, which the strategy that actually works (4s) fits inside. **The evidence half is now fixed too:** `utils/strategyStats.js` counts attempts *and* wins per strategy and the summary prints `wins/attempts`, so "Direct entered 40 times, won 0" is now visible — which is what reordering or dropping the ~72s Office Online path needs |
| F-60 | Medium | `scrapers.js:425` | One file attachment is scraped 2–3 times: a `div.WACEFContainer[role=link]` and the `span.WACEFOverlay` inside it both match, so the same PDF is downloaded repeatedly and lands as `file.pdf`, `file_1.pdf`, … **Confirmed live** (`Section1-Note1.1_PDFs` produced 3 entries for 1 file) | **fixed** — a candidate whose ancestor names the same file is a part of that file, not a file of its own. 3 → 2 on the live page, and the entry that had no click marker at all now has one |
| F-61 | **High** | `exporter.js:527`, `scrapers.js:267` | A page that had not finished rendering was written as a 15-byte note containing the string `Page Contents`, and the run reported success | **fixed** — wait for the requested page to be *settled* on the canvas: the right title, exactly one copy of it, and two consecutive identical readings (images load after the outlines do). Re-select once, then fail the page by name with nothing written, naming what the canvas really showed |
| F-62 | **High** | `exporter.js:294` | A section group that had not finished expanding returned an empty list, which was treated as "this group is empty": the whole subtree was skipped **with a warning that did not affect the exit status** | **fixed** — wait for the group's children, and click only while `aria-expanded` says collapsed, since selecting a group is a toggle. Fail the group by name if the children never appear. Found by a verification run of F-61 that lost 8 pages and still printed `Export complete!` with exit 0; the group's failure turned out to be a symptom of F-61's desynchronised canvas |
| **F-63** | **High** | `scrapers.js:492` | **Fixed.** Regression from F-60: attachments were downloaded but no longer linked from the note. The `[[assets/…]]` embed is emitted by a turndown rule keyed on `data-local-file` (`parser.js:26`), and turndown never consults custom rules for a *blank* node — and F-60's dedup kept OneNote's empty click overlay, so the id went there and no embed was produced. `Complete_Paris_9th_Arrondissement_Guide.docx` and `attached_file.bin` sat on disk referenced by **zero** notes | **fixed** — `data-local-file` (renders the link) and `data-one-attach-id` (marks the element to click) are different jobs and were conflated; the id now goes on the element that shows the file's name. Live: 12 assets, 0 orphaned, duplicate `_1` downloads gone, dangling links 8 → 1 |
| **F-64** | Medium | `exporter.js:695`, `714`, `750` | **Fixed.** Images, attachments and videos all rewrote their link to the final file name *before* attempting the download, so a failed download left `[[assets/…]]` pointing at a file that was never written. The page rendered as complete with an empty embed; the only trace was an `ERROR` in the log. 8 occurrences in a baseline run, 1 after the F-61/F-63 work | **fixed** — the link is kept, as the README's trade-off intends, and the page now ends with a notice naming what is missing, rebuilt each run so it self-clears on a re-run. Covers all three asset types. **Correction:** this was first written up as a "pre-existing defect needing a product decision", which was wrong — the README already documented the behaviour as deliberate ("it costs a re-run rather than correctness"). The gap was the missing half of a documented trade-off, not an unintended defect |
| **F-65** | **High** | `exporter.js:1108` | **Fixed.** F-01's residual, one level down: a run that lost pages, sections or groups printed `Export finished with errors - N item(s) could not be exported` and **still exited `0`**. The summary was truthful and nothing acted on it, so a CI job could go green over a vault with holes in it. Not hypothetical — this session's own F-62 verification run lost 8 pages that way | **fixed** — a pure `exitCodeForStats()` returns `3` when pages, sections or groups are missing, and `runExport` applies it. `3` rather than reusing `1`, because the two call for opposite responses: `1` is "nothing usable came out, retry from scratch", `3` is "mostly fine, some items absent", where retrying would discard a good vault. Failed *assets* deliberately do not change the exit code — downloads fail routinely, so a code set on nearly every run stops being read; they are counted in the summary and named in the note instead. A run whose tab died still exits `1`, since that is an unknown fraction rather than a known partial |
| F-34 | Low | `downloadStrategies.js:150` | Dangling `downloadPromise` can reject unhandled | **fixed** — marked handled at creation, awaited later. (The same class was fixed in `navigator.js`, `d878ceb`. An earlier row in this table said "open"; it contradicted the one below it and the code was the authority.) |
| F-33 | Medium | `downloadStrategies.js:136-172`, `auth-context.js` | Office Online automation is EN/FR only, and nothing pinned the language | **partly fixed** — `auth-context.js` now pins `locale: 'en-US'` **and** `Accept-Language` in `extraHTTPHeaders`, and logs the language the page actually came up in. Verified against real Chromium: `locale` reaches the page but **not** `context.request`, which is the client that downloads the files, so the header has to be set in both places. **Still open:** an account whose language is not English can still render a non-English menu, because M365 takes the UI language from the profile and Office Online additionally from the `lc`/`mkt` parameters the SharePoint host appends. What the fix buys is that the tool stops depending on the operator's OS language, and that a failure now says which language the page was in |
| F-36 | Medium | `logger.js:139` | No log-level gating: `debug` always prints and the log grows unbounded | **fixed** — `--verbose`/`--quiet` + `ONENOTE_EXPORT_LOG_LEVEL`, default hides debug; rotates at 5 MB |
| F-37 | Medium | `logger.js:8` | Log path lands inside `node_modules` for the documented global install | **fixed** — XDG state dir for global installs, `ONENOTE_EXPORT_LOG_DIR` override |
| F-40 | Medium | `auth-context.js:16` | No `storageState` validation; leaked browser if context creation fails | **fixed** — validated pre-launch, browser closed on context failure, loose-permission warning |
| F-45 | Medium | `entrypoint.sh:33` | Prints "completed successfully" unconditionally | **closed by decision** — the unconditional message is now intentional (see note) |
| F-46 | Medium | `start-container.sh:35` | Container-name mismatch, hardcoded paths, foreground run called "detached" | **fixed** — name, image, output dir and auth file all overridable; `--init` + `--shm-size=1g` added |
| F-47 | Medium | `exporter.js:31` | Authenticated GET to a host chosen by page content | **fixed (warn, by decision)** — classified and logged once per host; nothing blocked |
| F-48 | Medium | `logger.js:38` | `--dodump` writes authenticated DOM at 0644 | **fixed** — dirs 0700, files 0600, existing app.log tightened at startup |
| F-23 | Medium | `scrapers.js`, `attachmentNames.js` | 20+ untestable inline heuristics; the 19-extension list was written out **3×** in one `evaluate()` callback, with nothing keeping the copies equal | **partly fixed** `fb4816e` — `attachmentNames.js` owns the list, the pattern and the name-preference order, with 21 tests; the three copies are now one definition, passed into the page as a regex *source string* and rebuilt there. Also widened by `.doc`/`.xls`/`.ppt`, which the old list omitted and so never downloaded. **Left open by design:** the heuristics that need a live DOM (`fileOwner`'s ancestor walk, `fileLabel`, the real-element match) cannot leave the callback, because Playwright serialises it into the browser and a `require` there throws. Injecting them as source text to rebuild with `new Function` would make them Node-testable at the cost of `eval` against a Microsoft login page — not a trade worth making for a filename heuristic, and the fixture tests cover that behaviour in a real browser |
| F-03, F-04, F-05, F-06, F-07, F-08, F-09, F-10, F-11 | Low/Info | various | Dead code, empty catches, `no-cond-assign`, unused params, useless escapes | **fixed** `a306c9d` |
| F-41 | Low | `config.js:11,17` | `USER_DATA_DIR` exported, never imported | **fixed** — dead export removed |
| F-39 | Low | `retry.js:56` | Unreachable trailing `throw lastError` | **fixed** — now rejects instead of resolving `undefined` when `maxAttempts <= 0` |
| F-50 | Low | `README.md` | Project Structure named a non-existent root, omitted half the repo | **fixed** — rewritten, with a test that keeps it honest |
| F-54 | Low | `scrapers.js:132-140` | Page-label stripping is order-dependent: the trailing `Page. Select…` must be removed first for the `page N of M` rule to match at the end. A label shaped `<name>, page 2 of 5, Page.` would keep its whole suffix. **Not a live shape** — confirmed against the capture, so deliberately not "fixed" | open (documented) |
| F-13 | Medium | `exporter.js:544` | `runExport` contained the same ~35 lines twice (44% textual overlap between the two paths) | **fixed** — extracted `findContentFrame()` and `exportContent()`; 238 lines → 115 |
| F-16 | Medium | `exporter.js` | Re-runs duplicated assets instead of refreshing them | **fixed by decision** — overwrite by default, with a warning naming the folder and stating what will be overwritten |
| F-35 | Low | `downloadStrategies.js` | No per-strategy success statistics, so there was no way to tell whether the Direct strategy was earning its ~72s | **fixed** `1a5ab1b` — `utils/strategyStats.js` counts attempts and wins per strategy and the summary prints `wins/attempts`. (This was **wrongly** still listed in the "open" bundle for three releases' worth of edits; the per-strategy stats arrived with the F-32 fix.) |
| F-18, F-19, F-28 | Low/Info | various | Remaining polish: unused `content.title`, blank-line prefix when there is no date outline, table header assumption | open |
| **F-27** | Low/Info | `parser.js` | Image `alt` text was discarded, so an image embed with alt never round-tripped | **fixed** — the alt is carried through as Obsidian's alt syntax. A note full of images had been losing every caption, every description of what a picture shows, and every accessibility label the author had written, leaving the file on disk as the only trace. Two things came out of implementing it rather than just writing the line. A literal pipe in a caption is escaped, because the pipe is Obsidian's own delimiter and an unescaped one ends the embed early and leaves the rest as prose in the note — found by the test written for the line. And the images OneNote renders for a **printout** carry the printout's own title as their alt, so that title now appears on each printed page: it is what the DOM holds, so it is reproduced faithfully, and an attempt to suppress it on `data-is-printout` was **removed** because the one real printout page in the notebook carries no printout class at all, so no rule could be shown to distinguish it from a genuine caption. That limit is recorded here rather than guessed at |
| **F-43** | Low/Info | `diagnose-notebook.js`, `diagnose-notebook-newpage.js` | Both hand-rolled `process.argv` parsing while `commander` is already a dependency, and called `process.exit` inside the function doing the work | **fixed, and they stay in the package** — the packaging question was put and answered: these are the only tooling for working on the scrapers, and the F-42 arity bug lived in one of them, so shipping them is what makes a selector finding reproducible. Both parse with `commander` now, as `src/index.js` already did, so a flag given without its value is rejected instead of read as `undefined`, `--wait abc` is a usage error rather than a silent `NaN` the script then printed as `NaNs`, and `--help` works. The in-function `process.exit(1)` calls are thrown and caught at the bottom, which sets `process.exitCode` — so the browser cleanup above them always runs, the code after them is reachable, and a failure path can be exercised without killing the runner. Usage errors still exit 1, as before; what changed is the message and the strictness |
| **F-49** | Low/Info | `attachmentNames.js`, `exporter.js`, `parser.js` | Images were always written `.png` regardless of the real format, with no `content-type` check | **fixed** — the extension now follows the bytes. Live evidence of what this was: `attachment_pic-GIF_img_1.png` on disk, `file(1)` reporting `GIF image data, version 89a, 498 x 498`. An extension that lies is not cosmetic: a viewer, a converter or a search that trusts it has to sniff the file itself to find out. Magic bytes rather than the URL or the response header, because a OneNote image usually arrives through `getimage.ashx`, which names no format at all — the bytes are the only thing here that is actual evidence. Live: `attachment_pic-GIF_img_1.gif`, holding the same GIF, linked correctly from the note. The image rule in the parser uses a name that already carries an extension when given one, which is what F-24 had already forced the video rule to do; a bare id still defaults to `.png`, the only thing a caller that does not know the format can honestly say. An unrecognised image keeps its `.png` rather than being renamed to a guess |
| F-38 | Low | `logger.js:25-31`, `:297` | Timestamps omitted the year and timezone; `dumpSubDir` had minute granularity; the logger ran `ensureDirSync` as an import side effect | **fixed** — ISO date + UTC offset added, and now the second half: the dump directory is second-granular (`YYYY-MM-DD_HHhMMmSS`), because two exports started inside the same minute used to share one directory and the second run's HTML and screenshots overwrote the first's file by file — the opposite of what a dump is for, since a bug report naming a dump directory got whichever run happened to be last. The import side effect is gone too: `module.exports = new Logger()` ran the constructor at require time, and the constructor resolves the log directory, creates it, chmods an existing app.log and rotates it, so merely importing one of the seven modules that want a logger could throw on a read-only or full disk before `main()` could report anything. It is now a Proxy that constructs on first *use*, with `LoggerClass` and `LEVELS` answered without constructing anything |
| F-55 | High | `exporter.js:552,634` | One `Frame` object was pinned for the whole export, so a frame OneNote re-creates — or a tab/renderer that dies — ended the run at the next DOM call | **fixed** — `notebookFrame.js`: hold the page, resolve the frame per call, recover or report. *Found while chasing F-58; not its cause* |
| F-56 | **High** | `index.js:61` | A closed target makes Playwright reject an internal promise; Node killed the export with an unhandled rejection before the CLI's own handler ran | **fixed** — `parseAsync()` + an `unhandledRejection` handler; browser now closes, exit code is `1` |
| F-57 | Medium | `exporter.js:647` | The `.sectionList` wait reported every failure as "Timeout", including an instantly-failing dead target | **fixed** — only a `TimeoutError` is called a timeout; anything else names its cause |
| F-58 | **High** | `exporter.js:767,845` | `return exportContent(…)` inside `try { … } finally { browser.close() }` — the `finally` ran immediately, so the export closed its own browser before the first DOM call. Regression from `2807715` | **fixed** — `return await` in both paths, with the reason, an eslint-disable, and an ordering test |
| **F-69** | **High** | `scrapers.js:279`, `:470` | **Fixed.** An attachment OneNote drew *outside* every outline was invisible to the scraper, so the file was never downloaded, never linked, and never reported. `getPageContent()` builds the note body by cloning the `.OutlineContainer` elements into a detached div and then searches **that clone** for attachments (`:470`), so anything outside an outline could not be found by construction. OneNote sometimes draws an attachment as an absolutely positioned element that is a *sibling* of the outlines under the same `#PageContentContainer`. Live, on `attachment_PDF`: the note kept `PDF attached below` / `PDF attached above` with nothing between them, no file in `assets/`, and `Saved (0 assets)` — **no warning at all**, because "found no attachment" and "never looked where it was" are indistinguishable from outside | **fixed** — attachments outside every outline join the same visual-order pass as the outlines, so the file lands where the author put it rather than at the end of the note; live, `Saved (0 assets)` → `Saved (1 assets)`, 386 KB on disk, embed rendered between the two paragraphs that name its position. Deliberately narrow: the same page has a column wrapper and two resizers outside outlines, so "everything outside an outline" would inject page furniture. **High**, not Critical: the file is *missing* from the vault but not silently — it is one of the cases a user would report as an incomplete export, and every count the summary prints was correct, which is what made it invisible for a week. **A/B against the same dumps** proves the change is inert elsewhere: `printout_PDF`, `attachment_pic-GIF` and `Page2` produce byte-identical output before and after. **Different mechanism from F-60/F-63**, which asked which element *inside* a container carries the id; this one never reaches the search root |
| **F-72** | **High** | `scrapers.js:769`, `exporter.js:326` | **Fixed.** A pasted picture was silently absent from its note, and **two independent defects each had to occur** — fixing either alone would still have lost it. **(a)** The quiescence check read "nothing has changed" as "finished". `readCanvasState` counts images and images-with-a-source and says so in its own comment, but the caller never asked: it compared signatures and returned on the first pair that matched. A picture whose 1.9 MB base64 source had not begun decoding looks identical twice in a row. Measured over seven runs of one notebook: the source was present in four and absent in three, and the picture was exported in **none** of them. **(b)** The image loop walked `outlines` only, so a picture OneNote draws beside them was unreachable twice over — not collected, and with no clone in the note body its id would have had nowhere to land. On the page it came from, 7 of 25 images were inside an outline and the missing one was not; in two separate runs its base64 was in the DOM, fully decoded, while the export reported `Saved (0 assets)` | **fixed** — `.WACImageContainer` joins the same ordered pass F-69 built for `.WACEFContainer` (OneNote names its two out-of-outline containers alike, and F-69 adopted one of them), and a page is no longer settled while `images > imagesReady`. Live, same notebook: `Picture in` from `Saved (0 assets)` to `Saved (1 assets)`, a 4096×2864 PNG embedded between the two paragraphs that name its position, and **three** pictures recovered rather than one (assets 6 → 9 — `printout_PDF` gained two it had been dropping silently too). The settle rule is bounded by the deadline already there, so an image that never arrives costs the timeout rather than hanging, and nothing paid for it: **wall clock was identical, 3m46s before and after**. The selector was measured, not guessed — everything else living outside the outlines on a real page is OneNote's furniture (an upsell button, a colour block, a task-pane close button), so "any element outside an outline holding an image" would have exported those. **High, by F-51's precedent**, where silently-lost inline and printout images were rated High rather than Critical |
| **F-71** | **High** | `scrapers.js:762` | **Fixed.** A file attachment's chip was scraped twice: once correctly, as the attachment, and once as a page image — the chip's own icon, which is chrome rather than content. The icon clears every clause of the image filter (not a OneNote UI asset, not `one.png`/`box4x.png`, no `handle`/`one_` in its class, and at 16×16 well over the size floor), so each attachment page grew a phantom asset that OneNote serves as an object URL the request context cannot fetch (F-51). It never downloaded, so three of the notebook's four attachment pages ended every run with a permanent `> 1 asset could not be downloaded` callout naming a file that was never in the notebook — and whose own text, *"so a re-run can fill them in"*, no re-run ever could — while the summary reported `Assets failed: 3` | **fixed** — an image inside a `.WACEFContainer` is the chip's icon and is skipped; printouts stay exempt, since one is page content that happens to be wrapped. Live, same notebook: phantom download attempts 3 → **0**, false callouts 3 → **0**, and the `Assets failed` line no longer appears at all, with 24 pages and 6 real assets unchanged. Keyed on the **chip**, not on the URL scheme, because the icon is chrome however it is served — an `https` icon would download happily into `assets/` and still be worth nothing. **The part that made it invisible:** before the fix the icon was collected as an image and still produced **no embed**, so the note gained a link to a missing file and nothing else. Measured across the run, every object-URL image in the notebook was a chip icon and no genuine image was — so the exclusion could be made without guessing. The fixture carries a real image beside the chip, because "skip small images" and "skip object-URL images" both pass a test written only about the icon while dropping every picture on the page |
| **F-70** | **High** | `attachmentNames.js:37` | **Fixed.** Audio and video were missing from the attachment extension allowlist *entirely*, so every `.mp4` and `.mp3` lost its name. The files were still detected and downloaded — a file chip is recognised by its `WACEF*` class names, not by its extension — but the *name* has to pass this list to be believed, so both fell back to the placeholder: `assets/attached_file.bin` (an MP4) and `assets/attached_file_1.bin` (an MP3), on a page whose own text read `file attached name: Alerte-au-gogole_480p.mp4`. **Nothing warned, because the download succeeded.** The second file existed only as `_1`, so two different documents were told apart by a counter | **fixed** — audio and video added. Live, same notebook: `attached_file.bin` → `Alerte-au-gogole_480p.mp4`, `attached_file_1.bin` → `audio-cut-2min.mp3`, each note now linking the real name, no collision, and no `attached_file*` left anywhere in the vault. **High, not Critical:** no bytes are lost and the link resolves, so this is wrong output rather than data loss — but the note contradicts the file it points at, and two distinct documents are indistinguishable but for a suffix. **The lesson is the docstring's own, already written above the list** — "a missing extension means an attachment is treated as a hyperlink and silently not downloaded… the list errs towards recognition" — and it was not true: F-23 widened this list by `.docx/.xlsx/.pptx` for exactly this reason and audio was still never added. **One list decides three things** — whether something counts as a file, what it is called, and what the note links to — so a gap in it shows up in all three at once. Adding a type also makes a plain hyperlink to a file of that type count as an attachment rather than stay a link, which is the direction the list is meant to err in |
| **F-67** | Medium | `exporter.js:216`, `:265` | **Partly fixed.** A page with an **empty** title on the canvas was refused forever, so a genuinely untitled page was never exported at all. OneNote does not leave the title out for such a page — it renders one that is empty — so `titles` was `['']`, which fell through to the name comparison, was measured against `Untitled Page`, never matched, and the page was thrown away after one retry. Live, twice on one notebook: `The canvas is showing "" instead`, `Pages failed: 2`. The code already said this would happen: *"a page with no title outline at all is still a page that rendered, and refusing it would fail notes that used to export fine"* — the empty-title case simply took the branch below it | **partly fixed** — an empty canvas title is now read as *untitled* rather than as *a different page*, but only for a request whose own name is one of a known set of untitled labels, so a page the author **deliberately titled** "Untitled Page" is still verified by name like any other. **Still open as F-73**, found by the very run that verified this one: the same notebook holds an untitled page the author named "Another untitle page", and a name cannot distinguish an untitled page from a titled one. The broad alternative — accept any empty canvas title — is **not** taken: with an untitled page still on screen and a titled page requested, it settles one poll early and writes the previous page's content under the new name, which is silent rather than reported, and that is the trade every F-61 finding was about. Live: the untitled page exported (date only, which is all it holds), and the page immediately after it in the same section kept its picture |
| **F-73** | Medium | `exporter.js:222` | **Open.** F-67's limit: an untitled page whose name is not OneNote's untitled label is still refused, so it is still lost from the vault. Live on the notebook F-67 came from, which holds an untitled page the author named "Another untitle page": same `The canvas is showing "" instead`, same refusal, still counted as a failure. Nothing about the page is malformed — it rendered, with a date and whatever the author put on it | **open** — it needs a way to identify the rendered page that is *not* its name. The canvas markup does carry a per-page object id (`{guid}` on the outline's elements), measured as different per page and stable across runs, which would decide this exactly and retire the label list; that wants verifying against a live untitled page before anything relies on it. The alternative is **not recommended** for the reason given in F-67: it converts a reported failure into a possible silent wrong write |
| **F-75** | Low/Info | `downloadStrategies.js` | The popup a double-click opened was never closed when the download won the race | **fixed** — one double-click on an attachment makes OneNote do two things at once: start the download *and* open a viewer tab. The strategy raced a `download` event against a `popup` event, and every branch that used the popup closed it — but the download branch did not, and neither did the case where the popup arrived *after* the race was decided. The browser context is shared with the whole export, so every leaked tab kept rendering for the rest of the run, on a machine already running OneNote, a browser and a scraper; a notebook with forty attachments left forty tabs behind. **The register had this down as "the download popups leak on the error path", which understated it: the leak was on the *success* path.** A closer is now handed to the popup promise whenever the strategy is not going to use that popup — not awaited, since it resolves up to 30s later and the path must not sit waiting for a popup that may never come. Verified in a real browser by a fixture whose attachment element opens a viewer tab and starts a download on the same double-click, with the download winning the race; the new test fails against the pre-fix code |
| **F-74** | Low | `exporter.js:613` | **Fixed.** `processSections` took eight positional parameters and recursed with seven of them, in which two adjacent arguments are the same shape and one is the same object as the line above — a transposition at the call site would not fail, it would export something. The sharper half was `stats = newStats()`: a parameter default is evaluated once per *definition*, so every caller that omitted the argument shared one tally and the summary would have reported whichever call finished last. The last untriaged item touching the export hot path, and the last structural one | **fixed** — one `ctx` object destructured in the signature, with the recursion inheriting it and naming only what changes (`{ ...ctx, outputDir: groupDir, parentId: item.id }`), so a field added to the walk is added in one place and the recursion cannot forget it; `stats` and `processedItems` are created by the caller that starts a run. Behaviour-identical: a live export of a notebook with four nested groups, four levels deep, matched the run immediately before it page for page (23 pages, 8 assets, the same single failure). The recursion has **no end-to-end test** — the pipeline fixture has no group, and a static file cannot react to a group click — so it is covered by three structural assertions and by that live run, and a scripted fixture is the honest way to close that gap |
| **F-68** | Low | `exporter.js:799`, `utils/dumps.js` | **Open.** Dumps are named after the page, so two pages with the same name write one file: `debug_page_Duplicate Title.{html,png}` was written twice on a live run and the first page's pair was overwritten. The Markdown writer already avoids this with a `_1` suffix (`usedNames`, F-52); the dump name does not, so the diagnostic for a same-named page is the *last* one and its HTML and PNG stay consistent with each other while silently standing in for a page they are not | **open** — deliberately low and deliberately not fixed: it costs one diagnostic when two notes share a title, and every fix (a counter, an id, a timestamp) makes the dump name harder to match to the page name in a bug report, which is the reason the pairing exists |
| **F-66** | Low | `utils/dumps.js:98`, `notebookFrame.js:460` | **Fixed.** `--screenshot` wrote 30 HTML dumps and **2** PNGs on a real run. `ownerPageOf()` decided what it had been handed with `typeof target.screenshot === 'function'`, and every page and group dump is handed a `NotebookSession` — whose proxy answers **any** property name with a function, because it forwards unknown members to the live frame. The session was therefore classified as "already a Page", `screenshot()` was routed to the Frame behind it (which has none), `_call` returned `undefined` for the method it could not find, and `fs.writeFile` threw about a `data` argument — one warning per page, none of which said what was wrong. The two PNGs that did appear belonged to the two dumps whose targets were a real `Page` and a real `Frame`, which is exactly the pair the check could tell apart | **fixed** — ask `page()` first, which the session answers for real and a `Page` does not have at all, so the check cannot misfire; and `screenshotOf()` now requires image bytes back, so a future mis-resolution says what could not be screenshotted instead of blaming the disk. Live, same notebook: **30 dumps / 2 PNGs → 29 dumps / 29 PNGs**, 0 warnings (29 is the same run minus one repeat of a page name). **Low** because nothing about an export was wrong — no data lost, no wrong Markdown, and the flag is unreleased; what was lost is the debugging aid, on the runs where it is wanted. **What the tests missed:** they all passed a real `Page` or a real `Frame`, and both work perfectly — the exporter passes neither of those for a page dump |

Severity scale: **Critical** = silent data loss / false success / security ·
**High** = wrong output or hangs · **Medium** = maintainability, perf, portability ·
**Low** = polish.

### Fix ladder — as it was set, and as it landed

**Kept as written, because the order was the argument.** The ladder below is the one
this review set out with. Every rung shipped, in this order, which is the useful
record: the small correctness fixes came first, then data fidelity, then
observability, then structure. What is *not* in these rungs is the work that arrived
from the two real export runs (F-55 through F-65), which was more serious than
anything the ladder anticipated.

**P0 — correctness of the failure contract (small diffs)** — all shipped
F-01 (rethrow / return a result, map exit codes) · F-42 (fix the arity) · F-14 (fallback
name when `sanitize()` is empty) · F-12 (`--version` from `package.json`).
These four were tiny, independent, and each removed a way for the tool to lie or lose
data. F-01 turned out not to be one fix but two: F-65, its residual, was the same
defect one level down and shipped five releases later.

**P1 — data fidelity + the two silent-wrong-output bugs** — all shipped
F-24 (pass the real extension into the turndown rule) · F-25 (escape `|` in cells) ·
F-29 (specificity-ordered id matching) · F-20 (re-verify the notebook name before
clicking) · F-30 (normalise separators).

**P2 — observability and robustness** — all shipped
F-17 (failure counts + non-zero exit when items failed) · F-32 (per-attachment time
budget, and later the per-strategy stats) · F-36/F-37 (log level + log path) · F-22
(warn on a missing group container, and later say *which* kind of empty) · F-21
(honour `navigateBack` — **disproved and reverted**, which is why it is struck rather
than ticked) · F-48 (0600 dumps) · F-40 (validate `auth.json`, close browser on
failure).

**P3 — structure, dead code, docs, Docker** — shipped, except F-23, which is partial
F-23 (extract heuristics into a pure, testable module — **partly**: the extension list
and the name-preference order moved out and are tested; the DOM-bound heuristics cannot
without `eval`) · duplicated notebook-link flow (F-13) · F-15/F-16 (collision +
overwrite policy) · F-44/F-45/F-46 (Docker) · F-50 (README) · all Low/Info items —
**not all**; the tail is still open and is listed in §8a · `npm test` real tests + CI
workflow (53 tests at the time; **447** now).

**What the ladder got wrong.** It treated F-21 as a fix to make, and making it broke
the exporter. It also had no rung for the defects that a real export run exposes, which
turned out to be the expensive ones: F-55 through F-65 are all High or Medium, and
none of them was in this list. The lesson is written up below and belongs next to the
ladder that produced it.

### Deliberately not "fixing" without discussion

- **F-16 overwrite policy** and **F-33 locale** change user-visible behaviour, so they need
  a decision (and probably a new CLI flag) rather than a silent patch.
- **F-20** ideally moves to name-based lookup; the row-index scheme can stay as a fallback
  but must verify the name before clicking.
- Removing the duplicated `runExport` flow touches the export hot path and is best done
  with the fixture tests already in place (P3 after P2).
- **F-45 / F-01 interaction — resolved by the maintainer, 2026-09-28.** This review
  recommended that `entrypoint.sh` assert the export's exit status. The maintainer chose
  the opposite: the container must carry on and print "Export completed successfully!"
  even when the export failed, because that is the documented unattended path and callers
  collect whatever was written from a mounted volume. Aborting would discard a partial
  result and mark the container failed. So `entrypoint.sh` now captures the status rather
  than letting `set -e` abort, prints the failure on **stderr**, keeps the stdout
  completion line byte-identical for log scrapers, and exits `0`. The tool itself still
  exits `1`, so a direct CLI or CI run reports the truth; the tolerance is confined to the
  container wrapper. Pinned by `test/entrypoint.test.js`, which runs the real script with
  a stubbed `node` and fails against the pre-change behaviour (verified: that version
  exits `1` and prints nothing).

## 8. Definition of done

1. Every file in §6 has findings or an explicit clean note.
2. Every finding has `file:line` evidence — no speculation presented as fact.
3. P0 findings are either fixed on this branch or converted to linked issues.
4. A prioritised test backlog exists with a "write this first" recommendation.
5. README inaccuracies found during the review are listed (fix or document).
6. Residual risk that cannot be verified without live OneNote credentials is stated
   explicitly rather than assumed away.

## 8a. Session log

| Commit | What |
|--------|------|
| `87908fa` | Plan, decisions, dump index, `dumps/` ignore rules |
| `4e92a07` | ESLint flat config, `npm run lint`, green `npm test` baseline |
| `316294f` | Phase 2 findings, 50 of them, each with executed evidence |
| `4a5e4ce` | **F-01** exit codes, **F-14** `safeName` |
| `c35c3b5` | **F-42** `diagnose-notebook.js` arity + editor session |
| `98347e8` | **F-12** `--version` from `package.json` |
| `a306c9d` | **F-24/25/26/29/30/31/17/15** data fidelity, failure reporting, 53 tests, CI, lint cleanups |
| `99b6162` | Formatting tidy of the `no-else-return` autofix |
| `e2debbb` | Register status; **F-02 corrected** |
| `d878ceb` | **F-20** name verification, **F-21** `navigateBack`, **F-22** empty-group warning, unhandled-rejection guard |
| `4e8d065` | **Regression from `d878ceb` reverted** (F-21 was wrong), **F-51** blob URLs, **F-52** asset name reservation, **F-53** data: URL validation, CI installs Chromium |
| `b77417f` | **F-32 partly fixed** — permanent failures skip the retry backoff; `maxAttempts` deliberately unchanged |

**Release 0.3.1 — the review resumed after a pause.** One finding, because the rest
needed decisions rather than work.

| Commit | What |
|--------|------|
| `75192b8` | **F-33 partly** — pin `en-US`, and `Accept-Language` in `extraHTTPHeaders` as well because `locale` does not reach `context.request`. Verified against real Chromium: a `de-DE` context sends no language to the download client at all |
| `d0a5f4a` | Register: the §8a open list was naming nine fixed findings as open |
| `ab462ab` | `chore: release 0.3.1` |

**Release 0.3.5 — the four standing Mediums, one per PR.** Each got its own branch
and its own merge, so the diffs stayed reviewable and a mistake in one could not hide
inside another.

| Commit | What |
|--------|------|
| `985ac08` | **F-22** — `getSections` returns a reason; the warning names the remedy; a genuinely empty group is silent |
| `1a5ab1b` | **F-32** and **F-35** — per-strategy `wins/attempts` in the summary. Attempts counted on *entry*, which is the only way "entered 40 times, won 0" is visible |
| `36add33` | **F-02** — scraper diagnostics returned from the page and logged Node-side, levels preserved. The `FAILED to match real element` line predicts a download that cannot succeed and had been going to a browser console |
| `fb4816e` | **F-23 partly** — the 19-extension list defined once in a tested module, passed into the page as a regex source string; `.doc`/`.xls`/`.ppt` added |
| `4c1ec36` | `chore: release 0.3.5` |
| `d8f1c2a` | This reconciliation: two contradictory duplicate rows removed, F-35's status corrected, the ladder and the next-session list replaced with what actually remains |

**447 tests across 26 suites**, up from 382 when the review paused. Every one of the
four had at least one test verified to fail against the pre-fix code.

**F-33 — the language the tool asks Microsoft for (2026-09-29).** The Office Online
download menu is selected by UI text that exists in English and French only, and
Playwright's `locale` option "defaults to the system default locale", so the export
was sending the operator's OS language to Microsoft. Pinned `en-US`, and set
`Accept-Language` in `extraHTTPHeaders` as well — because, verified against real
Chromium rather than read out of the Playwright source, `locale` reaches the page but
**not** `context.request`, and `context.request` is what downloads every file:

```
de-DE context, unpinned:     page  Accept-Language = de-DE      context.request = (absent)
buildContextOptions():       page  Accept-Language = en-US      context.request = en-US,en;q=0.9
```

`navigator.language` is a browser-level property, so logging it needs no navigation
and costs nothing; the line is the answer to "0 selector matches" when an account
renders a non-English menu. The honest limit, and the reason this is *partly* fixed:
M365 takes the UI language from the signed-in profile, and Office Online additionally
from the `lc`/`mkt` parameters the SharePoint host appends to the WOPI URL. Nothing in
this codebase touches those, and forcing a header does not override an account setting.

**Standing as of 2026-09-29**, reconciled against `4c1ec36` (v0.3.5) by reading every
register row rather than by trusting the totals above — which is how the F-35 error
below was found.

**Two rows changed since, both from the 2026-10-03 run that found F-66:** the Medium row
is no longer "0 open" (F-67), and the Low/Info row gained F-68. Nothing else in this
table was re-read, so treat it as the 2026-09-29 reconciliation plus those two rows. The
counts at the top of §7 are recomputed by `test/reviewDoc.test.js` rather than by hand.

| Sev | State |
|-----|-------|
| Critical | **0 open.** F-01 fixed, and its residual F-65 with it. |
| High | **0 open.** All 18 fixed. F-20 was corrected down to Low when the live capture disproved its mechanism, and F-69 through F-72 are four more that a real run found rather than this review — four consecutive findings from one notebook, and the first four in a row that no test could have found. |
| Medium | **2 open.** 22 are fixed, or fixed with a limit that is argued rather than assumed: **F-33** (M365 takes its UI language from the account profile, and Office Online from the `lc`/`mkt` parameters SharePoint appends — nothing here overrides an account setting) and **F-23** (the DOM-bound heuristics cannot leave the browser callback without `eval` against a Microsoft login page; the fixture tests cover them in a real browser). The two open ones are **F-67**, partly fixed — an untitled page whose name is a known untitled label now exports, and the residual is **F-73**, an untitled page the author named something else, which a name cannot identify |

| Sev | Still open |
|-----|-------------|
| Low/Info | F-18 unused `content.title` · F-19 the `className` guard asymmetry (latent, unreachable today) · F-28 first-row-as-header assumption · **F-68** two same-named pages share one dump name, so the first pair is overwritten · F-54 order-dependent page-label stripping (documented, deliberately not fixed — not a live label shape) |
| Untriaged (§6, no ID) | `openNotebook` leaks the listing page · `linkResolver`'s case-folding vs a case-sensitive filesystem, and its second full read/write pass |

**Closed rather than fixed, and deliberately not counted as open.** F-21 was
recorded as a Medium, "fixing" it broke the exporter, and a real run disproved it —
so it is reverted, not pending. F-20 was a High until the live capture showed the
cross-table collision cannot occur, and was corrected down to Low with the name check
kept as defence-in-depth. Both are the register working, not two more items of work.

### Lesson worth keeping (from F-21)

F-21 was a Medium finding I was confident about, and "fixing" it broke the exporter. The
claim — "a failed back-navigation leaves the frame in the wrong tree" — was plausible and
unverified. The same review had already established the rule it violated: *no speculation
presented as fact*. Coding reading can tell you a return value is ignored; it cannot tell
you the ignored value is load-bearing. One real run answered that in a minute.

So: findings that assert a *runtime consequence* rather than a *code defect* need
execution evidence before any behaviour changes. The distinguishing question is "can I
demonstrate this input, and what happens?" — for F-21 the honest answer was "I don't know
what happens", and the fix should have been a log line, not a throw.

### Next session, in priority order

**The first three items shipped** — `processSections` (F-74), the F-38 residual and F-43.
The list is replaced rather than accumulated, because "what this review still owes" is the
only useful version of this section, and the previous list scheduled F-44/F-45/F-46,
F-36/F-37, F-32, F-23 and F-40/F-48 — all shipped.

1. **F-73 — an untitled page named something else is still refused.** The open half of
   F-67. The canvas markup carries a per-page object id that would decide it exactly and
   retire the label list; that needs verifying against a live untitled page first. The
   alternative — accept any empty canvas title — converts a reported failure into a
   possible silent wrong write, and is **not** recommended.
2. **F-49 / F-27 — asset fidelity.** Images are always written `.png` regardless of the
   real format, and image `alt` text is discarded, so `![[assets/x.png|alt]]` would
   round-trip. Both change output, and the decision is taken: the extension follows the
   real format. The PR is marked for review rather than merged, because every image
   filename changes.
3. **F-18 / F-28 / F-54 — the remaining parser and scraper polish**, plus
   `openNotebook`'s leaked listing page. All Low. The listing page is left alone
   deliberately: closing the window OneNote opened the editor from could plausibly break
   the editor through `window.opener`, and that is a runtime consequence rather than a
   code defect — F-21's rule says measure before changing behaviour. It wants a live
   run that watches what the editor does when its opener goes away.
4. **`linkResolver`'s case-folding and second full read/write pass.** The correctness half
   is done; this is the cost half, and it wants a measurement on a real notebook rather
   than a guess about which of the two matters.
5. **F-68 — two same-named pages share one dump name**, so the first pair is overwritten.
   Deliberately narrow: the PNG is named after its HTML so a bug report naming one finds
   the other, and every fix here makes that harder.
6. **F-19 — the `className` guard asymmetry**, recorded as latent and unreachable today.
   Listed so it is not mistaken for done; it is not worth a change on its own.
   `ensureDirSync` at require time, so merely importing any module can throw on a
   read-only filesystem. One line of laziness, and the only remaining import-side-effect
   in the codebase. `dumpSubDir`'s minute granularity is cosmetic next to it.
3. **F-43 — the `diagnose-*` scripts.** They hand-roll `process.argv` parsing while
   `commander` is already a dependency, and call `process.exit` inside functions. They
   also ship in the tarball via `files: ["src/"]`, which is a packaging question worth
   deciding rather than a code one.
4. **F-49 / F-27 — asset fidelity.** Images are always written `.png` regardless of the
   real format, and image `alt` text is discarded, so `![[assets/x.png|alt]]` would
   round-trip. Both are small, both change output, both want a decision about whether
   the extension should follow the actual content type.
5. **F-18 / F-28 / F-54 — the remaining parser and scraper polish**, plus
   `openNotebook`'s leaked listing page and the download popups that leak on the error
   path. All Low. All want a browser run to confirm against the live UI.
6. **`linkResolver`'s case-folding and second full read/write pass.** The correctness
   half is done; this is the cost half, and it wants a measurement on a real notebook
   rather than a guess about which of the two matters.

**Deliberately not scheduled.** F-33's residual and F-23's residual both need a
decision rather than a patch: one is a per-account language setting the tool cannot
override, the other needs `eval` in a Microsoft login page. Neither improves by being
attempted again. See the standing table above.

## 9. Open questions

Resolved on 2026-09-27 — see §0. Both of the original two are now answered:

1. ~~**P0 fix boundaries.**~~ **Answered.** F-01 shipped as exit `1`, F-65 added exit
   `3`, and 0.3.0's CHANGELOG states the bump reasoning up front so anyone keying on
   `== 0` sees why. The Docker service was the one dependant and it is covered by
   F-45's maintainer decision: the container wrapper tolerates a failure and says so on
   stderr, pinned by `test/entrypoint.test.js`.
2. ~~**Scope of the internal refactors.**~~ **Answered.** The duplicated `runExport`
   flow is gone (F-13, `2807715`) and asset naming was extracted rather than deferred.
   Both landed before the fixture tests existed, which is the outcome the review
   recommended and the one that needed the most care.

**New, opened 2026-09-29.** None of these block anything; they are the decisions a
maintainer should make rather than an agent:

1. **The published version sequence has holes.** 0.3.1 is followed by 0.3.5; 0.3.2,
   0.3.3 and 0.3.4 were never published. The numbering was tied one-to-one to this
   register's open findings, which reads well here and badly on the npm registry. The
   0.3.5 CHANGELOG says so, which is mitigation rather than a fix.
2. **`files: ["src/"]` ships both `diagnose-*` scripts.** They are developer tooling
   that the README points at for "find the right selectors", so shipping them is
   arguably right — but they are 336 lines of hand-rolled CLI in the package, and the
   F-42 arity bug lived in one of them until this review found it.
