# Self-hosted sync: findings from a real-vault test

Test target: a 697-note Obsidian vault (`Comedy`) pushed to a self-hosted Outline
instance (v1.9.2) over a VPN link. Everything below was measured, not inferred;
where a conclusion rests on inference it says so.

## Summary

|                                              |                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| Documents synced                             | 697 / 697                                                               |
| Attachments uploaded                         | 146 / 147                                                               |
| Bugs found in the plugin                     | 15 (14 fixed, 1 deferred)                                               |
| Root cause of the original 51 lost documents | API rate limiting, invisible because errors were swallowed              |
| Root cause of the remaining lost attachment  | ~1 Mbit sustained upload throughput, server closes the connection first |

The single most useful outcome: **a 5-note test vault would have found none of
this.** Every defect below needed either scale (rate limits), real attachment
sizes (upload timeouts), or messy real-world notes (dotted filenames, glued
frontmatter delimiters).

## 1. The vault

|                                            |                     |
| ------------------------------------------ | ------------------- |
| Markdown notes                             | 697                 |
| Total files                                | 3,707               |
| Directories                                | 390                 |
| Audio on disk                              | 160 `.mp3`, 1.31 GB |
| Attachment references resolved by the sync | 147                 |
| Largest single attachment                  | 48.5 MB             |

Notable shapes that mattered: 332 notes share a title with another note (all in
different folders, so no collision); `Archive 2` / `Compendium 2` exist but are
empty; dot-directories (`.git`, `.claude`, `.superpowers`) are correctly skipped.

## 2. Bugs found and fixed

### 2.1 Silent error swallowing (4 sites)

The defining bug. Every API failure collapsed to `null` or `false`, discarding
the status and the server's message.

| Location                                 | Was                                        | Now                                 |
| ---------------------------------------- | ------------------------------------------ | ----------------------------------- |
| `outline-api-base.ts` `createDocument`   | `catch { return null }`                    | throws with status + server message |
| `outline-api-base.ts` `updateDocument`   | `catch { return null }`                    | throws with status + server message |
| `outline-api-base.ts` `createAttachment` | `catch { return null }`                    | still degrades, but logs the reason |
| `outline-client-node.ts` upload          | `return res.ok` / `catch { return false }` | logs status or transport error      |

Downstream this produced 51 identical `Create failed` strings with no way to
distinguish a 429 from a 401 from a dropped socket. Diagnosis required replaying
requests by hand with `curl`.

### 2.2 Retry too weak, and unreportable

`custom-instance.ts` already retried 429s honouring `Retry-After` — three
attempts. Against a sustained 2x overload that was not enough. Two further
problems: the 429 branch `continue`s _before_ the logging block, so 429s were
never logged at all; and exhaustion threw a generic `Max retries exceeded`
carrying no status.

Fixed: `MAX_RETRIES` 3 → 5, last status/message remembered across attempts and
reported on exhaustion, and a warning emitted while waiting.

### 2.3 Attachment upload had no retry at all

Document writes went through `customInstance` and its retry. The attachment byte
upload (`files.create`) did not — it had exactly one attempt. Now 3 attempts with
linear backoff for _transport_ failures; an HTTP refusal (4xx) still fails fast,
since retrying a decision is pointless. 429/5xx do retry.

### 2.4 Incomplete pushes recorded as complete

**The most damaging bug.** A note whose document was created but whose attachment
upload failed still had its `outline_content_hash` written. The next run hashed
identical, skipped the note, and the `*(Upload failed: ...)*` placeholder became
permanent. 15 notes were in this state.

Fixed: the hash is omitted when a _retriable_ attachment failure occurred, and
both adapters clear a stale hash. A missing-from-vault file is deliberately not
counted — it would be missing next run too and would block the hash forever.

### 2.5 Frontmatter writer edited note body content

`updateLocalFrontmatter`'s closing-delimiter regex did not require `---` to be
alone on its line. A note ending its frontmatter with `---%%` had the `%%` pushed
onto a line of its own. One file of 646, and arguably harmless, but the function
has no business touching body content. Fixed by capturing and preserving trailing
text on the delimiter line.

### 2.6 `fetch failed` hid its cause

Node's fetch collapses every transport problem into the literal string
`fetch failed` and puts the real reason on `error.cause`. Four consecutive runs
logged nothing more useful. `getErrorMessage` now unwraps the cause, turning it
into `fetch failed (other side closed)`.

### 2.7 Found by code review

- **`images.ts`** — the embed regex treated any 1–10 char alphanumeric suffix as
  an attachment extension, so dotted note titles (`![[Chapter 1.2]]`,
  `![[Meeting 2024.01]]`) were captured as attachments, never resolved, and
  rendered `*(Image not found)*` instead of becoming document links. Now backed
  by the content-type map.
- **`code-regions.ts`** — fence length was discarded, so a ` ``` ` block
  wrapping a ``` example closed at the inner fence. Callouts, TOC lines and
  embeds inside such blocks were mangled — the exact case the module exists to
  prevent. Fences now keep their real run.
- **`sync.ts`** — regression introduced by 2.1: making `updateDocument` throw
  meant a failed post-attachment update escaped _before_ `writeFrontmatter`,
  stranding the note with no `outline_id` so the next run would duplicate it.
  The error is now captured, the id written, then rethrown.
- **`sync.ts`** — the content hash covered only the note body, so changing
  **Public URL** or **Remove TOC** left every synced note looking unchanged with
  links pointing at the old base URL. Render-affecting options are now hashed.
- **`push-engine.ts`** — an explicit "Push to Outline" on an unchanged note did
  nothing while reporting success. Single-file push now forces a push.
- **`main.ts`** — `folderDocIds` shared a reference with `DEFAULT_SETTINGS`,
  leaking state into the next load.
- **`node.ts`** — the folder-index JSON was not validated; a truncated file
  parsing to `null` threw on the first lookup.

### 2.8 Found from a real report: dangling `%%WIKILINK[...]%%` markers in pushed notes

Same class as 2.4, missed the first time because it lives in a different pass.
Pass 1 pushes a newly cross-linked note with a literal `%%WIKILINK[target|
display]%%` marker (`preserveUnresolved: true`); pass 2's follow-up
`updateDocument` is supposed to replace it with a real link. If that follow-up
call fails, the note was left live in Outline with the raw marker text — and
`outline_content_hash` was already written during pass 1, _before_ pass 2 ran,
so `skipUnchanged` treated the note as fully synced forever. No second chance,
and the failure wasn't even counted in the run's final tally.

Fixed: a failed pass-2 update now clears the note's local content hash, so the
next run retries it for real instead of skipping it (`src/sync/sync.ts`,
covered by `tests/syncFolderCrossRefFailureRetry.test.ts`).

**This does not retroactively fix notes already pushed before the fix
existed** — their local hash is already stale-but-matching, same as any other
note. A one-time forced full re-push (`SKIP_UNCHANGED=false`, or the
`skipUnchanged` toggle off in plugin settings) re-renders and re-checks every
note once; by then most cross-linked targets already have a real `outline_id`
on disk, so pass 1 resolves them directly without needing pass 2 to rescue
anything. To gauge scope first without re-pushing: search the Outline
collection itself for `WIKILINK[` — every hit is a note still carrying the bug.
`(Image not found:` and `(Upload failed:` are a different, expected category
(documented placeholders for a genuinely missing file or a failed upload, not
this bug) and are not fixed by a re-push unless the underlying file or
attachment issue is fixed first.

### 2.9 `getDocument` swallowed every failure into the same null

Found in review of the fixes above: `getDocument` returned `null` for a
confirmed 404 _and_ for a 401, a 429 that survived its own retries, or a
dropped connection -- indistinguishable to every caller. Two call sites
introduced by this branch (the skip-recovery check in §3, and the
folder-placeholder existence check) treated any `null` as "confirmed gone"
and would recreate or duplicate a document that was actually just
unreachable for one check.

Fixed: `getDocument` now returns `null` only for a confirmed 404; anything
else throws. Each caller decides what "couldn't tell" means for its own
case rather than guessing -- the skip-recovery and folder-placeholder checks
both now trust the last-known-good state on an unconfirmed error instead of
assuming deletion, while the main duplicate-detection call (`syncDocument`)
lets the throw fail that one note's push for the run, retriable next time,
rather than silently falling through to a title search that might not find
it either. Covered by `tests/getDocumentErrorHandling.test.ts`.

### 2.10 `searchDocumentByTitle` had the identical ambiguity, missed at the time

Flagged when 2.9 was fixed but not applied until a later production-readiness
pass: `searchDocumentByTitle` swallowed every failure -- a genuine "no match"
200 response _and_ a 401, an exhausted 429, a dropped connection -- into the
same `null`. Every caller (the main duplicate check in `syncDocument`, the
folder-placeholder search fallback) treated `null` as "confirmed no
duplicate" and could create a document that duplicates one the search merely
failed to find.

Fixed with the identical contract as 2.9: `null` now means "search ran,
found nothing" only; anything else throws. Covered by
`tests/searchDocumentByTitleErrorHandling.test.ts`.

## 3. Bug found, then fixed for the case that actually breaks a sync

**The skip path trusts frontmatter without confirming the document still
exists.** Delete or move a document in Outline and re-run: the note is never
recreated, is reported as "unchanged", and `nextParentId` is set to the dead id
so every child under it fails to create.

Originally deferred: fixing this in general needs a `documents.info` call per
skipped note, which changes the performance design of `skipUnchanged` — the
feature exists precisely to avoid per-note API calls.

Fixed with narrower scope instead: a skipped note only needs re-verifying when
it also parents other documents (a folder's `index.md`) — that's the only case
where a stale id cascades into failures for notes that never even changed.
Leaf notes, the overwhelming majority of any vault, are still skipped with no
extra API call. A parent-role note found missing is recreated in place before
its children sync, rather than left to fail (`src/sync/sync.ts` `syncNode`,
covered by `tests/syncFolderSkippedParentRecovery.test.ts`).

## 4. Infrastructure findings

### 4.1 Rate limiting: 25 requests/minute, per endpoint

The server was reporting exactly what was needed the whole time; the client threw
it away:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 51.11
RateLimit-Limit: 25
RateLimit-Remaining: 0
RateLimit-Reset: Tue Aug 11 2026 15:42:08 GMT
```

Confirmed identical on `documents.create` and `attachments.create`. The sync was
pushing ~48/min — roughly double the budget.

**Relevant configuration** (verified against Outline's `.env.sample`, not
guessed):

| Variable                       | Default | Effect                                                                                                    |
| ------------------------------ | ------- | --------------------------------------------------------------------------------------------------------- |
| `RATE_LIMITER_MULTIPLIER`      | `1`     | Multiplier on the **hardcoded per-endpoint** limits — this is the one that matters for the 25/min ceiling |
| `RATE_LIMITER_ENABLED`         | `true`  | Master switch                                                                                             |
| `RATE_LIMITER_REQUESTS`        | `1000`  | Global budget across all requests                                                                         |
| `RATE_LIMITER_DURATION_WINDOW` | `60`    | Window in seconds                                                                                         |

For a bulk import, raising `RATE_LIMITER_MULTIPLIER` is the targeted change. At
the default, a cold 697-note sync needs ~30 minutes of pure waiting even with
perfect client-side pacing.

### 4.2 Upload throughput: ~130 KB/s sustained

Measured with no concurrency, fresh upload slots:

| Size  | Result           | Effective rate |
| ----- | ---------------- | -------------- |
| 1 MB  | 200 OK in 0.28 s | 3.7 MB/s       |
| 5 MB  | 200 OK in 0.65 s | 8.0 MB/s       |
| 11 MB | 200 OK in 80.9 s | 143 KB/s       |
| 14 MB | timeout at 120 s | 116 KB/s       |
| 21 MB | timeout at 120 s | 137 KB/s       |

Small uploads look fast because they fit in socket buffers and return before the
bytes land. Anything large enough to expose _sustained_ throughput runs at
~130 KB/s — about 1 Mbit/s. `fetch failed (other side closed)` is the server
timing out a connection that is crawling, not a size limit.

This is not a client-library issue: a hand-built single-Buffer multipart body
with explicit `Content-Length` took 200 s where `FormData` took 227 s, and
**curl took 254 s on the same file**.

Throughput also _degraded_ during the session: run 1 moved 1.31 GB in ~40 min
(~550 KB/s); later measurements were ~130 KB/s. Cause unidentified.

### 4.3 Upload size ceiling

`FILE_STORAGE_UPLOAD_MAX_SIZE` — Outline's `.env.sample` on `main` shows
`262144000` (250 MB), while the hosting docs page states `26214400` (25 MB).
Worth confirming which applies to this deployment: the vault's largest
attachment is 48.5 MB, which clears one value and not the other.

## 5. Outline behaviour findings

### 5.1 Attachments render as download cards, not players

Three markdown syntaxes were sent to the instance and read back:

| Sent                        | Stored back                         |
| --------------------------- | ----------------------------------- |
| `[file.mp3](url)`           | `[ file.mp3](url)`                  |
| `[file.mp3](url "9371648")` | `[ file.mp3](url)` — size discarded |
| `![file.mp3](url)`          | `![file.mp3](url)`                  |

The leading space is Outline's own serialization of an attachment node, i.e. the
plain-link form **is** recognised as an attachment. But the size hint is
stripped, so there is no richer embed reachable through the API. A download card
is the ceiling for audio.

Outline's changelog documents an **embedded video player** for uploaded videos
and generic **file attachments**; no audio player is documented, and none was
reproducible here.

Consequence: 1.31 GB of audio buys download cards that cannot be played inline,
and attachments never appear in the document tree — only inside notes.

### 5.2 The official MCP server is present but not a sync transport

The instance exposes the official MCP server at `/mcp` (v1.9.2, 19 tools,
OAuth discovery live). It is **not** an alternative for this plugin:

- It is a facade over the same API and inherits the same 25/min limiter.
- `create_attachment` returns a pre-signed URL and instructs the caller to
  upload "via a multipart POST request (e.g. with curl)" — bytes never travel
  through MCP.
- MCP clients are agent runtimes; an Obsidian plugin has no LLM in its loop.
- None of the plugin's actual value (wiki-link resolution, tree building,
  `index.md`→folder mapping, content hashing) exists in MCP.

It is a good complement for _interactive_ querying of a synced collection.

## 6. Corrections made during the investigation

Recorded because each one cost a run:

1. **"No rate-limit handling anywhere in `src/`"** — false. `custom-instance.ts`
   already had 429 retry; the grep had missed the file that does the HTTP.
2. **"48 MB files are the risk"** — wrong. Size is not the factor; sustained
   throughput is. A 20.5 MB file uploaded in 2 s when the link was healthy.
3. **"Dropped folder nodes will flatten the tree"** — a sound prediction that did
   not materialise: zero folder nodes failed.
4. **"Undici's FormData path is the bottleneck"** — falsified by a hand-built
   Buffer body performing identically.
5. **"The server drops large uploads"** — curl was equally slow; the link was the
   constraint, and two of my own concurrent experiments were part of what I was
   measuring.
6. **Cause unwrapping added to `getErrorMessage` did not reach the upload path**,
   which built its message from `e.message` inline. Cost one full run.

## 7. Recommendations

**Before the next full sync**, in order:

1. **Decide on audio.** 1.31 GB at ~130 KB/s is ~3 hours and is the direct cause
   of every attachment failure, in exchange for non-playable download cards. A
   configurable size cap plus extension skip-list is the suggested shape — not a
   hardcoded "no audio".
2. **Note the re-push cost.** Fix 2.7 (hashing render-affecting options) means
   every note now hashes differently, so the next run re-pushes all 697 notes and
   re-uploads every attachment. Settle the audio decision first or pay the 1.31 GB
   twice.
3. **Raise `RATE_LIMITER_MULTIPLIER`** for the import window.
4. **Run the import from the Outline server's own network** if at all possible.
   Everything else is working around a 1 Mbit pipe.
5. **Raise the upload timeout** in whatever proxies Outline, if the import must
   run over the VPN.

**Open items**

None currently.

**Resolved since first written**

- Skip-path existence check for parent-role notes (section 3).
- Per-upload timeout, so a slow or stalled attachment fails fast with a clear
  message instead of hanging indefinitely on the far end (`UPLOAD_TIMEOUT_MS`
  in `src/outline-api/outline-api-base.ts`, both transports, covered by
  `tests/uploadTimeout.test.ts`).
- **"745 documents in the collection versus 735 derived from the run log."**
  Explained by code audit (not reproduced against the original live instance,
  which is no longer available to check): `syncFolder` creates a real Outline
  document for every folder that has no `index.md` -- a placeholder so the
  hierarchy survives -- but never counted it anywhere. `SyncResult.total` is
  fixed at the markdown file count before any folder is touched, and the
  placeholder-creation branch never incremented any counter, so every such
  folder was a real, permanent document in the collection invisible to the
  run's own `Done: N pushed, M unchanged, K failed (T total)` line. A
  697-note vault with even a modest number of folders lacking `index.md`
  would show exactly this shape of gap. Fixed: `SyncResult` gained a
  `foldersCreated` counter, incremented only on an actual new placeholder
  (not a reused one), and both the CLI (`run.ts`) and plugin
  (`src/push-engine.ts`) summaries now report it separately -- a collection's
  true document count is `total + foldersCreated`, not `total` alone.
  Covered by `tests/syncFolder.test.ts`.

## 8. Verification status

177 tests pass, `tsc --noEmit` clean, `prettier --check` clean. Fixes were
developed test-first; each test was watched failing for the right reason before
the implementation existed.
