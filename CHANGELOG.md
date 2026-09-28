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
  **This affects automation:** `entrypoint.sh` runs under `set -e` and will now
  abort on a failed export, and CI jobs or wrappers that relied on the
  always-zero exit will start reporting failure.
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
- An empty notebook list is an error when `--notebook` named a specific
  notebook, instead of a clean no-op.
- A sub-tree that failed to load no longer disappears without a warning, and a
  missing "Back" control no longer aborts a section group.

### Changed

- Permanent failures are no longer retried. A clickable element that never
  appears in the DOM cannot appear on a second attempt, so the previous three
  identical warnings ~8s apart per attachment are gone. The retry budget is
  unchanged for genuinely transient cloud failures.

### Added

- 68 tests (`npm test`) covering Markdown conversion, internal-link resolution,
  name sanitisation, retry semantics, the run summary, notebook selection, and
  the asset pipeline against a real browser.
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
