import { syncFolder } from '../src/sync/sync';
import type { SyncOptions, SyncEnv, FileDescriptor } from '../src/sync/types';
import type { IOutlineApi, Document } from '../src/outline-api/types';

/**
 * Real bug: syncDocument throws when the post-image content push fails, but
 * the document was already created successfully at that point. Before this
 * fix, syncFolder's catch block had no way to learn the real document id, so
 * every child of that node attached to its grandparent (or nothing) for the
 * rest of the run instead of the node that actually exists on the server.
 */
describe('a folder node whose final content push fails still parents its children', () => {
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
        // The one note with an image always fails its final content push --
        // the document was already created above, this simulates only the
        // second write (embedding the uploaded image URLs) failing.
        if (params.title === 'Parent') {
          throw new Error('simulated 500 on final content push');
        }
        return { id: params.id, title: params.title } as Document;
      },
      async searchDocumentByTitle() {
        return null;
      },
      async createAttachment() {
        return { uploadUrl: 'http://x/upload', form: {}, attachment: { url: 'http://x/pic.png' } };
      },
      async uploadAttachmentToStorage() {
        return true;
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
      resolveImage(_fd, imageRef) {
        return {
          placeholder: imageRef.placeholder,
          pathOrKey: 'fake-path',
          fileName: 'pic.png',
          contentType: 'image/png',
        };
      },
      async readImageBytes() {
        return new ArrayBuffer(8);
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

  it("attaches the child to the parent's real id, not the grandparent's", async () => {
    const api = makeApi();
    const env = makeEnv(api, {
      'Parent/index.md': '# Parent\n\n![[pic.png]]\n',
      'Parent/Child.md': '# Child',
    });

    const result = await syncFolder(options, env, '/root');

    expect(result.failed).toBe(1);

    const parentDoc = api.created.find((d) => d.title === 'Parent')!;
    const childDoc = api.created.find((d) => d.title === 'Child')!;

    expect(parentDoc).toBeDefined();
    expect(childDoc.parentDocumentId).toBeDefined();
    // Before the fix this was `undefined` (Parent's own parentDocumentId,
    // since syncNode's catch block never learned Parent's real id).
    expect(childDoc.parentDocumentId).toBe(`doc-1`);
  });
});
