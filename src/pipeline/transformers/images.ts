import type { TransformerPlugin, TransformContext, ImageRef } from '../types';
import { replaceOutsideCode } from '../code-regions';
import { isImageExtension } from '../../utils/content-type';

/**
 * Any embed with a file extension is a candidate attachment. Restricting this
 * to image extensions meant audio, video and PDF embeds were never uploaded --
 * they degraded to plain text and the file was silently lost.
 */
const EMBED_WIKI_REGEX = /!\[\[([^\]|]+\.([A-Za-z0-9]{1,10}))(?:\|[^\]]*)?\]\]/g;
const EMBED_MD_REGEX = /!\[([^\]]*)\]\(([^)]+\.([A-Za-z0-9]{1,10}))\)/g;

/** Already hosted elsewhere: absolute URLs, protocol-relative, data URIs. */
const REMOTE_TARGET_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function extensionOf(target: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(target);
  return match ? match[1].toLowerCase() : '';
}

export function detectImages(content: string): {
  content: string;
  images: ImageRef[];
} {
  const images: ImageRef[] = [];

  const capture = (imageName: string, originalSyntax: string): string => {
    // Remote files are served by someone else; rewriting them loses a working
    // reference and they cannot be uploaded as attachments anyway.
    if (REMOTE_TARGET_RE.test(imageName)) return originalSyntax;
    const ext = extensionOf(imageName);
    // `![[note.md]]` is a transclusion, not an attachment -- leave it for the
    // wiki link transformer to turn into a link.
    if (!ext || ext === 'md') return originalSyntax;

    const placeholder = `__OUTLINE_IMG_${images.length}__`;
    images.push({
      originalSyntax,
      imageName,
      placeholder,
      isImage: isImageExtension(ext),
    });
    return placeholder;
  };

  let result = replaceOutsideCode(content, EMBED_WIKI_REGEX, (match, name) => capture(name, match));
  result = replaceOutsideCode(result, EMBED_MD_REGEX, (match, _alt, target) =>
    capture(target, match)
  );

  return { content: result, images };
}

export const ImageDetector: TransformerPlugin = () => ({
  name: 'ImageDetector',
  transform(ctx: TransformContext): TransformContext {
    const { content, images } = detectImages(ctx.content);
    return {
      ...ctx,
      content,
      meta: {
        ...ctx.meta,
        plugins: {
          ...ctx.meta.plugins,
          ImageDetector: { images },
        },
      },
    };
  },
});
