# OneNote export — original dump index (2026-09-27)

Catalogue of the raw capture files collected for the code-quality review.
Each dump is produced by one stage of the export pipeline; `STEP n` is that stage.
One line per file: `STEP {step number}: {corresponding_file}, {comment}`

Status: **awaiting dumps** — this directory is currently empty apart from this file.
Rows are appended to *Files* below as captures land.

## Pipeline stages referenced by STEP numbers

| STEP | Stage | Produced by | Expected dump filenames |
|------|-------|-------------|-------------------------|
| 1 | Notebooks list page | `listNotebooks` — `src/navigator.js` | `debug_page_dump.html` |
| 2 | Notebook content frame | frame auto-detection — `src/exporter.js` | `debug_notebook_content.html` |
| 3 | Section group frame | `processSections` group branch — `src/exporter.js` | `debug_group_<name>.html` |
| 4 | Page frame | `processSections` page branch — `src/exporter.js` | `debug_page_<name>.html` |
| 5 | Attachment download | `src/downloadStrategies.js` | — (see STEP 6 for diagnostics) |
| 6 | Office Online viewer | `handleOfficeOnlineDownload` — `src/downloadStrategies.js` | `debug_office_online_<timestamp>.html`, `debug_office_online_frame_<timestamp>.html` |
| 7 | Direct notebook link | `openNotebookByLink` — `src/navigator.js` | `debug_notebook_link.html` |
| 8 | Selector diagnostics | `src/diagnose-notebook.js`, `src/diagnose-notebook-newpage.js` | `diag_frame_<n>.html`, `diag_frame_<n>_analysis.json`, `diag_notebook_screenshot.png`, `diag_newpage.html`, `diag_newpage_screenshot.png` |

## Convention

- `STEP n` is fixed per pipeline stage per the table above, so several files may share a STEP.
- Ordering within a STEP follows the order the tool wrote the files (mtime, oldest first).
- `comment` states what the dump is meant to prove or exercise — one clause, no full sentences.

## Files

<!-- Append one line per dump below, in the format:
STEP 1: debug_page_dump.html, main notebooks-list DOM after network idle
-->
