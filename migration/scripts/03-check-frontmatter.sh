#!/usr/bin/env bash
# Notes whose frontmatter block looks malformed: more than 2 lone "---"
# lines in the first 40 lines is a candidate for a mid-block delimiter
# (e.g. a horizontal rule used as a value) that would close the block early.
# Usage: 03-check-frontmatter.sh <vault_root>
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

ROOT="${1:-.}"
ROOT="${ROOT%/}"
[ -d "$ROOT" ] || { echo "Not a directory: $ROOT" >&2; exit 1; }

echo "## Notes with a possibly malformed frontmatter block"
prep_find_md_files "$ROOT" | while IFS= read -r f; do
  first_line=$(head -1 "$f")
  [ "$first_line" = "---" ] || continue
  n=$(head -40 "$f" | grep -c '^---[[:space:]]*$')
  if [ "$n" -gt 2 ]; then
    echo "$f ($n dash-lines in first 40)"
  fi
done

exit 0
