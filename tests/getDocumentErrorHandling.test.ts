/**
 * Real ambiguity found in review: getDocument used to swallow every failure
 * -- a confirmed 404, a 401, a 429 that survived its own retries, a dropped
 * connection -- into the same null. Callers that treat null as "the document
 * is gone" (skip-recovery, the folder-placeholder cache) could then recreate
 * or duplicate a document that was actually still there, just unreachable
 * for one check. Fixed: null now means "confirmed gone" (404) only;
 * anything else throws, and each caller decides what "couldn't tell" means
 * for its own situation rather than being forced to guess.
 */
import { OutlineApiBase } from '../src/outline-api/outline-api-base';
import { syncFolder } from '../src/sync/sync';
import { hashContent } from '../src/utils/content-hash';
import type { Transport } from '../src/outline-api/custom-instance';
import type { SyncOptions, SyncEnv, FileDescriptor, FolderIndex } from '../src/sync/types';
import type { IOutlineApi, Document } from '../src/outline-api/types';

class TestApi extends OutlineApiBase {
  async uploadAttachmentToStorage(): Promise<boolean> {
    return true;
  }
}

function transportAlways(status: number, body: unknown = {}): Transport {
  return async () => ({ status, headers: new Headers(), json: async () => body });
}

describe('getDocument distinguishes "confirmed gone" from "could not check"', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.useFakeTimers();
  });
  afterEach(() => {
    warnSpy.mockRestore();
    jest.useRealTimers();
  });

  it('returns null on a confirmed 404', async () => {
    const api = new TestApi('http://x', 'k', transportAlways(404, { message: 'Not Found' }));
    await expect(api.getDocument('d1')).resolves.toBeNull();
  });

  it('throws on a 401 rather than returning null', async () => {
    const api = new TestApi('http://x', 'k', transportAlways(401, { message: 'Unauthorized' }));
    await expect(api.getDocument('d1')).rejects.toThrow(/401/);
  });

  it('throws on a 429 that survived its own retries', async () => {
    const api = new TestApi('http://x', 'k', transportAlways(429, { message: 'rate limited' }));
    const promise = api.getDocument('d1');
    const assertion = expect(promise).rejects.toThrow(/429/);
    await jest.advanceTimersByTimeAsync(300_000);
    await assertion;
  });

  it('throws on a network exception rather than returning null', async () => {
    const transport: Transport = async () => {
      throw new Error('fetch failed');
    };
    const api = new TestApi('http://x', 'k', transport);
    const promise = api.getDocument('d1');
    const assertion = expect(promise).rejects.toThrow();
    await jest.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
});

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
    folderIndex,
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
  skipUnchanged: true,
};

describe('a skip-recovery check that could not confirm the parent trusts the skip', () => {
  it('does not recreate the parent, and children keep the original id', async () => {
    let nextId = 1;
    const created: { title: string; parentDocumentId?: string }[] = [];
    const api: IOutlineApi = {
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
        throw new Error('[Outline API] 429 on /documents.info: rate limited');
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
        return { id: params.id, title: params.title } as Document;
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

    const parentBody = '# Parent';
    // Matches sync.ts's own hash formula: body + render-affecting options.
    const hash = hashContent(
      parentBody + `\n<<outline-render>>${options.outlineUrl}|${options.removeToc ? '1' : '0'}`
    );
    const parentRaw =
      `---\noutline_id: existing-parent-id\noutline_collection_id: col-1\n` +
      `outline_last_synced: 2024-01-01T00:00:00.000Z\noutline_content_hash: ${hash}\n---\n${parentBody}`;

    const env = makeEnv(api, {
      'Parent/index.md': parentRaw,
      'Parent/Child.md': '# Child',
    });

    const result = await syncFolder(options, env, '/root');

    // Not recreated -- created only ever holds the Child.
    expect(created.find((d) => d.title === 'Parent')).toBeUndefined();
    const child = created.find((d) => d.title === 'Child');
    expect(child?.parentDocumentId).toBe('existing-parent-id');
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
  });
});

describe('a folder-placeholder check that could not confirm the remembered id trusts it', () => {
  it('does not search or create a duplicate placeholder', async () => {
    let nextId = 1;
    const created: { title: string }[] = [];
    const searched: string[] = [];
    const api: IOutlineApi = {
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
        throw new Error('[Outline API] 500 on /documents.info');
      },
      async createDocument(params) {
        created.push({ title: params.title });
        return {
          id: `doc-${nextId++}`,
          title: params.title,
          collectionId: params.collectionId,
        } as Document;
      },
      async updateDocument(params) {
        return { id: params.id, title: params.title } as Document;
      },
      async searchDocumentByTitle(title) {
        searched.push(title);
        return null;
      },
      async createAttachment() {
        return null;
      },
      async uploadAttachmentToStorage() {
        return false;
      },
    };

    const store: Record<string, string> = { 'col-1:Parent': 'remembered-folder-id' };
    const folderIndex: FolderIndex = {
      get: (key) => store[key],
      set: async (key, id) => {
        store[key] = id;
      },
    };

    // No index.md -- Parent is a placeholder-only folder node, exercising
    // the folder-index branch rather than the note-skip branch.
    const env = makeEnv(api, { 'Parent/Child.md': '# Child' }, folderIndex);

    await syncFolder(options, env, '/root');

    expect(created.find((d) => d.title === 'Parent')).toBeUndefined();
    expect(searched).not.toContain('Parent');
  });
});
