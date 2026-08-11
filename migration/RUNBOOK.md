# Migration runbook: Obsidian vault → Outline

A single, mechanical procedure for taking a vault from "as-is" to "fully
pushed to Outline" with no judgment calls left open. Written for an operator
(human or model) running this unattended, given: a vault path, an Outline
instance URL, an Outline API key, and (ideally) a target collection.

Two other documents back this one up — read them if a step here needs more
context, but this file is the one to *follow*:

- `migration/prep.md` — the reasoning behind each cleanup check
- `migration/scripts/README.md` — what each script does and doesn't touch

## Safety boundary — read this first

**Nothing in this runbook edits note content or renames files.** The only
write operation anywhere in this procedure is `06-archive-unsupported.sh
--apply`, which *moves* `.canvas`/`.excalidraw.md` files into a dot-prefixed
folder inside the vault — reversible, nothing deleted, nothing rewritten.

Everything else the scan finds (duplicate titles, malformed frontmatter,
unsupported-extension embeds, missing files, oversized attachments) is
**reported, not fixed**. None of those conditions stop the sync from
running — worst case is a document that renders imperfectly (a plain-text
link instead of an attachment, a note that failed to skip on a re-run). Do
not rename the user's notes or edit note bodies to silence a report finding
unless a human operator explicitly asks for that specific change. If you are
running this without a human available to review the report, proceed to the
sync anyway — the report is a record for later, not a gate.

## Required inputs

Confirm all of these are available before starting. If any are missing, stop
and ask rather than guessing:

| Variable | Where it's used | Notes |
| --- | --- | --- |
| `VAULT_PATH` | cleanup phase + `OBSIDIAN_FOLDER` | Absolute path to the vault root. |
| `OUTLINE_URL` | sync | e.g. `https://outline.example.com`. May be a private/LAN address. |
| `OUTLINE_API_KEY` | sync | From Outline Settings → API & Apps. Treat as a secret: never print it, never commit it. |
| `OUTLINE_PUBLIC_URL` | sync (optional) | Only needed if `OUTLINE_URL` is a private address readers can't reach — leave blank to reuse `OUTLINE_URL`. |
| `OUTLINE_COLLECTION_ID` | sync | UUID, slug, or exact name. If not provided, Phase 2 discovers the available collections and stops for the operator to pick one — it does not guess. |

## Phase 0 — Repo setup

```bash
cd <path to this repo checkout>
npm install
npx tsc -noEmit -skipLibCheck   # confirm the toolchain itself is healthy
```

If either command fails, stop — fix the toolchain before touching a vault.
This is a one-time check per checkout, not per vault.

## Phase 1 — Cleanup scan (read-only)

```bash
migration/scripts/prep-scan.sh "$VAULT_PATH" 20 > /tmp/outline-prep-report.md
cat /tmp/outline-prep-report.md
```

(The `20` is the oversized-attachment threshold in MB — see Phase 1c before
trusting it.)

Read the report. For each section:

**a. Canvas / Excalidraw files** — always safe to archive. Run:

```bash
migration/scripts/06-archive-unsupported.sh "$VAULT_PATH" --apply
```

This is the one action this runbook takes automatically. It's reversible
(move the files back out of `.outline-prep-archive/` if that's ever wrong).

**b. Dataview / Templater hits, malformed frontmatter, duplicate titles,
unsupported-extension embeds, missing-file embeds** — record the counts and
file lists from the report. Do not edit these files. If a human operator is
available, hand them the report before proceeding to Phase 3; if not,
proceed — see the safety boundary above.

**c. Oversized attachments** — before trusting the 20MB default, get the
real ceiling: ask whoever administers the Outline instance for their
`FILE_STORAGE_UPLOAD_MAX_SIZE` (Outline's own documented default is 25MB;
some self-hosted instances raise this — see `migration/prep.md` §5). Re-run just
that check with the real number if it differs meaningfully from 20:

```bash
migration/scripts/05-check-attachments.sh "$VAULT_PATH" <real_limit_mb>
```

Anything still flagged will very likely fail to upload. Note it in the
final summary (Phase 5) rather than blocking on it — the sync will report
that specific file as failed and everything else still goes through.

## Phase 2 — Configure the sync

```bash
cd <path to this repo checkout>
cp .env.example .env
```

Edit `.env`:

```env
OUTLINE_URL=<value>
OUTLINE_PUBLIC_URL=<value, or leave blank to reuse OUTLINE_URL>
OUTLINE_API_KEY=<value>
OUTLINE_COLLECTION_ID=<value, or leave blank>
OBSIDIAN_FOLDER=<VAULT_PATH, absolute, no quotes>
INDEX_AS_FOLDER=true
REMOVE_TOC=false
SKIP_UNCHANGED=true
```

If `OUTLINE_COLLECTION_ID` is blank, run the sync once anyway:

```bash
npm run sync
```

It authenticates, lists every available collection with its id/slug/name,
and exits without pushing anything. Pick the right one, set
`OUTLINE_COLLECTION_ID` in `.env`, and continue — this is the discovery step
referenced in "Required inputs" above, not a failure.

## Phase 3 — Dry run

Push a small, representative slice before the full vault, so a systemic
problem (wrong collection, auth issue, a callout type that renders oddly)
costs one note instead of the whole vault.

If a throwaway test collection ID was provided, set `OUTLINE_COLLECTION_ID`
to it for this step only. If not, build a temp subset from the real vault
instead — same mechanism, no extra Outline setup required:

```bash
mkdir -p /tmp/outline-dry-run
# Copy a handful of representative notes: at least one with an image embed,
# one with a callout, one with a code fence containing triple backticks,
# one with a wiki-link, and (if any exist) one pair of same-titled notes.
cp "$VAULT_PATH/some-note.md" /tmp/outline-dry-run/
# ...repeat for the rest of the sample...

OBSIDIAN_FOLDER=/tmp/outline-dry-run npm run sync
```

Open the pushed documents in Outline and check: callouts render as
`:::info`/`:::warning`/etc. blocks (not literal `> [!note]` text), image
embeds are inline images, non-image attachments are file-link cards,
wiki-links resolved to real Outline links, and nothing shows
`*(Image not found: ...)*` or a literal `%%WIKILINK[...]%%` string — either
means something leaked through unresolved.

If anything looks wrong, stop and diagnose before Phase 4 — every problem
visible here will otherwise repeat across the whole vault.

## Phase 4 — Full push

```bash
OBSIDIAN_FOLDER="$VAULT_PATH" npm run sync
```

This can take a while on a large vault — Outline rate-limits at roughly 25
requests/minute per endpoint by default (`migration/findings.md`
§4.1), and the client backs off and retries automatically rather than
failing fast. Let it run to completion rather than interrupting on apparent
slowness.

Watch the final line: `Done: N pushed, M unchanged, K failed (T total)`.

## Phase 5 — Verify and close out

- If `K failed (0)`: done. Record `T total` and the collection pushed to.
- If `K failed > 0`: re-run the exact same command once. `SKIP_UNCHANGED`
  means already-succeeded notes are skipped instantly on the retry, so this
  only re-attempts the failures — safe and cheap. Transient causes (a rate
  limit spike, a dropped connection) usually clear on retry.
- If failures persist after one retry: check the printed error for each
  failed note against this table, then stop and report rather than
  retrying indefinitely:

| Error signature | Likely cause | What to do |
| --- | --- | --- |
| `401` / `Authentication failed` | Bad or expired API key | Confirm `OUTLINE_API_KEY`, don't retry until fixed |
| `429` repeating past the built-in retries | Sustained rate-limit overload | Note it; consider `RATE_LIMITER_MULTIPLIER` on the server for a re-run (`migration/findings.md` §4.1 §7) |
| `fetch failed (...)` / timeout, on a specific attachment | Slow link + large file (throughput, not size) | Cross-reference Phase 1c's oversized-attachments list; §4.2 of the findings doc has the throughput numbers |
| `413` or a storage/size error | Over `FILE_STORAGE_UPLOAD_MAX_SIZE` | Confirmed too large for this instance; not retriable without compressing the file |

Never retry more than once automatically — a failure that survives a retry
needs a decision (raise a limit, compress a file, fix a key), not more
attempts.

Finish by noting, for the record: vault path, collection pushed to, final
`pushed/unchanged/failed/total` counts, and anything from Phase 1's report
that was left unresolved (duplicate titles, dataview blocks, etc.) so a
human can follow up later.
