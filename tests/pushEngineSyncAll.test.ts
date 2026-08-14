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

  it('names the directories it could not find in the final notice', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      outlineUrl: 'https://x',
      apiKey: 'k',
      directoryMappings: [
        { directoryPath: 'A', collectionId: 'col-a', collectionName: 'A' },
        { directoryPath: 'Renamed', collectionId: 'col-r', collectionName: 'Renamed' },
      ],
    };
    const root = new FakeTFolder('/', '', null);
    const folderA = new FakeTFolder('A', 'A', root);
    const fakeApp = {
      vault: {
        getRoot: () => root,
        getAbstractFileByPath: (path: string) => (path === 'A' ? folderA : null),
      },
    };
    const engine = new PushEngine(
      fakeApp as never,
      {} as unknown as OutlineClient,
      settings,
      async () => {},
      noopLogWriter
    );
    engine.syncMappedDirectory = async () => baseResult();

    await engine.syncAllMappedDirectories();

    const notice = NoticeMock.mock.calls.at(-1)?.[0] as string;
    expect(notice).toContain('1/2');
    expect(notice).toContain('1 mapped directory not found: Renamed');
  });
});
