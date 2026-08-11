import * as fs from 'fs';
import * as path from 'path';
import { getContentType } from '../utils/content-type';
import { buildWikiMapFromFiles } from '../utils/wiki-map';
import type { SyncEnv, FileDescriptor, ResolvedImage, ImageRefLike, FolderIndex } from '../sync';
import type { IOutlineApi } from '../outline-api/types';

const FOLDER_INDEX_FILE = '.outline-sync-folders.json';

/**
 * Folder placeholder ids, persisted next to the synced files. Folders without
 * an `index.md` have no note to record their id in, so without this a re-sync
 * relies on Outline's eventually-consistent search and can duplicate folders.
 */
function createFileFolderIndex(rootPath: string): FolderIndex {
  const file = path.join(rootPath, FOLDER_INDEX_FILE);
  let store: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // A truncated or hand-edited file can parse to null, a number or an array;
    // indexing into those throws or yields nonsense ids.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      store = parsed as Record<string, string>;
    }
  } catch {
    // Missing or unreadable: start empty and fall back to search this run.
  }

  return {
    get: (key) => store[key],
    set: async (key, documentId) => {
      if (store[key] === documentId) return;
      store[key] = documentId;
      try {
        fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf-8');
      } catch (e) {
        console.error(`[Outline Sync] Could not write ${FOLDER_INDEX_FILE}:`, e);
      }
    },
  };
}

/**
 * Directories Obsidian itself never shows. Walking into them publishes plugin
 * READMEs and deleted notes, so they are skipped everywhere.
 */
function isSkippedDir(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

function collectMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isSkippedDir(entry.name)) continue;
      files.push(...collectMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

/** Every file with this basename, anywhere under root. */
function findAllByName(dir: string, name: string, out: string[] = []): string[] {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === name) {
        out.push(path.join(dir, entry.name));
      } else if (entry.isDirectory() && !isSkippedDir(entry.name)) {
        findAllByName(path.join(dir, entry.name), name, out);
      }
    }
  } catch {
    // permission errors etc.
  }
  return out;
}

/**
 * Resolve an attachment reference to a file on disk.
 *
 * Obsidian resolves a bare filename to the "closest" match. Taking the first
 * hit of a recursive walk instead picks by directory iteration order, so a
 * vault with repeated filenames (very common for `image.png`, `Pasted image
 * *.png`) silently attaches the wrong file. Preference order here is: relative
 * to the note, then relative to the vault root, then the nearest match to the
 * note by directory distance, with the shortest path as a stable tiebreak.
 */
function resolveImagePath(mdFilePath: string, imageName: string, rootPath: string): string | null {
  const dir = path.dirname(mdFilePath);

  const candidate = path.resolve(dir, imageName);
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;

  const rootCandidate = path.resolve(rootPath, imageName);
  if (fs.existsSync(rootCandidate) && fs.statSync(rootCandidate).isFile()) return rootCandidate;

  const matches = findAllByName(rootPath, path.basename(imageName));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  const distance = (p: string): number => {
    const rel = path.relative(dir, path.dirname(p));
    return rel === '' ? 0 : rel.split(path.sep).length;
  };
  return matches.sort((a, b) => {
    const d = distance(a) - distance(b);
    if (d !== 0) return d;
    const depth = a.split(path.sep).length - b.split(path.sep).length;
    return depth !== 0 ? depth : a.localeCompare(b);
  })[0];
}

function updateLocalFrontmatter(
  filePath: string,
  outlineId: string,
  outlineCollectionId: string,
  contentHash?: string
): void {
  const rawContent = fs.readFileSync(filePath, 'utf-8');
  // The closing delimiter captures anything trailing it on the same line. A
  // note ending its frontmatter with "---%%" used to have the "%%" pushed onto
  // a line of its own, which edits body content this function has no business
  // touching.
  const fmRegex = /^---(\r?\n)([\s\S]*?)\r?\n---([^\r\n]*)(\r?\n|$)/;
  const match = fmRegex.exec(rawContent);
  const now = new Date().toISOString();
  const newFields = [
    `outline_id: ${outlineId}`,
    `outline_collection_id: ${outlineCollectionId}`,
    `outline_last_synced: ${now}`,
  ];
  if (contentHash !== undefined) {
    newFields.push(`outline_content_hash: ${contentHash}`);
  }
  if (match) {
    // Reused for every newline this function introduces, so a CRLF file
    // keeps CRLF end-to-end instead of gaining a hardcoded LF in just the
    // frontmatter block while the body stays CRLF.
    const eol = match[1];
    let fmBlock = match[2];
    for (const field of newFields) {
      const key = field.split(':')[0];
      const lineRegex = new RegExp(`^${key}:.*$`, 'm');
      if (lineRegex.test(fmBlock)) {
        fmBlock = fmBlock.replace(lineRegex, field);
      } else {
        fmBlock += `${eol}${field}`;
      }
    }
    // An incomplete push must not leave a stale hash behind, or the next run
    // skips the note and the failure becomes permanent.
    if (contentHash === undefined) {
      fmBlock = fmBlock.replace(/^outline_content_hash:.*$\r?\n?/m, '');
    }
    const trailing = match[3];
    const closing = match[4];
    const updated = rawContent.replace(
      fmRegex,
      () => `---${eol}${fmBlock}${eol}---${trailing}${closing}`
    );
    fs.writeFileSync(filePath, updated, 'utf-8');
  } else {
    const fmBlock = `---\n${newFields.join('\n')}\n---\n`;
    fs.writeFileSync(filePath, fmBlock + rawContent, 'utf-8');
  }
}

export interface NodeSyncEnvOptions {
  api: IOutlineApi;
  rootPath: string;
  onProgress?: (message: string) => void;
}

export function createNodeSyncEnv(options: NodeSyncEnvOptions): SyncEnv {
  const { api, rootPath, onProgress } = options;
  let wikiMap: Map<string, string> = new Map();

  return {
    api,
    folderIndex: createFileFolderIndex(rootPath),
    async listMarkdownFiles() {
      const absolutePaths = collectMarkdownFiles(rootPath);
      return absolutePaths.map((p) => {
        const relativePath = path.relative(rootPath, p).replace(/\\/g, '/');
        const basename = path.basename(p, '.md');
        return { path: p, basename, relativePath };
      });
    },
    async readFile(fd) {
      return fs.readFileSync(fd.path, 'utf-8');
    },
    getWikiResolver(filesWithContent) {
      if (filesWithContent) {
        wikiMap = buildWikiMapFromFiles(filesWithContent);
      }
      return (target: string) => wikiMap.get(target) ?? null;
    },
    resolveImage(fd, imageRef) {
      const decoded = decodeURIComponent(imageRef.imageName);
      const imgPath = resolveImagePath(fd.path, decoded, rootPath);
      if (!imgPath) return null;
      const fileName = path.basename(imgPath);
      return {
        placeholder: imageRef.placeholder,
        pathOrKey: imgPath,
        fileName,
        contentType: getContentType(path.extname(imgPath).slice(1)),
      };
    },
    async readImageBytes(pathOrKey) {
      const buf = fs.readFileSync(pathOrKey);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },
    async writeFrontmatter(fd, meta) {
      updateLocalFrontmatter(fd.path, meta.outlineId, meta.collectionId, meta.contentHash);
    },
    onProgress,
  };
}
