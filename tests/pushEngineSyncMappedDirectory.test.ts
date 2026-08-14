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
    // push-engine.ts transitively imports plugin-ui/conflict-modal.ts, which
    // declares `class ChoiceModal extends Modal` at module load time. These
    // tests never open a modal, but the class declaration still needs a real
    // base class to extend or the import throws before any test runs.
    Modal: class Modal {},
    Setting: class Setting {},
  }),
  { virtual: true }
);
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

function makeEngine(logWriter: SyncLogWriter, settingsOverrides: Record<string, unknown> = {}) {
  const fakeApp = { vault: { getRoot: () => new FakeTFolder('/', '', null) } };
  const settings = {
    ...DEFAULT_SETTINGS,
    outlineUrl: 'https://x',
    apiKey: 'k',
    ...settingsOverrides,
  };
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
    expect(entries[0].failed).toBe(1);
    expect(result.failedFiles[0]?.error).toContain('simulated connection refused');
    expect(result.failed).toBe(1);
  });

  it('refuses to sync and writes no log entry when the plugin is not configured', async () => {
    const entries: SyncLogEntry[] = [];
    const engine = makeEngine(
      {
        append: async (e) => {
          entries.push(e);
        },
      },
      { apiKey: '' }
    );
    const folder = new FakeTFolder('Compendium', 'Compendium');

    const result = await engine.syncMappedDirectory(folder as never, mapping);

    expect(syncFolder as jest.Mock).not.toHaveBeenCalled();
    expect(entries).toHaveLength(0);
    expect(result.failed).toBe(1);
    expect(result.failedFiles).toEqual([
      { path: 'Compendium', error: 'Please configure URL and API key in settings.' },
    ]);
    expect(NoticeMock).toHaveBeenCalledWith(
      expect.stringContaining('Please configure URL and API key')
    );
  });

  it('caps how many per-file failures one log entry carries', async () => {
    const failedFiles = Array.from({ length: 63 }, (_, i) => ({
      path: `Note${i}.md`,
      error: 'simulated 500',
    }));
    (syncFolder as jest.Mock).mockResolvedValue({
      success: 0,
      skipped: 0,
      failed: 63,
      total: 63,
      foldersCreated: 0,
      failedFiles,
    });
    const entries: SyncLogEntry[] = [];
    const engine = makeEngine({
      append: async (e) => {
        entries.push(e);
      },
    });
    const folder = new FakeTFolder('Compendium', 'Compendium');

    const result = await engine.syncMappedDirectory(folder as never, mapping);

    expect(entries[0].failures).toHaveLength(50);
    expect(entries[0].failures?.[0]?.path).toBe('Note0.md');
    expect(entries[0].failuresTruncated).toBe(13);
    // The full detail still reaches the caller; only the persisted log is capped.
    expect(result.failedFiles).toHaveLength(63);
  });

  it('does not mark a log entry as truncated when the failures fit', async () => {
    (syncFolder as jest.Mock).mockResolvedValue({
      success: 0,
      skipped: 0,
      failed: 1,
      total: 1,
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

    expect(entries[0].failuresTruncated).toBeUndefined();
  });

  it('refuses a second sync on the same directory while one is already running', async () => {
    // Real bug, confirmed against a live vault: nothing stopped the same
    // directory being synced twice at once (a double-click, or "Sync to
    // Outline" firing while "Sync all mapped directories" was already
    // processing it). Two concurrent syncFolder runs each saw "no
    // placeholder yet" for the same folder and both created one --
    // duplicate folder placeholders created 35ms apart in Outline.
    let resolveSyncFolder!: (value: unknown) => void;
    (syncFolder as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveSyncFolder = resolve;
      })
    );
    const engine = makeEngine({ append: async () => {} });
    const folder = new FakeTFolder('Compendium', 'Compendium');

    const first = engine.syncMappedDirectory(folder as never, mapping);
    // The first call is now in flight (syncFolder's promise hasn't resolved
    // yet) -- a second call on the same directory must not start a second
    // syncFolder run.
    const second = await engine.syncMappedDirectory(folder as never, mapping);

    expect(syncFolder as jest.Mock).toHaveBeenCalledTimes(1);
    expect(second).toEqual({
      success: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      foldersCreated: 0,
      failedFiles: [],
    });
    expect(NoticeMock).toHaveBeenCalledWith(expect.stringContaining('already syncing'));

    resolveSyncFolder({
      success: 1,
      skipped: 0,
      failed: 0,
      total: 1,
      foldersCreated: 0,
      failedFiles: [],
    });
    await first;
  });

  it('allows a directory to sync again once the previous run finished', async () => {
    (syncFolder as jest.Mock).mockResolvedValue({
      success: 1,
      skipped: 0,
      failed: 0,
      total: 1,
      foldersCreated: 0,
      failedFiles: [],
    });
    const engine = makeEngine({ append: async () => {} });
    const folder = new FakeTFolder('Compendium', 'Compendium');

    await engine.syncMappedDirectory(folder as never, mapping);
    await engine.syncMappedDirectory(folder as never, mapping);

    expect(syncFolder as jest.Mock).toHaveBeenCalledTimes(2);
  });
});
