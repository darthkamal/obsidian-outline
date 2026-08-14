import { App, Notice, TFile, TFolder } from 'obsidian';
import { OutlineClient } from './outline-client';
import { OutlineSyncSettings } from './settings';
import { syncDocument, syncFolder } from './sync';
import type { SyncOptions, FolderIndex, SyncResult } from './sync';
import { createObsidianSyncEnv, buildWikiLinkResolver } from './adapters/obsidian';
import { resolveConflict, resolveFolderConflictStrategy } from './plugin-ui/conflict-modal';
import { SyncLogNotice } from './plugin-ui/sync-log-notice';
import { getErrorMessage } from './utils/errors';
import type { SyncLogWriter } from './plugin-ui/sync-log-writer';
import { resolveOrCreateCollection } from './collection-resolver';
import type { DirectoryMapping } from './settings';

/** Shared so the Notice and the synthesized SyncResult can't drift apart. */
const NOT_CONFIGURED = 'Please configure URL and API key in settings.';

/**
 * Cap on per-file failure detail in one sync-log entry. The 200-entry cap
 * bounds how many entries the log keeps, but not how big one entry gets: a
 * vault-wide outage fails every note, and a few hundred notes of path+message
 * per entry would grow the log by megabytes. The dropped count is kept so the
 * entry still says there were more.
 */
const MAX_LOGGED_FAILURES = 50;

export class PushEngine {
  private app: App;
  private client: OutlineClient;
  private settings: OutlineSyncSettings;
  private saveSettings: () => Promise<void>;
  private syncLogWriter: SyncLogWriter;

  constructor(
    app: App,
    client: OutlineClient,
    settings: OutlineSyncSettings,
    saveSettings: () => Promise<void>,
    syncLogWriter: SyncLogWriter
  ) {
    this.app = app;
    this.client = client;
    this.settings = settings;
    this.saveSettings = saveSettings;
    this.syncLogWriter = syncLogWriter;
  }

  /** Folder placeholder ids, persisted in the plugin's data.json. */
  private buildFolderIndex(): FolderIndex {
    return {
      get: (key) => this.settings.folderDocIds[key],
      set: async (key, documentId) => {
        if (this.settings.folderDocIds[key] === documentId) return;
        this.settings.folderDocIds[key] = documentId;
        await this.saveSettings();
      },
    };
  }

  async mapDirectory(folder: TFolder): Promise<void> {
    if (!this.validateConfig()) return;

    if (folder.parent !== this.app.vault.getRoot()) {
      new Notice('Outline Sync: only top-level folders can be mapped to a collection.');
      return;
    }
    if (this.settings.directoryMappings.some((m) => m.directoryPath === folder.path)) {
      new Notice(`Outline Sync: "${folder.path}" is already mapped.`);
      return;
    }

    const resolved = await resolveOrCreateCollection(this.client, folder.name);
    if (!resolved) {
      new Notice(`Outline Sync: could not resolve or create a collection named "${folder.name}".`);
      return;
    }

    const mapping: DirectoryMapping = {
      directoryPath: folder.path,
      collectionId: resolved.id,
      collectionName: resolved.name,
    };
    this.settings.directoryMappings.push(mapping);
    await this.saveSettings();

    new Notice(
      resolved.created
        ? `Outline Sync: created collection "${resolved.name}" and mapped "${folder.path}" to it.`
        : `Outline Sync: mapped "${folder.path}" to existing collection "${resolved.name}".`
    );
  }

  private buildOptions(
    collectionId: string,
    folderConflictStrategy: 'overwrite' | 'duplicate'
  ): SyncOptions {
    return {
      // Link generation only -- the API base URL lives on the client.
      outlineUrl: this.settings.publicUrl || this.settings.outlineUrl,
      apiKey: this.settings.apiKey,
      collectionId,
      removeToc: this.settings.removeToc,
      indexAsFolder: true,
      folderConflictStrategy,
      skipUnchanged: this.settings.skipUnchanged,
    };
  }

  private summarizeResult(result: SyncResult): { summary: string; ok: boolean } {
    const ok = result.failed === 0;
    const unchanged = result.skipped > 0 ? `, ${result.skipped} unchanged` : '';
    const folders =
      result.foldersCreated > 0 ? `, ${result.foldersCreated} folder placeholder(s)` : '';
    const summary = ok
      ? `✓ ${result.success} file(s) pushed${unchanged}${folders}`
      : `✓ ${result.success} pushed${unchanged}${folders}, ✗ ${result.failed} failed`;
    return { summary, ok };
  }

  async pushFile(file: TFile, collectionId?: string): Promise<void> {
    if (!this.validateConfig()) return;

    const targetCollection = collectionId ?? this.settings.targetCollectionId;
    const notice = new Notice(`Pushing "${file.basename}" to Outline…`, 0);

    try {
      // Pushing one named note is a deliberate act, so it always pushes.
      // Honouring skipUnchanged here would make the command a no-op that still
      // reported "pushed", with no way to force the push from the UI.
      const options = { ...this.buildOptions(targetCollection, 'overwrite'), skipUnchanged: false };
      const env = createObsidianSyncEnv({
        app: this.app,
        api: this.client,
        getWikiResolverForSingleFile: () => buildWikiLinkResolver(this.app, file.path),
        resolveConflict: (title) => resolveConflict(this.app, title),
        onProgress: (msg) => {
          notice.setMessage(msg);
        },
      });

      const fd = { path: file.path, basename: file.basename, _file: file };
      const result = await syncDocument(options, env, fd);

      notice.hide();
      if (result) {
        new Notice(`✓ "${file.basename}" pushed to Outline`, 5000);
      }
    } catch (e) {
      notice.hide();
      new Notice(`✗ Push failed: ${getErrorMessage(e)}`, 8000);
      console.error('[Outline Sync] pushFile error:', e);
    }
  }

  async pushFolder(folder: TFolder, collectionId?: string): Promise<void> {
    if (!this.validateConfig()) return;

    const targetCollection = collectionId ?? this.settings.targetCollectionId;
    const folderStrategy = await resolveFolderConflictStrategy(this.app);
    if (folderStrategy === 'cancel') return;

    const log = new SyncLogNotice(`Pushing ${folder.name}…`);

    const options = this.buildOptions(targetCollection, folderStrategy);
    const env = createObsidianSyncEnv({
      app: this.app,
      api: this.client,
      folderIndex: this.buildFolderIndex(),
      onProgress: (msg) => log.appendLine(msg),
    });

    try {
      const result = await syncFolder(options, env, folder.path);
      const { summary, ok } = this.summarizeResult(result);
      log.finish(summary, ok);
    } catch (e) {
      log.finish(`✗ Push failed: ${getErrorMessage(e)}`, false);
      console.error('[Outline Sync] pushFolder error:', e);
    }
  }

  async syncMappedDirectory(
    folder: TFolder,
    mapping: DirectoryMapping,
    trigger: 'manual' | 'sync-all' = 'manual'
  ): Promise<SyncResult> {
    // A mapping outlives the settings that created it, so this can be reached
    // with the URL or key since cleared. Without the guard the run proceeds
    // and fails once per note instead of saying the one useful thing.
    if (!this.validateConfig()) {
      return {
        success: 0,
        failed: 1,
        skipped: 0,
        total: 1,
        foldersCreated: 0,
        failedFiles: [{ path: folder.path, error: NOT_CONFIGURED }],
      };
    }

    // A mapped sync is a routine, repeatable action -- default to overwrite
    // rather than prompting every run the way the ad-hoc push flow does.
    const options = this.buildOptions(mapping.collectionId, 'overwrite');
    const log = new SyncLogNotice(`Syncing ${folder.name}…`);
    const env = createObsidianSyncEnv({
      app: this.app,
      api: this.client,
      folderIndex: this.buildFolderIndex(),
      onProgress: (msg) => log.appendLine(msg),
    });

    let result: SyncResult;
    try {
      result = await syncFolder(options, env, folder.path);
      const { summary, ok } = this.summarizeResult(result);
      log.finish(summary, ok);
    } catch (e) {
      const msg = getErrorMessage(e);
      result = {
        success: 0,
        failed: 1,
        skipped: 0,
        total: 1,
        foldersCreated: 0,
        failedFiles: [{ path: folder.path, error: msg }],
      };
      log.finish(`✗ Sync failed: ${msg}`, false);
      console.error('[Outline Sync] syncMappedDirectory error:', e);
    }

    await this.syncLogWriter.append({
      timestamp: new Date().toISOString(),
      directoryPath: mapping.directoryPath,
      collectionId: mapping.collectionId,
      collectionName: mapping.collectionName,
      trigger,
      success: result.success,
      skipped: result.skipped,
      failed: result.failed,
      total: result.total,
      foldersCreated: result.foldersCreated,
      ...(result.failedFiles.length > 0
        ? {
            failures: result.failedFiles.slice(0, MAX_LOGGED_FAILURES),
            ...(result.failedFiles.length > MAX_LOGGED_FAILURES
              ? { failuresTruncated: result.failedFiles.length - MAX_LOGGED_FAILURES }
              : {}),
          }
        : {}),
    });

    return result;
  }

  async syncAllMappedDirectories(): Promise<void> {
    if (!this.validateConfig()) return;

    const mappings = this.settings.directoryMappings;
    if (mappings.length === 0) {
      new Notice('Outline Sync: no directories mapped yet.');
      return;
    }

    let succeeded = 0;
    const missing: string[] = [];
    for (const mapping of mappings) {
      const folder = this.app.vault.getAbstractFileByPath(mapping.directoryPath);
      if (!(folder instanceof TFolder)) {
        // Usually a mapped directory that was renamed or deleted in Obsidian.
        // It has to reach the Notice: otherwise the count below just looks
        // like a failed sync, with the real reason buried in the console.
        console.error(`[Outline Sync] Mapped directory not found: ${mapping.directoryPath}`);
        missing.push(mapping.directoryPath);
        continue;
      }
      const result = await this.syncMappedDirectory(folder, mapping, 'sync-all');
      if (result.failed === 0) succeeded++;
    }

    const noun = mappings.length === 1 ? 'directory' : 'directories';
    const missingNoun = missing.length === 1 ? 'directory' : 'directories';
    const notFound =
      missing.length > 0
        ? ` ${missing.length} mapped ${missingNoun} not found: ${missing.join(', ')}.`
        : '';
    new Notice(`Outline Sync: ${succeeded}/${mappings.length} ${noun} synced cleanly.${notFound}`);
  }

  private validateConfig(): boolean {
    if (!this.settings.outlineUrl || !this.settings.apiKey) {
      new Notice(`Outline Sync: ${NOT_CONFIGURED}`);
      return false;
    }
    return true;
  }
}
