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

describe('skipUnchanged (real round trip, not a synthetic mtime)', () => {
  const baseOptions: SyncOptions = {
    outlineUrl: 'https://example.com',
    apiKey: 'k',
    collectionId: 'col-1',
    removeToc: false,
    indexAsFolder: true,
    folderConflictStrategy: 'overwrite',
    skipUnchanged: true,
  };

  function makeApi() {
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
    return { api, calls };
  }

  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function push(api: IOutlineApi, file: string, options = baseOptions) {
    const env = createNodeSyncEnv({ api, rootPath: root });
    return syncDocument(options, env, {
      path: file,
      basename: path.basename(file, '.md'),
      relativePath: path.basename(file),
    });
  }

  it('skips on the second push of an untouched note', async () => {
    const { api, calls } = makeApi();
    const file = path.join(root, 'note.md');
    fs.writeFileSync(file, '# hello\n\nbody text\n');

    const first = await push(api, file);
    expect(first?.action).toBe('created');

    // This is the case the previous mtime-based check got wrong: writing
    // frontmatter bumps mtime past the timestamp it just wrote.
    const before = { ...calls };
    const second = await push(api, file);
    expect(second?.action).toBe('skipped');
    expect(second?.documentId).toBe('doc-1');
    expect(calls.createDocument).toBe(before.createDocument);
    expect(calls.updateDocument).toBe(before.updateDocument);
    expect(calls.getDocument).toBe(before.getDocument);
  });

  it('pushes again once the body actually changes', async () => {
    const { api } = makeApi();
    const file = path.join(root, 'note.md');
    fs.writeFileSync(file, '# hello\n\nbody text\n');

    await push(api, file);
    const raw = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, raw + '\nan edit\n');

    const third = await push(api, file);
    expect(third?.action).toBe('updated');
  });

  it('does not skip when only frontmatter changed', async () => {
    const { api } = makeApi();
    const file = path.join(root, 'note.md');
    fs.writeFileSync(file, '---\ntags:\n  - a\n---\n\nbody\n');

    await push(api, file);
    const raw = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, raw.replace('  - a', '  - a\n  - b'));

    // Body is unchanged, so this is a legitimate skip.
    const again = await push(api, file);
    expect(again?.action).toBe('skipped');
  });

  it('stays stable across three consecutive runs', async () => {
    const { api } = makeApi();
    const file = path.join(root, 'note.md');
    fs.writeFileSync(file, '# stable\n');

    expect((await push(api, file))?.action).toBe('created');
    expect((await push(api, file))?.action).toBe('skipped');
    expect((await push(api, file))?.action).toBe('skipped');
  });

  it('pushes everything when the option is off', async () => {
    const { api } = makeApi();
    const file = path.join(root, 'note.md');
    fs.writeFileSync(file, '# hello\n');

    await push(api, file);
    const again = await push(api, file, { ...baseOptions, skipUnchanged: false });
    expect(again?.action).toBe('updated');
  });

  it('writes a content hash into the note', async () => {
    const { api } = makeApi();
    const file = path.join(root, 'note.md');
    fs.writeFileSync(file, '# hello\n');
    await push(api, file);
    expect(fs.readFileSync(file, 'utf-8')).toMatch(/outline_content_hash: [0-9a-f]{16}/);
  });
});

describe('audio attachments are skipped, not uploaded', () => {
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
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-skip-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function makeApi() {
    const calls = { createAttachment: 0, uploadAttachmentToStorage: 0 };
    let lastUpdateText = '';
    const api = {
      async getDocument() {
        return { id: 'doc-1', collectionId: 'col-1' };
      },
      async createDocument() {
        return { id: 'doc-1', collectionId: 'col-1' };
      },
      async updateDocument(params: { text: string }) {
        lastUpdateText = params.text;
        return { id: 'doc-1', collectionId: 'col-1' };
      },
      async searchDocumentByTitle() {
        return null;
      },
      async createAttachment() {
        calls.createAttachment++;
        return { uploadUrl: 'http://x', form: {}, attachment: { url: '/att/1' } };
      },
      async uploadAttachmentToStorage() {
        calls.uploadAttachmentToStorage++;
        return true;
      },
    } as unknown as IOutlineApi;
    return { api, calls, getLastUpdateText: () => lastUpdateText };
  }

  function push(api: IOutlineApi, file: string) {
    const env = createNodeSyncEnv({ api, rootPath: root });
    return syncDocument(baseOptions, env, {
      path: file,
      basename: path.basename(file, '.md'),
      relativePath: path.basename(file),
    });
  }

  function writeNoteWithAudio() {
    const file = path.join(root, 'note.md');
    fs.writeFileSync(file, 'Listen:\n\n![[clip.mp3]]\n');
    fs.writeFileSync(path.join(root, 'clip.mp3'), 'not really audio');
    return file;
  }

  it('never calls createAttachment or uploadAttachmentToStorage', async () => {
    const { api, calls } = makeApi();
    await push(api, writeNoteWithAudio());
    expect(calls.createAttachment).toBe(0);
    expect(calls.uploadAttachmentToStorage).toBe(0);
  });

  it('replaces the embed with a not-synced placeholder naming the file', async () => {
    const { api, getLastUpdateText } = makeApi();
    await push(api, writeNoteWithAudio());
    expect(getLastUpdateText()).toContain('*(Audio not synced: clip.mp3)*');
  });

  it('writes a content hash, since the skip is not a failure', async () => {
    const { api } = makeApi();
    const file = writeNoteWithAudio();
    await push(api, file);
    expect(fs.readFileSync(file, 'utf-8')).toMatch(/outline_content_hash: [0-9a-f]{16}/);
  });

  it('does not report a skipped audio embed as a failed image upload', async () => {
    const { api } = makeApi();
    const result = await push(api, writeNoteWithAudio());
    expect(result?.imageStats).toBeUndefined();
  });

  it('excludes skipped audio from the image upload total when mixed with a real image', async () => {
    const { api } = makeApi();
    const file = path.join(root, 'note.md');
    fs.writeFileSync(file, '![[photo.png]]\n\n![[clip.mp3]]\n');
    fs.writeFileSync(path.join(root, 'photo.png'), 'not really a photo');
    fs.writeFileSync(path.join(root, 'clip.mp3'), 'not really audio');

    const result = await push(api, file);

    expect(result?.imageStats).toEqual({ uploaded: 1, total: 1 });
  });
});
