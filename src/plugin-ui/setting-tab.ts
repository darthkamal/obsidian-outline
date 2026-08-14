import { App, DropdownComponent, Notice, PluginSettingTab, Setting, TFolder } from 'obsidian';
import type OutlineSyncPlugin from './main';
import type { Collection } from '../outline-client';
import type { OutlineSyncSettings } from '../settings';

export class OutlineSyncSettingTab extends PluginSettingTab {
  plugin: OutlineSyncPlugin;
  private collectionDropdown: DropdownComponent | null = null;

  constructor(app: App, plugin: OutlineSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    if (this.plugin.cachedCollections.length > 0) {
      void this.loadCollections();
    }

    const warning = containerEl.createEl('div', { cls: 'callout' });
    warning.style.cssText =
      'background:var(--background-modifier-error-hover);border-left:3px solid var(--color-orange);padding:8px 12px;margin-bottom:16px;border-radius:4px;font-size:0.85em;';
    warning.createEl('strong', { text: 'Security notice: ' });
    warning.appendText(
      'The API key is stored in plain text in data.json. Make sure this file is excluded from public cloud sync services (e.g. iCloud, Dropbox).'
    );

    new Setting(containerEl)
      .setName('Outline URL (API)')
      .setDesc(
        'Where the plugin sends API requests. May be a LAN or VPN address, e.g. http://10.0.0.5:3000'
      )
      .addText((text) =>
        text
          .setPlaceholder('https://outline.example.com')
          .setValue(this.plugin.settings.outlineUrl)
          .onChange(async (value) => {
            this.plugin.settings.outlineUrl = value.trim().replace(/\/$/, '');
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Public URL (optional)')
      .setDesc(
        'Base URL used for links written into your documents. Leave blank to reuse the API URL. ' +
          'Set this if the API URL is private, so links stay usable for everyone.'
      )
      .addText((text) =>
        text
          .setPlaceholder('https://outline.example.com')
          .setValue(this.plugin.settings.publicUrl)
          .onChange(async (value) => {
            this.plugin.settings.publicUrl = value.trim().replace(/\/$/, '');
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('Outline API Key (Settings → API & Apps)')
      .addText((text) => {
        text
          .setPlaceholder('ol_api_...')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
      });

    new Setting(containerEl)
      .setName('Validate API Key')
      .setDesc('Test connection to Outline and load collections')
      .addButton((btn) =>
        btn
          .setButtonText('Connect')
          .setCta()
          .onClick(async () => {
            btn.setButtonText('Checking…');
            btn.setDisabled(true);
            const result = await this.plugin.client.checkConnection();
            btn.setDisabled(false);
            if (result.ok) {
              btn.setButtonText(`✓ ${result.user}`);
              await this.loadCollections();
            } else {
              btn.setButtonText('✗ Failed');
              new Notice(`Outline Sync: ${result.reason}`, 10000);
            }
          })
      );

    new Setting(containerEl)
      .setName('Default Collection')
      .setDesc('Documents will be pushed to this collection by default')
      .addDropdown((dropdown) => {
        this.collectionDropdown = dropdown;
        dropdown.addOption('', '— Connect first —');
        if (this.plugin.settings.targetCollectionId) {
          dropdown.addOption(
            this.plugin.settings.targetCollectionId,
            this.plugin.settings.targetCollectionName
          );
          dropdown.setValue(this.plugin.settings.targetCollectionId);
        }
        dropdown.onChange(async (value) => {
          this.plugin.settings.targetCollectionId = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Skip unchanged notes')
      .setDesc(
        'Only push notes modified since their last sync. Much faster on large folders. ' +
          'Turn off to force a full re-push.'
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.skipUnchanged).onChange(async (value) => {
          this.plugin.settings.skipUnchanged = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Remove table of contents')
      .setDesc('Strip TOC blocks (lists of [[#section]] links) before pushing to Outline')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.removeToc).onChange(async (value) => {
          this.plugin.settings.removeToc = value;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl('h3', { text: 'Directory → Collection mappings' });
    containerEl.createEl('p', {
      text:
        'Top-level directories synced against their own dedicated collection. ' +
        'Unmapped directories are unaffected.',
      cls: 'setting-item-description',
    });

    for (const mapping of this.plugin.settings.directoryMappings) {
      new Setting(containerEl)
        .setName(mapping.directoryPath)
        .setDesc(`→ ${mapping.collectionName}`)
        .addButton((btn) =>
          btn.setButtonText('Sync now').onClick(async () => {
            const folder = this.plugin.app.vault.getAbstractFileByPath(mapping.directoryPath);
            if (!(folder instanceof TFolder)) {
              new Notice(`Outline Sync: "${mapping.directoryPath}" no longer exists in the vault.`);
              return;
            }
            await this.plugin.engine.syncMappedDirectory(folder, mapping, 'manual');
          })
        )
        .addButton((btn) =>
          btn.setButtonText('Remove mapping').onClick(async () => {
            this.plugin.settings.directoryMappings = this.plugin.settings.directoryMappings.filter(
              (m) => m.directoryPath !== mapping.directoryPath
            );
            await this.plugin.saveSettings();
            this.display();
          })
        );
    }

    const alreadyMapped = new Set(
      this.plugin.settings.directoryMappings.map((m) => m.directoryPath)
    );
    const candidates = this.plugin.app.vault
      .getRoot()
      .children.filter(
        (f): f is TFolder =>
          f instanceof TFolder && !f.name.startsWith('.') && !alreadyMapped.has(f.path)
      );

    new Setting(containerEl)
      .setName('Add directory')
      .setDesc('Map a top-level directory to an Outline collection (found or created by name).')
      .addDropdown((dropdown) => {
        dropdown.addOption('', '— Select a directory —');
        for (const folder of candidates) {
          dropdown.addOption(folder.path, folder.name);
        }
        dropdown.onChange(async (value) => {
          if (!value) return;
          const folder = this.plugin.app.vault.getAbstractFileByPath(value);
          if (folder instanceof TFolder) {
            await this.plugin.engine.mapDirectory(folder);
            this.display();
          }
        });
      });
  }

  async loadCollections(): Promise<void> {
    await this.plugin.refreshCollections();
    const collections = this.plugin.cachedCollections;

    if (collections.length === 0 || !this.collectionDropdown) {
      new Notice('Could not load collections.');
      return;
    }

    const dropdown = this.collectionDropdown;
    const selectEl = dropdown.selectEl;
    selectEl.empty();

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.text = '— Select collection —';
    selectEl.appendChild(placeholder);

    for (const col of collections) {
      const opt = document.createElement('option');
      opt.value = col.id ?? '';
      opt.text = col.name ?? '';
      if (col.id === this.plugin.settings.targetCollectionId) {
        opt.selected = true;
      }
      selectEl.appendChild(opt);
    }

    dropdown.onChange(async (value) => {
      const selected = collections.find((c: Collection) => c.id === value);
      this.plugin.settings.targetCollectionId = value;
      this.plugin.settings.targetCollectionName = selected?.name ?? '';
      await this.plugin.saveSettings();
    });

    new Notice(`${collections.length} collection(s) loaded.`);
  }
}
