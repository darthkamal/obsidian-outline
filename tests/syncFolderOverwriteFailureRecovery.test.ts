import { syncFolder } from '../src/sync/sync';
import type { SyncOptions, SyncEnv, FileDescriptor } from '../src/sync/types';
import type { IOutlineApi, Document } from '../src/outline-api/types';

/**
 * Real bug found in review: unlike the post-image "final content" update
 * (covered by syncFolderParentRecovery.test.ts), the updateDocument call in
 * syncDocument's "overwrite an existing duplicate" branch had no
 * partialResult attached to a thrown error. The document's id was already
 * known before the call (it's an existing document being overwritten, not
 * one just created) -- if the update itself failed, every child of that node
 * still attached to the grandparent instead of the real, already-live
 * document for the rest of the run.
 */
describe('a folder node whose overwrite of an existing duplicate fails still parents its children', () => {
  function makeApi(): IOutlineApi & { created: { title: string; parentDocumentId?: string }[] } {
    let nextId = 1;
    const created: { title: string; parentDocumentId?: string }[] = [];
    const api: IOutlineApi & { created: typeof created } = {
      created,
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
      async getDocument() {
        return null;
      },
      async createDocument(params) {
        const doc: Document = {
          id: `doc-${nextId++}`,
          title: params.title,
          text: params.text,
          collectionId: params.collectionId,
          parentDocumentId: params.parentDocumentId,
        };
        created.push({ title: params.title, parentDocumentId: params.parentDocumentId });
        return doc;
      },
      async updateDocument(params) {
        if (params.title === 'Parent') {
          throw new Error('simulated 502 on overwrite');
        }
        return { id: params.id, title: params.title } as Document;
      },
      // Parent already exists in Outline (e.g. a first-time push whose title
      // collides with something already there); Child does not.
      async searchDocumentByTitle(title) {
        if (title === 'Parent') {
          return { id: 'existing-parent-id', collectionId: 'col-1', title: 'Parent' };
        }
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

  function makeEnv(api: IOutlineApi, fileContents: Record<string, string>): SyncEnv {
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

  it("attaches the child to the existing duplicate's real id, not the grandparent's", async () => {
    const api = makeApi();
    const env = makeEnv(api, {
      'Parent/index.md': '# Parent',
      'Parent/Child.md': '# Child',
    });

    const result = await syncFolder(options, env, '/root');

    expect(result.failed).toBe(1);

    const childDoc = api.created.find((d) => d.title === 'Child')!;
    expect(childDoc).toBeDefined();
    expect(childDoc.parentDocumentId).toBe('existing-parent-id');
  });
});
