#!/usr/bin/env node
const { program } = require('commander');
const logger = require('./utils/logger');
const { runExport } = require('./exporter');

program
    .name('onenote-export-nb')
    .description('Export a Microsoft OneNote notebook to Obsidian Markdown via Playwright — extracted from MSOneNote Exporter')
    // Single source of truth: a hardcoded version drifts from package.json and
    // makes `--version` report a release that does not exist.
    .version(require('../package.json').version);

program
    .command('export')
    .description('Export a OneNote notebook to Obsidian-compatible Markdown')
    .requiredOption('--auth-file <path>', 'Path to authentication JSON file (auth.json)')
    .option('--notebook <name>', 'Pre-select notebook by name (skips interactive selection)')
    .option('--notebook-link <url>', 'Directly export a notebook by its full OneNote URL (skips listing)')
    .option('--output-dir <path>', 'Output directory for exported Markdown files (default: ./output)')
    .option('--notheadless', 'Run in visible browser mode for debugging')
    .option('--dodump', 'Dump HTML content to files for debugging')
    .option('--nopassasked', 'Skip password-protected sections instead of asking')
    .option('--non-interactive', 'Run unattended (containers/CI): requires --notebook or --notebook-link, and implies --nopassasked')
    .option('-v, --verbose', 'Show debug output (debug logging is off by default)')
    .option('-q, --quiet', 'Only show warnings and errors')
    .action(async (options) => {
        // Log verbosity. Also settable without the CLI, for containers:
        // ONENOTE_EXPORT_LOG_LEVEL=debug.
        if (options.verbose) {
            logger.setLevel('debug');
        } else if (options.quiet) {
            logger.setLevel('warn');
        }

        // Map --output-dir to exportDir used internally
        if (options.outputDir) {
            options.exportDir = options.outputDir;
        }

        // Fail fast, before any browser is launched, when the caller asked for
        // an unattended run but forgot how to pick a notebook. Without this the
        // export would reach the interactive picker and hang forever.
        if (options.nonInteractive) {
            if (!options.notebook && !options.notebookLink) {
                logger.error('--non-interactive requires either --notebook <name> or --notebook-link <url>.');
                logger.error('Without one of them the export would stop at the interactive notebook picker.');
                process.exit(2);
            }
            // Nobody is there to answer a password prompt in a container.
            options.nopassasked = true;
        }

        try {
            await runExport(options);
        } catch (e) {
            logger.error('Export failed:', e);
            process.exit(1);
        }
    });

program.parse();
