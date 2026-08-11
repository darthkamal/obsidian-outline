#!/usr/bin/env bash
# Embedded attachments: unsupported extensions, missing files, oversized
# files. This is a regex heuristic, not the plugin's exact parser -- treat
# it as a starting point, not a guarantee.
# Usage: 05-check-attachments.sh <vault_root> [size_threshold_mb]
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

ROOT="${1:-.}"
ROOT="${ROOT%/}"
THRESHOLD_MB="${2:-20}"
THRESHOLD_BYTES=$((THRESHOLD_MB * 1024 * 1024))
[ -d "$ROOT" ] || { echo "Not a directory: $ROOT" >&2; exit 1; }

TMP_UNSUPPORTED=$(mktemp)
TMP_MISSING=$(mktemp)
TMP_OVERSIZED=$(mktemp)
TMP_MD_BASENAMES=$(mktemp)
trap 'rm -f "$TMP_UNSUPPORTED" "$TMP_MISSING" "$TMP_OVERSIZED" "$TMP_MD_BASENAMES"' EXIT

# Note titles containing a dot (e.g. "Chapter 1.2") match the same embed
# regex as a real attachment and get rejected for an "invalid" extension --
# that's correct plugin behavior (images.ts falls through to the wiki-link
# transformer, ../prep.md #0/#4), not a broken reference. Build the set of
# real note titles up front so those don't get reported as unsupported.
prep_find_md_files "$ROOT" | while IFS= read -r m; do basename "$m" .md; done > "$TMP_MD_BASENAMES"

prep_find_md_files "$ROOT" | while IFS= read -r md; do
  {
    grep -oE '!\[\[[^]|]+\.[A-Za-z0-9]{1,10}(\|[^]]*)?\]\]' "$md" 2>/dev/null \
      | sed -e 's/^!\[\[//' -e 's/\]\]$//' -e 's/|.*$//'
    grep -oE '!\[[^]]*\]\([^)]+\.[A-Za-z0-9]{1,10}\)' "$md" 2>/dev/null \
      | sed -E 's/^!\[[^]]*\]\((.*)\)$/\1/'
  } | while IFS= read -r target; do
    case "$target" in
      http://*|https://*) continue ;;
    esac
    base=$(basename "$target")
    case "$base" in
      *.*) ext="${base##*.}" ;;
      *) continue ;;
    esac

    if ! is_attachment_ext "$ext"; then
      grep -Fxq "$target" "$TMP_MD_BASENAMES" && continue
      printf '%s\t->\t%s\n' "$md" "$base" >> "$TMP_UNSUPPORTED"
      continue
    fi

    match=$(prep_find "$ROOT" -name "$base" | head -1)
    if [ -z "$match" ]; then
      printf '%s\t->\t%s\n' "$md" "$base" >> "$TMP_MISSING"
      continue
    fi

    size=$(wc -c < "$match" 2>/dev/null | tr -d ' ')
    if [ -n "$size" ] && [ "$size" -gt "$THRESHOLD_BYTES" ]; then
      mb=$((size / 1024 / 1024))
      printf '%s\t%sMB\n' "$match" "$mb" >> "$TMP_OVERSIZED"
    fi
  done
done

echo "## Embeds with an unsupported extension (won't upload -- ../prep.md #0 allowlist)"
sort -u "$TMP_UNSUPPORTED"
echo
echo "## Embeds referencing a file not found anywhere in the vault"
sort -u "$TMP_MISSING"
echo
echo "## Attachments over ${THRESHOLD_MB}MB (check against the server's FILE_STORAGE_UPLOAD_MAX_SIZE -- ../prep.md #5)"
sort -u "$TMP_OVERSIZED"

exit 0
