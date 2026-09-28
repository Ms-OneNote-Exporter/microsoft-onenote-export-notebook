# microsoft-onenote-export-notebook


## Why does this project exists ?

Well MS is not playing it fair when it comes to export your complete notebook.
You can export page by page from OneNote interface...
MS DO not provide any convenient way, that I am aware of, to export the whole thing.
And I am sure none exists to export it as markdown.

NO GraphAPI, no limitation. 
GraphAPI has following limitation :
 - since years... it is limiting you to 50page or so
 => look by youself: https://learn.microsoft.com/en-us/answers/questions/2276682/onenote-api-fails-with-large-sharepoint-document-l 
 - you need your entra admin to provide you with rights to use MSEntra GraphAPI

That Microsoft Q&A thread is kept in this repository as
[`docs/graphapi-sharepoint-limit-evidence.pdf`](docs/graphapi-sharepoint-limit-evidence.pdf),
so the claim above can be checked without following a link that may one day move
or disappear. It is a **printout of a public Microsoft Q&A page** — the content
is Microsoft's, not this project's; the file is quoted as evidence and is not
covered by this project's MIT licence. Its source URL is printed on the first
page.


This is a standalone CLI tool for exporting Microsoft OneNote notebooks using Playwright with authentication state loaded from a JSON file (produced by [microsoft-webauth](https://github.com/Ms-OneNote-Exporter/microsoft-webauth)).

## Issues
Please raise an issue if you find any

## Available on npmjs

<https://www.npmjs.com/package/@msout/microsoft-onenote-export-notebook>

## Installation

```bash
npm install -g @msout/microsoft-onenote-export-notebook
```

Or locally, for development:

```bash
git clone https://github.com/Ms-OneNote-Exporter/microsoft-onenote-export-notebook.git
cd microsoft-onenote-export-notebook
npm install
```

After a global install the command is available as `onenote-export-nb`.

## Usage

### Export by notebook name

```bash
node src/index.js export \
  --auth-file /path/to/auth.json \
  --notebook "My Notebook Name" \
  [--output-dir ./output] \
  [--notheadless] \
  [--dodump] \
  [--nopassasked]
```

### Export by direct URL (skips listing)

```bash
node src/index.js export \
  --auth-file /path/to/auth.json \
  --notebook-link "https://..." \
  [--output-dir ./output]
```

### Interactive selection (no --notebook or --notebook-link)

```bash
node src/index.js export \
  --auth-file /path/to/auth.json
```

## Options

| Option | Description |
|--------|-------------|
| `--auth-file <path>` | **Required.** Path to authentication JSON file (`auth.json`) |
| `--notebook <name>` | Pre-select notebook by name (skips interactive prompt) |
| `--notebook-link <url>` | Directly export a notebook by its full OneNote URL (skips listing) |
| `--output-dir <path>` | Output directory for exported files (default: `./output`) |
| `--notheadless` | Run in visible browser mode (useful for debugging / password-protected sections) |
| `--dodump` | Dump raw HTML content to `logs/dumps/` for debugging |
| `--nopassasked` | Skip password-protected sections instead of pausing to ask |
| `--non-interactive` | Run unattended (containers/CI). Requires `--notebook` or `--notebook-link`, and implies `--nopassasked` |
| `-v, --verbose` | Show debug output (off by default) |
| `-q, --quiet` | Only show warnings and errors |

## Unattended / container use

Two parts of the tool ask for human input: the notebook picker (when neither
`--notebook` nor `--notebook-link` is given) and the keypress that waits for you
to unlock a password-protected section. In a container, CI or a service worker
there is no terminal, so both would wait forever instead of failing.

`--non-interactive` closes both holes:

- it fails immediately (exit code 2) if no notebook was specified
- it implies `--nopassasked`, so locked sections are skipped rather than awaited
- every remaining prompt path also checks for a TTY and raises a clear error

```bash
node src/index.js export \
  --auth-file /data/output/auth.json \
  --notebook "My Notebook" \
  --output-dir /data/output \
  --non-interactive
```

Password-protected sections are written as `SectionName [passProtected]/`
placeholder directories, so their presence stays visible in the export.

## Output

Exported files are written to `<output-dir>/<NotebookName>/`:

```
output/
└── My Notebook/
    ├── Section One/
    │   ├── assets/
    │   │   ├── Page1_img_1.png
    │   │   └── document.docx
    │   ├── Page 1.md
    │   └── Page 2.md
    └── Group/
        └── Nested Section/
            └── Page 3.md
```

Each Markdown file uses Obsidian wikilink format:
- Images: `![[assets/filename.png]]`
- Attachments: `[[assets/filename.docx]]`
- Internal links: `[[Section/Page Name]]`

## Authentication

Authentication state must be obtained using the `microsoft-webauth` module:

```bash
# After having download and installed [microsoft-webauth](https://github.com/Ms-OneNote-Exporter/microsoft-webauth)
# First, authenticate (saves auth.json)
microsoft-webauth login --email your@email.com --password yourpassword

# Second, list you notebook with [microsoft-onenote-list-notebooks](https://github.com/Ms-OneNote-Exporter/microsoft-onenote-list-notebooks)
microsoft-onenote-list-notebook list --auth-file ../microsoft-webauth/auth.json 

# Then export
node src/index.js export \
  --auth-file /path/to/auth.json \
  --notebook "My Notebook"
```

## Project Structure

```
microsoft-onenote-export-notebook/
├── src/
│   ├── index.js              # CLI entry point (commander)
│   ├── auth-context.js       # Auth context loader + storageState validation
│   ├── config.js             # Configuration (OneNote URL)
│   ├── navigator.js          # Browser navigation (list & open notebooks)
│   ├── exporter.js           # Main export logic (section/page traversal)
│   ├── notebookFrame.js      # Live handle on the notebook frame (survives reloads)
│   ├── scrapers.js           # DOM scraping (sections, pages, content)
│   ├── parser.js             # HTML → Markdown converter (Turndown)
│   ├── linkResolver.js       # Internal link resolution for Obsidian
│   ├── downloadStrategies.js # Attachment download strategies
│   ├── diagnose-notebook.js        # Selector diagnostics (dev tool)
│   ├── diagnose-notebook-newpage.js # Popup/redirect diagnostics (dev tool)
│   └── utils/
│       ├── logger.js         # Levelled logging + file logger
│       ├── logPaths.js       # Where logs live (checkout vs global install)
│       ├── fetchHosts.js     # Classification of asset fetch hosts
│       ├── naming.js         # File/dir name sanitising and de-duplication
│       └── retry.js          # Exponential backoff, with permanent-failure support
├── test/                     # Jest suite (`npm test`)
├── .github/workflows/ci.yml  # lint + test + CLI smoke test
├── Dockerfile                # Container image (builds from this working tree)
├── entrypoint.sh             # Container entry point
├── start-container.sh        # Helper to run the container
├── dumps/                    # Raw DOM captures used to build fixtures (gitignored)
├── output/                   # Exported notebooks (gitignored)
├── logs/                     # Log files and HTML dumps (gitignored)
├── CHANGELOG.md
├── package.json
└── README.md
```

The two `diagnose-*` scripts are developer tools for working out which CSS
selectors the current OneNote web UI uses. They are not needed to export
anything, but they are the first thing to run when a selector breaks.

## Logs

Log output goes to `logs/app.log` in a checkout. After a global install it goes
to `~/.local/state/microsoft-onenote-export-notebook/` (honouring
`XDG_STATE_HOME`), because writing inside `node_modules` is unreliable and gets
wiped on reinstall. Override either with `ONENOTE_EXPORT_LOG_DIR`.

Logs and `--dodump` HTML dumps are created owner-only (`0600`/`0700`): a dump
contains the authenticated DOM of a real notebook, including cookies and tenant
hostnames. Treat `logs/dumps/` as sensitive and do not commit it.

### Verbosity

Debug output is **off by default** — it used to be unconditional and buried the
useful output.

```bash
onenote-export-nb export --auth-file auth.json --notebook "X" --verbose   # add debug
onenote-export-nb export --auth-file auth.json --notebook "X" --quiet     # warnings and errors only
ONENOTE_EXPORT_LOG_LEVEL=debug onenote-export-nb export …                 # for containers
```

`app.log` rotates to `app.log.1` once it passes 5 MB.

## Re-running an export

Exporting the same notebook again into the same `--output-dir` **overwrites** the
existing Markdown and assets rather than creating `report.pdf_1`, `report.pdf_2`
duplicates. The run warns you first:

```
[WARN] Output folder already exists: /path/to/output/My Notebook
[WARN]   Existing Markdown and assets in it will be overwritten by this run.
[WARN]   Files from a previous run that are no longer in the notebook are left in place,
[WARN]   so this is a merge, not a clean mirror. Remove the folder first for a clean export.
```

So a re-export is a **merge, not a sync**: anything you deleted from OneNote since the
last run keeps its old `.md` file. Delete the notebook's output folder before exporting
if you want a clean result.

Two attachments that resolve to the same filename *within a single run* still get
distinct files (`report.docx` and `report_1.docx`), so one never silently clobbers the
other.

## If the editor tab goes away

OneNote draws the notebook inside a frame (`onenoteframe.aspx`) in the SharePoint
page, and it **replaces that frame whenever the page reloads** — which it does on
its own schedule, not only when you ask it to. The exporter re-attaches to the
replacement and carries on:

```
[INFO] The OneNote notebook frame was replaced by a page reload - re-attached and continuing.
```

If the tab itself is gone — you closed it, its renderer ran out of memory, or the
browser was killed — the run stops and says which of those it was, because they
need different responses:

```
[ERROR] Export failed:
NotebookUnavailableError: the OneNote editor tab crashed (its renderer stopped),
so the export cannot continue. This is usually the browser running out of memory
on a heavy OneNote page: close other tabs and re-run…
```

Run with `--verbose` and the line above it records what the browser could still
see at the moment of failure (`death=… pageClosed=… contextPages=…`), which is
what to include in a bug report.

Whatever was already written stays on disk, and re-running overwrites it rather
than duplicating it, so a re-run is always safe. The exit code is `1`.

## Attachments can be slow, and sometimes fail

Attachments are fetched by three strategies in turn (a direct request, clicking
the file in OneNote, then a plain request), each with its own retries, so a page
with several files takes a while. Two things are worth knowing:

- Each attachment is capped at **30 seconds** of wall clock. The strategy that
  actually works — clicking the file in OneNote and confirming the download —
  takes about four seconds, so the cap never truncates a working download; it
  stops the failing ones from spending minutes apiece.
- A file attachment is currently fetched more than once for a single file, and
  the repeats are written as `file.pdf`, `file_1.pdf`, … See `REVIEW-CODE.md`
  (F-60).

A file that cannot be fetched is named in the log and is still linked by its
planned name in the Markdown, so the note is never silently lost — it costs a
re-run rather than correctness.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Export completed |
| `1` | Export failed (bad auth file, notebook not found, browser error, …) |
| `2` | Usage error — for example `--non-interactive` without `--notebook` |

Note the asymmetry with the container: `entrypoint.sh` deliberately **exits `0`
even when the export fails**, so a partial export is kept rather than discarded.
The CLI itself always reports the truth.


## License

MIT — see [LICENSE](LICENSE), and read [NOTICE.md](NOTICE.md).
