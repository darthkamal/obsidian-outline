import type { IOutlineApi } from '../outline-api/types';

export type ConflictResolution = 'overwrite' | 'duplicate' | 'cancel';

export interface SyncOptions {
  /**
   * Base URL used to build links *inside* pushed documents. This is not the API
   * base URL -- see OutlineSyncSettings.publicUrl.
   */
  outlineUrl: string;
  apiKey: string;
  collectionId: string;
  removeToc: boolean;
  indexAsFolder: boolean;
  /** Used when no UI (e.g. CLI); ignored when resolveConflict is provided. */
  folderConflictStrategy: 'overwrite' | 'duplicate';
  /** When true, unresolved wiki links are kept as markers for two-pass resolution. */
  preserveUnresolved?: boolean;
  /**
   * Skip notes whose body hash matches `outline_content_hash` from the last
   * push. Note that a skipped note is not re-rendered, so a link it makes to a
   * note created in this same run stays unresolved until the linking note
   * itself changes.
   */
  skipUnchanged?: boolean;
}

export interface SyncResult {
  success: number;
  failed: number;
  skipped: number;
  total: number;
}

export interface SyncDocumentResult {
  documentId: string;
  collectionId: string;
  action: 'created' | 'updated' | 'skipped';
  imageStats?: { uploaded: number; total: number };
  /** Final markdown sent to Outline (used for two-pass wiki link resolution). */
  finalMarkdown?: string;
}

/**
 * Attached to the error `syncDocument` throws when the document itself was
 * created/updated successfully but a later step (the post-image content
 * push) failed. The id is real and already live on the server, so a caller
 * building a document tree can still attach children to it instead of
 * losing the parent relationship for the rest of the run.
 */
export interface SyncPartialFailure {
  partialResult?: { documentId: string; collectionId: string };
}

export interface FileDescriptor {
  /** Canonical path (vault path for Obsidian, absolute path for Node). */
  path: string;
  basename: string;
  relativePath?: string;
}

/** Minimal image ref (from conversion pipeline) for resolving. */
export interface ImageRefLike {
  imageName: string;
  placeholder: string;
}

/** Sync metadata written back into a note after a successful push. */
export interface SyncedFrontmatter {
  outlineId: string;
  collectionId: string;
  /**
   * Hash of the note body, used to skip unchanged notes on the next run.
   *
   * Omitted when the push was incomplete -- an attachment that could not be
   * reserved or uploaded. Recording a hash then would make the next run skip
   * the note and leave the "*(Upload failed: ...)*" placeholder permanent.
   */
  contentHash?: string;
}

/** Resolved image for upload: path/key to read bytes + metadata. */
export interface ResolvedImage {
  placeholder: string;
  /** Path or key for env.readImageBytes. */
  pathOrKey: string;
  fileName: string;
  contentType: string;
}

/**
 * Persistent map of folder placeholder documents.
 *
 * Folders without an `index.md` get an empty Outline document so the hierarchy
 * survives, but there is no local file to record its id in. Without this map a
 * re-sync depends entirely on `documents.search`, which is eventually
 * consistent, so a stale index silently produces duplicate folder trees.
 * Keys are `${collectionId}:${relativePath}`.
 */
export interface FolderIndex {
  get(key: string): string | undefined;
  set(key: string, documentId: string): Promise<void>;
}

export interface SyncEnv {
  api: IOutlineApi;
  listMarkdownFiles(rootPath: string): Promise<FileDescriptor[]>;
  readFile(fd: FileDescriptor): Promise<string>;
  /** For folder sync pass all files with content to resolve wiki links across the vault. */
  getWikiResolver(
    filesWithContent?: { path: string; content: string }[]
  ): (target: string) => string | null;
  /** Resolve image ref to path/key and metadata; return null if not found. */
  resolveImage(fd: FileDescriptor, imageRef: ImageRefLike): ResolvedImage | null;
  readImageBytes(pathOrKey: string): Promise<ArrayBuffer>;
  writeFrontmatter(fd: FileDescriptor, meta: SyncedFrontmatter): Promise<void>;
  /** Optional; when missing, folder placeholders are looked up by search only. */
  folderIndex?: FolderIndex;
  /** Optional; when missing, use options.folderConflictStrategy for folder sync. */
  resolveConflict?(title: string): Promise<ConflictResolution>;
  onProgress?(message: string): void;
}
