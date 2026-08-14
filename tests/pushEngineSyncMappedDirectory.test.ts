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
