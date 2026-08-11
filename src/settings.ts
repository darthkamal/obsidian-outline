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
}

export const DEFAULT_SETTINGS: OutlineSyncSettings = {
  outlineUrl: '',
  publicUrl: '',
  apiKey: '',
  targetCollectionId: '',
  targetCollectionName: '',
  removeToc: false,
};
