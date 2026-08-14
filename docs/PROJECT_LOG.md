# Project log — fix/self-hosted-sync

Running log of work on this branch, for picking the thread back up later.
Newest entry on top.

---

## 2026-08-14 (late night) — v1.9.0: production-readiness pass and release

Repo history was pushed to `main` continuously throughout the day (see the
three entries below for what shipped); this entry covers the final polish
pass once the feature and its bugs were done.

- **Attribution** — `manifest.json`/`package.json` `author` changed from
  `defcon1702` to `Daniel Togun` (`authorUrl` → `https://github.com/darthkamal`).
  This is what Obsidian's Settings → Community plugins list shows. `LICENSE`
  copyright deliberately left as `defcon1702` — standard for a fork, and
  their original code is still substantially present.
- **Version** — bumped 1.8.0 → 1.9.0 across `package.json`, `manifest.json`,
  `versions.json`.
- **README** — repo links (install/clone instructions) repointed from the
  upstream `defcon1702/obsidian-outline` to this fork
  (`darthkamal/obsidian-outline`); added a full "Directory → collection
  sync" section documenting the new commands, the settings-tab UI, and the
  sync-log location. Also fixed stale German command names
  ("Push zu Outline" etc.) left over from before the plugin's UI strings
  were switched to English in 1.7.0 — a pre-existing doc bug, unrelated to
  this session's work, caught while touching the same section.
- **`CHANGELOG.md`** — new 1.9.0 entry summarizing the feature and every
  reliability fix below.
- **One more real bug, found by asking "what did we miss"** —
  `searchDocumentByTitle` had the identical error-swallowing ambiguity
  already fixed in `getDocument` (see the entry below) but never applied
  here: a genuine "no match" 200 response and a 401/429/network failure
  both collapsed to `null`, so a caller could create a document that
  duplicates one a failed search merely didn't find. Same fix, same
  contract — `null` now means "search ran, found nothing" only, anything
  else throws. `migration/findings.md` §2.10,
  `tests/searchDocumentByTitleErrorHandling.test.ts`.

250/250 tests, `tsc` clean, `prettier` clean, production build (`npm run
build`) verified and redeployed to the real vault at
`/Users/darthkamal/Projects/Obs` for install.

## 2026-08-14 (night) — two real bugs found via live testing, plus an ultrareview pass, plus manual data cleanup

The directory-collection-sync feature (previous entry) was code-reviewed and
tested automatically, but nobody had actually opened Obsidian and clicked
through it yet — every implementer subagent explicitly said so. Once
real usage started, two genuine bugs surfaced immediately, both diagnosed
against live Outline data via direct API calls (`curl` + `documents.list` /
`documents.info` / `documents.search`), not guessed.

1. **Wrong-collection push** — a mapped folder's right-click menu showed
   both "Push folder to Outline" (the old ad-hoc command, silently uses the
   already-configured default collection with zero prompt) and "Sync to
   Outline" (the new one, uses the mapping's own collection) side by side.
   The user clicked the familiar one by habit: confirmed against the live
   Outline instance that several notes were _updated_ in the old default
   collection at the exact sync timestamp, while the newly-mapped
   collection had zero documents. No data was lost — those were updates to
   already-existing documents, not destructive writes. Fixed
   (`1b3175e`): the ad-hoc menu item is now hidden entirely once a folder
   is mapped, and the command-palette equivalent refuses with a Notice
   pointing at the right command instead of silently pushing to the wrong
   place. Extracted `findMapping()` to replace three copies of the same
   lookup.
2. **Concurrent-sync race creating duplicate folder placeholders** — a
   second, worse bug surfaced on the very next test: re-syncing the same
   folder created a _second_ copy of several folder/note placeholders
   inside Outline (`Business Ideas`, `Digital`, and children created 35ms
   apart — confirmed via `documents.info` `createdAt` timestamps, too
   tight to be two separate clicks). Root cause: nothing stopped the same
   mapped directory being synced twice at once — a double-click, or
   `syncMappedDirectory` firing while `syncAllMappedDirectories` was
   already processing the same directory — and two concurrent `syncFolder`
   runs each saw "no placeholder yet" for the same folder (`folderDocIds`
   is only written back after a run finishes) and both created one. Fixed
   (`12c8029`): a `Set<string>` of in-flight directory paths on
   `PushEngine`; a second sync attempt on a directory already syncing is
   refused with a Notice instead of racing. Independent directories still
   sync in parallel.
3. **Manual cleanup of the live Outline duplicates** — the race above (and
   an earlier still-running instance of the pre-fix code that kept creating
   more duplicates even after a plugin reload, until Obsidian was fully
   quit and restarted) had already left real duplicate documents in the
   user's "Business" collection: 123 documents at one point, several
   branches duplicated wholesale (the entire "Business Ideas / Digital"
   numbered-files subtree, plus a few smaller "Nigeria / Care" branches).
   Cleaned up by hand via the Outline API (`documents.delete`, soft
   delete/trash — recoverable, never `permanent: true`): for each
   duplicate-root pair (same title, same parent, parent itself not
   duplicated), kept the larger/more-complete subtree or the earlier-created
   copy when sizes matched and content was verified byte-identical, deleted
   the other. Iterated to a stable, zero-duplicate state (verified twice,
   15–20s apart, to rule out a still-running background sync). Also patched
   the local `folderDocIds` cache in `data.json` to point at the surviving
   IDs instead of the deleted ones — not strictly required (the fixed
   `getDocument` correctly treats a trashed doc as "confirmed gone" and
   self-heals via search on the next run) but avoids an unnecessary
   recreate-and-search round trip. A follow-up sync after this cleanup was
   independently re-verified clean: zero same-parent/same-title duplicates,
   and every consolidated branch still pointed at the correct survivor.
4. **`/ultrareview` cloud pass** on the merged branch found two more real
   bugs, both fixed and tested (`12337a2`):
   - Pass-2 wiki-link-resolution failures (a note pushed with a literal
     `%%WIKILINK[...]%%` marker whose follow-up "replace with a real link"
     call then failed) were never counted in `result.failed` or
     `result.failedFiles` — unlike the structurally identical pass-1
     failure path. Every caller keyed off `result.failed`
     (`summarizeResult`'s success toast, the JSON sync log's `failures[]`,
     `syncAllMappedDirectories`'s "synced cleanly" count) reported a clean
     run while a note sat live in Outline with raw marker text. Fixed with
     `success--`/`failed++` in the pass-2 catch block, so the totals stay
     internally consistent instead of double-counting.
   - The JSON sync log's `append()` was a non-atomic read-modify-write
     across three `await` points with no serialization; two syncs
     finishing close together could each read the log before either wrote
     it, silently dropping one entry. Fixed with a single-slot promise
     chain so concurrent appends serialize.

## 2026-08-14 (evening) — directory-to-collection sync feature shipped

Full cycle: brainstormed with the user (architectural-path questions on
mapping method, directory scope, triggers, ad-hoc-push coexistence, sync-log
design, CLI scope), wrote a design spec
(`docs/superpowers/specs/2026-08-14-directory-collection-sync-design.md`),
wrote a 10-task TDD implementation plan
(`docs/superpowers/plans/2026-08-14-directory-collection-sync.md`), then
executed it with subagent-driven-development in an isolated worktree — one
implementer subagent per task, a task-scoped reviewer after each, one fix
round where needed.

**What shipped:** map a top-level vault folder to its own dedicated Outline
collection (found by name or created automatically); sync just that folder
or all mapped folders at once, always overwrite, no repeated conflict
prompt; a capped (200-entry) JSON sync log at
`.obsidian/plugins/obsidian-outline-sync/sync-log.json`; a settings-tab
section to manage mappings. New: `src/collection-resolver.ts`,
`src/plugin-ui/sync-log-writer.ts`, `PushEngine.mapDirectory` /
`.syncMappedDirectory` / `.syncAllMappedDirectories`, three new commands
plus matching context-menu items. `SyncResult` gained a `failedFiles` field
along the way (`syncNode`'s per-note catch block already computed the error
and path, just never retained them).

**Two implementer-found bugs in the plan's own text**, fixed additively
without touching implementation logic (both documented in the plan's task
briefs for anyone re-reading the plan later): the brief's test `obsidian`
mock was missing `Modal`/`Setting` exports, crashing any test importing
`push-engine.ts` at module load (it transitively imports
`conflict-modal.ts`); and several brief test literals spread
`DEFAULT_SETTINGS` without their own `directoryMappings` array, hitting the
exact shared-mutable-array footgun `normalizeSettings()` exists to prevent.

**Final whole-branch review** (dispatched on the most capable model, per the
SDD process) found one Critical bug no per-task review could see:
`skipUnchanged` never checked the target collection, only the content hash
— so mapping an already-pushed directory to a new collection silently
skipped every unchanged note and reported success. This was the feature's
headline use case. Fixed with a collection-match check added to the skip
condition in `syncDocument` (`src/sync/sync.ts`), plus four Important
findings in the same fix wave: `syncMappedDirectory` was missing the
`validateConfig()` guard every sibling method has; the sync log's
`failures[]` array was unbounded (capped at 50 with a `failuresTruncated`
count); a missing mapped folder was only `console.error`'d, invisible to
the user (now surfaced in the aggregate Notice); and a corrupted
`data.json` could crash the whole plugin on load if `directoryMappings`
wasn't an array (guarded). Two more findings — Outline's 100-collection
`listCollections` page cap risking a duplicate past 100 collections, and no
handler for a mapped directory being renamed in Obsidian — were
deliberately **not** fixed, just disclosed as code comments (matching this
codebase's established convention for accepted tradeoffs), since both are
real scope additions (pagination logic, a new vault event listener) beyond
a mechanical fix.

241/241 tests at merge time, `tsc` clean, `prettier` clean.

## 2026-08-14 (afternoon) — self-hosted sync reliability: three more real bugs closed

Picked up the loose ends from the entries below plus new findings from a
fresh code review of the branch's own diagnosability work.

1. **`getDocument` swallowed every failure into the same `null`** — a
   confirmed 404 and a 401/429/network failure were indistinguishable. Two
   call sites this branch introduced (a skip-recovery check, a
   folder-placeholder existence check) treated any `null` as "confirmed
   gone" and could recreate or duplicate a document that was actually just
   unreachable for one check. Fixed: `null` now means "confirmed gone"
   (404) only; anything else throws, and each caller decides what
   "couldn't tell" means for its own case. `migration/findings.md` §2.9,
   `tests/getDocumentErrorHandling.test.ts`.
2. **The "745 documents vs. 735 derived from the run log" mystery**
   (`migration/findings.md`, previously an open item) — explained by code
   audit: `syncFolder` creates a real Outline document for every folder
   with no `index.md` (a placeholder so the hierarchy survives) but never
   counted it anywhere, so the collection's live document count was
   silently higher than any run's own reported total. Fixed:
   `SyncResult.foldersCreated`, surfaced separately in both the CLI and
   plugin summaries.
3. **Skip-path existence check for parent-role notes** (previously
   deliberately deferred as an owner decision) — fixed with a narrower
   scope than originally proposed: only re-verify a skipped note when it
   also parents other documents, so the common case (leaf notes) stays as
   cheap as `skipUnchanged` is meant to be.
4. Also in this pass: document create/update now retries on 5xx and
   network exceptions, not just HTTP 429; the "overwrite an existing
   duplicate" branch in `syncDocument` now attaches `partialResult` on
   failure (previously only the post-image update branch did, an
   asymmetry a review caught); a per-upload timeout on both transports so
   a stalled attachment fails fast instead of hanging indefinitely; two
   bugs fixed in `migration/scripts/07-duplicate-title-risk.sh` (an
   over-broad self-exclusion was hiding genuine cross-links between
   duplicate-titled notes; an unanchored substring match was over-counting
   unrelated titles sharing a prefix).

## 2026-08-11 (evening) — all 10 code-review findings fixed and verified

All findings from the entry below are now applied. `tsc -noEmit`, `prettier
--check` on `src`/`tests`, and the full jest suite (186/186, up from 177) all
pass with the fixes in place.

1. **CRLF fence bug** — fixed at two levels: `pipeline/context.ts` now
   normalizes CRLF→LF once at the pipeline's entry point (mirroring the
   precedent in `content-hash.ts`), and `code-regions.ts`'s `FENCE_RE` plus
   `callouts.ts`'s two callout regexes were also hardened directly
   (`(.*)$` → `(.*?)\r?$`), since those functions are called directly by
   tests and potentially other callers, not only through the pipeline.
   Regression tests added in `regressions.test.ts`.
2. **Plugin upload path had no retry** — the retry/backoff + cause-unwrapping
   logic was extracted from `OutlineClientNode` into a shared
   `OutlineApiBase.retryUpload()`, and both `OutlineClientNode` (Node/CLI,
   fetch) and `OutlineClient` (Obsidian plugin, `requestUrl`) now build a
   transport-specific single-attempt callback and delegate retry policy to
   it. This also resolves finding 5 (the two clients previously had
   independently-drifting retry policies) as a side effect of sharing one
   implementation. New test file `outlineClientRetry.test.ts` — there was
   previously **zero** test coverage on `OutlineClient`, which is very
   likely why this gap went unnoticed for as long as it did.
3. **`documentId` lost on partial failure** — `syncDocument` now attaches a
   `partialResult` (the real, already-created document id) to the error it
   throws when only the post-image content push fails. `syncFolder`'s catch
   block reads it back to set `nextParentId` correctly instead of losing the
   parent relationship for the rest of the run. Regression test in the new
   `syncFolderParentRecovery.test.ts`.
4. **Attachment allowlist gap** — confirmed as the intended trade-off (see
   `migration/prep.md` §0), not a bug. Mitigated impact by adding `heic`,
   `heif`, `tiff`, `tif` to the attachment map (as file-link attachments, not
   inline images — poor browser support for inline HEIC/TIFF rendering).
5. **Duplicate upload retry policies** — resolved by sharing `retryUpload`
   (see #2).
6. **Triplicated error-message extraction** — `extractApiMessage()` added to
   `utils/errors.ts`, replacing three separate inline copies across
   `custom-instance.ts` (×2) and `outline-api-base.ts` (×1).
7. **Stale `'Update failed'`/`'Create failed'` throws** — reworded to
   `'Outline returned success but no document data'`, since real failures
   now throw earlier with a real status/message; these only ever guard the
   narrow 200-with-empty-body case.
8. **Two variables tracking one decision** — `retriableAttachmentFailures`
   (a counter, only ever used as a boolean) and `finalUpdateError` collapsed
   into a single `pushIncomplete` flag set from every failure source, so a
   future failure mode can't update only one and silently reintroduce the
   "incomplete push recorded as complete" bug.
9. **CRLF frontmatter round-trip** — `updateLocalFrontmatter` in
   `adapters/node.ts` now captures and reuses the frontmatter block's own
   line-ending style for every newline it introduces, instead of hardcoding
   `\n`. Regression test added to `rateLimit.test.ts`.
10. **Sequential attachment uploads, no concurrency** — deliberately **not**
    changed. The measured bottleneck (`migration/findings.md` §4.2) is
    sustained upload throughput on a slow link (~130KB/s), not request
    latency; concurrent uploads would split one constrained pipe between
    transfers instead of speeding it up. Left a comment at the call site
    explaining this so it isn't "fixed" into something worse later.

### Open items for next session

1. Everything is now committed and pushed — nothing left uncommitted on this
   branch as of this entry.
2. Audio decision, rate-limit tuning for the next bulk import, and the
   deferred skip-path existence-check bug (`migration/findings.md` §3) are
   still open, unrelated to this fix pass.

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
(finding 4) is very likely _not_ a bug — it's the documented, intended
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
  _moves_ `.canvas`/`.excalidraw.md` into a dot-prefixed archive folder —
  reversible, nothing deleted, nothing rewritten.
- `migration/RUNBOOK.md` — the mechanical, no-judgment-calls procedure tying
  cleanup and the actual `npm run sync` push together, with a required-inputs
  table, an explicit safety boundary (no note content is ever auto-edited),
  and a troubleshooting table keyed to actual error strings from `run.ts`
  and `custom-instance.ts`.

All scripts were validated against a synthetic test vault (in scratchpad, not
committed) covering every edge case named in `prep.md`: duplicate titles
across folders, a dotted note title that must _not_ false-positive as a
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

| File                                                                | Change                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/adapters/node.ts`                                              | Validate the folder-index JSON shape before indexing; a truncated file parsing to `null` used to throw on first lookup.                                                                                                                                                                                                   |
| `src/outline-api/outline-client-node.ts`                            | Attachment upload now retries 429/5xx with backoff instead of failing on the first non-ok response; genuine 4xx refusals still fail fast.                                                                                                                                                                                 |
| `src/pipeline/code-regions.ts`                                      | Fence matching keeps the real backtick/tilde run length and requires the closing fence to carry no info string, so a ` ``` ` block wrapping a ``` example no longer closes early.                                                                                                                                         |
| `src/pipeline/transformers/images.ts` + `src/utils/content-type.ts` | Embed→attachment detection uses a known-extension allowlist (`isAttachmentExtension`) instead of "any 1–10 char suffix", so dotted note titles (`![[Chapter 1.2]]`) resolve as document links, not missing attachments.                                                                                                   |
| `src/plugin-ui/main.ts`                                             | `folderDocIds` is cloned on load — it was sharing a reference with `DEFAULT_SETTINGS` and leaking state into the next load.                                                                                                                                                                                               |
| `src/push-engine.ts`                                                | Single-file "Push to Outline" now always forces `skipUnchanged: false`; previously it could report success while doing nothing.                                                                                                                                                                                           |
| `src/sync/sync.ts`                                                  | Two fixes: (1) content hash now covers render-affecting options (`outlineUrl`, `removeToc`), so toggling them invalidates the skip-cache instead of leaving stale links; (2) a failed `updateDocument` no longer strands a note without `outline_id` — the error is captured, frontmatter is written, then it's rethrown. |

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
4. The render-affecting-options hash change means the _next_ sync re-pushes all 697 notes and re-uploads every attachment — settle the audio decision first, or pay the transfer twice.
5. If running another bulk import: raise `RATE_LIMITER_MULTIPLIER` for the window, and run from the Outline server's own network if possible (findings §4.1, §7).
6. Deferred, not fixed: skip path trusts frontmatter without confirming the document still exists in Outline — deleting/moving a doc and re-running silently orphans its children. Needs an owner decision since fixing it changes `skipUnchanged`'s per-note API-call design (findings §3).
