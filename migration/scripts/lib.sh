# Shared helpers for the outline-prep scripts. Source, don't execute.
#
# Extension lists mirror src/utils/content-type.ts on the fix/self-hosted-sync
# branch. If that file's allowlist changes, update the two case statements
# below to match -- there is no automated link between them.

# True if $1 (an extension, with or without leading dot) is one of the
# extensions Outline renders as an inline image.
is_image_ext() {
  local ext
  ext=$(printf '%s' "${1#.}" | tr '[:upper:]' '[:lower:]')
  case "$ext" in
    png|jpg|jpeg|gif|webp|svg|bmp|avif) return 0 ;;
    *) return 1 ;;
  esac
}

# True if $1 is any extension the plugin will upload as an attachment
# (images plus audio/video/document types). heic/heif/tiff/tif upload as
# file-link cards, not inline images -- see is_image_ext.
is_attachment_ext() {
  local ext
  ext=$(printf '%s' "${1#.}" | tr '[:upper:]' '[:lower:]')
  case "$ext" in
    png|jpg|jpeg|gif|webp|svg|bmp|avif|heic|heif|tiff|tif|mp3|m4a|wav|ogg|oga|opus|flac|aac|webm|mp4|mov|mkv|avi|pdf|txt|csv|json|zip|docx|xlsx|pptx|doc|xls|ppt|rtf|epub) return 0 ;;
    *) return 1 ;;
  esac
}

# Print every path under $1, skipping dot-directories and node_modules --
# matching this plugin's own walker (src/adapters/node.ts: isSkippedDir).
# Extra find predicates (e.g. -name '*.md') may follow $1.
#
# -mindepth 1 keeps the *root itself* out of the dot-directory test, so this
# is safe to call with "." or with a path that itself contains a dot segment
# above the vault root -- only entries actually inside the vault are tested.
prep_find() {
  local root="$1"
  shift
  find "$root" -mindepth 1 \( -name '.*' -o -name node_modules \) -prune -o -type f "$@" -print
}

prep_find_md_files() {
  prep_find "$1" -name '*.md'
}
