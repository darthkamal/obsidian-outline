#!/usr/bin/env bash
# Moves .canvas and .excalidraw.md files into <vault_root>/.outline-prep-archive/,
# preserving their relative path. The destination is dot-prefixed, so the
# plugin's own walker skips it automatically -- nothing is deleted, and it's
# fully reversible by moving the folder's contents back.
#
# Dry-run by default. Pass --apply to actually move files.
# Usage: 06-archive-unsupported.sh <vault_root> [--apply]
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

ROOT="${1:-.}"
ROOT="${ROOT%/}"
APPLY=0
[ "${2:-}" = "--apply" ] && APPLY=1
[ -d "$ROOT" ] || { echo "Not a directory: $ROOT" >&2; exit 1; }

ARCHIVE="$ROOT/.outline-prep-archive"

{
  prep_find "$ROOT" -name '*.canvas'
  prep_find "$ROOT" -name '*.excalidraw.md'
} | while IFS= read -r f; do
  rel="${f#"$ROOT"/}"
  dest="$ARCHIVE/$rel"
  if [ "$APPLY" -eq 1 ]; then
    mkdir -p "$(dirname "$dest")"
    mv "$f" "$dest"
    echo "moved: $f -> $dest"
  else
    echo "would move: $f -> $dest"
  fi
done

if [ "$APPLY" -eq 0 ]; then
  echo
  echo "Dry run -- nothing moved. Re-run with --apply to actually move these files."
fi

exit 0
