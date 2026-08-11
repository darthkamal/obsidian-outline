import type { TransformContext } from './types';

export function createContext(content: string, fileName = '', filePath = ''): TransformContext {
  return {
    // Every transformer downstream splits content on '\n' and matches
    // per-line regexes ending in `(.*)$`. `.` never matches `\r`, so a
    // CRLF-saved file left every such match failing at the very last
    // character -- fence detection, callouts -- without ever producing an
    // error. Normalizing once here, the same way content-hash.ts already
    // does for change detection, fixes it for every current and future
    // transformer instead of patching each regex individually. This only
    // affects the copy pushed to Outline; the local file on disk is untouched.
    content: content.replace(/\r\n/g, '\n'),
    meta: {
      fileName,
      filePath,
      frontmatter: {},
      plugins: {},
    },
  };
}
