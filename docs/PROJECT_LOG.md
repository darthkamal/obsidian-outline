# Project log — fix/self-hosted-sync

Running log of work on this branch, for picking the thread back up later.
Newest entry on top.

---

## 2026-08-11 (later) — migration prep kit + interrupted review resolved

### The interrupted `/code-review` finished
The review flagged as interrupted in the entry below finished in the
background and reported 10 findings against the 8 uncommitted files. Not yet
triaged/fixed as of this entry — top three by severity, for whoever picks
this up:

1. **`src/pipeline/code-regions.ts:11`** — `FENCE_RE`'s new `(.*)$` never
   matches `\r`, so a CRLF-terminated fence line fails to match at all. On a
   CRLF-saved note, `fencedLineFlags` never marks a fenced block as code, so
   every other transformer (wiki-links, TOC, callouts, images) treats its
   contents as regular text and rewrites them — the exact bug class commit
   `c9175c6` fixed for LF files, reintroduced for CRLF by this diff.
2. **`src/outline-client.ts:44`** — the retry/backoff and cause-unwrapping
   fixes from commit `9896a2c` landed only in `OutlineClientNode` (the
   Node/CLI client). The Obsidian plugin's actual upload path
   (`OutlineClient`, used by `push-engine.ts`/`main.ts`) still gets exactly
   one upload attempt with no cause unwrapping — the bug the commit's own
   message describes as fixed is still live for real plugin users, just not
   for the CLI.
3. **`src/sync/sync.ts:209`** — when the post-image `updateDocument` throws,
   `syncDocument` writes frontmatter and rethrows but never returns a
   result, so `syncNode` in `syncFolder` never learns the real
   `documentId`. Every child under that note attaches to the wrong parent
   (or none) for the rest of that run. Before this diff `updateDocument`
   never threw, so this cross-ref breakage is newly introduced by making it
   throw.

Full 10-finding list is in the task output; ask to have it re-surfaced if
picking this up fresh. `src/utils/content-type.ts`'s allowlist restriction
(finding 4) is very likely *not* a bug — it's the documented, intended
trade-off from `migration/prep.md` §0 (unsupported extensions like `.heic` were
being uploaded before with a generic content-type; now they're correctly
left as unresolved links instead) — but worth a second look before
dismissing outright given the reviewer flagged it as a regression.

### Migration prep kit added
Built out from a plain request to "prep any vault for migration" into a full
handoff package, since the intended user is an on-device/local model running
this unattended:

- `migration/prep.md` — the "why", grounded in `src/` and in Outline's own docs
  (confirmed via `docs.getoutline.com`: 25MB default
  `FILE_STORAGE_UPLOAD_MAX_SIZE`, no documented callout/table/embed support
  beyond "all Markdown elements").
- `migration/scripts/` — `lib.sh` + 6 numbered scripts + `prep-scan.sh`
  orchestrator, bash 3.2-compatible (macOS ships 3.2, no associative
  arrays), portable across GNU find/BSD find/`bfs`. All read-only except
  `06-archive-unsupported.sh`, which is dry-run by default and only ever
  *moves* `.canvas`/`.excalidraw.md` into a dot-prefixed archive folder —
  reversible, nothing deleted, nothing rewritten.
- `migration/RUNBOOK.md` — the mechanical, no-judgment-calls procedure tying
  cleanup and the actual `npm run sync` push together, with a required-inputs
  table, an explicit safety boundary (no note content is ever auto-edited),
  and a troubleshooting table keyed to actual error strings from `run.ts`
  and `custom-instance.ts`.

All scripts were validated against a synthetic test vault (in scratchpad, not
committed) covering every edge case named in `prep.md`: duplicate titles
across folders, a dotted note title that must *not* false-positive as a
missing attachment, malformed mid-block frontmatter, canvas/excalidraw files,
dataview/Templater syntax, and oversized/missing/unsupported-extension
attachments. One real bug caught in testing: scripts had no explicit `exit
0`, so their exit status reflected whatever their last internal `grep`
happened to return rather than "did the scan complete" — fixed across all
seven scripts, since an automated caller branching on `$?` would have read a
clean scan as a failure.

### Open items for next session
1. Triage and fix the 10 code-review findings above (none applied yet).
2. The 8 `src/` files from the previous entry are still uncommitted and
   still carry the unresolved findings above. `migration/` (this kit) was
   committed and pushed separately — see the branch log.
3. Everything else from the previous entry still stands (audio decision,
   rate-limit tuning, the deferred existence-check bug).

---

## 2026-08-11

### Context
A 697-note real vault was pushed to a self-hosted Outline instance (v1.9.2)
to find bugs a small test vault couldn't. Full writeup, measurements, and
the deferred bug: `migration/findings.md`. 15 bugs found, 14
fixed, 1 deferred as an owner decision.

### Commits on this branch (oldest → newest)
- `3da267c` fix: repair wiki-link resolution and stop duplicating folder placeholders
- `187d862` feat: upload all attachment types, skip unchanged notes, ignore dot-directories
- `d14ea43` fix: detect changes by content hash, not modification time
- `c9175c6` fix(toc): do not strip TOC-looking lines inside code fences
- `9896a2c` fix: make failed pushes diagnosable and recoverable

(`git show <hash>` for full messages — each has the "what broke / why / fix" reasoning.)

### Uncommitted working tree (not yet committed)
These 8 files are the fixes from findings-doc §2.7 ("found by code review")
— reviewed but never committed:

| File | Change |
| --- | --- |
| `src/adapters/node.ts` | Validate the folder-index JSON shape before indexing; a truncated file parsing to `null` used to throw on first lookup. |
| `src/outline-api/outline-client-node.ts` | Attachment upload now retries 429/5xx with backoff instead of failing on the first non-ok response; genuine 4xx refusals still fail fast. |
| `src/pipeline/code-regions.ts` | Fence matching keeps the real backtick/tilde run length and requires the closing fence to carry no info string, so a ```` ``` ```` block wrapping a ``` example no longer closes early. |
| `src/pipeline/transformers/images.ts` + `src/utils/content-type.ts` | Embed→attachment detection uses a known-extension allowlist (`isAttachmentExtension`) instead of "any 1–10 char suffix", so dotted note titles (`![[Chapter 1.2]]`) resolve as document links, not missing attachments. |
| `src/plugin-ui/main.ts` | `folderDocIds` is cloned on load — it was sharing a reference with `DEFAULT_SETTINGS` and leaking state into the next load. |
| `src/push-engine.ts` | Single-file "Push to Outline" now always forces `skipUnchanged: false`; previously it could report success while doing nothing. |
| `src/sync/sync.ts` | Two fixes: (1) content hash now covers render-affecting options (`outlineUrl`, `removeToc`), so toggling them invalidates the skip-cache instead of leaving stale links; (2) a failed `updateDocument` no longer strands a note without `outline_id` — the error is captured, frontmatter is written, then it's rethrown. |

### Review status
`/code-review` was launched on this diff and hit the session's API rate
limit before finishing (resets 9pm Europe/Berlin) — **not a completed
review**. One finding was confirmed before it stopped:

- **CONFIRMED** — `main.ts` `folderDocIds` mutation-leak bug is real; the
  `{ ...this.settings.folderDocIds }` fix is correct.

Two further review angles were still in progress and never reported.
**Re-run `/code-review` on this diff before treating it as reviewed.**

### Verified today
- `tsc -noEmit -skipLibCheck`: clean
- `jest`: 177/177 passing, 13/13 suites
(Confirmed against the current working tree, including the uncommitted diff above — not copied from the findings doc, which predates it.)

### Open items for next session
1. Finish the interrupted `/code-review` pass on the 8 uncommitted files.
2. Commit the 8 files once review is clear (currently sitting uncommitted on a clean tree otherwise).
3. Decide on audio handling before the next full sync — 1.31 GB at ~130 KB/s sustained is ~3 hours and the direct cause of every attachment failure in the test run (findings §4.2, §7).
4. The render-affecting-options hash change means the *next* sync re-pushes all 697 notes and re-uploads every attachment — settle the audio decision first, or pay the transfer twice.
5. If running another bulk import: raise `RATE_LIMITER_MULTIPLIER` for the window, and run from the Outline server's own network if possible (findings §4.1, §7).
6. Deferred, not fixed: skip path trusts frontmatter without confirming the document still exists in Outline — deleting/moving a doc and re-running silently orphans its children. Needs an owner decision since fixing it changes `skipUnchanged`'s per-note API-call design (findings §3).
