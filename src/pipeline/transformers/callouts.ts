import type { TransformerPlugin, TransformContext } from '../types';
import { fencedLineFlags } from '../code-regions';

const CALLOUT_OPEN_REGEX = /^> \[!(\w+)\]([-+]?)[ \t]*(.*)$/;
/** A callout nested one level deeper, after the outer `> ` has been stripped. */
const NESTED_CALLOUT_REGEX = /^>[ \t]*\[!(\w+)\]([-+]?)[ \t]*(.*)$/;

const OBSIDIAN_TO_OUTLINE_TYPE: Record<string, string> = {
  note: 'info',
  abstract: 'info',
  info: 'info',
  tip: 'tip',
  success: 'success',
  question: 'info',
  warning: 'warning',
  failure: 'warning',
  danger: 'warning',
  bug: 'warning',
  example: 'tip',
  quote: 'info',
  cite: 'info',
};

/**
 * Outline's `:::` notices don't nest, so a callout inside a callout is flattened
 * to a bold label plus its text. Emitting nested `:::` fences would make the
 * inner one close the outer block.
 */
function flattenNested(bodyLines: string[]): string[] {
  return bodyLines.map((line) => {
    const nested = line.match(NESTED_CALLOUT_REGEX);
    if (nested) {
      const label = nested[3].trim() || nested[1].toLowerCase();
      return `**${label}**`;
    }
    return line.replace(/^>[ \t]?/, '');
  });
}

export function convertCallouts(content: string): string {
  const lines = content.split('\n');
  const inFence = fencedLineFlags(lines);
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const openMatch = inFence[i] ? null : lines[i].match(CALLOUT_OPEN_REGEX);
    if (!openMatch) {
      result.push(lines[i]);
      i++;
      continue;
    }

    const obsidianType = openMatch[1].toLowerCase();
    const titlePart = openMatch[3].trim();
    const outlineType = OBSIDIAN_TO_OUTLINE_TYPE[obsidianType] ?? 'info';

    const bodyLines: string[] = [];
    if (titlePart) {
      bodyLines.push(titlePart);
    }
    i++;

    const rawBody: string[] = [];
    while (i < lines.length && !inFence[i] && lines[i].startsWith('>')) {
      rawBody.push(lines[i].replace(/^> ?/, ''));
      i++;
    }
    bodyLines.push(...flattenNested(rawBody));

    const body = bodyLines.join('\n').trim();
    result.push(`:::${outlineType}`);
    if (body) {
      result.push(body);
    }
    result.push('');
    result.push(':::');
  }

  return result.join('\n');
}

export const CalloutTransformer: TransformerPlugin = () => ({
  name: 'CalloutTransformer',
  transform(ctx: TransformContext): TransformContext {
    return { ...ctx, content: convertCallouts(ctx.content) };
  },
});
