/**
 * Stable hash of a note's body, used to detect real edits.
 *
 * Modification time cannot be used for this: a successful push writes sync
 * metadata back into the note's frontmatter, which bumps mtime a few
 * milliseconds past the `outline_last_synced` value being written, so every
 * later run would see the file as modified and re-push it.
 *
 * FNV-1a with two seeds, concatenated. Not cryptographic -- it only has to
 * detect a note changing against its own previous value, where a collision is
 * around one in 2^64 per edit. Implemented by hand so the same code runs in
 * Node and in Obsidian's bundle without pulling in `crypto`.
 */
function fnv1a(input: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619, kept in 32-bit range without overflowing to float
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function hashContent(content: string): string {
  // Normalise line endings so a CRLF/LF change alone is not treated as an edit.
  const normalized = content.replace(/\r\n/g, '\n');
  const a = fnv1a(normalized, 0x811c9dc5);
  const b = fnv1a(normalized, 0x7fffffff);
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
