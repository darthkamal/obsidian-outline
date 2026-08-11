/**
 * Helpers for leaving code alone.
 *
 * Every markdown transformer in this pipeline is regex-based, which means a
 * document that *documents* Obsidian syntax (a fenced block containing
 * `> [!NOTE]`, or `` `[[wikilink]]` ``) would otherwise get rewritten as if the
 * example were real. These helpers let a transformer ask "is this position
 * inside code?" before touching it.
 */

// `.` never matches `\r`, so a bare `(.*)$` fails outright on a line that
// still carries one -- e.g. content.split('\n') on a CRLF file leaves every
// line ending in `\r`. The pipeline normalizes CRLF to LF once at its entry
// point (pipeline/context.ts) so real pushes never hit this, but this module
// is also called directly (including from tests), so the regex itself stays
// correct independent of that normalization.
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*?)\r?$/;
/** A run of backticks, then anything up to a matching run. */
const INLINE_CODE_RE = /(`+)(?:(?!\1)[\s\S])*?\1/g;

/**
 * Per-line flags: true when the line is inside a fenced code block, including
 * the opening and closing fence lines themselves.
 */
export function fencedLineFlags(lines: string[]): boolean[] {
  const flags: boolean[] = new Array(lines.length).fill(false);
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const match = FENCE_RE.exec(lines[i]);
    if (!fence) {
      if (match) {
        // Keep the run verbatim: a ````-fence is how a note wraps an example
        // that itself contains ```, and normalising to three would let the
        // inner fence close the outer block.
        fence = match[1];
        flags[i] = true;
      }
    } else {
      flags[i] = true;
      // A closing fence uses the same character, is at least as long as the
      // opening run, and carries no info string.
      if (
        match &&
        match[1][0] === fence[0] &&
        match[1].length >= fence.length &&
        !match[2].trim()
      ) {
        fence = null;
      }
    }
  }

  return flags;
}

/**
 * Character mask over `content`: true where the character sits inside a fenced
 * code block or an inline code span.
 */
export function buildCodeMask(content: string): boolean[] {
  const mask: boolean[] = new Array(content.length).fill(false);
  const lines = content.split('\n');
  const fenced = fencedLineFlags(lines);

  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fenced[i]) {
      for (let j = 0; j < line.length; j++) mask[offset + j] = true;
    } else {
      INLINE_CODE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = INLINE_CODE_RE.exec(line)) !== null) {
        for (let j = 0; j < m[0].length; j++) mask[offset + m.index + j] = true;
      }
    }
    offset += line.length + 1; // +1 for the newline
  }

  return mask;
}

/**
 * Like `String.replace` with a global regex, but matches that begin inside a
 * code region are returned untouched.
 */
export function replaceOutsideCode(
  content: string,
  regex: RegExp,
  replacer: (match: string, ...groups: string[]) => string
): string {
  const mask = buildCodeMask(content);
  return content.replace(regex, (...args: unknown[]) => {
    const match = args[0] as string;
    // Trailing args are (offset, wholeString) plus an optional groups object.
    const offset = args.find((a, i) => i > 0 && typeof a === 'number') as number;
    if (mask[offset]) return match;
    const groups = args.slice(1, args.indexOf(offset)) as string[];
    return replacer(match, ...groups);
  });
}
