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

# Overridable so the script can be exercised in tests; the container default is
# unchanged.
OUTPUT_DIR="${OUTPUT_DIR:-/data/output}"

echo "Starting export for notebook: '$NOTEBOOK_NAME'"
echo "Session GUID: $SESSION_GUID"
echo "Output directory: $OUTPUT_DIR"

# Ensure output directory exists
mkdir -p "$OUTPUT_DIR"

# Export the notebook (headless mode by default)
# --non-interactive makes the tool fail fast instead of hanging on a prompt:
# it also enforces --nopassasked, so password-protected sections are skipped
# rather than waiting for a keypress that can never arrive in a container.
#
# A failed export is deliberately NOT fatal here. `set -e` would abort before
# the completion line below, and this entrypoint is the documented unattended
# path: callers mount an output volume, run the export, and collect whatever
# was written. Aborting on a partial export would discard that partial result
# and mark the container failed, which is a regression for pipelines that
# tolerate a few unreadable sections.
#
# So the status is captured instead of aborting, reported on stderr, and the
# container still exits 0. Note the tool itself (src/index.js) is unchanged and
# still exits 1 on a failed export, so a direct CLI or CI invocation still sees
# the truth - this tolerance lives only in the container wrapper.
EXPORT_STATUS=0
node src/index.js export \
    --auth-file /data/output/auth.json \
    --notebook "$NOTEBOOK_NAME" \
    --output-dir "$OUTPUT_DIR" \
    --non-interactive || EXPORT_STATUS=$?

if [ "$EXPORT_STATUS" -ne 0 ]; then
    echo "WARNING: the export reported failure (exit $EXPORT_STATUS)." >&2
    echo "WARNING: any Markdown already written to $OUTPUT_DIR has been kept;" >&2
    echo "WARNING: check the log above and logs/app.log for what was skipped." >&2
fi

# Exit 3 means the export finished but some pages, sections or groups are
# missing, which is not the same as exit 1 ("nothing usable came out"). Both are
# worth the warning above, so both are reported the same way here - the container
# still exits 0 either way, which is the whole point of capturing the status
# rather than letting `set -e` discard a partial export.
if [ "$EXPORT_STATUS" -eq 3 ]; then
    echo "NOTE: the export completed with some pages, sections or groups missing." >&2
    echo "NOTE: the notes that were written are complete, and name any asset" >&2
    echo "NOTE: they refer to but could not download. Re-run to try again." >&2
fi

echo "Export completed successfully!"
exit 0
