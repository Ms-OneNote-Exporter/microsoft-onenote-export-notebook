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
- F-21 (Medium) — `navigateBack` returns `false` when no back button is found
  (`scrapers.js:586-604`) and `processSections` ignores the return value
  (`exporter.js:122`), so a failed "back" leaves the frame inside the group and the
  traversal silently continues against the wrong tree.

**`scrapers.js`**
- F-02 (Medium) — unused `logger` import is the root cause of 4 `console.*` calls; scraper
  diagnostics never reach `logs/app.log`.
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

- **Exit criteria met:** every module in §6 has findings or an explicit clean note.

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

## 7. Findings register

**50 findings: 1 Critical, 8 High, 24 Medium, 17 Low/Info.** Full evidence for each is in
the Phase 2 section above; this table is the index and the fix ladder.

| ID | Sev | Area | One-line summary |
|----|-----|------|------------------|
| F-01 | **Critical** | `exporter.js:539` | Failed export exits 0 — `runExport` swallows every error, disabling all failure detection |
| F-20 | High | `navigator.js:147,226` | Notebook identity is a row index; the click never re-verifies the name ⇒ wrong notebook can be exported |
| F-24 | High | `parser.js:72` | Video wikilinks hardcode `.mp4` while files are written with the URL's real extension |
| F-25 | High | `parser.js:113` | Unescaped `|` in table cells silently adds phantom columns |
| F-29 | High | `linkResolver.js:19` | Substring id matching with no specificity ordering ⇒ links resolve to the **wrong page** |
| F-44 | High | `Dockerfile:8` | Image `git clone`s `main` from GitHub; local code is never in the image |
| F-42 | High | `diagnose-notebook.js:66` | Diagnostic script calls a 4-param function with 3 args ⇒ guaranteed TypeError |
| F-14 | High | `exporter.js:99,152,169` | `sanitize()` returning `''` collapses a section into its parent directory |
| F-21 | Medium | `exporter.js:122` | `navigateBack` failure ignored ⇒ traversal continues against the wrong tree |
| F-32 | Medium | `downloadStrategies.js:333` | Up to 9 strategy chains per attachment ⇒ ~7 min for one dead link |
| F-33 | Medium | `downloadStrategies.js:88` | Office Online automation is EN/FR only, with no `Accept-Language` set |
| F-36 | Medium | `logger.js:139` | No log-level gating: `debug` always prints and the log grows unbounded |
| F-37 | Medium | `logger.js:8` | Log path lands inside `node_modules` for the documented global install |
| F-40 | Medium | `auth-context.js:16` | No `storageState` validation; leaked browser if context creation fails |
| F-47 | Medium | `exporter.js:31` | Authenticated GET to a host chosen by page content |
| F-48 | Medium | `logger.js:38` | `--dodump` writes authenticated DOM at 0644 |
| F-15 | Medium | `exporter.js:169` | Sections with equal sanitised names share one directory |
| F-16 | Medium | `exporter.js:247` | Re-runs duplicate assets (`name_1`, `name_2`, …) instead of refreshing |
| F-17 | Medium | `exporter.js:87,340` | No failure accounting: partial exports look clean |
| F-22 | Medium | `scrapers.js:52` | Missing group container returns `[]`; a whole subtree vanishes at default log level |
| F-23 | Medium | `scrapers.js:302` | 20+ untestable inline heuristics; extension regex duplicated 3× |
| F-26 | Medium | `parser.js:41` | Text-less internal links become `[[]]` → `[[path|]]` |
| F-30 | Medium | `linkResolver.js:81` | Windows `\` separators break Obsidian wikilinks |
| F-02 | Medium | `scrapers.js:1` | Unused `logger` import ⇒ 4 `console.*` calls bypass `logs/app.log` |
| F-45 | Medium | `entrypoint.sh:33` | Prints "completed successfully" unconditionally |
| F-46 | Medium | `start-container.sh:35` | Container-name mismatch, hardcoded paths, foreground run called "detached" |
| F-12…F-13, F-18, F-19, F-27, F-28, F-31, F-34, F-35, F-38, F-39, F-41, F-43, F-49, F-50 | Low/Info | various | Polish, dead code, doc drift, latent fragility — see Phase 2 |

Severity scale: **Critical** = silent data loss / false success / security ·
**High** = wrong output or hangs · **Medium** = maintainability, perf, portability ·
**Low** = polish.

### Fix ladder

**P0 — correctness of the failure contract (do first, small diffs)**
F-01 (rethrow / return a result, map exit codes) · F-42 (fix the arity) · F-14 (fallback
name when `sanitize()` is empty) · F-12 (`--version` from `package.json`).
These four are tiny, independent, and each removes a way for the tool to lie or lose data.

**P1 — data fidelity + the two silent-wrong-output bugs**
F-24 (pass the real extension into the turndown rule) · F-25 (escape `|` in cells) ·
F-29 (specificity-ordered id matching) · F-20 (re-verify the notebook name before clicking)
· F-30 (normalise separators).

**P2 — observability and robustness**
F-17 (failure counts + non-zero exit when items failed) · F-32 (per-attachment time budget) ·
F-36/F-37 (log level + log path) · F-22 (warn on a missing group container) · F-21 (honour
`navigateBack`) · F-48 (0600 dumps) · F-40 (validate `auth.json`, close browser on failure).

**P3 — structure, dead code, docs, Docker**
F-23 (extract heuristics into a pure, testable module) · duplicated notebook-link flow ·
F-15/F-16 (collision + overwrite policy) · F-44/F-45/F-46 (Docker) · F-50 (README) ·
all Low/Info items · `npm test` real tests + CI workflow.

### Deliberately not "fixing" without discussion

- **F-16 overwrite policy** and **F-33 locale** change user-visible behaviour, so they need
  a decision (and probably a new CLI flag) rather than a silent patch.
- **F-20** ideally moves to name-based lookup; the row-index scheme can stay as a fallback
  but must verify the name before clicking.
- Removing the duplicated `runExport` flow touches the export hot path and is best done
  with the fixture tests already in place (P3 after P2).

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
