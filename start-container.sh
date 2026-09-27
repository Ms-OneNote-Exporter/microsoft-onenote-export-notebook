#!/bin/bash
set -euo pipefail

# This script is intended to be used outside of the container, to start the container with the correct arguments.

# Usage: ./start-container.sh <sessionGuid> <notebookName>
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

#OUTPUT_DIR="$(pwd)/dckr_output_$SESSIONGUID"
OUTPUT_DIR="../microsoft-onenote-exporter-docker/dckr_output_$SESSIONGUID"

echo "Starting container for notebook: '$NOTEBOOK_NAME'"
echo "Session GUID: $SESSIONGUID"
echo "Output directory: $OUTPUT_DIR"
echo ""
echo "Before running this, ensure you have an auth.json file in the output directory:"
echo "  mkdir -p $OUTPUT_DIR"
echo "  # Copy your auth.json to $OUTPUT_DIR/auth.json"
echo ""
echo "Then run the export inside the container:"
echo "  docker exec one-$SESSIONGUID /entrypoint.sh $SESSIONGUID \"$NOTEBOOK_NAME\""

# Start container in detached mode with a shell for manual interaction
docker run --name oneexp_$SESSIONGUID \
    -v "$OUTPUT_DIR:/data/output" \
    microsoft-onenote-export-a-notebook $SESSIONGUID "$NOTEBOOK_NAME"


echo ""
echo "Container started successfully."
echo "To export, run: docker exec one-$SESSIONGUID /entrypoint.sh $SESSIONGUID \"$NOTEBOOK_NAME\""
