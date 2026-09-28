#!/bin/bash
set -euo pipefail

# Starts the export container.
#
# Usage: ./start-container.sh <sessionGuid> <notebookName>
#
# Everything that was previously hardcoded is overridable, because the old script
# pointed at a sibling checkout that only existed on one machine:
#   ../microsoft-onenote-exporter-docker/dckr_output_<guid>
# and at a fixed image name, so it could not be used anywhere else.

SESSIONGUID="${1:-}"
NOTEBOOK_NAME="${2:-}"

# Validate arguments
if [[ -z "$SESSIONGUID" ]]; then
    echo "ERROR: SESSIONGUID is required" >&2
    echo "Usage: $0 <sessionGuid> <notebookName>" >&2
    exit 1
fi

if [[ -z "$NOTEBOOK_NAME" ]]; then
    echo "ERROR: Notebook name is required" >&2
    echo "Usage: $0 <sessionGuid> <notebookName>" >&2
    exit 1
fi

IMAGE="${IMAGE:-microsoft-onenote-export-a-notebook}"
CONTAINER="${CONTAINER:-oneexp_${SESSIONGUID}}"
OUTPUT_DIR="${OUTPUT_DIR:-./dckr_output_${SESSIONGUID}}"
AUTH_FILE="${AUTH_FILE:-${OUTPUT_DIR}/auth.json}"

if [[ ! -f "$AUTH_FILE" ]]; then
    echo "ERROR: no auth file at $AUTH_FILE" >&2
    echo "  Create it first, e.g. with microsoft-webauth:" >&2
    echo "    mkdir -p \"$OUTPUT_DIR\"" >&2
    echo "    cp ~/.microsoft-webauth/auth-file.json \"$AUTH_FILE\"" >&2
    echo "  or set AUTH_FILE to point at an existing one." >&2
    exit 1
fi

mkdir -p "$OUTPUT_DIR"
# Resolve so the -v argument is valid even when the path has not been created yet.
OUTPUT_DIR_ABS="$(cd "$OUTPUT_DIR" && pwd)"

echo "Container : $CONTAINER"
echo "Image     : $IMAGE"
echo "Notebook  : $NOTEBOOK_NAME"
echo "Output    : $OUTPUT_DIR_ABS"
echo ""
echo "The export runs on container start. To re-run it without recreating:"
echo "  docker exec $CONTAINER /app/entrypoint.sh \"$SESSIONGUID\" \"$NOTEBOOK_NAME\""
echo ""

# Chromium needs more than Docker's default 64 MB of shared memory or it crashes
# on memory-heavy pages, hence --shm-size. --init runs a tiny PID-1 reaper so
# Chromium's child processes are cleaned up instead of accumulating as zombies
# when the export ends.
#
# The container is created detached (-d) and the export is run via `exec`, which
# is what the previous script claimed to do while actually running in the
# foreground with no way to use the container afterwards.
docker run --detach \
    --name "$CONTAINER" \
    --init \
    --shm-size=1g \
    -v "${OUTPUT_DIR_ABS}:/data/output" \
    "$IMAGE" \
    "$SESSIONGUID" "$NOTEBOOK_NAME" >/dev/null

# The entrypoint runs as PID 1 under the reaper, so wait for it and propagate a
# non-zero status if the export failed. `docker wait` returns the container's exit
# code, and the entrypoint is written to exit 0 even when the export itself
# failed (see entrypoint.sh) - so this is about the container failing, not the
# export failing.
EXIT_CODE="$(docker wait "$CONTAINER")"

echo ""
if [[ "$EXIT_CODE" == "0" ]]; then
    echo "Container finished. Exported files are in: $OUTPUT_DIR_ABS"
else
    echo "WARNING: container exited with status $EXIT_CODE." >&2
    echo "         Check the log:  docker logs $CONTAINER" >&2
fi
