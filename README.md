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
  --notebook "NB_Attached_WordsDocuments"
```

## Project Structure

```
microsoft-onenote-export-notebook-playwright-js/
├── src/
│   ├── index.js              # CLI entry point
│   ├── auth-context.js       # Auth context loader (file-based)
│   ├── config.js             # Configuration (paths, URLs)
│   ├── navigator.js          # Browser navigation (list & open notebooks)
│   ├── exporter.js           # Main export logic (section/page traversal)
│   ├── scrapers.js           # DOM scraping (sections, pages, content)
│   ├── parser.js             # HTML → Markdown converter (Turndown)
│   ├── linkResolver.js       # Internal link resolution for Obsidian
│   ├── downloadStrategies.js # Attachment download strategies
│   └── utils/
│       ├── logger.js         # Coloured logging + file logger
│       └── retry.js          # Exponential backoff retry helper
├── output/                   # Exported notebooks (gitignored)
├── logs/                     # Log files and HTML dumps (gitignored)
├── package.json
└── README.md
```

## License

MIT — see [LICENSE](LICENSE), and read [NOTICE.md](NOTICE.md).
