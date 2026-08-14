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
    // push-engine.ts transitively imports plugin-ui/conflict-modal.ts (for
    // pushFolder's conflict resolution), which declares `class ChoiceModal
    // extends Modal` at module load time. These tests never open a modal,
    // but the class declaration still needs a real base class to extend or
    // the import throws before any test runs.
    Modal: class Modal {},
    Setting: class Setting {},
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
      directoryMappings: [
        { directoryPath: 'Compendium', collectionId: 'col-1', collectionName: 'Compendium' },
      ],
    };
    const saveSettings = jest.fn();
    const { engine, root } = makeEngine(fakeApi(), settings, saveSettings);
    const folder = new FakeTFolder('Compendium', 'Compendium', root);

    await engine.mapDirectory(folder as never);

    expect(settings.directoryMappings).toHaveLength(1);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('maps a top-level directory to an existing collection by name', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      outlineUrl: 'https://x',
      apiKey: 'k',
      directoryMappings: [],
    };
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
    const settings = {
      ...DEFAULT_SETTINGS,
      outlineUrl: 'https://x',
      apiKey: 'k',
      directoryMappings: [],
    };
    const saveSettings = jest.fn();
    const { engine, root } = makeEngine(fakeApi(), settings, saveSettings);
    const folder = new FakeTFolder('Compendium', 'Compendium', root);

    await engine.mapDirectory(folder as never);

    expect(settings.directoryMappings).toEqual([
      { directoryPath: 'Compendium', collectionId: 'col-new', collectionName: 'Compendium' },
    ]);
  });

  it('does not save a mapping when resolution fails', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      outlineUrl: 'https://x',
      apiKey: 'k',
      directoryMappings: [],
    };
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
