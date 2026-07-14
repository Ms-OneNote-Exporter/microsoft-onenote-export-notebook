# microsoft-onenote-export-notebook

## Why does this project exists ?
Well MS is not playing it fair when it comes to export your complete notebook.
You can export page by page from OneNote interface...
MS DO not provide any convenient way, that I am aware of, to export the whole thing.
And I am sure none exists to export it as markdown.

NO GraphAPI, no limitation. 
GraphAPI has following limitation :
 - since years... it is limiting you to 50page or so
 - you need your entra admin to provide you with rights to use MSEntra GraphAPI


This is a standalone CLI tool for exporting OneNote notebooks using Playwright with authentication state loaded from a JSON file (produced by `microsoft-webauth-playwright`).

## Installation

```bash
npm install
```

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

Authentication state must be obtained using the `microsoft-webauth-playwright` module:

```bash
# First, authenticate (saves auth.json)
webauth login --email your@email.com --password yourpassword

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

ISC — same as MSOneNote Exporter.
