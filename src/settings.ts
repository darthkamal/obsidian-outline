export interface DirectoryMapping {
  /** Top-level vault-relative path, e.g. "Compendium". */
  directoryPath: string;
  /** Resolved once when the mapping is created; never re-resolved by name. */
  collectionId: string;
  /** Cached for display only -- not authoritative, collectionId is. */
  collectionName: string;
}

export interface OutlineSyncSettings {
  /** Base URL the plugin talks to. May be a LAN/VPN address. */
  outlineUrl: string;
  /**
   * Base URL written into links inside pushed documents. Leave blank to reuse
   * `outlineUrl`. Set this when the API is reached over a private address but
   * readers open Outline on a public hostname -- otherwise every cross-link in
   * your Outline documents points somewhere only you can reach.
   */
  publicUrl: string;
  apiKey: string;
  targetCollectionId: string;
  targetCollectionName: string;
  removeToc: boolean;
  /**
   * Skip notes not modified since their last push. Makes repeat pushes of a
   * large folder cheap. Trade-off: a skipped note is not re-rendered, so a link
   * it makes to a note created in the same run stays unresolved until that note
   * is edited again.
   */
  skipUnchanged: boolean;
  /**
   * Outline document ids for folder placeholders, keyed
   * `${collectionId}:${relativePath}`. Without this a re-sync can duplicate
   * folder trees when Outline's search index lags behind.
   */
  folderDocIds: Record<string, string>;
  /** Top-level directories synced against their own dedicated collection. */
  directoryMappings: DirectoryMapping[];
}

export const DEFAULT_SETTINGS: OutlineSyncSettings = {
  outlineUrl: '',
  publicUrl: '',
  apiKey: '',
  targetCollectionId: '',
  targetCollectionName: '',
  removeToc: false,
  skipUnchanged: true,
  folderDocIds: {},
  directoryMappings: [],
};

/**
 * Merges loaded plugin data over the defaults and defensively copies every
 * mutable field. Object.assign copies the *reference* when data.json
 * predates a field, so writing to it later would mutate DEFAULT_SETTINGS
 * itself and leak into the next load -- see the folderDocIds precedent this
 * follows.
 */
export function normalizeSettings(
  loaded: Partial<OutlineSyncSettings> | null | undefined
): OutlineSyncSettings {
  const merged = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
  merged.folderDocIds = { ...merged.folderDocIds };
  merged.directoryMappings = [...merged.directoryMappings];
  return merged;
}
