#!/usr/bin/env bash
# Runs every read-only prep check and prints one combined report.
# Usage: prep-scan.sh <vault_root> [size_threshold_mb] > outline-prep-report.md
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

ROOT="${1:-.}"
THRESHOLD_MB="${2:-20}"

if [ ! -d "$ROOT" ]; then
  echo "Not a directory: $ROOT" >&2
  exit 1
fi

echo "# Outline prep report"
echo
echo "Vault: $ROOT"
echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo
"$SCRIPT_DIR/01-inventory.sh" "$ROOT"
echo
"$SCRIPT_DIR/02-find-unsupported-content.sh" "$ROOT"
echo
"$SCRIPT_DIR/03-check-frontmatter.sh" "$ROOT"
echo
"$SCRIPT_DIR/04-find-duplicate-titles.sh" "$ROOT"
echo
"$SCRIPT_DIR/05-check-attachments.sh" "$ROOT" "$THRESHOLD_MB"
echo
echo "---"
echo "06-archive-unsupported.sh was NOT run here -- it's the one script that"
echo "moves files. Review the sections above first, then run it directly"
echo "(dry-run by default; pass --apply to actually move canvas/excalidraw"
echo "files into .outline-prep-archive/)."

exit 0
