#!/usr/bin/env bash
# Canvas/Excalidraw files and Dataview/Templater syntax that won't survive
# the push as-is (see ../prep.md #2).
# Usage: 02-find-unsupported-content.sh <vault_root>
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

ROOT="${1:-.}"
ROOT="${ROOT%/}"
[ -d "$ROOT" ] || { echo "Not a directory: $ROOT" >&2; exit 1; }

echo "## Canvas files (never pushed -- not a document, not linkable)"
prep_find "$ROOT" -name '*.canvas'
echo

echo "## Excalidraw notes (pushed as raw JSON unless exported first)"
prep_find "$ROOT" -name '*.excalidraw.md'
echo

echo "## Notes containing a dataview code block (query text preserved, live results are not)"
prep_find_md_files "$ROOT" | while IFS= read -r f; do
  grep -q '```dataview' "$f" 2>/dev/null && echo "$f"
done
echo

echo "## Notes with Templater/plugin-style <% %> tags (needs manual review -- may be inside or outside a code fence)"
prep_find_md_files "$ROOT" | while IFS= read -r f; do
  grep -q '<%.*%>' "$f" 2>/dev/null && echo "$f"
done

exit 0
