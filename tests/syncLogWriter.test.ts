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
