import { App, TFile, TFolder } from 'obsidian';
import { type WikiLinkResolver } from '../pipeline';
import { updateOutlineFrontmatter } from '../frontmatter';
import { getContentType } from '../utils/content-type';
import { buildWikiMapFromFiles } from '../utils/wiki-map';
import type { SyncEnv, FileDescriptor, ResolvedImage, ImageRefLike, FolderIndex } from '../sync';
import type { IOutlineApi } from '../outline-api/types';

interface ObsidianFd extends FileDescriptor {
  _file: TFile;
}

function collectMarkdownFiles(folder: TFolder): TFile[] {
  const files: TFile[] = [];
  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === 'md') {
      files.push(child);
    } else if (child instanceof TFolder) {
      files.push(...collectMarkdownFiles(child));
    }
  }
  return files;
}

/**
 * Resolves `[[Note]]` to the target note's `outline_id`.
 *
 * Reads the id from Obsidian's metadata cache. The previous implementation
 * reached for `app.vault.readCache`, which is not part of the public API and
 * is undefined at runtime, so every link silently degraded to plain text.
 *
 * `sourcePath` matters: link resolution is relative to the linking note, so
 * passing the wrong source can match a same-named note elsewhere in the vault.
 */
export function buildWikiLinkResolver(app: App, sourcePath = ''): WikiLinkResolver {
  return (linkTarget: string) => {
    const targetFile = app.metadataCache.getFirstLinkpathDest(linkTarget, sourcePath);
    if (!(targetFile instanceof TFile)) return null;
    const id = app.metadataCache.getFileCache(targetFile)?.frontmatter?.['outline_id'];
    return typeof id === 'string' && id.length > 0 ? id : null;
  };
}

export interface ObsidianSyncEnvOptions {
  app: App;
  api: IOutlineApi;
  /** For single-file sync, pass a resolver that uses app (e.g. from metadataCache). */
  getWikiResolverForSingleFile?: () => (target: string) => string | null;
  resolveConflict?: (title: string) => Promise<'overwrite' | 'duplicate' | 'cancel'>;
  onProgress?: (message: string) => void;
  folderIndex?: FolderIndex;
}

export function createObsidianSyncEnv(options: ObsidianSyncEnvOptions): SyncEnv {
  const { app, api, getWikiResolverForSingleFile, resolveConflict, onProgress, folderIndex } =
    options;
  let wikiMap: Map<string, string> = new Map();

  return {
    api,
    async listMarkdownFiles(rootPath: string) {
      const folder = app.vault.getAbstractFileByPath(rootPath);
      if (!(folder instanceof TFolder)) return [];
      const files = collectMarkdownFiles(folder);
      return files.map((file) => {
        const relativePath = rootPath
          ? file.path.slice(rootPath.length).replace(/^\//, '')
          : file.path;
        return {
          path: file.path,
          basename: file.basename,
          relativePath,
          _file: file,
        } as ObsidianFd;
      });
    },
    async readFile(fd) {
      const file = (fd as ObsidianFd)._file;
      return file ? app.vault.read(file) : '';
    },
    getWikiResolver(filesWithContent) {
      if (filesWithContent) {
        wikiMap = buildWikiMapFromFiles(filesWithContent);
        return (target: string) => wikiMap.get(target) ?? null;
      }
      if (getWikiResolverForSingleFile) {
        return getWikiResolverForSingleFile();
      }
      return (target: string) => wikiMap.get(target) ?? null;
    },
    resolveImage(fd, imageRef) {
      const file = (fd as ObsidianFd)._file;
      if (!file) return null;
      const decoded = decodeURIComponent(imageRef.imageName);
      const imageFile =
        app.metadataCache.getFirstLinkpathDest(decoded, file.path) ??
        app.vault.getAbstractFileByPath(decoded) ??
        app.vault.getAbstractFileByPath(imageRef.imageName);
      if (!(imageFile instanceof TFile)) return null;
      return {
        placeholder: imageRef.placeholder,
        pathOrKey: imageFile.path,
        fileName: imageFile.name,
        contentType: getContentType(imageFile.extension),
      };
    },
    async readImageBytes(pathOrKey: string) {
      const file = app.vault.getAbstractFileByPath(pathOrKey);
      if (!(file instanceof TFile)) throw new Error(`File not found: ${pathOrKey}`);
      return app.vault.readBinary(file);
    },
    async getMtime(fd) {
      return (fd as ObsidianFd)._file?.stat?.mtime ?? null;
    },
    async writeFrontmatter(fd, outlineId, collectionId) {
      const file = (fd as ObsidianFd)._file;
      if (!file) return;
      await updateOutlineFrontmatter(app, file, {
        outline_id: outlineId,
        outline_collection_id: collectionId,
        outline_last_synced: new Date().toISOString(),
      });
    },
    folderIndex,
    resolveConflict,
    onProgress,
  };
}
