#!/usr/bin/env bash
# Note basenames that appear more than once across the vault. Wiki-link
# resolution is basename-only, vault-wide (src/utils/wiki-map.ts), so a
# duplicate risks a [[Link]] resolving to the wrong note.
# Usage: 04-find-duplicate-titles.sh <vault_root>
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

ROOT="${1:-.}"
ROOT="${ROOT%/}"
[ -d "$ROOT" ] || { echo "Not a directory: $ROOT" >&2; exit 1; }

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

prep_find_md_files "$ROOT" | while IFS= read -r f; do
  base=$(basename "$f" .md)
  printf '%s\t%s\n' "$base" "$f"
done > "$TMP"

echo "## Duplicate note titles (same basename, different folders)"
awk -F'\t' '
  { paths[$1] = paths[$1] $2 "\n"; count[$1]++ }
  END {
    for (b in count) {
      if (count[b] > 1) {
        print "- \"" b "\":"
        n = split(paths[b], arr, "\n")
        for (i = 1; i <= n; i++) if (arr[i] != "") print "    " arr[i]
      }
    }
  }
' "$TMP"

exit 0
