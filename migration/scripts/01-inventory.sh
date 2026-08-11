#!/usr/bin/env bash
# Extension counts and total size, vault-wide.
# Usage: 01-inventory.sh <vault_root>
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

ROOT="${1:-.}"
ROOT="${ROOT%/}"
[ -d "$ROOT" ] || { echo "Not a directory: $ROOT" >&2; exit 1; }

echo "## File inventory: $ROOT"
echo
printf '%-14s %8s %12s\n' "extension" "count" "bytes"

prep_find "$ROOT" | while IFS= read -r f; do
  base=$(basename "$f")
  case "$base" in
    *.*) ext=$(printf '%s' "${base##*.}" | tr '[:upper:]' '[:lower:]') ;;
    *) ext="(none)" ;;
  esac
  size=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
  printf '%s\t%s\n' "$ext" "${size:-0}"
done | awk -F'\t' '
  { cnt[$1]++; sum[$1] += $2 }
  END { for (e in cnt) printf "%-14s %8d %12d\n", e, cnt[e], sum[e] }
' | sort -k2,2rn

exit 0
