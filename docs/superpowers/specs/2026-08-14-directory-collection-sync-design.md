# Directory → collection sync — design

Status: approved by user, not yet planned/implemented.

## Motivation

Today the plugin syncs against a single, globally-configured Outline
collection (`settings.targetCollectionId`). Every push — single file or
folder — goes to that one collection unless the operator picks a different
one from a one-off modal each time. Outline collections are flat (confirmed
against the generated API client: `Collection` has no `parentCollectionId`),
so they map naturally onto a vault's top-level directories: "Compendium" the
folder becomes "Compendium" the collection, keeping the plugin-provided
per-directory content (permissions, sidebar organization, scoped search)
Outline already gives a collection for free.

The ask: pick a top-level directory, have it sync — as a whole, one-way,
Obsidian → Outline — against its own dedicated collection, remembered across
runs, with unchanged notes skipped (already true today via content-hash) and
a persistent record of what happened.

Two-way sync (pulling Outline changes back into Obsidian) is an explicit
non-goal here — call it out as future work, but nothing in this design should
make it harder to add later.

## Current state (relevant facts, verified against the code)

- `syncFolder`'s wiki-link resolver is already scoped to the folder tree
  passed to it (`env.listMarkdownFiles(rootPath)` in
  `src/adapters/obsidian.ts`), not vault-wide. A folder-scoped sync already
  cannot resolve links outside that folder within the same run. This design
  does not change that; per-directory collections don't make cross-directory
  links any more or less resolvable than they already are today.
- The folder-placeholder index (`FolderIndex`, `folderDocIds` in
  `settings.ts`) is already keyed `${collectionId}:${relativePath}` — already
  collection-scoped by construction. No change needed there.
- `PushEngine.pushFolder` / `pushFile` already accept an explicit
  `collectionId` parameter (`src/push-engine.ts`); the one-off collection
  picker (`collection-picker-modal.ts`) is a thin UI wrapper around the same
  calls this design reuses.
- `collectionsCreate` exists in the generated API client
  (`src/outline-api/generated-client/outlineAPI.ts`) but is not yet exposed
  through `IOutlineApi`/`OutlineApiBase` — needs adding.

## Decisions made during brainstorming

1. **Mapping method**: auto-match an Outline collection by exact name;
   create one if none exists. Once resolved, the mapping stores the
   `collectionId` directly — **never re-resolved by name again** for that
   mapping, so a later rename of the directory or the collection can't cause
   a duplicate collection to be created.
2. **Directory scope**: opt-in only. No top-level directory syncs unless
   explicitly mapped. Nothing implicit, nothing surprising for a vault with
   private/non-Outline folders.
3. **Triggers**: both a per-directory command ("Sync to Outline" on a mapped
   folder, right-click and command palette) and a bulk "Sync all mapped
   directories" command. Both reuse `PushEngine.pushFolder` underneath — no
   new sync engine.
4. **Ad-hoc push stays**: the existing one-off "pick a collection and push"
   flow (single file or folder, unmapped) is untouched and coexists.
   `targetCollectionId`/`targetCollectionName` remain as the default/fallback
   collection for that ad-hoc flow.
5. **Conflict strategy for mapped sync**: defaults to `overwrite` silently,
   no modal prompt. A mapped sync is a routine, repeatable action; prompting
   every run defeats that. The ad-hoc flow keeps its existing prompt.
6. **Sync log**: `.obsidian/plugins/obsidian-outline-sync/sync-log.json`,
   separate file from `data.json` (settings) so routine sync activity
   doesn't bloat settings load/save. One entry per directory per run, with
   per-file failure detail only when something failed. Capped at the most
   recent 200 entries (oldest dropped first) — bounded growth, no unbounded
   log file on a vault synced daily for years.
7. **CLI**: out of scope. `run.ts` keeps its current single
   `OUTLINE_COLLECTION_ID` design. It exists for bulk one-time imports, not
   routine incremental sync — YAGNI applies; revisit only if headless
   multi-collection sync becomes an actual need.

## Component design

### Settings (`src/settings.ts`)

```ts
export interface DirectoryMapping {
  /** Top-level vault-relative path, e.g. "Compendium". */
  directoryPath: string;
  /** Resolved once at mapping time; never re-resolved by name. */
  collectionId: string;
  /** Cached for display only -- not authoritative, collectionId is. */
  collectionName: string;
}
```

Add `directoryMappings: DirectoryMapping[]` to `OutlineSyncSettings`, default
`[]`. `loadSettings()` needs the same defensive-copy treatment already
applied to `folderDocIds` (`Object.assign` copies the *reference* when
`data.json` predates the field, which would leak a write into
`DEFAULT_SETTINGS` — see the existing comment in `main.ts`): copy the array
on load if it came from `DEFAULT_SETTINGS`.

### Collection resolution (new: `src/collection-resolver.ts`)

```ts
export async function resolveOrCreateCollection(
  api: IOutlineApi,
  name: string
): Promise<{ id: string; name: string; created: boolean } | null>
```

`created` distinguishes "found an existing collection" from "made a new
one" so the caller's confirmation `Notice` can say which happened.

1. List collections (reuse `refreshCollections`'s cache where available, or
   call `listCollections` directly), find an exact case-sensitive name match.
2. If none found, call `api.createCollection({ name })` (new method, see
   below).
3. Return `null` on any failure (auth, network) rather than throwing — the
   caller (mapping setup) surfaces this as a `Notice` and does not save a
   partial/broken mapping.

Requires adding to `IOutlineApi` / `OutlineApiBase`:

```ts
createCollection(params: { name: string }): Promise<Collection | null>
```

Implemented the same way `createDocument` is: no try/catch, throws via
`apiError('/collections.create', ...)` on a non-200 status, consistent with
every other write in `OutlineApiBase`.

### Mapping setup (`src/push-engine.ts` or a new small module)

New method, e.g. `PushEngine.mapDirectory(folder: TFolder)`:

1. Guard: `folder.parent` must be the vault root (top-level only — matches
   the "directory scope" decision; a subfolder can't be independently
   mapped).
2. Guard: not already in `settings.directoryMappings`.
3. `resolveOrCreateCollection(api, folder.name)`.
4. On success: push a `DirectoryMapping`, `saveSettings()`, `Notice`
   confirming (state whether the collection was found or created).
5. On failure: `Notice` with the reason, nothing saved.

### Sync commands (`src/plugin-ui/main.ts`)

- `sync-directory-to-outline`: `checkCallback` limited to a `TFolder` that
  has a mapping (menu item only appears for mapped folders — parallel to how
  `push-folder-to-outline` already checks `abstractFile instanceof TFolder`).
  Calls `PushEngine.syncMappedDirectory(folder)`.
- `sync-all-mapped-directories`: iterates `settings.directoryMappings`
  sequentially (not `Promise.all` — matches the existing sequential-upload
  reasoning: don't split one connection across concurrent transfers).
  Continues past a single directory's failure; aggregates a final count
  ("3/4 directories synced cleanly") via one `SyncLogNotice`-style summary.
  Each directory still gets its own log entry.

`PushEngine.syncMappedDirectory(folder, mapping)`:

- Same as `pushFolder` but: `folderConflictStrategy` fixed to `'overwrite'`
  (no `resolveFolderConflictStrategy` modal), `collectionId` from the
  mapping (no picker), and a `SyncLogEntry` written after `syncFolder`
  resolves (success or thrown error both produce an entry — a thrown error
  produces one with `failed` reflecting whatever completed before the
  throw, plus the throw's own message as a single failure entry if no
  finer detail is available).

### Sync log (new: `src/plugin-ui/sync-log-writer.ts`)

```ts
export interface SyncLogEntry {
  timestamp: string; // ISO 8601
  directoryPath: string;
  collectionId: string;
  collectionName: string;
  trigger: 'manual' | 'sync-all';
  success: number;
  skipped: number;
  failed: number;
  total: number;
  foldersCreated: number;
  /** Verbatim from SyncResult.failedFiles -- same field names, no reshaping. */
  failures?: { path: string; error: string }[]; // present only if failed > 0
}

export interface SyncLogWriter {
  append(entry: SyncLogEntry): Promise<void>;
}
```

Real implementation reads/writes via `app.vault.adapter` (Obsidian's
low-level FS-like adapter, which operates on vault-relative paths including
`.obsidian/...` — not Node's `fs`, which isn't available/appropriate inside
the plugin sandbox) at
`.obsidian/plugins/obsidian-outline-sync/sync-log.json`:

1. Read existing array (empty array if file missing or unparseable —
   mirrors the defensive parsing already in `createFileFolderIndex` for
   `.outline-sync-folders.json`).
2. Push the new entry.
3. Truncate to the most recent 200 (`slice(-200)`).
4. Write back.

A write failure is caught and `console.error`'d, never thrown — matches the
existing "secondary bookkeeping must not abort the primary operation"
pattern (`folderIndex.set`'s own try/catch in `src/adapters/node.ts`). The
sync itself already succeeded or failed on its own terms before the log
write is attempted; losing the log entry is a diagnosability regression, not
a sync failure.

The `SyncLogWriter` interface exists (rather than calling
`app.vault.adapter` directly from `PushEngine`) specifically so tests can
inject an in-memory fake, the same reasoning as the existing `FolderIndex`
abstraction.

Per-file failure detail (`failures[]`) needs `syncFolder`/`syncNode` to
surface which specific files failed, not just the aggregate count.
`syncNode`'s per-note catch block (`src/sync/sync.ts`) already computes the
error message and `fd.path` for its `onProgress`/`console.error` calls today,
then discards them. Add `failedFiles: { path: string; error: string }[]` to
`SyncResult`, pushed to in that same catch block — no new data source, just
retaining what the function already computes on every failure instead of
throwing it away. `SyncLogEntry.failures` is `result.failedFiles` verbatim
when non-empty.

### UI (`src/plugin-ui/setting-tab.ts`)

New section, "Directory → Collection mappings":

- List of current mappings: directory name → collection name, each row with
  "Sync now" and "Remove mapping" buttons. Removing a mapping only forgets
  it locally — does not delete the Outline collection or touch already-
  pushed documents.
- "Add directory" control: dropdown of top-level vault folders not already
  mapped (excludes dot-directories, matching the existing walker's skip
  rule) → triggers `mapDirectory` on selection.

## Data flow — "Sync to Outline" on a mapped directory

```
User action (right-click mapped folder, or sync-all)
  → PushEngine.syncMappedDirectory(folder, mapping)
    → createObsidianSyncEnv(...) with folderIndex scoped to
      `${mapping.collectionId}:...` (unchanged from today)
    → syncFolder(options[collectionId=mapping.collectionId,
                          folderConflictStrategy='overwrite'], env, folder.path)
    → SyncLogWriter.append({ ...result, directoryPath, collectionId,
                              collectionName, trigger, timestamp })
    → Notice / SyncLogNotice summary (existing pattern, now also surfaces
      result.foldersCreated per the earlier fix)
```

## Error handling

- Collection auto-create fails during mapping setup: `Notice`, mapping not
  saved, retryable by the user re-triggering "Sync this directory as a
  collection."
- A mapped directory's Outline collection is deleted/renamed after mapping:
  out of scope for this design (same class of drift as the disclosed
  `getDocument` collection-mismatch gap already accepted elsewhere in this
  codebase) — `syncFolder` will surface API errors from a dead
  `collectionId` normally (through the existing retry/error-reporting path),
  visible in the log's `failures[]`.
- Sync-all: one directory's failure does not stop the batch. Matches
  `syncFolder`'s own per-node philosophy (one note's failure doesn't stop
  its siblings).
- Log write failure: logged to console, never surfaced to the user as a sync
  failure, never blocks or retries the sync itself.

## Testing

- `resolveOrCreateCollection`: found-by-exact-name case; not-found-creates
  case; create-fails-returns-null case. Fake `IOutlineApi`.
- `SyncLogWriter` (real implementation, or a thin wrapper around a fake
  adapter): entry shape round-trips; cap-at-200 truncation drops oldest
  first; malformed/missing existing file starts from an empty array rather
  than throwing.
- Settings migration: a `data.json` fixture without `directoryMappings`
  loads with `[]`, and does not mutate `DEFAULT_SETTINGS` (same shape as the
  existing `folderDocIds` regression test implied by the comment in
  `main.ts`).
- `PushEngine.syncMappedDirectory`: uses `'overwrite'` without invoking the
  conflict-resolution modal; writes exactly one log entry per call; a
  partial failure still produces a log entry with accurate counts.
- `sync-all-mapped-directories` command: one mapped directory throwing does
  not prevent the next mapped directory from being attempted.

## Explicitly out of scope

- Two-way sync (Outline → Obsidian). Nothing in this design should make it
  harder to add later — the log entry's `trigger` field and the mapping's
  stable `collectionId` are both reusable by a future pull direction.
- CLI (`run.ts`) support for multiple directory mappings.
- Per-directory overrides of `removeToc`/`skipUnchanged`/`indexAsFolder` —
  all mapped directories share the existing global settings for these.
- Automatic re-sync on file save / any kind of watch mode. This design is
  manually triggered only (per-directory command or sync-all command).
