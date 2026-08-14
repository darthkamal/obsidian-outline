import { Menu, Notice, Plugin, TFile, TFolder } from 'obsidian';
import { OutlineClient } from '../outline-client';
import type { Collection } from '../outline-client';
import { PushEngine } from '../push-engine';
import { DEFAULT_SETTINGS, normalizeSettings, OutlineSyncSettings } from '../settings';
import { OutlineSyncSettingTab } from './setting-tab';
import { pickCollection } from './collection-picker-modal';
import { createObsidianSyncLogWriter } from './sync-log-writer';

export default class OutlineSyncPlugin extends Plugin {
  settings: OutlineSyncSettings = DEFAULT_SETTINGS;
  client!: OutlineClient;
  cachedCollections: Collection[] = [];
  private engine!: PushEngine;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.rebuildClient();

    this.addSettingTab(new OutlineSyncSettingTab(this.app, this));

    if (this.settings.outlineUrl && this.settings.apiKey) {
      void this.refreshCollections();
    }

    this.addCommand({
      id: 'push-to-outline',
      name: 'Push active file to Outline',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) {
          void this.pushFileWithPicker(file);
        }
        return true;
      },
    });

    this.addCommand({
      id: 'push-folder-to-outline',
      name: 'Push folder to Outline',
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;
        const folder = file.parent;
        if (folder instanceof TFolder) {
          void this.pushFolderWithPicker(folder);
        }
      },
    });

    this.addCommand({
      id: 'map-directory-to-outline',
      name: 'Map this directory to an Outline collection',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const folder = file?.parent;
        if (!(folder instanceof TFolder) || folder.parent !== this.app.vault.getRoot()) {
          return false;
        }
        if (!checking) void this.engine.mapDirectory(folder);
        return true;
      },
    });

    this.addCommand({
      id: 'sync-directory-to-outline',
      name: 'Sync this directory to Outline',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const folder = file?.parent;
        const mapping =
          folder instanceof TFolder
            ? this.settings.directoryMappings.find((m) => m.directoryPath === folder.path)
            : undefined;
        if (!folder || !mapping) return false;
        if (!checking) void this.engine.syncMappedDirectory(folder, mapping, 'manual');
        return true;
      },
    });

    this.addCommand({
      id: 'sync-all-mapped-directories',
      name: 'Sync all mapped directories to Outline',
      callback: () => void this.engine.syncAllMappedDirectories(),
    });

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu: Menu, abstractFile) => {
        if (abstractFile instanceof TFile && abstractFile.extension === 'md') {
          menu.addItem((item) => {
            item
              .setTitle('Push to Outline')
              .setIcon('upload')
              .onClick(() => void this.pushFileWithPicker(abstractFile));
          });
        }

        if (abstractFile instanceof TFolder) {
          menu.addItem((item) => {
            item
              .setTitle('Push folder to Outline')
              .setIcon('folder-up')
              .onClick(() => void this.pushFolderWithPicker(abstractFile));
          });

          const mapping = this.settings.directoryMappings.find(
            (m) => m.directoryPath === abstractFile.path
          );
          if (mapping) {
            menu.addItem((item) => {
              item
                .setTitle('Sync to Outline')
                .setIcon('refresh-cw')
                .onClick(
                  () => void this.engine.syncMappedDirectory(abstractFile, mapping, 'manual')
                );
            });
          } else if (abstractFile.parent === this.app.vault.getRoot()) {
            menu.addItem((item) => {
              item
                .setTitle('Map this directory to an Outline collection')
                .setIcon('link')
                .onClick(() => void this.engine.mapDirectory(abstractFile));
            });
          }
        }
      })
    );
  }

  async pushFileWithPicker(file: TFile): Promise<void> {
    const collectionId = await this.resolveCollectionId();
    if (!collectionId) return;
    void this.engine.pushFile(file, collectionId);
  }

  async pushFolderWithPicker(folder: TFolder): Promise<void> {
    const collectionId = await this.resolveCollectionId();
    if (!collectionId) return;
    void this.engine.pushFolder(folder, collectionId);
  }

  private async resolveCollectionId(): Promise<string | null> {
    if (this.settings.targetCollectionId) {
      return this.settings.targetCollectionId;
    }

    if (this.cachedCollections.length === 0) {
      await this.refreshCollections();
    }

    if (this.cachedCollections.length === 0) {
      new Notice('Outline Sync: No collections available. Check URL and API key.');
      return null;
    }

    return pickCollection(this.app, this.cachedCollections, '');
  }

  async refreshCollections(): Promise<void> {
    const collections = await this.client.listCollections();
    this.cachedCollections = collections ?? [];
  }

  async loadSettings(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.rebuildClient();
  }

  rebuildClient(): void {
    this.client = new OutlineClient(this.settings.outlineUrl, this.settings.apiKey);
    const pluginDir =
      this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const syncLogWriter = createObsidianSyncLogWriter(
      this.app.vault.adapter,
      `${pluginDir}/sync-log.json`
    );
    // saveData rather than saveSettings: the latter calls rebuildClient(),
    // which would swap the client and engine out from under a running sync.
    this.engine = new PushEngine(
      this.app,
      this.client,
      this.settings,
      () => this.saveData(this.settings),
      syncLogWriter
    );
  }
}
