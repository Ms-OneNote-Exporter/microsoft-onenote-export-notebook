#!/bin/bash
set -e

# Validate arguments
if [ $# -lt 2 ]; then
    echo "Usage: $0 <session_guid> <notebook_name>"
    echo "Example: $0 abc123 My Notebook"
    exit 1
fi

SESSION_GUID="$1"
NOTEBOOK_NAME="$2"

OUTPUT_DIR="/data/output"

echo "Starting export for notebook: '$NOTEBOOK_NAME'"
echo "Session GUID: $SESSION_GUID"
echo "Output directory: $OUTPUT_DIR"

# Ensure output directory exists
mkdir -p "$OUTPUT_DIR"

# Export the notebook (headless mode by default)
# --non-interactive makes the tool fail fast instead of hanging on a prompt:
# it also enforces --nopassasked, so password-protected sections are skipped
# rather than waiting for a keypress that can never arrive in a container.
node src/index.js export \
    --auth-file /data/output/auth.json \
    --notebook "$NOTEBOOK_NAME" \
    --output-dir "$OUTPUT_DIR" \
    --non-interactive

echo "Export completed successfully!"
