# OneNote export — original dump index (2026-09-27)

Catalogue of the raw capture files collected for the code-quality review.
Each dump is produced by one stage of the export pipeline; `STEP n` is that stage.
One line per file: `STEP {step number}: {corresponding_file}, {comment}`

Status: **captured 2026-09-28** — see the Files section below. Raw captures stay in
this directory and are gitignored; de-identified extracts live in
`test/fixtures/` and are committed.

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

STEP 1: debug_page_dump.html, notebooks-list DOM (349 KB); 13 notebooks, all rows in ONE table
STEP 1: diag_notebook_screenshot.png, notebooks list as rendered
STEP 2: debug_notebook_content.html, the OneNote content frame (905 KB) with 3 sections + 1 group
STEP 3: debug_group.html, section-group frame expanded; reveals nested group + 5 page nodes
STEP 4: debug_page.html, a page frame after selecting the first page
STEP 4: debug_page_content.html, the extracted contentHtml of that page
STEP 4: debug_page_content.json, the same page's parsed image/attachment/link/video inventory
STEP 4: page_Section1_Note1_1_PDFs.html, page with 1 image + 3 attachments
STEP 4: page_Section_S1_Note2wPic.html, page with a large inline image (48 KB)
STEP 4: page_Section_S1_Note1w_Table.html, table-heavy page (159 KB)
STEP 4: page_S1Note6_docu_docxasttachment.html, docx embedded as an attachment
STEP 4: page_S1Note8_docu_docxasprintout.html, docx embedded as a printout (2 images + 4 attachments)
STEP 4: page_Password_protected_.html, a password-protected page
STEP 4: page_SectionS2_Note1wPic.html, page with an image and an internal link
STEP 4: page_Note_w_linktopage.html, internal link to another page
STEP 4: page_Note_with_SectionLink.html, internal link to a section

## What the capture established

Recorded here because these are facts about the live OneNote UI, not inferences,
and the fixtures in `test/fixtures/` are derived from them.

- **Section ids are plain UUIDs**; page ids are `{uuid}{n}`; **group ids are
  URL-encoded absolute SharePoint folder URLs** (`https%3A%2F%2F…%2Ffolders%2F<guid>`).
  All three shapes are well over 20 characters, which is what the `MIN_ID_LENGTH`
  guard in `linkResolver.js` relies on.
- **There is exactly ONE table** of notebook rows on the list page (14 rows, 13 of
  them notebooks, `rowIndex` starting at 1 because row 0 is a header). So the
  cross-table collision that F-20 hypothesised does **not** occur on the current
  page. See REVIEW-CODE.md.
- **Notebook names can repeat** — two rows were both `John @ MOBILUTILS`. The tool
  dedupes by name, keeping the first.
- **Page labels come in two shapes**, and `getPages()` handles both:
  - `<name>, page N of M, Page. Select to open page contents.`
  - `<name>, page N of M, Page. Selected. Press Ctrl + F6 to navigate to page contents.`
  Order matters: the trailing `Page. Select…` is stripped first, which leaves
  `page N of M` at the end where the second rule can reach it.
- **CSS-module class hashes change between builds** (e.g. `mainItem__item___HEta0`),
  which is why the selectors match on the stable prefix.
- A password-protected section and a password-protected page both exist in this
  notebook, so both code paths are represented.
