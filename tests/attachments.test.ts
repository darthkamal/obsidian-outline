import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { convertContentToOutlineMarkdown } from '../src/convert';
import { createNodeSyncEnv } from '../src/adapters/node';
import { syncDocument } from '../src/sync/sync';
import type { SyncOptions } from '../src/sync/types';
import type { IOutlineApi } from '../src/outline-api/types';

const noteResolver = () => null;

function convert(input: string) {
  return convertContentToOutlineMarkdown(input, {}, 'n', 'n.md', noteResolver);
}

describe('non-image attachments are uploaded, not dropped', () => {
  it.each([
    ['audio', 'recording.m4a'],
    ['audio', 'interview.mp3'],
    ['video', 'clip.mp4'],
    ['document', 'contract.pdf'],
    ['archive', 'bundle.zip'],
  ])('detects %s embed %s', (_kind, file) => {
    const { imageRefs } = convert(`Here: ![[${file}]]`);
    expect(imageRefs).toHaveLength(1);
    expect(imageRefs[0].imageName).toBe(file);
    expect(imageRefs[0].isImage).toBe(false);
  });

  it('flags images so they still embed inline', () => {
    const { imageRefs } = convert('![[photo.png]]');
    expect(imageRefs[0].isImage).toBe(true);
  });

  it('does not treat a note transclusion as an attachment', () => {
    const { imageRefs, markdown } = convert('![[Some Note]]');
    expect(imageRefs).toHaveLength(0);
    expect(markdown).toBe('Some Note');
  });
});

describe('CLI file discovery', () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
    fs.mkdirSync(path.join(root, '.obsidian/plugins/p'), { recursive: true });
    fs.mkdirSync(path.join(root, '.trash'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Notes/Deep/Deeper'), { recursive: true });
    fs.mkdirSync(path.join(root, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Notes/Real.md'), '# real');
    fs.writeFileSync(path.join(root, '.obsidian/plugins/p/README.md'), '# plugin');
    fs.writeFileSync(path.join(root, '.trash/Deleted.md'), '# deleted');
    fs.writeFileSync(path.join(root, 'attachments/shared.png'), 'far');
    fs.writeFileSync(path.join(root, 'Notes/shared.png'), 'near');
    fs.writeFileSync(path.join(root, 'Notes/Deep/Deeper/only.png'), 'only');
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('skips .obsidian and .trash', async () => {
    const env = createNodeSyncEnv({ api: {} as IOutlineApi, rootPath: root });
    const files = await env.listMarkdownFiles(root);
    expect(files.map((f) => f.relativePath)).toEqual(['Notes/Real.md']);
  });

  it('prefers the attachment nearest the note when basenames collide', () => {
    const env = createNodeSyncEnv({ api: {} as IOutlineApi, rootPath: root });
    const resolved = env.resolveImage(
      { path: path.join(root, 'Notes/Real.md'), basename: 'Real' },
      { imageName: 'shared.png', placeholder: 'P' }
    );
    expect(resolved?.pathOrKey).toBe(path.join(root, 'Notes/shared.png'));
  });

  it('still finds an attachment stored elsewhere in the vault', () => {
    const env = createNodeSyncEnv({ api: {} as IOutlineApi, rootPath: root });
    const resolved = env.resolveImage(
      { path: path.join(root, 'Notes/Real.md'), basename: 'Real' },
      { imageName: 'only.png', placeholder: 'P' }
    );
    expect(resolved?.pathOrKey).toBe(path.join(root, 'Notes/Deep/Deeper/only.png'));
  });

  it('reports the right content type for audio', () => {
    const env = createNodeSyncEnv({ api: {} as IOutlineApi, rootPath: root });
    fs.writeFileSync(path.join(root, 'Notes/voice.m4a'), 'audio');
    const resolved = env.resolveImage(
      { path: path.join(root, 'Notes/Real.md'), basename: 'Real' },
      { imageName: 'voice.m4a', placeholder: 'P' }
    );
    expect(resolved?.contentType).toBe('audio/mp4');
  });
});

describe('skipUnchanged', () => {
  const baseOptions: SyncOptions = {
    outlineUrl: 'https://example.com',
    apiKey: 'k',
    collectionId: 'col-1',
    removeToc: false,
    indexAsFolder: true,
    folderConflictStrategy: 'overwrite',
    skipUnchanged: true,
  };

  function makeEnv(content: string, mtime: number | null) {
    const calls = { getDocument: 0, createDocument: 0, updateDocument: 0 };
    const api = {
      async getDocument() {
        calls.getDocument++;
        return { id: 'doc-1', collectionId: 'col-1' };
      },
      async createDocument() {
        calls.createDocument++;
        return { id: 'doc-1', collectionId: 'col-1' };
      },
      async updateDocument() {
        calls.updateDocument++;
        return { id: 'doc-1', collectionId: 'col-1' };
      },
      async searchDocumentByTitle() {
        return null;
      },
    } as unknown as IOutlineApi;

    return {
      calls,
      env: {
        api,
        async listMarkdownFiles() {
          return [];
        },
        async readFile() {
          return content;
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
        async getMtime() {
          return mtime;
        },
      },
    };
  }

  const synced = '2026-08-11T10:00:00.000Z';
  const withMeta = `---\noutline_id: doc-1\noutline_last_synced: ${synced}\n---\n\nbody`;

  it('skips a file older than its last sync without touching the API', async () => {
    const { env, calls } = makeEnv(withMeta, Date.parse(synced) - 60_000);
    const res = await syncDocument(baseOptions, env, { path: 'a.md', basename: 'a' });
    expect(res?.action).toBe('skipped');
    expect(res?.documentId).toBe('doc-1');
    expect(calls).toEqual({ getDocument: 0, createDocument: 0, updateDocument: 0 });
  });

  it('pushes a file modified after its last sync', async () => {
    const { env, calls } = makeEnv(withMeta, Date.parse(synced) + 60_000);
    const res = await syncDocument(baseOptions, env, { path: 'a.md', basename: 'a' });
    expect(res?.action).toBe('updated');
    expect(calls.getDocument).toBe(1);
  });

  it('pushes when the note has never been synced', async () => {
    const { env } = makeEnv('no frontmatter here', Date.now());
    const res = await syncDocument(baseOptions, env, { path: 'a.md', basename: 'a' });
    expect(res?.action).toBe('created');
  });

  it('pushes when mtime is unknown', async () => {
    const { env } = makeEnv(withMeta, null);
    const res = await syncDocument(baseOptions, env, { path: 'a.md', basename: 'a' });
    expect(res?.action).toBe('updated');
  });

  it('pushes everything when the option is off', async () => {
    const { env } = makeEnv(withMeta, Date.parse(synced) - 60_000);
    const res = await syncDocument({ ...baseOptions, skipUnchanged: false }, env, {
      path: 'a.md',
      basename: 'a',
    });
    expect(res?.action).toBe('updated');
  });
});
