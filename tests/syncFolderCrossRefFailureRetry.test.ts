import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { syncFolder } from '../src/sync/sync';
import { createNodeSyncEnv } from '../src/adapters/node';
import type { SyncOptions } from '../src/sync/types';
import type { IOutlineApi, Document } from '../src/outline-api/types';

/**
 * Real bug, same class as findings.md #2.4 ("incomplete pushes recorded as
 * complete") but never applied to cross-reference resolution: pass 1 pushes a
 * newly-linked note with a literal `%%WIKILINK[target|display]%%` marker
 * (preserveUnresolved), and pass 2's follow-up updateDocument is supposed to
 * replace it with a real link. If that follow-up call fails, the note is left
 * live in Outline with the raw marker text -- and its outline_content_hash
 * was already written during pass 1, before pass 2 ever ran, so skipUnchanged
 * treats the note as done forever. There is no second chance.
 */
describe('a note whose pass-2 link resolution fails is not marked fully synced', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'crossref-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function makeApi(): IOutlineApi {
    let nextId = 1;
    const docs = new Map<string, Document>();
    return {
      async checkConnection() {
        return { ok: true as const, user: 'test' };
      },
      async validateAuth() {
        return 'test';
      },
      async listCollections() {
        return [];
      },
      async createCollection() {
        return null;
      },
      async getDocument(id) {
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
        return doc;
      },
      // Pass 1 never calls this here (no duplicates to overwrite) -- only
      // pass 2's link-resolution follow-up does, so failing it unconditionally
      // isolates the bug precisely.
      async updateDocument() {
        throw new Error('simulated rate limit on link-fix update');
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
  }

  const options: SyncOptions = {
    outlineUrl: 'https://example.com',
    apiKey: 'test-key',
    collectionId: 'col-1',
    removeToc: false,
    indexAsFolder: true,
    folderConflictStrategy: 'overwrite',
    skipUnchanged: true,
  };

  it('clears the content hash so the note is retried, not silently skipped forever', async () => {
    fs.writeFileSync(path.join(root, 'Alpha.md'), 'See [[Beta]] for details');
    fs.writeFileSync(path.join(root, 'Beta.md'), 'Back to [[Alpha]]');

    const env = createNodeSyncEnv({ api: makeApi(), rootPath: root });
    await syncFolder(options, env, root);

    const alpha = fs.readFileSync(path.join(root, 'Alpha.md'), 'utf-8');
    const beta = fs.readFileSync(path.join(root, 'Beta.md'), 'utf-8');

    expect(alpha).not.toMatch(/outline_content_hash:/);
    expect(beta).not.toMatch(/outline_content_hash:/);
    // The id must still be recorded -- otherwise a retry would create a
    // duplicate document instead of updating the one that already exists.
    expect(alpha).toMatch(/outline_id: doc-/);
    expect(beta).toMatch(/outline_id: doc-/);
  });
});
