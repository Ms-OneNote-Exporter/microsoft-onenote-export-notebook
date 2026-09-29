# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **An empty section group now says which kind of empty it was.** The warning that
  fires when a group yields no sections used to read "No items found inside group X.
  If this group is not really empty, its sections were skipped" — a guess, in the
  one message that is the entire record of a subtree going missing. There are three
  different situations behind an empty result and they call for different responses:

  | Reason | What happened | What to do |
  |--------|----------------|------------|
  | `no-parent` | the id is not in the DOM; OneNote re-rendered | re-run; file a dump if it repeats |
  | `no-container` | the row is there, its contents are not | re-run — it had not finished expanding |
  | `empty` | a group with no sections, which is legal in OneNote | nothing |

  The third now logs nothing at all. It was the common case in a healthy notebook,
  and warning about it trained people to ignore the warnings that matter.

## [0.3.1] - 2026-09-29

A **patch**, not a minor: this removes a dependence on the machine the export runs
on, and adds nothing new for anyone already exporting from an English-language
machine. No CLI contract, exit code or output format changes.

### Fixed

- **The export no longer depends on the operator's operating-system language.**
  The Office Online "Download a Copy" menu is found by UI text that exists in
  English and French only, and Playwright's `locale` option defaults to the system
  locale — so the same tool could work on one machine and fail on another, with
  nothing in the log to say why. The browser context now requests `en-US`.

  The language has to be set in two places, which is not obvious and was verified
  against a real browser rather than assumed:

  | Client | `locale: 'en-US'` | `Accept-Language` in `extraHTTPHeaders` |
  |--------|--------------------|----------------------------------------|
  | page requests (the selectors) | yes | yes |
  | `context.request` (the file downloads) | **no** | yes |

  `context.request` is what downloads every attachment, image and video, and
  Playwright's `BrowserContextAPIRequestContext` copies `userAgent`,
  `extraHTTPHeaders`, `proxy` and `baseURL` into its defaults but **not** `locale`
  — so a `locale` on its own would have left every download going out with no
  language at all while the pages were English.

  Each run now also logs the language the page actually came up in, which is the
  answer when a download-menu selector finds nothing:

  ```
  Browser language: navigator.language=en-US, Intl=en-US (requested en-US).
  ```

  The limit worth knowing: Microsoft for the web takes its display language from
  the signed-in profile, and Office Online additionally from the `lc`/`mkt`
  parameters SharePoint appends to the WOPI URL. An account whose language is not
  English can still render a non-English menu — the log line above is how you find
  out. Setting `--lang`-style flags or relying on the machine's language will not
  change that; it is a per-account setting.

## [0.3.0] - 2026-09-29

A **minor** bump, not a patch, because of one entry below: a run that completes
with pages missing now exits `3`, which is new observable behaviour. Anything
keying on `== 0` will start reporting failure, and that is the intended effect
rather than a defect — but it is not a change a patch release should carry
quietly.

Everything here was found by exporting a real notebook and comparing the result
against a known-good run, then comparing runs against each other.

### Added

- **Exit code `3`: the export completed, but some pages, sections or groups are
  missing.** F-01 fixed the case where `runExport` swallowed every error and a
  failed export exited `0`. This is the same defect one level down, and it was not
  hypothetical — a verification run in the course of fixing F-62 lost eight pages,
  printed

  ```
  Export finished with errors - 8 item(s) could not be exported.
  ```

  and exited `0`. The summary was truthful and nothing acted on it, so a CI job
  could go green over a vault with holes in it.

  `3` is deliberately not `1`. `1` means the export blew up and nothing usable
  came out, which is worth retrying from scratch; `3` means most of it is fine and
  some items are absent, where retrying would throw away a mostly-good vault. A
  script that only checks "is it non-zero" keeps working either way.

  A run whose tab died still exits `1` — that is an unknown fraction of the
  notebook rather than a known partial one, and the distinction is worth keeping.

### Fixed

- **The summary no longer passes over assets that failed to download.**
  `Total Assets: 12` next to a page whose notice lists two missing files reads as a
  complete export. The total now carries the count, and the failure is named:

  ```
    Assets   failed: 2 (linked, but not downloaded - see the note)
  Total Assets: 12 (2 could not be downloaded)
  ```

  Failed assets do **not** make the run non-zero, and that is a considered choice
  rather than an omission. Downloads fail routinely — three strategies, a 30s cap,
  an Office Online round trip — so a code set on nearly every real run would stop
  being read. The page carrying the link also carries a notice naming the file that
  is not there (F-64 below), which is where someone looking for a missing
  attachment will actually look.

- **A failed download now says so in the note, not only in the log** (F-64).
  A link to a file that was never written renders as an empty embed, so the page
  looked complete and was not. The only trace was an `ERROR` line in
  `logs/app.log`.

  The link itself is still kept, which was already a deliberate decision: it
  costs a re-run rather than correctness, and the link is what the re-run fills
  in. What was missing is the other half of that trade, so the page now ends with
  a notice naming what is not on disk:

  ```markdown
  > ⚠️ **2 assets could not be downloaded.**
  >
  > The links below point at files that are not on disk. They are left in
  > place on purpose, so a re-run can fill them in.
  > - `assets/report.pdf`
  > - `assets/Page_img_3.png`
  ```

  The notice is rebuilt on every run, so it disappears by itself once a re-run
  succeeds and there is no stale marker to clean up. It counts distinct files
  rather than references, because the same file attached and hyperlinked on one
  page is one missing file.

  Covers all three asset types. Images, attachments and videos all rewrote their
  link to the final file name *before* attempting the download, so a failure left
  a dead embed for any of them — that was the eight broken links a baseline run
  produced, and the one that survived the F-61/F-63 work.

## [0.2.2] - 2026-09-29
Four fixes with one theme: **the export was writing wrong or missing data and
reporting success.** Every one was found by running the export against a real
notebook and comparing the result against a known-good run rather than by
reading the code.

| | Finding | Symptom |
|---|---|---|
| F-60 | One file attachment scraped once per part of itself | `report.pdf` *and* `report_1.pdf` |
| F-61 | A page that had not rendered was written as a note | a 15-byte file reading `Page Contents` |
| F-62 | A group that had not expanded was read as "empty" | 8 pages lost, `Export complete!`, exit 0 |
| F-63 | The F-60 dedup dropped the attachment's link | files on disk, referenced by zero notes |

Measured on the real notebook, before → after:

| | before | after |
|---|---|---|
| pages exported | 11 | **19** |
| links pointing at files never written | 8 | **1** |
| duplicate `…_1` downloads | 5 | **0** |
| internal links resolved | 0 of 3 | **3 of 3** |

### Fixed

- **A section group that had not expanded no longer costs you its whole
  subtree, silently** (F-62). A real run entered a group, found nothing in it,
  logged a warning, and finished reporting `Export complete!` with exit 0 — eight
  pages of the notebook simply absent.

  Two separate faults, both found while verifying the fix below:

  1. **A group that yields nothing was read as an empty group.** The exporter
     warned, but the warning changed nothing anyone downstream could see, so a
     whole subtree could vanish behind a successful-looking run.
  2. **Selecting a group is a toggle, not an action.** Measured on the real
     notebook:

     ```
     fresh page load       aria-expanded=false  items=0
     after selectSection   aria-expanded=true   items=2
     after selectSection   aria-expanded=false  items=0   <- collapsed again
     ```

     A retry that clicks without asking therefore *closes* the group it just
     opened. OneNote publishes the state on the row, so the exporter now reads
     `aria-expanded` and clicks only while the group is actually collapsed.

  The export now waits for the group's children to be readable rather than
  sleeping five seconds, re-clicks only if the row still says collapsed, and
  **fails the group by name** — counted in the summary, non-zero exit — if the
  children never appear. A missing group is visible; a silently empty one is not.

- **A page that had not rendered is no longer written as a two-word note** (F-61).
  One page of a real notebook exported as fifteen bytes:

  ```
  $ od -c "Section S1/Section1-Note1.1_PDFs.md"
  0000000  \n  \n   P   a   g   e       C   o   n   t   e   n   t   s
  ```

  That page holds a full-page printout image and two attachments. Nothing about
  the file says it is wrong — it has a name, a size, and no error anywhere: the
  run logged `Saved (0 assets)` and finished declaring success. In Obsidian it
  read simply as "Page Contents".

  The cause was a fixed three-second sleep between selecting a page and scraping
  it. OneNote tears the old page's content down before building the new one, so
  the canvas is briefly empty, and a heavy page can still be mid-render when the
  sleep ends. The scraper then found no content outlines, fell back to
  `div[role="main"]` — an ARIA landmark whose only remaining text is its own
  accessible name — and wrote that as the page. Two runs of the same notebook
  eleven hours apart produced opposite results for the same page, which is what
  identifies it as a race rather than a page that cannot be read.

  The sleep is replaced by waiting for the requested page to actually be on the
  canvas, and — because the sleep was load-bearing in a way that is easy to
  miss — it is worth recording what the obvious replacements get wrong. Both of
  these were shipped by an earlier attempt at this fix and measured on the real
  notebook before being caught:

  - **Waiting for *any* content to be present** returns immediately, because
    OneNote does not clear the canvas when you click a page: the outgoing page's
    outlines are still there. That gave 16 of 19 pages the previous page's text,
    and the run reported success.
  - **Waiting for the right *title*** is nearly as bad. OneNote clones whichever
    page is on screen while it transitions, so the title is already correct while
    the content is doubled:

    ```
    [previous] -> [previous + previous] -> [] -> [wanted + wanted] -> [wanted]
    ```

    A scrape taken at `[wanted + wanted]` writes the page **twice** into one note.

  So the export now waits for a canvas that has the requested title, holds
  exactly one copy of it, and has stopped changing — the last part because
  OneNote fills in image sources *after* the outlines settle, one polling step
  later, and scraping in that gap exports a page with its picture silently
  missing.

  If the page still has not settled, it is selected a second time — which
  restarts the transition and reliably recovers the transient case — and if it
  still has not, the page is **failed by name with nothing written at all**, and
  the failure says what the canvas was actually showing. A missing note is
  visible; a plausible-looking empty one, or one holding the wrong page's text, is
  not.

  The same check is applied to the scrape itself, because a frame can be replaced
  between waiting for the content and reading it.

  Verified on the real notebook: 19 pages, 12 assets, 3 internal links resolved
  and 0 unresolved, with 14 of 19 notes byte-identical to a known-good earlier
  run. The two-word page is now 35 words of real content. The section group that
  used to lose eight pages also came back — its failure turned out to be a
  symptom of the same desynchronised canvas.

- **A file attachment is no longer downloaded once per part of itself** (F-60).
  OneNote does not draw a file attachment as a link. It draws a container holding
  an overlay, an icon and a filename label:

  ```
  div.WACEFContainer[role=link][aria-label="report.pdf"]
    span.WACEFOverlay[title="report.pdf"]     <- the click target
    img.WACEFImage[title="report.pdf"]
    div.WACEFFilename[title="report.pdf"]    <- the label
  ```

  More than one of those parts matched the attachment pattern, so a single PDF
  became two or three download attempts and landed on disk as `file.pdf` and
  `file_1.pdf`. The duplicate was also the harmful one: the click marker is
  placed by matching on title, so it landed on the *other* candidate and the
  first was logged as `Could not find clickable element` on every page it
  appeared on, and could never be fetched at all.

  A candidate whose ancestor names the same file is now treated as a part of that
  file rather than a file of its own. The test is deliberately narrow — the
  ancestor must name *this* candidate's file — so two different files with
  identical markup still both export, a titled element with no container around
  it is untouched, and a hyperlink the author added on purpose survives as its
  own attachment. On the live page this went from 3 attempts to 2, the two being
  the two references the note actually makes, and the entry that had no marker at
  all now has one.

  Deduplicating to one attachment per file had a consequence that no count showed:
  **the file downloaded and the note stopped linking to it.** OneNote's click
  overlay is an *empty* element and the first candidate in document order, so the
  dedup kept it — and the id that becomes the Obsidian embed was stamped there.
  Turndown answers a blank node from its built-in blank rule and never consults
  custom rules at all:

  ```js
  Rules.prototype.forNode = function (node) {
    if (node.isBlank) return this.blankRule
  }
  ```

  So no embed was produced, silently. In a real export,
  `Complete_Paris_9th_Arrondissement_Guide.docx` and `attached_file.bin` sat in
  `assets/` referenced by **zero** notes, and the notes showed the filename as
  plain text.

  Before the dedup this worked by accident: the overlay was scraped first and the
  visible label second, so it was the *second* candidate's id that produced the
  embed. The two attributes do different jobs — `data-local-file` renders the link
  in the note, `data-one-attach-id` marks the element to click to download it —
  and the dedup conflated them. The id now goes on the element that shows the
  file's name; the click marker still goes on the overlay.

  Verified on the real notebook: 12 assets on disk, **none orphaned**, and the
  duplicate `_1` downloads are gone. Links in the output pointing at files that
  were never written fell from **8 to 1**, and the one that remains is a separate
  pre-existing fault, described below.

  Two references to one document are still exported twice, on purpose: the note
  says it twice, so the Markdown says it twice. Collapsing that would lose a
  reference the author made.

## [0.2.1] - 2026-09-28

An export had not completed since 12:17 on 2026-09-28. Every run since reached
the same line and died a second later — with the browser window open on screen,
showing the notebook, fully rendered:

```
[SUCCESS] Found content frame (navigation): https://…/onenoteframe.aspx?…
[INFO]    Scanning sections...
[WARN]    Timeout waiting for .sectionList, trying to scrape anyway...
frame.evaluate: Target page, context or browser has been closed
    at getSections (src/scrapers.js:15:18)
```

`Target page, context or browser has been closed`, raised against a tab that was
sitting there working, is the tell: the target was not dying, the tool was
closing it.

Patch rather than minor — the CLI, its options and the exit codes are all
unchanged. This restores behaviour 0.2.0 shipped working. Verified end to end
against a real notebook: 19 pages, 12 assets, 3 internal links resolved, 0
unresolved, exit 0.

### Fixed

- **The export no longer closes its own browser before it starts** (F-58).
  `runExport` ends with a `finally` that closes the browser. Returning a
  *promise* from inside a `try` that has a `finally` does not wait for it — the
  `finally` runs the instant the return expression is evaluated:

  ```js
  try { return doTheWork(); }       finally { await browser.close(); }  // close() runs FIRST
  try { return await doTheWork(); } finally { await browser.close(); }  // close() runs after
  ```

  `runExport` ended with `return exportContent({ … })`, so every export killed
  the browser it was about to use, and the race decided whether the run got one
  section in first. That is the whole of this failure, six runs in a row on
  2026-09-28:

  ```
  [SUCCESS] Found content frame (navigation): https://…/onenoteframe.aspx?…
  [INFO]    Scanning sections...
  [WARN]    Timeout waiting for .sectionList, trying to scrape anyway...
  frame.evaluate: Target page, context or browser has been closed
      at getSections (src/scrapers.js:15:18)
  ```

  `Target page, context or browser has been closed` from a tab that was sitting
  there fully rendered, on screen, is the tell: the target was not dying, the
  tool was closing it. The last good export of the same notebook was at 12:17;
  the regression arrived with `2807715` (13:34), which collapsed the two export
  paths into the shared `exportContent` helper and turned a `return stats` — a
  value, so the `finally` ran at the right time — into a `return` of a promise.
  Both paths now `return await`, with a comment and a test. The `await` is
  invisible to the type system and to this project's linter — `no-return-await`
  deliberately exempts `return await` inside a `try`/`finally`, because there it
  is required — so the regression test is what holds the line.
- **A failing export is reported instead of crashing the process** (F-56).
  Closing the browser out from under Playwright also rejects one of Playwright's
  own internal promises, which nothing awaited, so Node killed the export with an
  *unhandled promise rejection* before the CLI's handler could run: no
  `Export failed`, no summary, and an exit status unrelated to the export.
  `index.js` now awaits the command's promise (`parseAsync`, not `parse`) and
  reports a stray rejection like any other failure. Exit codes are unchanged:
  `1` for a failed export.
- **A notebook frame that OneNote replaces no longer kills the export**
  (F-55). Not the cause of the above, but a real defect found while chasing it:
  the exporter looked the notebook frame up once and then used that single
  Playwright `Frame` object for the whole run, and a frame is not a durable
  handle. OneNote re-creates its `onenoteframe.aspx` frame when the editor page
  reloads, and the tab, its renderer or the browser can go away at any moment.
  The export now holds the page and resolves the frame on demand: a replaced
  frame is found again and the section walk continues, and a tab that is really
  gone ends the run with a stated cause and an instruction instead of a
  Playwright stack trace.
- **"Timeout waiting for .sectionList" is only said when it really timed out**
  (F-57). The wait reported *every* failure as a timeout, so a dead target
  looked like a slow DOM — and the genuine 15s timeouts, which do
  happen, became indistinguishable from it. The message now names the actual
  cause.

### Known issues — unchanged, but an export now reaches them

With the browser no longer being closed underneath it, the export runs to
completion for the first time since 12:17, and is now visibly slow on notebooks
with attachments. One pre-existing defect there is confirmed against the live
DOM (F-60): a single file attachment is scraped two or three times, because both
`div.WACEFContainer[role="link"]` and the `span.WACEFOverlay` inside it match the
attachment pattern, so the same PDF is downloaded repeatedly and written out as
`file.pdf`, `file_1.pdf`, ... Per-attachment wall clock is now capped (see F-32
above), so the wasted time is bounded, but the duplicate work is still done.

Attachments that cannot be fetched are still reported per file and the page is
still written, so this costs time and a few near-duplicate files rather than
correctness.

## [0.2.0] - 2026-09-28

A code-quality review of the whole tool (see `REVIEW-CODE.md`) found 53 issues.
This release fixes the ones that caused wrong output, silent data loss, or a
misleading exit status, and adds the tooling to stop them coming back.

### Behaviour changes — please read before upgrading

- **A failed export now exits non-zero.** `runExport` used to catch every error
  and only log it, so `index.js` never reached `process.exit(1)` and the process
  exited `0` even when nothing was exported. Exit codes are now: `0` success,
  `1` export failure, `2` usage error (`--non-interactive` without a notebook).

  **Scope: the CLI, not the container.** `entrypoint.sh` deliberately still
  tolerates a failed export: it captures the status instead of letting `set -e`
  abort, reports it on **stderr**, prints `Export completed successfully!` as
  before, and exits `0`. A direct CLI or CI invocation still sees the truth. This
  keeps the unattended container path behaving as it always has for pipelines
  that mount a volume, run the export, and collect whatever was written — a
  partial export is kept rather than discarded, and the container is not marked
  failed.
- **A partially-failed export is no longer reported as a clean run.** Failures
  are counted per category and summarised at the end. The run still completes
  and still writes what it could; only the messaging changed.
- **`onenote-export-nb --version` reports the real package version** (0.2.0)
  instead of a hardcoded `1.0.0`.
- **Video attachments now link correctly.** The Markdown rule hardcoded `.mp4`
  while files were written with the extension taken from the video URL, so every
  non-mp4 video exported a dead embed. The exporter now stamps the final file
  name.
- **A `blob:` image URL is now downloaded instead of being silently dropped.**
  A blob URL only resolves inside the page that created it, and Playwright's
  request context speaks http/https only, so every inline and printout image
  failed with `Protocol "blob:" not supported` and was lost while the page still
  reported success. Such images are now read through the page.

### Fixed

- **The Docker image contained the wrong code.** It ran `git clone … /app`, so the
  image held whatever was on `main` at build time and never the local working tree:
  a local fix could not be container-tested, and the image silently disagreed with
  the checkout. It now `COPY`s the source, installs with `npm ci`, pins the base
  image to a patch release, and drops to an unprivileged `node` user.
  `start-container.sh` no longer points at a hardcoded sibling checkout, creates
  the container detached as it always claimed to, and prints a `docker exec` hint
  naming the container it actually created (it used to name a different one, so the
  copy-pasted command could not work). It passes `--init` and `--shm-size=1g` for
  Chromium. A `.dockerignore` keeps `auth.json` and local state out of the image.
- Internal links could resolve to **the wrong page**: the target was picked by
  first-match substring search over all known ids, so an id that merely appeared
  somewhere in an href could win. Matching is now scored, and ids too short to
  be a OneNote identity are rejected.
- A `|` inside a table cell was emitted unescaped, silently adding a phantom
  column and shifting every cell after it.
- Wikilinks contained `\` separators on Windows, breaking them in Obsidian.
  Paths are now normalised to forward slashes.
- A link with no text became `[[]]` and then `[[path|]]`; it now falls back to
  the href and omits the empty alias.
- Opening a notebook no longer risks **exporting the wrong notebook**: the row
  index used to identify it was never re-checked against the name, so a
  re-sorted list could silently open a different one. The name is now verified
  before clicking, and a mismatch aborts with an actionable message.
- A section whose title sanitised to an empty string (`"..."`, `".."`, `"CON"`,
  all-whitespace) was written into its **parent** directory, interleaving with
  sibling sections. Such names now get a fallback.
- Two sections whose titles sanitise to the same string no longer share a
  directory.
- Two attachments with the same name in one page no longer overwrite each other:
  asset names are reserved when planned rather than probed from the filesystem.
- `src/diagnose-notebook.js` could never run — it called `openNotebook` with 3
  arguments against a 4-parameter signature, throwing a `TypeError`, and it
  discarded the editor page it had just opened.
- A `data:` URL that is not base64 failed silently, or could write garbage. It
  now fails with a stated reason.
- **The authentication file is validated before the browser starts.** Only its
  existence was checked, so a truncated file, a saved HTML login page, or a
  structurally invalid state reached `browser.newContext()` and surfaced as an
  opaque Playwright error — and the already-launched browser was never closed,
  leaking a Chromium process per attempt. A bad auth file is now rejected up front
  with an actionable message ("it starts with `<`, so it looks like a saved web
  page", "contains no cookies, so the login probably expired"), and a browser whose
  context fails to open is closed.
- **A world-readable auth file now produces a warning.** One granting full account
  access should be `chmod 600`; the tool will tell you when it is not, but still
  runs.
- An empty notebook list is an error when `--notebook` named a specific
  notebook, instead of a clean no-op.
- A sub-tree that failed to load no longer disappears without a warning, and a
  missing "Back" control no longer aborts a section group.

### Changed

- **Fetching from an unexpected host now warns.** Asset URLs come from page content
  and are fetched with your signed-in session, so a link inside a shared notebook
  decides where an authenticated request is sent. A request to a host that is not a
  known OneNote/SharePoint/OneDrive host is now logged, once per host, naming the host
  and explaining that the request carried your credentials. **Nothing is blocked** —
  an allowlist would risk silently dropping legitimate attachments from a host not on
  the list, which is a worse and far harder-to-diagnose failure.


- Permanent failures are no longer retried. A clickable element that never
  appears in the DOM cannot appear on a second attempt, so the previous three
  identical warnings ~8s apart per attachment are gone. The retry budget is
  unchanged for genuinely transient cloud failures.

### Changed

- **Re-exporting overwrites instead of accumulating copies.** Running an export again
  into the same output folder used to write `report.pdf_1`, `report.pdf_2` and so on,
  because asset names were chosen by probing the filesystem for collisions. They are
  now reserved within a single run, so a re-run replaces each file with the current
  version. The run warns when the notebook's output folder already exists, naming it
  and stating that its contents will be overwritten. Note this is a **merge, not a
  sync**: files from a previous run that no longer exist in the notebook are left in
  place rather than deleted, so delete the folder yourself for a clean export.
- **Debug output is off by default.** It was previously unconditional, so every run
  filled stdout and the log with scraper and navigation chatter. Use `--verbose`
  (or `ONENOTE_EXPORT_LOG_LEVEL=debug`) to get it back, and `--quiet` to see only
  warnings and errors.
- **Logs no longer land inside `node_modules`.** The path was hardcoded relative to
  the package, so `npm install -g @msout/microsoft-onenote-export-notebook` — the
  install the README recommends — wrote to
  `<prefix>/lib/node_modules/@msout/…/logs/app.log`. Logs now go to
  `~/.local/state/microsoft-onenote-export-notebook` for a global install (honouring
  `XDG_STATE_HOME`) and stay in `<package>/logs` for a checkout.
  `ONENOTE_EXPORT_LOG_DIR` overrides both. `app.log` rotates to `app.log.1` past 5 MB.
- **Logs and HTML dumps are now owner-only** (`0600`/`0700`). `--dodump` writes the
  authenticated DOM of a real notebook — cookies, tenant hostnames, note content — and
  was creating those files world-readable. An existing over-permissive `app.log` is
  tightened on the next run.
- Log timestamps now include the year and a UTC offset, so an overnight run that crosses
  midnight is unambiguous.

### Added

- 249 tests (`npm test`) covering Markdown conversion, internal-link resolution,
  name sanitisation, retry semantics, the run summary, notebook selection, the
  asset pipeline against a real browser, `entrypoint.sh`'s failure handling, log
  level gating and log-path resolution, authentication-file validation, fetch-host classification, README accuracy, the Docker build inputs, the scrapers
  against de-identified fixtures captured from the live OneNote UI, and the whole
  export pipeline run end to end against a fixture, and the re-export overwrite policy (`Dockerfile`, `.dockerignore`, `start-container.sh`).
- ESLint (`npm run lint`) configured for defect detection rather than style, and
  a GitHub Actions workflow running lint, tests and a CLI smoke test.
- `REVIEW-CODE.md`: the full review, with per-finding evidence, fix status, and
  the items still open.

### Known issues (not fixed here)

Recorded in `REVIEW-CODE.md` with severity and evidence. The most relevant:

- The container image `git clone`s `main` from GitHub at build time, so it never
  contains local code, and it lacks `--init` and `/dev/shm` sizing for Chromium.
- Re-running an export into the same output directory duplicates assets
  (`report.pdf_1`, `report.pdf_2`, …) rather than refreshing them.
- Office Online download automation only recognises English and French menus, and
  no `Accept-Language` is set.
- Log output has no level gating and its path resolves inside `node_modules` for
  a global install.
- `--dodump` writes authenticated DOM to `logs/dumps` at mode 0644.

[0.3.0]: https://github.com/Ms-OneNote-Exporter/microsoft-onenote-export-notebook/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/Ms-OneNote-Exporter/microsoft-onenote-export-notebook/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Ms-OneNote-Exporter/microsoft-onenote-export-notebook/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Ms-OneNote-Exporter/microsoft-onenote-export-notebook/compare/v0.1.1...v0.2.0
