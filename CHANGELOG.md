# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

- 163 tests (`npm test`) covering Markdown conversion, internal-link resolution,
  name sanitisation, retry semantics, the run summary, notebook selection, the
  asset pipeline against a real browser, `entrypoint.sh`'s failure handling, log
  level gating and log-path resolution, authentication-file validation, fetch-host classification, and the
  Docker build inputs (`Dockerfile`, `.dockerignore`, `start-container.sh`).
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

[0.2.0]: https://github.com/Ms-OneNote-Exporter/microsoft-onenote-export-notebook/compare/v0.1.1...v0.2.0
