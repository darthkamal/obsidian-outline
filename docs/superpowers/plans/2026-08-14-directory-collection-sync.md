# Directory → Collection Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a vault owner map a top-level directory to its own Outline collection (auto-created if needed) and sync just that directory — one-way, Obsidian → Outline, skip-unchanged already applies — either individually or all mapped directories at once, with a persisted JSON log of what happened.

**Architecture:** All new logic sits on top of the existing `syncFolder`/`PushEngine` sync engine — no new sync engine, no changes to how documents get pushed. New pieces: a `DirectoryMapping[]` in plugin settings (directory path → collection id, resolved once and never re-resolved by name), a small collection-resolver that finds-or-creates an Outline collection by name, a JSON sync log written via Obsidian's vault adapter (capped at 200 entries), and two new `PushEngine` methods (`syncMappedDirectory`, `syncAllMappedDirectories`) that reuse `pushFolder`'s machinery with a fixed `overwrite` strategy instead of a conflict-resolution prompt.

**Tech Stack:** TypeScript, Obsidian Plugin API, Jest (ts-jest), existing `syncFolder`/`OutlineApiBase` sync engine.

**Spec:** `docs/superpowers/specs/2026-08-14-directory-collection-sync-design.md`

## Global Constraints

- Every new/modified file must pass `npx tsc -noEmit -skipLibCheck` and `npx prettier --check <file>` before its task is committed.
- Run the full suite (`npm test`) at the end of every task — it must stay green throughout, not just at the end of the plan.
- No behavior change to the existing ad-hoc push flow (`pushFile`, `pushFolder` via the collection picker) — it keeps its prompt and its own `targetCollectionId` default.
- CLI (`run.ts`) is untouched by this plan — this feature is plugin-only (see spec, "Explicitly out of scope").
- A directory can only be mapped if it is a direct child of the vault root (top-level only).
- Once a `DirectoryMapping` is created, its `collectionId` is used directly on every future sync — never re-resolved by name.
- A log-write failure must never fail or block a sync; it's caught and `console.error`'d only.

---

## Task 1: `SyncResult.failedFiles`

**Files:**
- Modify: `src/sync/types.ts` (the `SyncResult` interface)
- Modify: `src/sync/sync.ts` (the two `SyncResult` literals, and `syncNode`'s per-note catch block)
- Test: `tests/syncFolder.test.ts`

**Interfaces:**
- Produces: `SyncResult.failedFiles: { path: string; error: string }[]` — populated by `syncFolder`, consumed later by `SyncLogEntry.failures` (Task 7).

- [ ] **Step 1: Write the failing test**

Add to `tests/syncFolder.test.ts` (uses the existing `makeFakeApi`/`makeEnv`/`defaultOptions` helpers already in that file):

```ts
  it('records which files failed and why in failedFiles', async () => {
    const api = makeFakeApi();
    const originalCreate = api.createDocument.bind(api);
    api.createDocument = async (params) => {
      if (params.title === 'Broken') {
        throw new Error('simulated 500 on create');
      }
      return originalCreate(params);
    };
    const env = makeEnv(api, { 'Broken.md': '# v1', 'Fine.md': '# ok' });

    const result = await syncFolder(defaultOptions, env, '/root');

    expect(result.failed).toBe(1);
    expect(result.failedFiles).toEqual([
      { path: 'Broken.md', error: expect.stringContaining('simulated 500') },
    ]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/syncFolder.test.ts -t "records which files failed"`
Expected: FAIL — `TS2339: Property 'failedFiles' does not exist on type 'SyncResult'` (or, if TS doesn't block the test run, a runtime `expect(result.failedFiles).toEqual(...)` failure because it's `undefined`).

- [ ] **Step 3: Add `failedFiles` to `SyncResult`**

In `src/sync/types.ts`, extend the interface:

```ts
export interface SyncResult {
  success: number;
  failed: number;
  skipped: number;
  total: number;
  foldersCreated: number;
  /**
   * One entry per note that failed to push this run. syncNode already
   * computes the error message and path for its onProgress/console.error
   * calls on every failure -- retained here instead of discarded, so a
   * caller (the sync log, Task 7) doesn't have to re-derive it.
   */
  failedFiles: { path: string; error: string }[];
}
```

- [ ] **Step 4: Populate `failedFiles` in `syncFolder`**

In `src/sync/sync.ts`:

1. The early-return literal (`files.length === 0`):

```ts
    return { success: 0, failed: 0, skipped: 0, total: 0, foldersCreated: 0, failedFiles: [] };
```

2. The main `result` object:

```ts
  const result: SyncResult = {
    success: 0,
    failed: 0,
    skipped: 0,
    total: files.length,
    foldersCreated: 0,
    failedFiles: [],
  };
```

3. The per-note catch block inside `syncNode` (the one that logs
   `` `${indent}${prefix}${node.title}… ✗ ${msg}` ``) — add one line right
   after `const msg = getErrorMessage(e);`:

```ts
          const msg = getErrorMessage(e);
          result.failedFiles.push({ path: fd.path, error: msg });
          env.onProgress?.(`${indent}${prefix}${node.title}… ✗ ${msg}`);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest tests/syncFolder.test.ts`
Expected: PASS, all tests in the file (including the new one).

- [ ] **Step 6: Full verification and commit**

Run: `npx tsc -noEmit -skipLibCheck && npm test && npx prettier --check src/sync/types.ts src/sync/sync.ts tests/syncFolder.test.ts`

```bash
git add src/sync/types.ts src/sync/sync.ts tests/syncFolder.test.ts
git commit -m "feat: record which files failed to push in SyncResult"
```

---

## Task 2: `createCollection` API method + `resolveOrCreateCollection`

**Files:**
- Modify: `src/outline-api/types.ts` (`IOutlineApi`)
- Modify: `src/outline-api/outline-api-base.ts` (implementation)
- Create: `src/collection-resolver.ts`
- Test: `tests/collectionResolver.test.ts`

**Interfaces:**
- Produces: `IOutlineApi.createCollection(params: { name: string }): Promise<Collection | null>`
- Produces: `resolveOrCreateCollection(api: IOutlineApi, name: string): Promise<{ id: string; name: string; created: boolean } | null>` — consumed by `PushEngine.mapDirectory` (Task 6).

- [ ] **Step 1: Add `createCollection` to `IOutlineApi`**

In `src/outline-api/types.ts`, add to the interface (after `listCollections`):

```ts
  listCollections(): Promise<Collection[] | null>;
  createCollection(params: { name: string }): Promise<Collection | null>;
  getDocument(id: string): Promise<Document | null>;
```

- [ ] **Step 2: Write the failing test for `createCollection`**

Create `tests/collectionResolver.test.ts`:

```ts
import { OutlineApiBase } from '../src/outline-api/outline-api-base';
import { resolveOrCreateCollection } from '../src/collection-resolver';
import type { Transport } from '../src/outline-api/custom-instance';
import type { IOutlineApi, Collection } from '../src/outline-api/types';

class TestApi extends OutlineApiBase {
  async uploadAttachmentToStorage(): Promise<boolean> {
    return true;
  }
}

function transportAlways(status: number, body: unknown): Transport {
  return async () => ({ status, headers: new Headers(), json: async () => body });
}

describe('OutlineApiBase.createCollection', () => {
  it('returns the created collection on success', async () => {
    const api = new TestApi(
      'http://x',
      'k',
      transportAlways(200, { data: { id: 'col-1', name: 'Compendium' } })
    );
    const result = await api.createCollection({ name: 'Compendium' });
    expect(result).toEqual({ id: 'col-1', name: 'Compendium' });
  });

  it('throws with the status and message on failure', async () => {
    const api = new TestApi(
      'http://x',
      'k',
      transportAlways(400, { message: 'name already exists' })
    );
    await expect(api.createCollection({ name: 'Compendium' })).rejects.toThrow(/400/);
  });
});
```

(This test will not compile yet — `resolveOrCreateCollection` doesn't exist.
That's expected; the next steps create it.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest tests/collectionResolver.test.ts`
Expected: FAIL — module not found (`src/collection-resolver`) or `createCollection` not a function on `TestApi`.

- [ ] **Step 4: Implement `createCollection` in `OutlineApiBase`**

In `src/outline-api/outline-api-base.ts`:

1. Add `collectionsCreate` to the import from `./generated-client/outlineAPI`:

```ts
import {
  authInfo,
  collectionsList,
  collectionsCreate,
  documentsInfo,
  documentsCreate,
  documentsUpdate,
  documentsSearch,
  attachmentsCreate,
} from './generated-client/outlineAPI';
```

2. Add the method right after `listCollections`:

```ts
  async createCollection(params: { name: string }): Promise<Collection | null> {
    const res = await collectionsCreate(params);
    if (res.status !== 200) throw apiError('/collections.create', res.status, res.data);
    return res.data.data ?? null;
  }
```

- [ ] **Step 5: Write `resolveOrCreateCollection`**

Create `src/collection-resolver.ts`:

```ts
import type { IOutlineApi } from './outline-api/types';

export interface ResolvedCollection {
  id: string;
  name: string;
  /** True if this call created a new collection; false if an existing one matched by name. */
  created: boolean;
}

/**
 * Finds an Outline collection with an exact name match, or creates one if
 * none exists. Returns null on any failure (auth, network, a create that
 * fails) rather than throwing -- the caller decides how to surface that
 * (see PushEngine.mapDirectory) and must not save a partial mapping.
 */
export async function resolveOrCreateCollection(
  api: IOutlineApi,
  name: string
): Promise<ResolvedCollection | null> {
  const collections = await api.listCollections();
  const existing = collections?.find((c) => c.name === name);
  if (existing?.id) {
    return { id: existing.id, name: existing.name ?? name, created: false };
  }

  try {
    const created = await api.createCollection({ name });
    if (!created?.id) return null;
    return { id: created.id, name: created.name ?? name, created: true };
  } catch {
    return null;
  }
}
```

- [ ] **Step 6: Add the resolver tests**

Append to `tests/collectionResolver.test.ts`:

```ts
function fakeApi(overrides: Partial<IOutlineApi> = {}): IOutlineApi {
  return {
    async validateAuth() {
      return 'test';
    },
    async checkConnection() {
      return { ok: true as const, user: 'test' };
    },
    async listCollections() {
      return [];
    },
    async createCollection() {
      return null;
    },
    async getDocument() {
      return null;
    },
    async createDocument() {
      return null;
    },
    async updateDocument() {
      return null;
    },
    async searchDocumentByTitle() {
      return null;
    },
    async createAttachment() {
      return null;
    },
    async uploadAttachmentToStorage() {
      return false;
    },
    ...overrides,
  };
}

describe('resolveOrCreateCollection', () => {
  it('returns an existing collection by exact name, without creating one', async () => {
    let createCalled = false;
    const api = fakeApi({
      async listCollections() {
        return [{ id: 'col-1', name: 'Compendium' } as Collection];
      },
      async createCollection() {
        createCalled = true;
        return null;
      },
    });

    const result = await resolveOrCreateCollection(api, 'Compendium');

    expect(result).toEqual({ id: 'col-1', name: 'Compendium', created: false });
    expect(createCalled).toBe(false);
  });

  it('creates a collection when no name matches', async () => {
    const api = fakeApi({
      async listCollections() {
        return [{ id: 'col-1', name: 'Something Else' } as Collection];
      },
      async createCollection(params) {
        return { id: 'col-2', name: params.name } as Collection;
      },
    });

    const result = await resolveOrCreateCollection(api, 'Compendium');

    expect(result).toEqual({ id: 'col-2', name: 'Compendium', created: true });
  });

  it('returns null when creation fails', async () => {
    const api = fakeApi({
      async listCollections() {
        return [];
      },
      async createCollection() {
        throw new Error('simulated 400');
      },
    });

    const result = await resolveOrCreateCollection(api, 'Compendium');

    expect(result).toBeNull();
  });

  it('returns null when listCollections itself returns null', async () => {
    const api = fakeApi({
      async listCollections() {
        return null;
      },
      async createCollection(params) {
        return { id: 'col-3', name: params.name } as Collection;
      },
    });

    const result = await resolveOrCreateCollection(api, 'Compendium');

    // listCollections failing is not fatal -- still tries to create.
    expect(result).toEqual({ id: 'col-3', name: 'Compendium', created: true });
  });
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx jest tests/collectionResolver.test.ts`
Expected: PASS, all 6 tests (2 from Step 2, 4 from Step 6).

- [ ] **Step 8: Full verification and commit**

Run: `npx tsc -noEmit -skipLibCheck && npm test && npx prettier --check src/outline-api/types.ts src/outline-api/outline-api-base.ts src/collection-resolver.ts tests/collectionResolver.test.ts`

```bash
git add src/outline-api/types.ts src/outline-api/outline-api-base.ts src/collection-resolver.ts tests/collectionResolver.test.ts
git commit -m "feat: add createCollection API method and resolveOrCreateCollection"
```

---

## Task 3: `DirectoryMapping` settings + settings normalization

**Files:**
- Modify: `src/settings.ts`
- Modify: `src/plugin-ui/main.ts` (`loadSettings`)
- Test: `tests/settingsNormalize.test.ts`

**Interfaces:**
- Produces: `DirectoryMapping { directoryPath: string; collectionId: string; collectionName: string }`, exported from `src/settings.ts`.
- Produces: `normalizeSettings(loaded: Partial<OutlineSyncSettings> | null | undefined): OutlineSyncSettings`, exported from `src/settings.ts`, consumed by `main.ts#loadSettings`.

- [ ] **Step 1: Write the failing test**

Create `tests/settingsNormalize.test.ts`:

```ts
import { normalizeSettings, DEFAULT_SETTINGS } from '../src/settings';

describe('normalizeSettings', () => {
  it('fills in directoryMappings as an empty array when data.json predates it', () => {
    const result = normalizeSettings({ outlineUrl: 'https://x', apiKey: 'k' });

    expect(result.directoryMappings).toEqual([]);
  });

  it('does not mutate DEFAULT_SETTINGS.directoryMappings across two loads', () => {
    const first = normalizeSettings(null);
    first.directoryMappings.push({
      directoryPath: 'Compendium',
      collectionId: 'col-1',
      collectionName: 'Compendium',
    });

    const second = normalizeSettings(null);

    expect(second.directoryMappings).toEqual([]);
    expect(DEFAULT_SETTINGS.directoryMappings).toEqual([]);
  });

  it('preserves an already-populated directoryMappings from loaded data', () => {
    const mapping = { directoryPath: 'A', collectionId: 'c1', collectionName: 'A' };
    const result = normalizeSettings({ directoryMappings: [mapping] });

    expect(result.directoryMappings).toEqual([mapping]);
  });

  it('still copies folderDocIds defensively (existing behavior, unchanged)', () => {
    const first = normalizeSettings(null);
    first.folderDocIds['x'] = 'y';

    const second = normalizeSettings(null);

    expect(second.folderDocIds).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/settingsNormalize.test.ts`
Expected: FAIL — `normalizeSettings` is not exported from `src/settings.ts`.

- [ ] **Step 3: Add `DirectoryMapping` and `normalizeSettings` to `src/settings.ts`**

Replace the full contents of `src/settings.ts`:

```ts
export interface DirectoryMapping {
  /** Top-level vault-relative path, e.g. "Compendium". */
  directoryPath: string;
  /** Resolved once when the mapping is created; never re-resolved by name. */
  collectionId: string;
  /** Cached for display only -- not authoritative, collectionId is. */
  collectionName: string;
}

export interface OutlineSyncSettings {
  /** Base URL the plugin talks to. May be a LAN/VPN address. */
  outlineUrl: string;
  /**
   * Base URL written into links inside pushed documents. Leave blank to reuse
   * `outlineUrl`. Set this when the API is reached over a private address but
   * readers open Outline on a public hostname -- otherwise every cross-link in
   * your Outline documents points somewhere only you can reach.
   */
  publicUrl: string;
  apiKey: string;
  targetCollectionId: string;
  targetCollectionName: string;
  removeToc: boolean;
  /**
   * Skip notes not modified since their last push. Makes repeat pushes of a
   * large folder cheap. Trade-off: a skipped note is not re-rendered, so a link
   * it makes to a note created in the same run stays unresolved until that note
   * is edited again.
   */
  skipUnchanged: boolean;
  /**
   * Outline document ids for folder placeholders, keyed
   * `${collectionId}:${relativePath}`. Without this a re-sync can duplicate
   * folder trees when Outline's search index lags behind.
   */
  folderDocIds: Record<string, string>;
  /** Top-level directories synced against their own dedicated collection. */
  directoryMappings: DirectoryMapping[];
}

export const DEFAULT_SETTINGS: OutlineSyncSettings = {
  outlineUrl: '',
  publicUrl: '',
  apiKey: '',
  targetCollectionId: '',
  targetCollectionName: '',
  removeToc: false,
  skipUnchanged: true,
  folderDocIds: {},
  directoryMappings: [],
};

/**
 * Merges loaded plugin data over the defaults and defensively copies every
 * mutable field. Object.assign copies the *reference* when data.json
 * predates a field, so writing to it later would mutate DEFAULT_SETTINGS
 * itself and leak into the next load -- see the folderDocIds precedent this
 * follows.
 */
export function normalizeSettings(
  loaded: Partial<OutlineSyncSettings> | null | undefined
): OutlineSyncSettings {
  const merged = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
  merged.folderDocIds = { ...merged.folderDocIds };
  merged.directoryMappings = [...merged.directoryMappings];
  return merged;
}
```

- [ ] **Step 4: Wire `normalizeSettings` into `main.ts#loadSettings`**

In `src/plugin-ui/main.ts`:

1. Update the import:

```ts
import { DEFAULT_SETTINGS, normalizeSettings, OutlineSyncSettings } from '../settings';
```

2. Replace `loadSettings`:

```ts
  async loadSettings(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest tests/settingsNormalize.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 6: Full verification and commit**

Run: `npx tsc -noEmit -skipLibCheck && npm test && npx prettier --check src/settings.ts src/plugin-ui/main.ts tests/settingsNormalize.test.ts`

```bash
git add src/settings.ts src/plugin-ui/main.ts tests/settingsNormalize.test.ts
git commit -m "feat: add DirectoryMapping settings and extract normalizeSettings"
```

---

## Task 4: Sync log writer

**Files:**
- Create: `src/plugin-ui/sync-log-writer.ts`
- Test: `tests/syncLogWriter.test.ts`

**Interfaces:**
- Produces: `SyncLogEntry` (see below), `SyncLogWriter { append(entry): Promise<void> }`, `createObsidianSyncLogWriter(adapter: LogAdapter, logPath: string): SyncLogWriter` — consumed by `PushEngine` (Task 5) and `main.ts` (Task 5).

- [ ] **Step 1: Write the failing test**

Create `tests/syncLogWriter.test.ts`:

```ts
import { createObsidianSyncLogWriter, type SyncLogEntry } from '../src/plugin-ui/sync-log-writer';

/** In-memory stand-in for the slice of Obsidian's DataAdapter this module uses. */
function fakeAdapter(initial?: string) {
  let store: string | undefined = initial;
  return {
    async exists() {
      return store !== undefined;
    },
    async read() {
      if (store === undefined) throw new Error('ENOENT');
      return store;
    },
    async write(_path: string, data: string) {
      store = data;
    },
    _get: () => store,
  };
}

function entry(overrides: Partial<SyncLogEntry> = {}): SyncLogEntry {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    directoryPath: 'Compendium',
    collectionId: 'col-1',
    collectionName: 'Compendium',
    trigger: 'manual',
    success: 1,
    skipped: 0,
    failed: 0,
    total: 1,
    foldersCreated: 0,
    ...overrides,
  };
}

describe('createObsidianSyncLogWriter', () => {
  it('creates the log file with one entry on first append', async () => {
    const adapter = fakeAdapter();
    const writer = createObsidianSyncLogWriter(adapter, 'log.json');

    await writer.append(entry());

    const stored = JSON.parse(adapter._get()!);
    expect(stored).toEqual([entry()]);
  });

  it('appends to an existing log rather than overwriting it', async () => {
    const adapter = fakeAdapter(JSON.stringify([entry({ directoryPath: 'First' })]));
    const writer = createObsidianSyncLogWriter(adapter, 'log.json');

    await writer.append(entry({ directoryPath: 'Second' }));

    const stored = JSON.parse(adapter._get()!);
    expect(stored.map((e: SyncLogEntry) => e.directoryPath)).toEqual(['First', 'Second']);
  });

  it('starts fresh instead of throwing when the existing file is malformed', async () => {
    const adapter = fakeAdapter('not valid json{{{');
    const writer = createObsidianSyncLogWriter(adapter, 'log.json');

    await writer.append(entry());

    const stored = JSON.parse(adapter._get()!);
    expect(stored).toEqual([entry()]);
  });

  it('caps the log at the most recent 200 entries', async () => {
    const existing = Array.from({ length: 200 }, (_, i) => entry({ directoryPath: `D${i}` }));
    const adapter = fakeAdapter(JSON.stringify(existing));
    const writer = createObsidianSyncLogWriter(adapter, 'log.json');

    await writer.append(entry({ directoryPath: 'Newest' }));

    const stored = JSON.parse(adapter._get()!);
    expect(stored).toHaveLength(200);
    expect(stored[0].directoryPath).toBe('D1'); // D0 dropped
    expect(stored[199].directoryPath).toBe('Newest');
  });

  it('only includes failures when the entry has them', async () => {
    const adapter = fakeAdapter();
    const writer = createObsidianSyncLogWriter(adapter, 'log.json');

    await writer.append(entry({ failed: 1, failures: [{ path: 'A.md', error: 'boom' }] }));

    const stored = JSON.parse(adapter._get()!);
    expect(stored[0].failures).toEqual([{ path: 'A.md', error: 'boom' }]);
  });

  it('does not throw when the write itself fails', async () => {
    const adapter = {
      async exists() {
        return false;
      },
      async read() {
        return '[]';
      },
      async write() {
        throw new Error('disk full');
      },
    };
    const writer = createObsidianSyncLogWriter(adapter, 'log.json');

    await expect(writer.append(entry())).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/syncLogWriter.test.ts`
Expected: FAIL — module `src/plugin-ui/sync-log-writer` not found.

- [ ] **Step 3: Implement the sync log writer**

Create `src/plugin-ui/sync-log-writer.ts`:

```ts
const MAX_LOG_ENTRIES = 200;

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
  /** Present only when failed > 0. Same shape as SyncResult.failedFiles. */
  failures?: { path: string; error: string }[];
}

export interface SyncLogWriter {
  append(entry: SyncLogEntry): Promise<void>;
}

/** The slice of Obsidian's DataAdapter this module needs -- kept minimal so tests can fake it. */
export interface LogAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
}

/**
 * Appends one entry per sync run to a JSON array at `logPath`, capped at the
 * most recent MAX_LOG_ENTRIES. A write failure is caught and logged, never
 * thrown -- the sync itself already succeeded or failed on its own terms by
 * the time this runs; losing the log entry is a diagnosability regression,
 * not a sync failure.
 */
export function createObsidianSyncLogWriter(adapter: LogAdapter, logPath: string): SyncLogWriter {
  return {
    async append(entry: SyncLogEntry): Promise<void> {
      let entries: SyncLogEntry[] = [];
      try {
        if (await adapter.exists(logPath)) {
          const raw = await adapter.read(logPath);
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) entries = parsed as SyncLogEntry[];
        }
      } catch {
        // Missing, unreadable, or malformed: start fresh rather than lose
        // future logging over one corrupted read.
        entries = [];
      }

      entries.push(entry);
      if (entries.length > MAX_LOG_ENTRIES) {
        entries = entries.slice(-MAX_LOG_ENTRIES);
      }

      try {
        await adapter.write(logPath, JSON.stringify(entries, null, 2));
      } catch (e) {
        console.error('[Outline Sync] Could not write sync log:', e);
      }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/syncLogWriter.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Full verification and commit**

Run: `npx tsc -noEmit -skipLibCheck && npm test && npx prettier --check src/plugin-ui/sync-log-writer.ts tests/syncLogWriter.test.ts`

```bash
git add src/plugin-ui/sync-log-writer.ts tests/syncLogWriter.test.ts
git commit -m "feat: add JSON sync log writer capped at 200 entries"
```

---

## Task 5: `PushEngine` plumbing — inject the log writer, extract `summarizeResult`

**Files:**
- Modify: `src/push-engine.ts`
- Modify: `src/plugin-ui/main.ts` (`rebuildClient`)

**Interfaces:**
- Consumes: `SyncLogWriter`, `createObsidianSyncLogWriter` (Task 4); `DirectoryMapping` (Task 3).
- Produces: `PushEngine` constructor gains a 5th param `syncLogWriter: SyncLogWriter`; `PushEngine.summarizeResult(result: SyncResult): { summary: string; ok: boolean }` (private, reused by Task 7).

No new test in this task — it's a mechanical refactor of already-tested code
paths (`pushFolder`'s existing behavior must not change). Verified by the
existing suite staying green plus a manual `tsc` check that nothing calling
`new PushEngine(...)` was missed.

- [ ] **Step 1: Add the constructor param and extract `summarizeResult`**

In `src/push-engine.ts`:

1. Add the import:

```ts
import type { SyncLogWriter } from './plugin-ui/sync-log-writer';
```

2. Update the class fields and constructor:

```ts
export class PushEngine {
  private app: App;
  private client: OutlineClient;
  private settings: OutlineSyncSettings;
  private saveSettings: () => Promise<void>;
  private syncLogWriter: SyncLogWriter;

  constructor(
    app: App,
    client: OutlineClient,
    settings: OutlineSyncSettings,
    saveSettings: () => Promise<void>,
    syncLogWriter: SyncLogWriter
  ) {
    this.app = app;
    this.client = client;
    this.settings = settings;
    this.saveSettings = saveSettings;
    this.syncLogWriter = syncLogWriter;
  }
```

3. Add the private helper (place it right after `buildOptions`):

```ts
  private summarizeResult(result: SyncResult): { summary: string; ok: boolean } {
    const ok = result.failed === 0;
    const unchanged = result.skipped > 0 ? `, ${result.skipped} unchanged` : '';
    const folders =
      result.foldersCreated > 0 ? `, ${result.foldersCreated} folder placeholder(s)` : '';
    const summary = ok
      ? `✓ ${result.success} file(s) pushed${unchanged}${folders}`
      : `✓ ${result.success} pushed${unchanged}${folders}, ✗ ${result.failed} failed`;
    return { summary, ok };
  }
```

4. Add the `SyncResult` type import (needed for the helper's signature) —
   update the existing type-only import line:

```ts
import type { SyncOptions, FolderIndex, SyncResult } from './sync';
```

5. Replace `pushFolder`'s summary construction to use the helper:

```ts
    try {
      const result = await syncFolder(options, env, folder.path);
      const { summary, ok } = this.summarizeResult(result);
      log.finish(summary, ok);
    } catch (e) {
```

- [ ] **Step 2: Wire the real log writer into `main.ts`**

In `src/plugin-ui/main.ts`:

1. Add the import:

```ts
import { createObsidianSyncLogWriter } from './sync-log-writer';
```

2. Update `rebuildClient`:

```ts
  rebuildClient(): void {
    this.client = new OutlineClient(this.settings.outlineUrl, this.settings.apiKey);
    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const syncLogWriter = createObsidianSyncLogWriter(
      this.app.vault.adapter,
      `${pluginDir}/sync-log.json`
    );
    // saveData rather than saveSettings: the latter calls rebuildClient(),
    // which would swap the client and engine out from under a running sync.
    this.engine = new PushEngine(
      this.app,
      this.client,
      this.settings,
      () => this.saveData(this.settings),
      syncLogWriter
    );
  }
```

- [ ] **Step 3: Verify the existing suite still passes and types check**

Run: `npx tsc -noEmit -skipLibCheck && npm test`
Expected: PASS, no test count change (204 tests, unchanged — this task only
refactors already-covered code paths).

- [ ] **Step 4: Full verification and commit**

Run: `npx prettier --check src/push-engine.ts src/plugin-ui/main.ts`

```bash
git add src/push-engine.ts src/plugin-ui/main.ts
git commit -m "refactor: inject SyncLogWriter into PushEngine, extract summarizeResult"
```

---

## Task 6: `PushEngine.mapDirectory`

**Files:**
- Modify: `src/push-engine.ts`
- Test: `tests/pushEngineMapDirectory.test.ts`

**Interfaces:**
- Consumes: `resolveOrCreateCollection` (Task 2), `DirectoryMapping` (Task 3).
- Produces: `PushEngine.mapDirectory(folder: TFolder): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/pushEngineMapDirectory.test.ts`:

```ts
const NoticeMock = jest.fn();
class FakeTFolder {
  path: string;
  name: string;
  parent: FakeTFolder | null;
  children: unknown[] = [];
  constructor(path: string, name: string, parent: FakeTFolder | null = null) {
    this.path = path;
    this.name = name;
    this.parent = parent;
  }
}

jest.mock(
  'obsidian',
  () => ({
    Notice: NoticeMock,
    TFolder: FakeTFolder,
    TFile: class TFile {},
  }),
  { virtual: true }
);

import { PushEngine } from '../src/push-engine';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { OutlineSyncSettings } from '../src/settings';
import type { IOutlineApi, Collection } from '../src/outline-api/types';
import type { OutlineClient } from '../src/outline-client';
import type { SyncLogWriter } from '../src/plugin-ui/sync-log-writer';

function fakeApi(overrides: Partial<IOutlineApi> = {}): IOutlineApi {
  return {
    async validateAuth() {
      return 'test';
    },
    async checkConnection() {
      return { ok: true as const, user: 'test' };
    },
    async listCollections() {
      return [];
    },
    async createCollection(params) {
      return { id: 'col-new', name: params.name } as Collection;
    },
    async getDocument() {
      return null;
    },
    async createDocument() {
      return null;
    },
    async updateDocument() {
      return null;
    },
    async searchDocumentByTitle() {
      return null;
    },
    async createAttachment() {
      return null;
    },
    async uploadAttachmentToStorage() {
      return false;
    },
    ...overrides,
  };
}

const noopLogWriter: SyncLogWriter = { append: async () => {} };

function makeEngine(api: IOutlineApi, settings: OutlineSyncSettings, saveSettings: jest.Mock) {
  const root = new FakeTFolder('/', '', null);
  const fakeApp = { vault: { getRoot: () => root } };
  const engine = new PushEngine(
    fakeApp as never,
    api as unknown as OutlineClient,
    settings,
    saveSettings,
    noopLogWriter
  );
  return { engine, root };
}

describe('PushEngine.mapDirectory', () => {
  beforeEach(() => {
    NoticeMock.mockClear();
  });

  it('rejects a folder that is not top-level', async () => {
    const settings = { ...DEFAULT_SETTINGS, outlineUrl: 'https://x', apiKey: 'k' };
    const saveSettings = jest.fn();
    const { engine, root } = makeEngine(fakeApi(), settings, saveSettings);
    const parent = new FakeTFolder('Compendium', 'Compendium', root);
    const nested = new FakeTFolder('Compendium/Sub', 'Sub', parent);

    await engine.mapDirectory(nested as never);

    expect(settings.directoryMappings).toEqual([]);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('rejects a directory that is already mapped', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      outlineUrl: 'https://x',
      apiKey: 'k',
      directoryMappings: [{ directoryPath: 'Compendium', collectionId: 'col-1', collectionName: 'Compendium' }],
    };
    const saveSettings = jest.fn();
    const { engine, root } = makeEngine(fakeApi(), settings, saveSettings);
    const folder = new FakeTFolder('Compendium', 'Compendium', root);

    await engine.mapDirectory(folder as never);

    expect(settings.directoryMappings).toHaveLength(1);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('maps a top-level directory to an existing collection by name', async () => {
    const settings = { ...DEFAULT_SETTINGS, outlineUrl: 'https://x', apiKey: 'k' };
    const saveSettings = jest.fn();
    const api = fakeApi({
      async listCollections() {
        return [{ id: 'col-existing', name: 'Compendium' } as Collection];
      },
    });
    const { engine, root } = makeEngine(api, settings, saveSettings);
    const folder = new FakeTFolder('Compendium', 'Compendium', root);

    await engine.mapDirectory(folder as never);

    expect(settings.directoryMappings).toEqual([
      { directoryPath: 'Compendium', collectionId: 'col-existing', collectionName: 'Compendium' },
    ]);
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it('creates a collection when none matches and maps the directory to it', async () => {
    const settings = { ...DEFAULT_SETTINGS, outlineUrl: 'https://x', apiKey: 'k' };
    const saveSettings = jest.fn();
    const { engine, root } = makeEngine(fakeApi(), settings, saveSettings);
    const folder = new FakeTFolder('Compendium', 'Compendium', root);

    await engine.mapDirectory(folder as never);

    expect(settings.directoryMappings).toEqual([
      { directoryPath: 'Compendium', collectionId: 'col-new', collectionName: 'Compendium' },
    ]);
  });

  it('does not save a mapping when resolution fails', async () => {
    const settings = { ...DEFAULT_SETTINGS, outlineUrl: 'https://x', apiKey: 'k' };
    const saveSettings = jest.fn();
    const api = fakeApi({
      async createCollection() {
        throw new Error('simulated 400');
      },
    });
    const { engine, root } = makeEngine(api, settings, saveSettings);
    const folder = new FakeTFolder('Compendium', 'Compendium', root);

    await engine.mapDirectory(folder as never);

    expect(settings.directoryMappings).toEqual([]);
    expect(saveSettings).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/pushEngineMapDirectory.test.ts`
Expected: FAIL — `engine.mapDirectory is not a function`.

- [ ] **Step 3: Implement `mapDirectory`**

In `src/push-engine.ts`:

1. Add the import:

```ts
import { resolveOrCreateCollection } from './collection-resolver';
import type { DirectoryMapping } from './settings';
```

2. Add the method (place it after `buildFolderIndex`, before `buildOptions`):

```ts
  async mapDirectory(folder: TFolder): Promise<void> {
    if (!this.validateConfig()) return;

    if (folder.parent !== this.app.vault.getRoot()) {
      new Notice('Outline Sync: only top-level folders can be mapped to a collection.');
      return;
    }
    if (this.settings.directoryMappings.some((m) => m.directoryPath === folder.path)) {
      new Notice(`Outline Sync: "${folder.path}" is already mapped.`);
      return;
    }

    const resolved = await resolveOrCreateCollection(this.client, folder.name);
    if (!resolved) {
      new Notice(
        `Outline Sync: could not resolve or create a collection named "${folder.name}".`
      );
      return;
    }

    const mapping: DirectoryMapping = {
      directoryPath: folder.path,
      collectionId: resolved.id,
      collectionName: resolved.name,
    };
    this.settings.directoryMappings.push(mapping);
    await this.saveSettings();

    new Notice(
      resolved.created
        ? `Outline Sync: created collection "${resolved.name}" and mapped "${folder.path}" to it.`
        : `Outline Sync: mapped "${folder.path}" to existing collection "${resolved.name}".`
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/pushEngineMapDirectory.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Full verification and commit**

Run: `npx tsc -noEmit -skipLibCheck && npm test && npx prettier --check src/push-engine.ts tests/pushEngineMapDirectory.test.ts`

```bash
git add src/push-engine.ts tests/pushEngineMapDirectory.test.ts
git commit -m "feat: add PushEngine.mapDirectory to pair a top-level folder with a collection"
```

---

## Task 7: `PushEngine.syncMappedDirectory`

**Files:**
- Modify: `src/push-engine.ts`
- Test: `tests/pushEngineSyncMappedDirectory.test.ts`

**Interfaces:**
- Consumes: `summarizeResult` (Task 5, private — exercised indirectly), `SyncLogWriter` (Task 4), `DirectoryMapping` (Task 3), `SyncResult.failedFiles` (Task 1).
- Produces: `PushEngine.syncMappedDirectory(folder: TFolder, mapping: DirectoryMapping, trigger?: 'manual' | 'sync-all'): Promise<SyncResult>` — consumed by Task 8 and Task 9.

- [ ] **Step 1: Write the failing tests**

Create `tests/pushEngineSyncMappedDirectory.test.ts`. This mocks both
`obsidian` (for `Notice`) and `./plugin-ui/sync-log-notice` (so the test
doesn't have to fake DOM/`Notice.containerEl` -- `SyncLogNotice` becomes a
no-op mock instance):

```ts
const NoticeMock = jest.fn();
class FakeTFolder {
  path: string;
  name: string;
  parent: FakeTFolder | null;
  children: unknown[] = [];
  constructor(path: string, name: string, parent: FakeTFolder | null = null) {
    this.path = path;
    this.name = name;
    this.parent = parent;
  }
}
jest.mock('obsidian', () => ({ Notice: NoticeMock, TFolder: FakeTFolder, TFile: class TFile {} }), {
  virtual: true,
});
jest.mock('../src/plugin-ui/sync-log-notice');

import { PushEngine } from '../src/push-engine';
import { syncFolder } from '../src/sync/sync';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { DirectoryMapping } from '../src/settings';
import type { OutlineClient } from '../src/outline-client';
import type { SyncLogEntry, SyncLogWriter } from '../src/plugin-ui/sync-log-writer';

// push-engine.ts imports both syncDocument and syncFolder from './sync'
// (src/sync/index.ts, which re-exports from src/sync/sync.ts -- the same
// resolved path this jest.mock targets). Only syncFolder is exercised by
// these tests, but syncDocument is stubbed too so the module shape matches.
jest.mock('../src/sync/sync', () => ({
  syncDocument: jest.fn(),
  syncFolder: jest.fn(),
}));

// createObsidianSyncEnv reads real Obsidian vault APIs -- stub it out too,
// syncFolder itself is mocked so its env is never actually used to read files.
jest.mock('../src/adapters/obsidian', () => ({
  createObsidianSyncEnv: () => ({}),
  buildWikiLinkResolver: () => () => null,
}));

const mapping: DirectoryMapping = {
  directoryPath: 'Compendium',
  collectionId: 'col-1',
  collectionName: 'Compendium',
};

function makeEngine(logWriter: SyncLogWriter) {
  const fakeApp = { vault: { getRoot: () => new FakeTFolder('/', '', null) } };
  const settings = { ...DEFAULT_SETTINGS, outlineUrl: 'https://x', apiKey: 'k' };
  return new PushEngine(
    fakeApp as never,
    {} as unknown as OutlineClient,
    settings,
    async () => {},
    logWriter
  );
}

describe('PushEngine.syncMappedDirectory', () => {
  beforeEach(() => {
    NoticeMock.mockClear();
    (syncFolder as jest.Mock).mockReset();
  });

  it('syncs with overwrite strategy and the mapping collection, no conflict prompt', async () => {
    (syncFolder as jest.Mock).mockResolvedValue({
      success: 2,
      skipped: 0,
      failed: 0,
      total: 2,
      foldersCreated: 0,
      failedFiles: [],
    });
    const engine = makeEngine({ append: async () => {} });
    const folder = new FakeTFolder('Compendium', 'Compendium');

    await engine.syncMappedDirectory(folder as never, mapping);

    const [options] = (syncFolder as jest.Mock).mock.calls[0];
    expect(options.collectionId).toBe('col-1');
    expect(options.folderConflictStrategy).toBe('overwrite');
  });

  it('writes one log entry with the run counts', async () => {
    (syncFolder as jest.Mock).mockResolvedValue({
      success: 3,
      skipped: 1,
      failed: 0,
      total: 4,
      foldersCreated: 1,
      failedFiles: [],
    });
    const entries: SyncLogEntry[] = [];
    const engine = makeEngine({
      append: async (e) => {
        entries.push(e);
      },
    });
    const folder = new FakeTFolder('Compendium', 'Compendium');

    await engine.syncMappedDirectory(folder as never, mapping, 'manual');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      directoryPath: 'Compendium',
      collectionId: 'col-1',
      collectionName: 'Compendium',
      trigger: 'manual',
      success: 3,
      skipped: 1,
      failed: 0,
      total: 4,
      foldersCreated: 1,
    });
    expect(entries[0].failures).toBeUndefined();
  });

  it('includes failures in the log entry only when the run had failures', async () => {
    (syncFolder as jest.Mock).mockResolvedValue({
      success: 1,
      skipped: 0,
      failed: 1,
      total: 2,
      foldersCreated: 0,
      failedFiles: [{ path: 'Broken.md', error: 'simulated 500' }],
    });
    const entries: SyncLogEntry[] = [];
    const engine = makeEngine({
      append: async (e) => {
        entries.push(e);
      },
    });
    const folder = new FakeTFolder('Compendium', 'Compendium');

    await engine.syncMappedDirectory(folder as never, mapping);

    expect(entries[0].failures).toEqual([{ path: 'Broken.md', error: 'simulated 500' }]);
  });

  it('still writes a log entry when syncFolder throws outright', async () => {
    (syncFolder as jest.Mock).mockRejectedValue(new Error('simulated connection refused'));
    const entries: SyncLogEntry[] = [];
    const engine = makeEngine({
      append: async (e) => {
        entries.push(e);
      },
    });
    const folder = new FakeTFolder('Compendium', 'Compendium');

    const result = await engine.syncMappedDirectory(folder as never, mapping);

    expect(entries).toHaveLength(1);
    expect(entries[0].failures?.[0]?.error).toContain('simulated connection refused');
    expect(result.failedFiles[0]?.error).toContain('simulated connection refused');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/pushEngineSyncMappedDirectory.test.ts`
Expected: FAIL — `engine.syncMappedDirectory is not a function`.

- [ ] **Step 3: Implement `syncMappedDirectory`**

In `src/push-engine.ts`, add after `pushFolder`:

```ts
  async syncMappedDirectory(
    folder: TFolder,
    mapping: DirectoryMapping,
    trigger: 'manual' | 'sync-all' = 'manual'
  ): Promise<SyncResult> {
    // A mapped sync is a routine, repeatable action -- default to overwrite
    // rather than prompting every run the way the ad-hoc push flow does.
    const options = this.buildOptions(mapping.collectionId, 'overwrite');
    const log = new SyncLogNotice(`Syncing ${folder.name}…`);
    const env = createObsidianSyncEnv({
      app: this.app,
      api: this.client,
      folderIndex: this.buildFolderIndex(),
      onProgress: (msg) => log.appendLine(msg),
    });

    let result: SyncResult;
    try {
      result = await syncFolder(options, env, folder.path);
      const { summary, ok } = this.summarizeResult(result);
      log.finish(summary, ok);
    } catch (e) {
      const msg = getErrorMessage(e);
      result = {
        success: 0,
        failed: 0,
        skipped: 0,
        total: 0,
        foldersCreated: 0,
        failedFiles: [{ path: folder.path, error: msg }],
      };
      log.finish(`✗ Sync failed: ${msg}`, false);
      console.error('[Outline Sync] syncMappedDirectory error:', e);
    }

    await this.syncLogWriter.append({
      timestamp: new Date().toISOString(),
      directoryPath: mapping.directoryPath,
      collectionId: mapping.collectionId,
      collectionName: mapping.collectionName,
      trigger,
      success: result.success,
      skipped: result.skipped,
      failed: result.failed,
      total: result.total,
      foldersCreated: result.foldersCreated,
      ...(result.failedFiles.length > 0 ? { failures: result.failedFiles } : {}),
    });

    return result;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/pushEngineSyncMappedDirectory.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Full verification and commit**

Run: `npx tsc -noEmit -skipLibCheck && npm test && npx prettier --check src/push-engine.ts tests/pushEngineSyncMappedDirectory.test.ts`

```bash
git add src/push-engine.ts tests/pushEngineSyncMappedDirectory.test.ts
git commit -m "feat: add PushEngine.syncMappedDirectory with logging, no conflict prompt"
```

---

## Task 8: `PushEngine.syncAllMappedDirectories`

**Files:**
- Modify: `src/push-engine.ts`
- Test: `tests/pushEngineSyncAll.test.ts`

**Interfaces:**
- Consumes: `PushEngine.syncMappedDirectory` (Task 7).
- Produces: `PushEngine.syncAllMappedDirectories(): Promise<void>` — consumed by `main.ts` (Task 9).

- [ ] **Step 1: Write the failing tests**

Create `tests/pushEngineSyncAll.test.ts`:

```ts
const NoticeMock = jest.fn();
class FakeTFolder {
  path: string;
  name: string;
  parent: FakeTFolder | null;
  children: unknown[] = [];
  constructor(path: string, name: string, parent: FakeTFolder | null = null) {
    this.path = path;
    this.name = name;
    this.parent = parent;
  }
}
jest.mock('obsidian', () => ({ Notice: NoticeMock, TFolder: FakeTFolder, TFile: class TFile {} }), {
  virtual: true,
});

import { PushEngine } from '../src/push-engine';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { OutlineClient } from '../src/outline-client';
import type { SyncLogWriter } from '../src/plugin-ui/sync-log-writer';
import type { SyncResult } from '../src/sync/types';

const noopLogWriter: SyncLogWriter = { append: async () => {} };

function baseResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    success: 1,
    skipped: 0,
    failed: 0,
    total: 1,
    foldersCreated: 0,
    failedFiles: [],
    ...overrides,
  };
}

describe('PushEngine.syncAllMappedDirectories', () => {
  beforeEach(() => NoticeMock.mockClear());

  it('does nothing and notifies when no directories are mapped', async () => {
    const settings = { ...DEFAULT_SETTINGS, outlineUrl: 'https://x', apiKey: 'k' };
    const fakeApp = {
      vault: { getRoot: () => new FakeTFolder('/', '', null), getAbstractFileByPath: () => null },
    };
    const engine = new PushEngine(
      fakeApp as never,
      {} as unknown as OutlineClient,
      settings,
      async () => {},
      noopLogWriter
    );

    await engine.syncAllMappedDirectories();

    expect(NoticeMock).toHaveBeenCalledWith(expect.stringContaining('no directories mapped'));
  });

  it('syncs every mapped directory and continues past a failure', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      outlineUrl: 'https://x',
      apiKey: 'k',
      directoryMappings: [
        { directoryPath: 'A', collectionId: 'col-a', collectionName: 'A' },
        { directoryPath: 'B', collectionId: 'col-b', collectionName: 'B' },
      ],
    };
    const root = new FakeTFolder('/', '', null);
    const folderA = new FakeTFolder('A', 'A', root);
    const folderB = new FakeTFolder('B', 'B', root);
    const fakeApp = {
      vault: {
        getRoot: () => root,
        getAbstractFileByPath: (path: string) =>
          path === 'A' ? folderA : path === 'B' ? folderB : null,
      },
    };
    const engine = new PushEngine(
      fakeApp as never,
      {} as unknown as OutlineClient,
      settings,
      async () => {},
      noopLogWriter
    );
    const calls: string[] = [];
    engine.syncMappedDirectory = async (folder, mapping, trigger) => {
      calls.push(mapping.directoryPath);
      expect(trigger).toBe('sync-all');
      if (mapping.directoryPath === 'A') {
        return baseResult({ failed: 1, success: 0 });
      }
      return baseResult();
    };

    await engine.syncAllMappedDirectories();

    expect(calls).toEqual(['A', 'B']);
    expect(NoticeMock).toHaveBeenCalledWith(expect.stringContaining('1/2'));
  });

  it('skips a mapping whose folder no longer exists in the vault, without throwing', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      outlineUrl: 'https://x',
      apiKey: 'k',
      directoryMappings: [{ directoryPath: 'Gone', collectionId: 'col-1', collectionName: 'Gone' }],
    };
    const fakeApp = {
      vault: { getRoot: () => new FakeTFolder('/', '', null), getAbstractFileByPath: () => null },
    };
    const engine = new PushEngine(
      fakeApp as never,
      {} as unknown as OutlineClient,
      settings,
      async () => {},
      noopLogWriter
    );
    let called = false;
    engine.syncMappedDirectory = async () => {
      called = true;
      return baseResult();
    };

    await expect(engine.syncAllMappedDirectories()).resolves.toBeUndefined();
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/pushEngineSyncAll.test.ts`
Expected: FAIL — `engine.syncAllMappedDirectories is not a function`.

- [ ] **Step 3: Implement `syncAllMappedDirectories`**

In `src/push-engine.ts`, add after `syncMappedDirectory`:

```ts
  async syncAllMappedDirectories(): Promise<void> {
    if (!this.validateConfig()) return;

    const mappings = this.settings.directoryMappings;
    if (mappings.length === 0) {
      new Notice('Outline Sync: no directories mapped yet.');
      return;
    }

    let succeeded = 0;
    for (const mapping of mappings) {
      const folder = this.app.vault.getAbstractFileByPath(mapping.directoryPath);
      if (!(folder instanceof TFolder)) {
        console.error(`[Outline Sync] Mapped directory not found: ${mapping.directoryPath}`);
        continue;
      }
      const result = await this.syncMappedDirectory(folder, mapping, 'sync-all');
      if (result.failed === 0) succeeded++;
    }

    const noun = mappings.length === 1 ? 'directory' : 'directories';
    new Notice(`Outline Sync: ${succeeded}/${mappings.length} ${noun} synced cleanly.`);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/pushEngineSyncAll.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Full verification and commit**

Run: `npx tsc -noEmit -skipLibCheck && npm test && npx prettier --check src/push-engine.ts tests/pushEngineSyncAll.test.ts`

```bash
git add src/push-engine.ts tests/pushEngineSyncAll.test.ts
git commit -m "feat: add PushEngine.syncAllMappedDirectories, continues past one failure"
```

---

## Task 9: Commands and context menu wiring

**Files:**
- Modify: `src/plugin-ui/main.ts`

**Interfaces:**
- Consumes: `PushEngine.mapDirectory`, `PushEngine.syncMappedDirectory`, `PushEngine.syncAllMappedDirectories` (Tasks 6–8).

This task is Obsidian command/menu registration glue — following the
existing, already-untested pattern in this file (`push-folder-to-outline`'s
command and menu item have no dedicated test either). Verified by `tsc` and
a manual smoke test in Obsidian (Step 3), not a new automated test.

- [ ] **Step 1: Add the two new commands**

In `src/plugin-ui/main.ts`, inside `onload()`, after the existing
`push-folder-to-outline` command registration:

```ts
    this.addCommand({
      id: 'map-directory-to-outline',
      name: 'Map this directory to an Outline collection',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const folder = file?.parent;
        if (!(folder instanceof TFolder) || folder.parent !== this.app.vault.getRoot()) {
          return false;
        }
        if (!checking) void this.engine.mapDirectory(folder);
        return true;
      },
    });

    this.addCommand({
      id: 'sync-directory-to-outline',
      name: 'Sync this directory to Outline',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const folder = file?.parent;
        const mapping =
          folder instanceof TFolder
            ? this.settings.directoryMappings.find((m) => m.directoryPath === folder.path)
            : undefined;
        if (!folder || !mapping) return false;
        if (!checking) void this.engine.syncMappedDirectory(folder, mapping, 'manual');
        return true;
      },
    });

    this.addCommand({
      id: 'sync-all-mapped-directories',
      name: 'Sync all mapped directories to Outline',
      callback: () => void this.engine.syncAllMappedDirectories(),
    });
```

- [ ] **Step 2: Add context menu items for folders**

In `src/plugin-ui/main.ts`, inside the existing `file-menu` event handler,
in the `if (abstractFile instanceof TFolder)` block, after the existing
"Push folder to Outline" item:

```ts
        if (abstractFile instanceof TFolder) {
          menu.addItem((item) => {
            item
              .setTitle('Push folder to Outline')
              .setIcon('folder-up')
              .onClick(() => void this.pushFolderWithPicker(abstractFile));
          });

          const mapping = this.settings.directoryMappings.find(
            (m) => m.directoryPath === abstractFile.path
          );
          if (mapping) {
            menu.addItem((item) => {
              item
                .setTitle('Sync to Outline')
                .setIcon('refresh-cw')
                .onClick(() => void this.engine.syncMappedDirectory(abstractFile, mapping, 'manual'));
            });
          } else if (abstractFile.parent === this.app.vault.getRoot()) {
            menu.addItem((item) => {
              item
                .setTitle('Map this directory to an Outline collection')
                .setIcon('link')
                .onClick(() => void this.engine.mapDirectory(abstractFile));
            });
          }
        }
```

- [ ] **Step 3: Manual smoke test**

Run: `npm run build`

Copy `main.js` and `manifest.json` to the test vault's plugin directory
(same path used earlier this session:
`/Users/darthkamal/Projects/Obs/.obsidian/plugins/obsidian-outline-sync/`),
then in Obsidian:

1. Reload the plugin (or restart Obsidian) so the new commands register.
2. Right-click a top-level folder → "Map this directory to an Outline
   collection." Confirm the `Notice` reports either "mapped to existing
   collection" or "created collection" as expected, and check the Outline
   instance for the collection.
3. Right-click the same folder again → confirm the menu now shows "Sync to
   Outline" instead of the mapping option.
4. Run "Sync to Outline" → confirm the push completes and
   `.obsidian/plugins/obsidian-outline-sync/sync-log.json` now has one new
   entry (`cat` the file or open it in a text editor outside Obsidian).
5. Run the command palette action "Sync all mapped directories to Outline"
   → confirm it processes every mapped directory and reports an aggregate
   count.

- [ ] **Step 4: Full verification and commit**

Run: `npx tsc -noEmit -skipLibCheck && npm test && npx prettier --check src/plugin-ui/main.ts`

```bash
git add src/plugin-ui/main.ts
git commit -m "feat: add commands and context menu items for directory-collection sync"
```

---

## Task 10: Settings tab UI

**Files:**
- Modify: `src/plugin-ui/setting-tab.ts`
- Modify: `src/plugin-ui/main.ts` (`engine` field visibility only, see Step 1)

**Interfaces:**
- Consumes: `settings.directoryMappings` (Task 3), `PushEngine.mapDirectory`, `PushEngine.syncMappedDirectory` (Tasks 6–7).

Pure Obsidian DOM-building UI code, matching this file's existing convention
(no tests currently exist for `setting-tab.ts`). Verified manually.

- [ ] **Step 1: Add the mappings section**

In `src/plugin-ui/setting-tab.ts`, add the import:

```ts
import { TFolder } from 'obsidian';
```

Add a new section at the end of `display()`, right before the closing brace
(after the "Remove table of contents" `Setting` block):

```ts
    containerEl.createEl('h3', { text: 'Directory → Collection mappings' });
    containerEl.createEl('p', {
      text:
        'Top-level directories synced against their own dedicated collection. ' +
        'Unmapped directories are unaffected.',
      cls: 'setting-item-description',
    });

    for (const mapping of this.plugin.settings.directoryMappings) {
      new Setting(containerEl)
        .setName(mapping.directoryPath)
        .setDesc(`→ ${mapping.collectionName}`)
        .addButton((btn) =>
          btn.setButtonText('Sync now').onClick(async () => {
            const folder = this.plugin.app.vault.getAbstractFileByPath(mapping.directoryPath);
            if (!(folder instanceof TFolder)) {
              new Notice(`Outline Sync: "${mapping.directoryPath}" no longer exists in the vault.`);
              return;
            }
            await this.plugin.engine.syncMappedDirectory(folder, mapping, 'manual');
          })
        )
        .addButton((btn) =>
          btn.setButtonText('Remove mapping').onClick(async () => {
            this.plugin.settings.directoryMappings = this.plugin.settings.directoryMappings.filter(
              (m) => m.directoryPath !== mapping.directoryPath
            );
            await this.plugin.saveSettings();
            this.display();
          })
        );
    }

    const alreadyMapped = new Set(
      this.plugin.settings.directoryMappings.map((m) => m.directoryPath)
    );
    const candidates = this.plugin.app.vault
      .getRoot()
      .children.filter(
        (f): f is TFolder =>
          f instanceof TFolder && !f.name.startsWith('.') && !alreadyMapped.has(f.path)
      );

    new Setting(containerEl)
      .setName('Add directory')
      .setDesc('Map a top-level directory to an Outline collection (found or created by name).')
      .addDropdown((dropdown) => {
        dropdown.addOption('', '— Select a directory —');
        for (const folder of candidates) {
          dropdown.addOption(folder.path, folder.name);
        }
        dropdown.onChange(async (value) => {
          if (!value) return;
          const folder = this.plugin.app.vault.getAbstractFileByPath(value);
          if (folder instanceof TFolder) {
            await this.plugin.engine.mapDirectory(folder);
            this.display();
          }
        });
      });
```

`PushEngine` needs to be reachable from the setting tab as
`this.plugin.engine` — check `src/plugin-ui/main.ts`: `engine` is currently
`private engine!: PushEngine;`. Change it to a plain (non-private) field so
`setting-tab.ts` can call it, matching how `this.plugin.client` and
`this.plugin.settings` are already accessed the same way from this file:

```ts
  engine!: PushEngine;
```

- [ ] **Step 2: Manual smoke test**

Run: `npm run build`, copy `main.js`/`manifest.json` to the test vault as in
Task 9 Step 3, reload the plugin, open Settings → Outline Sync:

1. Confirm the "Directory → Collection mappings" section appears below
   "Remove table of contents."
2. Confirm the "Add directory" dropdown lists top-level folders not yet
   mapped, and dot-directories are excluded.
3. Select a directory → confirm a new row appears with "Sync now" / "Remove
   mapping" buttons, and the dropdown no longer offers that directory.
4. Click "Sync now" → confirm it runs (log notice appears, sync-log.json
   gains an entry).
5. Click "Remove mapping" → confirm the row disappears and the directory
   reappears in the "Add directory" dropdown.

- [ ] **Step 3: Full verification and commit**

Run: `npx tsc -noEmit -skipLibCheck && npm test && npx prettier --check src/plugin-ui/setting-tab.ts src/plugin-ui/main.ts`

```bash
git add src/plugin-ui/setting-tab.ts src/plugin-ui/main.ts
git commit -m "feat: add directory-to-collection mapping UI to the settings tab"
```

---

## Final check

After Task 10, run the full verification one more time to confirm nothing
regressed across the whole plan:

```bash
npx tsc -noEmit -skipLibCheck
npm test
npx prettier --check src tests
npm run build
```

All should pass clean. `npm test` should report more tests than the 204
this plan started from (Task 1 adds 1, Task 2 adds 6, Task 3 adds 4, Task 4
adds 6, Task 6 adds 5, Task 7 adds 4, Task 8 adds 3 — 233 total expected).
