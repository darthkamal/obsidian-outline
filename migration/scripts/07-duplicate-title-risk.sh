#!/usr/bin/env bash
# Of the duplicate basenames 04-find-duplicate-titles.sh finds, only the ones
# actually referenced by a [[wiki-link]] somewhere pose a real resolution
# risk (../prep.md #4: "accept the ambiguity if those notes are never
# cross-linked by that name"). This narrows the list to that subset.
# Usage: 07-duplicate-title-risk.sh <vault_root>
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

ROOT="${1:-.}"
ROOT="${ROOT%/}"
[ -d "$ROOT" ] || { echo "Not a directory: $ROOT" >&2; exit 1; }

TMP_NAMES=$(mktemp)
trap 'rm -f "$TMP_NAMES"' EXIT

prep_find_md_files "$ROOT" | while IFS= read -r f; do basename "$f" .md; done \
  | sort | uniq -d > "$TMP_NAMES"

echo "## Duplicate titles actually referenced by a [[wiki-link]] somewhere (real resolution risk)"
referenced=0
total=0
while IFS= read -r name; do
  [ -z "$name" ] && continue
  total=$((total + 1))
  # Escape regex metacharacters in the title, then require the match to
  # actually close as a wiki-link target (]], |alias, or #heading) --
  # otherwise "Log" false-matches inside "[[Logbook]]" or "[[Login Notes]]".
  # No exclusion of the duplicate-named files themselves: one of them linking
  # to the shared name is still a real, unresolved resolution risk (it's
  # ambiguous which of the duplicates the link means), not a false positive.
  esc=$(printf '%s' "$name" | sed -e 's/[][\.*^$/]/\\&/g')
  count=$(LC_ALL=C grep -rlE -- "\[\[${esc}(\]\]|\||#)" "$ROOT" --include='*.md' 2>/dev/null \
    | wc -l | tr -d ' ')
  if [ "${count:-0}" -gt 0 ]; then
    echo "- \"$name\" -- referenced from $count file(s)"
    referenced=$((referenced + 1))
  fi
done < "$TMP_NAMES"

echo
echo "## Summary"
echo "$total duplicate basenames found; $referenced are actually wiki-linked somewhere and need a decision."
echo "$((total - referenced)) are duplicated in name only, never cross-linked -- safe to leave per ../prep.md #4."

exit 0
