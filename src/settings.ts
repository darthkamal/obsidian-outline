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
};
