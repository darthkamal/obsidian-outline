# Prep scripts

Read-only vault scanners (plus one reversible archiver) backing
`../prep.md` (`migration/prep.md` from the repo root). Bash 3.2+ compatible,
no Node/npm required, works on macOS and Linux `find` (GNU, BSD, or `bfs`).

Run the orchestrator, or any script standalone:

```bash
./prep-scan.sh /path/to/vault > outline-prep-report.md
```

## Scripts

| Script | Reads/writes | Purpose |
| --- | --- | --- |
| `lib.sh` | — | Shared helpers, sourced by every script below. Not run directly. |
| `01-inventory.sh` | read-only | Extension counts and total bytes, vault-wide. |
| `02-find-unsupported-content.sh` | read-only | `.canvas` files, `.excalidraw.md` notes, `dataview` blocks, Templater `<% %>` tags. |
| `03-check-frontmatter.sh` | read-only | Notes with a suspicious mid-block `---` that could break the frontmatter round-trip. |
| `04-find-duplicate-titles.sh` | read-only | Basenames shared by notes in different folders (wiki-link resolution is basename-only). |
| `05-check-attachments.sh` | read-only | Embeds with an unsupported extension, embeds pointing at a missing file, attachments over a size threshold (default 20MB, pass a second arg to change it). |
| `06-archive-unsupported.sh` | **writes** (dry-run by default) | Moves `.canvas` / `.excalidraw.md` files into `<vault>/.outline-prep-archive/`. Dot-prefixed, so the plugin's walker skips it automatically. Nothing is deleted; pass `--apply` to actually move, otherwise it only prints what it would do. |
| `prep-scan.sh` | read-only | Runs `01`–`05` and prints one combined report. Does not call `06` — that's the one script with side effects, run it separately after reviewing the report. |

Every script exits `0` on a completed scan (regardless of what it found) and
non-zero only if the given path isn't a directory. Don't infer "problems
found" from the exit code — read the output.

## What these scripts do *not* do

They don't edit note content, rename files, or touch anything outside
`.outline-prep-archive/`. Findings in sections other than the canvas/
excalidraw list (duplicate titles, malformed frontmatter, unsupported/
missing/oversized attachments) are for a human or an operator's explicit
decision — see `../RUNBOOK.md` (`migration/RUNBOOK.md` from the repo root)
for how those are meant to be handled in an unattended run.
