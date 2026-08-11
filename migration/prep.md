# Prepping a vault for Outline migration

A checklist for cleaning up any Obsidian vault before pushing it with this
plugin. Read this once per vault, not once per note — most of it is "run this
command, look at the output, decide."

Everything here is grounded either in this plugin's source (`src/`) or in
Outline's own docs/behavior; the latter are marked. Where the real-vault test
in `migration/findings.md` measured something, this doc points at
it instead of repeating it.

**Running this end-to-end, including the actual sync?** Use
`migration/RUNBOOK.md` instead — it's the mechanical, no-judgment-calls procedure
built on top of this document and the scripts below. Read this doc for *why*
each check exists; read the runbook for *what to run, in order*.

Every shell command below is also packaged as a standalone script in
`migration/scripts/` — run `migration/scripts/prep-scan.sh <vault>` to get
every check's output in one pass instead of copy-pasting commands one at a
time. See `migration/scripts/README.md` for what each script does.

## 0. Ground truth: what actually happens to a file

Before cleaning anything, know what the plugin does with each file type, so
you're not fixing things it already handles.

| Vault content | What happens |
| --- | --- |
| `.md` files | Pushed as documents. Title = **filename**, not any frontmatter `title:` field — the tree builder (`src/pipeline/tree/documentTree.ts`) never reads frontmatter. |
| `index.md` in a folder | Becomes that folder's own document (folder-as-document mode), not a separate child. |
| Frontmatter (`---\n...\n---`) | **Stripped entirely** before push. Only `outline_id`, `outline_collection_id`, `outline_last_synced`, `outline_content_hash` are written back locally afterward (`src/pipeline/transformers/frontmatter.ts`). Tags, aliases, `cssclass`, custom fields — none of it reaches Outline. |
| `![[embed.ext]]` | Uploaded as an attachment **only if `ext` is in the allowlist** below. Images (`png jpg jpeg gif webp svg bmp avif`) embed inline; everything else in the list becomes a file-link card. Anything not in the list is left alone for the wiki-link transformer, which — since it isn't a note either — usually renders as plain unlinked text. |
| `[[Note Name]]` / `![[Note Name]]` | Resolved to a real Outline link **only if a note with that exact basename has already been pushed** (its `outline_id` is known). Resolution is by basename only, vault-wide — see §4. |
| `[[Note#Heading]]` | Links to the whole note; the `#Heading` part is discarded. There is no block/heading-level embed support. |
| `> [!type]` callouts | Converted to `:::type` fences. Nested callouts (a callout inside a callout) are **flattened** to a bold label — Outline's `:::` fences don't nest. |
| Code fences | Preserved verbatim, including their real backtick/tilde run length. A `dataview`/`dataviewjs` block is a code fence like any other: its **query text** is preserved, not its rendered output — Outline has no Dataview plugin, so it will render as a literal code block, not live data. |
| TOC-looking bullet lists (`- [[#Heading]]`) | Removed if the "Remove TOC" setting is on. Off by default. |
| `.canvas`, `.excalidraw`, and other non-`.md` vault files | **Never pushed.** The file walker only collects `*.md` (`src/adapters/node.ts`). A `.excalidraw.md` file *is* markdown, though — see §2. |
| Dot-directories (`.obsidian`, `.trash`, `.git`, `.claude`, …) and `node_modules` | Skipped automatically. Nothing to do here. |

The attachment allowlist (`src/utils/content-type.ts`), current as of this branch:

```
images:     png jpg jpeg gif webp svg bmp avif
audio:      mp3 m4a wav ogg oga opus flac aac
video:      webm mp4 mov mkv avi
documents:  pdf txt csv json zip docx xlsx pptx doc xls ppt rtf epub
```

Anything outside this list — `.heic`, `.tiff`, `.psd`, `.ai`, `.numbers`,
`.key`, `.dwg`, iOS Live Photo pairs, etc. — is invisible to the plugin. It
won't error; the embed just won't upload.

## 1. Inventory the vault

Run from the vault root:

```bash
# All file extensions in use, with counts
find . -type f -not -path '*/.*' | sed 's/.*\.//' | sort | uniq -c | sort -rn

# Total size by extension (macOS/BSD find; adjust -printf for GNU find)
find . -type f -not -path '*/.*' -exec du -h {} + | awk '{print $1, $2}' | sort -rh | head -30
```

Cross-reference the extension list against §0's allowlist. Anything not on
it is either (a) a format to convert, or (b) fine to leave — not every file
in a vault needs to reach Outline.

Packaged as `migration/scripts/01-inventory.sh <vault>`.

## 2. Archive or convert unsupported content

- **Canvas files (`.canvas`)** — not migrated, not linkable. Either leave
  them out of the push root entirely, or note that canvases will need to be
  recreated manually in Outline (which has no canvas equivalent) or exported
  as an image and embedded as a PDF/PNG.
- **Excalidraw (`.excalidraw.md`)** — these *are* `.md` files, so the plugin
  *will* push them, as a note full of raw JSON drawing data. Either exclude
  them (move outside the push root, or prefix with `.` to use the
  dot-directory skip) or export each as a PNG/SVG first and embed that
  instead.
- **Dataview / Templater / other plugin syntax** — `dataview` code blocks
  survive as literal text (see §0); `dataviewjs`, Templater `<% %>` tags, and
  other plugin-specific inline syntax outside a code fence are **not**
  fenced and will be pushed as raw text with no meaning in Outline. Search
  for them and decide case-by-case:

  ```bash
  grep -rl '```dataview' --include='*.md' .
  grep -rln '<%.*%>' --include='*.md' .
  ```

- **Anything you don't want in Outline at all** — the plugin's dot-directory
  skip is the cheapest exclusion mechanism: move a folder to `.archive/` (or
  similar) and it's invisible to both the walker and the vault search.

Packaged as `migration/scripts/02-find-unsupported-content.sh <vault>` (scan)
and `migration/scripts/06-archive-unsupported.sh <vault> [--apply]` (moves
`.canvas`/`.excalidraw.md` into `.outline-prep-archive/` — dry-run unless
`--apply` is passed; reversible, deletes nothing).

## 3. Clean up frontmatter

The plugin's frontmatter parser is intentionally simple (`src/pipeline/transformers/frontmatter.ts`)
— it's a `key: value` line reader, not a full YAML parser. It only needs to
find and strip a clean `---`-delimited block; it does not need the fields
inside to be well-formed, since none of them are read. Still worth fixing
before migration, because a malformed block breaks the round-trip (the local
frontmatter *rewriter* in `src/adapters/node.ts`, which the plugin uses to
write back `outline_id` etc., expects the block to close on a line that is
`---` optionally followed by trailing text — not a `---` buried mid-block):

```bash
# Notes that start with a frontmatter block but have more than 2 lone "---"
# lines in their first 40 lines -- a candidate for a mid-block delimiter
# (e.g. a horizontal rule used as a value separator) that would close the
# block early.
for f in $(find . -name '*.md' -not -path '*/.*'); do
  head -1 "$f" | grep -q '^---$' || continue
  n=$(head -40 "$f" | grep -c '^---[[:space:]]*$')
  [ "$n" -gt 2 ] && echo "$f ($n dashes)"
done
```

Anything flagged: open it and confirm exactly one opening `---` and one
closing `---`, each alone on its own line, with nothing that looks like a
delimiter in between.

Packaged as `migration/scripts/03-check-frontmatter.sh <vault>`.

Since frontmatter is dropped on push (§0), there's no need to *reformat* it
for Outline's benefit — only to remove anything that would confuse the
plugin's own parser. Two things worth doing anyway, because they affect what
readers see in Outline:

- **If a note's meaningful title lives in `title:` frontmatter and differs
  from the filename** — rename the file. The frontmatter `title:` is
  silently ignored; only the filename becomes the Outline document title.
- **Tags, if you care about them surviving in some form** — they don't.
  Outline has no note-level tag concept this plugin writes to. If tags
  matter, either fold them into the note body before migrating (e.g. as a
  line of `#tag` text, which Outline does support natively) or accept they
  won't carry over.

## 4. Fix filename collisions

Wiki-link resolution is **basename-only, vault-wide** (`src/utils/wiki-map.ts`):
it maps `"Note Name" → outline_id`, with no folder disambiguation. If two
notes share a title in different folders, whichever was pushed *last* wins
the map entry, and `[[Note Name]]` links from other notes may silently
resolve to the wrong document.

```bash
# List basenames that appear more than once in the vault
find . -name '*.md' -not -path '*/.*' -exec basename {} \; | sort | uniq -d
```

If the list is non-empty, decide per name: rename to disambiguate (`Meeting
Notes (Project A).md`), or accept the ambiguity if those notes are never
cross-linked by that name.

This is different from the dotted-title case (`Chapter 1.2.md`) — that's
already handled correctly by the attachment-extension allowlist in §0 and
needs no vault changes.

Packaged as `migration/scripts/04-find-duplicate-titles.sh <vault>`.

## 5. Check attachment sizes before a bulk push

Outline's own documented default for `FILE_STORAGE_UPLOAD_MAX_SIZE` is
**25 MB** (`docs.getoutline.com`, self-hosting → file storage). Some
deployments raise this — **confirm the actual configured value with whoever
runs the instance** rather than assuming either 25 MB or a larger number.

```bash
# Every embedded attachment over 20 MB, vault-wide
find . -type f -size +20M -not -path '*/.*' \
  \( -iname '*.mp3' -o -iname '*.mp4' -o -iname '*.mov' -o -iname '*.pdf' \
     -o -iname '*.m4a' -o -iname '*.wav' -o -iname '*.zip' \)
```

For anything close to or over the limit, either compress it, split it, or
plan to host it externally and link instead of embed.

Packaged as `migration/scripts/05-check-attachments.sh <vault> [threshold_mb]`
— also flags embeds with an unsupported extension and embeds pointing at a
file missing from the vault, both regex-heuristic, not the plugin's exact
parser.

Separately from the size ceiling: sustained upload **throughput**, not size,
was the actual failure mode in the real-vault test — a large file over a slow
link times out well before hitting any size limit. If this vault has a lot
of audio/video and the push runs over VPN or a slow link, read
`migration/findings.md` §4.2 and §7 before starting a bulk import
and budget the time accordingly (or run the import from the server's own
network).

## 6. Bulk-import specific: rate limits

Doing a first-time push of a large vault (hundreds of notes) will run into
Outline's per-endpoint rate limit — 25 requests/minute by default, confirmed
against a live instance. See `migration/findings.md` §4.1 for the
exact numbers and the `RATE_LIMITER_MULTIPLIER` env var to raise it for the
import window. Nothing to fix in the vault itself here — just don't be
surprised by a slow first run, and consider raising the multiplier ahead of
time if you control the server.

## 7. Dry-run before the real push

1. Point the plugin (or the CLI) at a **throwaway test collection** first,
   not the destination collection.
2. Push a representative slice — one folder with a mix of note sizes,
   at least one of every attachment type present in the vault, at least one
   pair of same-titled notes if any exist, one callout, one code fence
   containing triple backticks, one wiki-link to a not-yet-pushed note.
3. Open the results in Outline and check: callout types render as expected,
   attachments that should be inline images actually are, attachments that
   should be file-link cards are, wiki-links resolved, nothing shows
   `*(Image not found: ...)*` or `%%WIKILINK[...]%%` (an unresolved-link
   marker that leaked through).
4. Only then point at the real collection and push the full vault.

## Checklist

- [ ] Inventoried every file extension in the vault (§1)
- [ ] Archived or converted `.canvas` / `.excalidraw.md` / other unsupported formats (§2)
- [ ] Searched for `dataview` / Templater syntax and decided what to do with each hit (§2)
- [ ] Confirmed every note's frontmatter block is a single, cleanly-closed `---` block (§3)
- [ ] Renamed any note whose real title lives in `title:` frontmatter, not the filename (§3)
- [ ] Checked for duplicate note basenames across folders and disambiguated the ones that matter (§4)
- [ ] Confirmed the target Outline instance's actual `FILE_STORAGE_UPLOAD_MAX_SIZE` (§5)
- [ ] Flagged any attachment near or over that size (§5)
- [ ] Read the throughput notes in `migration/findings.md` if this vault has significant audio/video (§5)
- [ ] Raised `RATE_LIMITER_MULTIPLIER` (or accepted the wait) for a large first import (§6)
- [ ] Ran a dry-run push into a test collection and eyeballed the result (§7)

Sources consulted: [Outline formatting guide](https://docs.getoutline.com/s/guide/doc/formatting-kn6wBtxlQ1), [Outline file storage / self-hosting docs](https://docs.getoutline.com/s/hosting/doc/file-storage-N4M0T6Ypu7).
