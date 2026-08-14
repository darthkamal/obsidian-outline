const MAX_LOG_ENTRIES = 200;

export interface SyncLogEntry {
  timestamp: string; // ISO 8601
  directoryPath: string;
  collectionId: string;
  collectionName: string;
  trigger: 'manual' | 'sync-all';
  success: number;
  skipped: number;
  failed: number;
  total: number;
  foldersCreated: number;
  /**
   * Present only when failed > 0. Same shape as SyncResult.failedFiles, but
   * capped -- one run can fail thousands of notes and the entry cap alone
   * would not stop the file growing by megabytes.
   */
  failures?: { path: string; error: string }[];
  /** How many further failures were dropped from `failures`, when it was capped. */
  failuresTruncated?: number;
}

export interface SyncLogWriter {
  append(entry: SyncLogEntry): Promise<void>;
}

/** The slice of Obsidian's DataAdapter this module needs -- kept minimal so tests can fake it. */
export interface LogAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
}

/**
 * Appends one entry per sync run to a JSON array at `logPath`, capped at the
 * most recent MAX_LOG_ENTRIES. A write failure is caught and logged, never
 * thrown -- the sync itself already succeeded or failed on its own terms by
 * the time this runs; losing the log entry is a diagnosability regression,
 * not a sync failure.
 */
async function appendOnce(
  adapter: LogAdapter,
  logPath: string,
  entry: SyncLogEntry
): Promise<void> {
  let entries: SyncLogEntry[] = [];
  try {
    if (await adapter.exists(logPath)) {
      const raw = await adapter.read(logPath);
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) entries = parsed as SyncLogEntry[];
    }
  } catch {
    // Missing, unreadable, or malformed: start fresh rather than lose
    // future logging over one corrupted read.
    entries = [];
  }

  entries.push(entry);
  if (entries.length > MAX_LOG_ENTRIES) {
    entries = entries.slice(-MAX_LOG_ENTRIES);
  }

  try {
    await adapter.write(logPath, JSON.stringify(entries, null, 2));
  } catch (e) {
    console.error('[Outline Sync] Could not write sync log:', e);
  }
}

export function createObsidianSyncLogWriter(adapter: LogAdapter, logPath: string): SyncLogWriter {
  // Every trigger site (per-row "Sync now", the command palette, the file
  // menu) fires append() without awaiting the previous sync, so two runs
  // finishing close together can each read the log before either writes it
  // -- whichever writes last silently drops the other's entry. Chaining
  // every call onto the same promise serializes the read-modify-write
  // instead of letting them interleave. appendOnce never rejects (its own
  // write failure is caught and logged), so the chain itself never breaks.
  let chain: Promise<void> = Promise.resolve();

  return {
    append(entry: SyncLogEntry): Promise<void> {
      chain = chain.then(() => appendOnce(adapter, logPath, entry));
      return chain;
    },
  };
}
