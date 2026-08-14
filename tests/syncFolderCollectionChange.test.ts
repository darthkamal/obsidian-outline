import { syncFolder } from '../src/sync/sync';
import type { SyncOptions, SyncEnv, FileDescriptor } from '../src/sync/types';
import type { IOutlineApi, Collection, Document } from '../src/outline-api/types';

/**
 * Regression cover for the skip-unchanged/collection interaction: pointing an
 * already-pushed folder at a *different* collection (what mapping a directory
 * to its own collection does) must not skip every unchanged note and report a
 * clean sync for a collection that never received them.
 *
 * These tests drive the real skip path end to end -- run one pushes and writes
 * the frontmatter back into the file store, run two reads that frontmatter --
 * rather than hand-computing a content hash that could drift from the real one.
 */
function makeFakeApi(): IOutlineApi & {
  created: { title: string; collectionId: string }[];
  updated: { id: string; title: string }[];
} {
  let nextId = 1;
  const docs = new Map<string, Document>();

  const api: ReturnType<typeof makeFakeApi> = {
    created: [],
    updated: [],
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
      api.created.push({ title: params.title, collectionId: params.collectionId });
      return doc;
    },
    async updateDocument(params) {
      const doc = docs.get(params.id);
      if (!doc) return null;
      doc.title = params.title;
      doc.text = params.text;
      api.updated.push({ id: params.id, title: params.title });
      return doc;
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
  };
  return api;
}

/**
 * Env over a mutable file store whose writeFrontmatter really rewrites the
 * file, the way the Obsidian adapter does -- so a second run sees the
 * outline_id/outline_collection_id/outline_content_hash the first run left.
 */
function makeEnv(
  api: IOutlineApi,
  store: Record<string, string>,
  opts: { recordCollectionId?: boolean } = {}
): SyncEnv {
  const recordCollectionId = opts.recordCollectionId ?? true;
  const files: FileDescriptor[] = Object.keys(store).map((relPath) => ({
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
      return store[fd.relativePath ?? fd.path] ?? '';
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
    async writeFrontmatter(fd, meta) {
      const key = fd.relativePath ?? fd.path;
      const body = (store[key] ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
      const lines = [`outline_id: ${meta.outlineId}`];
      if (recordCollectionId) lines.push(`outline_collection_id: ${meta.collectionId}`);
      if (meta.contentHash !== undefined) lines.push(`outline_content_hash: ${meta.contentHash}`);
      store[key] = `---\n${lines.join('\n')}\n---\n${body}`;
    },
  };
}

const baseOptions: SyncOptions = {
  outlineUrl: 'https://example.com',
  apiKey: 'test-key',
  collectionId: 'col-old',
  removeToc: false,
  indexAsFolder: true,
  folderConflictStrategy: 'overwrite',
  skipUnchanged: true,
};

describe('skipUnchanged and a changed target collection', () => {
  it('still skips an unchanged note re-synced against the same collection', async () => {
    const api = makeFakeApi();
    const store: Record<string, string> = { 'Note.md': '# Hello' };
    const env = makeEnv(api, store);

    const first = await syncFolder(baseOptions, env, '/root');
    expect(first.success).toBe(1);

    const second = await syncFolder(baseOptions, env, '/root');

    expect(second.skipped).toBe(1);
    expect(second.success).toBe(0);
    expect(api.created).toHaveLength(1);
  });

  it('does not skip an unchanged note when the target collection changed', async () => {
    const api = makeFakeApi();
    const store: Record<string, string> = { 'Note.md': '# Hello' };
    const env = makeEnv(api, store);

    await syncFolder(baseOptions, env, '/root');
    expect(api.created).toEqual([{ title: 'Note', collectionId: 'col-old' }]);

    // Same untouched body, new destination -- e.g. the folder was just mapped
    // to its own collection.
    const result = await syncFolder({ ...baseOptions, collectionId: 'col-new' }, env, '/root');

    expect(result.skipped).toBe(0);
    expect(result.success).toBe(1);
    expect(api.created).toEqual([
      { title: 'Note', collectionId: 'col-old' },
      { title: 'Note', collectionId: 'col-new' },
    ]);
  });

  it('still skips a legacy note that has no recorded collection id', async () => {
    const api = makeFakeApi();
    const store: Record<string, string> = { 'Note.md': '# Hello' };
    // Frontmatter written before outline_collection_id existed.
    const env = makeEnv(api, store, { recordCollectionId: false });

    await syncFolder(baseOptions, env, '/root');
    expect(store['Note.md']).not.toContain('outline_collection_id');

    const result = await syncFolder({ ...baseOptions, collectionId: 'col-new' }, env, '/root');

    expect(result.skipped).toBe(1);
    expect(api.created).toHaveLength(1);
  });
});
