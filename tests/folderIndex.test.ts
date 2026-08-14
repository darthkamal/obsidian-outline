import { syncFolder } from '../src/sync/sync';
import type { SyncOptions, SyncEnv, FileDescriptor, FolderIndex } from '../src/sync/types';
import type { IOutlineApi, Collection, Document } from '../src/outline-api/types';

/**
 * Fake API whose search never finds anything -- this models Outline's
 * `documents.search`, which is backed by an eventually-consistent full text
 * index and so may not return a document that was created moments ago.
 */
function makeFakeApi(opts: { searchFinds?: boolean } = {}) {
  let nextId = 1;
  const docs = new Map<string, Document>();
  const created: { id: string; title: string; parentDocumentId?: string }[] = [];

  const api: IOutlineApi & typeof extras = {
    async checkConnection() {
      return { ok: true as const, user: 'test' };
    },
    async validateAuth() {
      return 'Test User';
    },
    async listCollections(): Promise<Collection[] | null> {
      return [];
    },
    async createCollection() {
      return null;
    },
    async getDocument(id: string) {
      return docs.get(id) ?? null;
    },
    async createDocument(params) {
      const doc: Document = {
        id: `doc-${nextId++}`,
        title: params.title,
        text: params.text,
        collectionId: params.collectionId,
        parentDocumentId: params.parentDocumentId,
      };
      docs.set(doc.id!, doc);
      created.push({
        id: doc.id!,
        title: params.title,
        parentDocumentId: params.parentDocumentId,
      });
      return doc;
    },
    async updateDocument(params) {
      const doc = docs.get(params.id);
      if (!doc) return null;
      doc.title = params.title;
      doc.text = params.text;
      return doc;
    },
    async searchDocumentByTitle(title, collectionId, parentDocumentId) {
      if (!opts.searchFinds) return null;
      for (const doc of docs.values()) {
        if (
          doc.title?.toLowerCase() === title.toLowerCase() &&
          doc.collectionId === collectionId &&
          (doc.parentDocumentId ?? undefined) === parentDocumentId
        ) {
          return doc;
        }
      }
      return null;
    },
    async createAttachment() {
      return null;
    },
    async uploadAttachmentToStorage() {
      return false;
    },
    created,
    docs,
  };
  const extras = { created, docs };
  return api;
}

function makeEnv(
  api: IOutlineApi,
  fileContents: Record<string, string>,
  folderIndex?: FolderIndex
): SyncEnv {
  const files: FileDescriptor[] = Object.keys(fileContents).map((relPath) => ({
    path: relPath,
    basename: relPath.split('/').pop()!.replace(/\.md$/, ''),
    relativePath: relPath,
  }));

  return {
    api,
    async listMarkdownFiles() {
      return files;
    },
    async readFile(fd) {
      return fileContents[fd.relativePath ?? fd.path] ?? '';
    },
    getWikiResolver() {
      return () => null;
    },
    resolveImage() {
      return null;
    },
    async readImageBytes() {
      return new ArrayBuffer(0);
    },
    async writeFrontmatter() {},
    folderIndex,
  };
}

/** In-memory stand-in for the persisted map. */
function makeFolderIndex(): FolderIndex & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: (key) => store.get(key),
    set: async (key, id) => {
      store.set(key, id);
    },
  };
}

const options: SyncOptions = {
  outlineUrl: 'https://example.com',
  apiKey: 'test-key',
  collectionId: 'col-1',
  removeToc: false,
  indexAsFolder: true,
  folderConflictStrategy: 'overwrite',
};

const vault = { 'A/B/leaf.md': '# leaf' };

describe('folder placeholder documents survive a re-sync', () => {
  it('does not duplicate placeholders when search cannot find them', async () => {
    const api = makeFakeApi({ searchFinds: false });
    const index = makeFolderIndex();

    await syncFolder(options, makeEnv(api, vault, index), '/root');
    const firstRun = api.created.filter((d) => d.title === 'A' || d.title === 'B');
    expect(firstRun).toHaveLength(2);

    // Second run, same persisted index, search still blind.
    await syncFolder(options, makeEnv(api, vault, index), '/root');
    const allFolderDocs = api.created.filter((d) => d.title === 'A' || d.title === 'B');
    expect(allFolderDocs).toHaveLength(2); // no new placeholders
  });

  it('records folder ids in the index, namespaced by collection', async () => {
    const api = makeFakeApi();
    const index = makeFolderIndex();

    await syncFolder(options, makeEnv(api, vault, index), '/root');

    // Keys use the full relative path so two folders sharing a name in
    // different places cannot collide.
    expect(index.store.get('col-1:A')).toBeDefined();
    expect(index.store.get('col-1:A/B')).toBeDefined();
    expect(index.store.get('col-1:A')).not.toEqual(index.store.get('col-1:A/B'));
  });

  it('distinguishes same-named folders in different places', async () => {
    const api = makeFakeApi({ searchFinds: false });
    const index = makeFolderIndex();

    await syncFolder(
      options,
      makeEnv(api, { 'X/Shared/a.md': '# a', 'Y/Shared/b.md': '# b' }, index),
      '/root'
    );

    expect(index.store.get('col-1:X/Shared')).toBeDefined();
    expect(index.store.get('col-1:Y/Shared')).toBeDefined();
    expect(index.store.get('col-1:X/Shared')).not.toEqual(index.store.get('col-1:Y/Shared'));
  });

  it('keeps placeholders separate per collection', async () => {
    const api = makeFakeApi({ searchFinds: false });
    const index = makeFolderIndex();

    await syncFolder(options, makeEnv(api, vault, index), '/root');
    await syncFolder({ ...options, collectionId: 'col-2' }, makeEnv(api, vault, index), '/root');

    expect(index.store.get('col-1:A')).toBeDefined();
    expect(index.store.get('col-2:A')).toBeDefined();
    expect(index.store.get('col-1:A')).not.toEqual(index.store.get('col-2:A'));
  });

  it('re-creates the placeholder if the remembered document is gone', async () => {
    const api = makeFakeApi({ searchFinds: false });
    const index = makeFolderIndex();

    await syncFolder(options, makeEnv(api, vault, index), '/root');
    const staleId = index.store.get('col-1:A')!;
    api.docs.delete(staleId); // someone deleted it in Outline

    await syncFolder(options, makeEnv(api, vault, index), '/root');

    expect(index.store.get('col-1:A')).toBeDefined();
    expect(index.store.get('col-1:A')).not.toEqual(staleId);
  });

  it('still works when no folder index is provided', async () => {
    const api = makeFakeApi({ searchFinds: true });
    await syncFolder(options, makeEnv(api, vault), '/root');
    expect(api.created.map((d) => d.title)).toEqual(expect.arrayContaining(['A', 'B', 'leaf']));
  });

  it('reuses a placeholder found by search and remembers it', async () => {
    const api = makeFakeApi({ searchFinds: true });
    const index = makeFolderIndex();

    await syncFolder(options, makeEnv(api, vault, index), '/root');
    const idAfterFirst = index.store.get('col-1:A');

    await syncFolder(options, makeEnv(api, vault, index), '/root');
    expect(index.store.get('col-1:A')).toEqual(idAfterFirst);
    expect(api.created.filter((d) => d.title === 'A')).toHaveLength(1);
  });
});
