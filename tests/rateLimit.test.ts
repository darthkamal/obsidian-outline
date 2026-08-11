import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OutlineApiBase } from '../src/outline-api/outline-api-base';
import { OutlineClientNode } from '../src/outline-api/outline-client-node';
import type { Transport } from '../src/outline-api/custom-instance';
import { updateOutlineFrontmatter } from '../src/frontmatter';
import { createNodeSyncEnv } from '../src/adapters/node';
import { syncDocument } from '../src/sync/sync';
import type { SyncOptions } from '../src/sync/types';
import type { IOutlineApi } from '../src/outline-api/types';

/** Concrete subclass so the abstract upload method can be stubbed per test. */
class TestApi extends OutlineApiBase {
  public uploadResult = true;
  async uploadAttachmentToStorage(): Promise<boolean> {
    return this.uploadResult;
  }
}

function transportAlways(status: number, body: unknown, headers: Record<string, string> = {}) {
  const t: Transport = async () => ({
    status,
    headers: new Headers(headers),
    json: async () => body,
  });
  return t;
}

const rateLimited = {
  ok: false,
  error: 'rate_limit_exceeded',
  status: 429,
  message: 'Rate limit exceeded for this operation',
};

describe('a rate-limited write reports why it failed', () => {
  // Real bug: 51 documents were dropped from a 697-note push and every one of
  // them reported the same bare "Create failed". The 429 was retried, the
  // retries were exhausted, and the reason was swallowed by `catch { return
  // null }` — so the run was undiagnosable without replaying it by hand.
  it('rejects with the server reason instead of resolving null', async () => {
    // retry-after 0 keeps the test fast while still exercising the retry path.
    const api = new TestApi(
      'http://x',
      'k',
      transportAlways(429, rateLimited, { 'retry-after': '0' })
    );

    await expect(
      api.createDocument({ title: 't', text: 'b', collectionId: 'c', publish: true })
    ).rejects.toThrow(/rate limit/i);
  });

  it('names the status so a 4xx is distinguishable from a network drop', async () => {
    const api = new TestApi(
      'http://x',
      'k',
      transportAlways(429, rateLimited, { 'retry-after': '0' })
    );

    await expect(
      api.createDocument({ title: 't', text: 'b', collectionId: 'c', publish: true })
    ).rejects.toThrow(/429/);
  });

  it('reports a failed update too', async () => {
    const api = new TestApi(
      'http://x',
      'k',
      transportAlways(429, rateLimited, { 'retry-after': '0' })
    );

    await expect(
      api.updateDocument({ id: 'd', title: 't', text: 'b', publish: true })
    ).rejects.toThrow(/rate limit/i);
  });
});

describe('a note whose attachment failed is not recorded as fully synced', () => {
  // Real bug: 15 notes uploaded their document but not their audio. The
  // content hash was written anyway, so the next run skipped them and the
  // "*(Upload failed: ...)*" placeholder became permanent.
  const baseOptions: SyncOptions = {
    outlineUrl: 'https://example.com',
    apiKey: 'k',
    collectionId: 'col-1',
    removeToc: false,
    indexAsFolder: true,
    folderConflictStrategy: 'overwrite',
    skipUnchanged: true,
  };

  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  /** Document writes succeed; the attachment step is what fails. */
  function apiWithFailingAttachment() {
    const api = {
      async getDocument() {
        return { id: 'doc-1', collectionId: 'col-1' };
      },
      async createDocument() {
        return { id: 'doc-1', collectionId: 'col-1' };
      },
      async updateDocument() {
        return { id: 'doc-1', collectionId: 'col-1' };
      },
      async searchDocumentByTitle() {
        return null;
      },
      async createAttachment() {
        return null; // upload slot could not be reserved
      },
      async uploadAttachmentToStorage() {
        return false;
      },
    } as unknown as IOutlineApi;
    return api;
  }

  function writeNoteWithAudio() {
    const file = path.join(root, 'note.md');
    fs.writeFileSync(file, 'Listen:\n\n![[clip.mp3]]\n');
    fs.writeFileSync(path.join(root, 'clip.mp3'), 'not really audio');
    return file;
  }

  function push(api: IOutlineApi, file: string) {
    const env = createNodeSyncEnv({ api, rootPath: root });
    return syncDocument(baseOptions, env, {
      path: file,
      basename: path.basename(file, '.md'),
      relativePath: path.basename(file),
    });
  }

  it('writes no content hash when the attachment did not upload', async () => {
    const file = writeNoteWithAudio();

    await push(apiWithFailingAttachment(), file);

    expect(fs.readFileSync(file, 'utf-8')).not.toMatch(/outline_content_hash:/);
  });

  it('still records the document id so children keep their parent', async () => {
    const file = writeNoteWithAudio();

    await push(apiWithFailingAttachment(), file);

    expect(fs.readFileSync(file, 'utf-8')).toMatch(/outline_id: doc-1/);
  });

  it('re-pushes the note on the next run instead of skipping it', async () => {
    const file = writeNoteWithAudio();
    await push(apiWithFailingAttachment(), file);

    const second = await push(apiWithFailingAttachment(), file);

    expect(second?.action).not.toBe('skipped');
  });
});

describe('a rejected attachment upload says why', () => {
  // The byte upload is a separate call from reserving the slot, and it was the
  // last place still discarding its status: a real recovery run reported six
  // "(0/1 images)" with nothing else logged anywhere.
  const realFetch = global.fetch;
  let errors: string[];
  let spy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    errors = [];
    spy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    // Retries warn by design; keep the suite output clean.
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = realFetch;
    spy.mockRestore();
    warnSpy.mockRestore();
  });

  function upload() {
    const client = new OutlineClientNode('http://x', 'k');
    return client.uploadAttachmentToStorage(
      'http://x/api/files.create',
      {},
      new ArrayBuffer(8),
      'audio/mpeg'
    );
  }

  it('reports the status when storage rejects the file', async () => {
    global.fetch = (async () => new Response('nope', { status: 413 })) as typeof fetch;

    expect(await upload()).toBe(false);

    expect(errors.join(' ')).toMatch(/413/);
  });

  it('reports the reason when the connection drops', async () => {
    global.fetch = (async () => {
      throw new Error('socket hang up');
    }) as typeof fetch;

    expect(await upload()).toBe(false);

    expect(errors.join(' ')).toMatch(/socket hang up/);
  });

  it('retries an upload the server dropped mid-transfer', async () => {
    // Real failure: "fetch failed (other side closed)" on files.create for
    // 10-21MB audio, intermittently. Document writes already retry through
    // customInstance; the byte upload had exactly one attempt.
    let attempts = 0;
    global.fetch = (async () => {
      attempts++;
      if (attempts < 3)
        throw Object.assign(new Error('fetch failed'), { cause: new Error('other side closed') });
      return new Response('', { status: 200 });
    }) as typeof fetch;

    expect(await upload()).toBe(true);
    expect(attempts).toBe(3);
  });

  it('gives up after repeated drops rather than looping forever', async () => {
    let attempts = 0;
    global.fetch = (async () => {
      attempts++;
      throw Object.assign(new Error('fetch failed'), { cause: new Error('other side closed') });
    }) as typeof fetch;

    expect(await upload()).toBe(false);
    expect(attempts).toBeLessThanOrEqual(4);
    expect(attempts).toBeGreaterThan(1);
  });

  it('unwraps the cause a bare "fetch failed" hides', async () => {
    // Regression: this path built its message from `e.message` directly, so
    // the cause unwrapping added to getErrorMessage never reached it and four
    // real runs logged nothing but "fetch failed".
    global.fetch = (async () => {
      throw Object.assign(new Error('fetch failed'), {
        cause: new Error('read ECONNRESET'),
      });
    }) as typeof fetch;

    expect(await upload()).toBe(false);

    expect(errors.join(' ')).toMatch(/ECONNRESET/);
  });
});

describe('the plugin path clears a stale hash too', () => {
  // The Node adapter drops the hash on an incomplete push. Without the same
  // behaviour here, a note that synced cleanly once and later lost an
  // attachment keeps its old hash and is skipped forever inside Obsidian.
  function fakeApp(initial: Record<string, unknown>) {
    const fm: Record<string, unknown> = { ...initial };
    const app = {
      fileManager: {
        async processFrontMatter(_file: unknown, cb: (fm: Record<string, unknown>) => void) {
          cb(fm);
        },
      },
    };
    return { app, fm };
  }

  it('removes outline_content_hash when asked to', async () => {
    const { app, fm } = fakeApp({ outline_content_hash: 'stale', outline_id: 'doc-1' });

    await updateOutlineFrontmatter(
      app as never,
      {} as never,
      { outline_id: 'doc-1' },
      { remove: ['outline_content_hash'] }
    );

    expect(fm['outline_content_hash']).toBeUndefined();
  });

  it('leaves the hash alone on a normal push', async () => {
    const { app, fm } = fakeApp({ outline_content_hash: 'keep' });

    await updateOutlineFrontmatter(app as never, {} as never, { outline_id: 'doc-1' });

    expect(fm['outline_content_hash']).toBe('keep');
  });
});

describe('frontmatter rewriting leaves the note body alone', () => {
  // Real bug: a note closing its frontmatter with "---%%" had the "%%" moved
  // onto its own line, because the closing delimiter was not required to be
  // alone on its line. Appending sync metadata must not edit body content.
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('preserves trailing text on the closing delimiter line', async () => {
    const file = path.join(root, 'note.md');
    fs.writeFileSync(file, '---\ntitle: x\n---%%\ncomment body\n%%\n');

    const env = createNodeSyncEnv({ api: {} as IOutlineApi, rootPath: root });
    await env.writeFrontmatter(
      { path: file, basename: 'note', relativePath: 'note.md' },
      { outlineId: 'doc-1', collectionId: 'col-1', contentHash: 'abc' }
    );

    expect(fs.readFileSync(file, 'utf-8')).toContain('---%%');
  });

  it('still inserts the sync fields', async () => {
    const file = path.join(root, 'note.md');
    fs.writeFileSync(file, '---\ntitle: x\n---%%\ncomment body\n%%\n');

    const env = createNodeSyncEnv({ api: {} as IOutlineApi, rootPath: root });
    await env.writeFrontmatter(
      { path: file, basename: 'note', relativePath: 'note.md' },
      { outlineId: 'doc-1', collectionId: 'col-1', contentHash: 'abc' }
    );

    const out = fs.readFileSync(file, 'utf-8');
    expect(out).toMatch(/outline_id: doc-1/);
    expect(out).toMatch(/title: x/);
  });
});
