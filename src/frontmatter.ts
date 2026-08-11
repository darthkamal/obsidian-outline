import { App, TFile } from 'obsidian';
import type { OutlineFrontmatter } from './pipeline';

export { parseFrontmatter, stripFrontmatter, getOutlineMeta } from './pipeline';
export type { OutlineFrontmatter } from './pipeline';

export async function updateOutlineFrontmatter(
  app: App,
  file: TFile,
  updates: OutlineFrontmatter,
  /**
   * Keys to delete. An incomplete push must not leave a stale
   * `outline_content_hash` behind, or the next run skips the note and its
   * failed attachment becomes permanent.
   */
  options?: { remove?: string[] }
): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm) => {
    if (updates.outline_id !== undefined) fm['outline_id'] = updates.outline_id;
    if (updates.outline_collection_id !== undefined)
      fm['outline_collection_id'] = updates.outline_collection_id;
    if (updates.outline_last_synced !== undefined)
      fm['outline_last_synced'] = updates.outline_last_synced;
    if (updates.outline_content_hash !== undefined)
      fm['outline_content_hash'] = updates.outline_content_hash;
    for (const key of options?.remove ?? []) {
      delete fm[key];
    }
  });
}
