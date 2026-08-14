import { syncFolder } from '../src/sync/sync';
import { hashContent } from '../src/utils/content-hash';
import type { SyncOptions, SyncEnv, FileDescriptor } from '../src/sync/types';
import type { IOutlineApi, Document } from '../src/outline-api/types';

/**
 * Real bug, deliberately deferred in migration/findings.md #3: syncDocument's
 * skip path trusts frontmatter's outline_id without confirming the document
 * still exists. If a folder-as-document note (an index.md) is deleted or
 * moved out of the collection in Outline, a re-run reports it "unchanged"
 * and hands its stale id to every child as nextParentId -- every child under
 * it then fails to create.
 *
 * Fix scope: only re-verify existence for a skipped note that also parents
 * other documents (node.children.length > 0). Leaf notes -- the vast
 * majority of any vault -- stay exactly as cheap as skipUnchanged is meant
 * to be; only the small set of folder-index notes pays for the check.
 */
const options: SyncOptions = {
  outlineUrl: 'https://example.com',
  apiKey: 'test-key',
  collectionId: 'col-1',
  removeToc: false,
  indexAsFolder: true,
  folderConflictStrategy: 'overwrite',
  skipUnchanged: true,
};

function parentHash(body: string): string {
  return hashContent(
    body + `\n<<outline-render>>${options.outlineUrl}|${options.removeToc ? '1' : '0'}`
  );
}

const PARENT_BODY = '# Parent';
const PARENT_RAW =
  `---\n` +
  `outline_id: stale-parent-id\n` +
  `outline_collection_id: col-1\n` +
  `outline_last_synced: 2024-01-01T00:00:00.000Z\n` +
  `outline_content_hash: ${parentHash(PARENT_BODY)}\n` +
  `---\n${PARENT_BODY}`;

function makeApi(opts: {
  parentExists: boolean;
}): IOutlineApi & { created: { title: string; parentDocumentId?: string }[] } {
  let nextId = 1;
  const created: { title: string; parentDocumentId?: string }[] = [];
  const docs = new Map<string, Document>();
  if (opts.parentExists) {
    docs.set('stale-parent-id', {
      id: 'stale-parent-id',
      title: 'Parent',
      collectionId: 'col-1',
    } as Document);
  }

  return {
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
      created.push({ title: params.title, parentDocumentId: params.parentDocumentId });
      return doc;
    },
    async updateDocument(params) {
      const doc = docs.get(params.id);
      if (!doc) return null;
      doc.title = params.title;
      doc.text = params.text;
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

describe('a skipped folder-parent note whose Outline document is gone', () => {
  it('is recreated so its children still attach to a live document', async () => {
    const api = makeApi({ parentExists: false });
    const env = makeEnv(api, {
      'Parent/index.md': PARENT_RAW,
      'Parent/Child.md': '# Child',
    });

    const result = await syncFolder(options, env, '/root');

    const parentCreated = api.created.find((d) => d.title === 'Parent');
    expect(parentCreated).toBeDefined();

    const childCreated = api.created.find((d) => d.title === 'Child');
    expect(childCreated).toBeDefined();
    expect(childCreated!.parentDocumentId).toBeDefined();
    expect(childCreated!.parentDocumentId).not.toBe('stale-parent-id');

    expect(result.failed).toBe(0);
  });

  it('leaves a skipped parent untouched when its document still exists', async () => {
    const api = makeApi({ parentExists: true });
    const env = makeEnv(api, {
      'Parent/index.md': PARENT_RAW,
      'Parent/Child.md': '# Child',
    });

    const result = await syncFolder(options, env, '/root');

    expect(api.created.find((d) => d.title === 'Parent')).toBeUndefined();

    const childCreated = api.created.find((d) => d.title === 'Child');
    expect(childCreated!.parentDocumentId).toBe('stale-parent-id');

    expect(result.skipped).toBe(1);
  });
});
