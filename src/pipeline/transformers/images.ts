import type { TransformerPlugin, TransformContext, ImageRef } from '../types';
import { replaceOutsideCode } from '../code-regions';

const IMAGE_EXTENSIONS = 'png|jpg|jpeg|gif|webp|svg|bmp';
const EMBEDDED_IMAGE_WIKI_REGEX = new RegExp(
  `!\\[\\[([^\\]|]+\\.(${IMAGE_EXTENSIONS}))(?:\\|[^\\]]*)?\\]\\]`,
  'gi'
);
const EMBEDDED_IMAGE_MD_REGEX = new RegExp(
  `!\\[([^\\]]*)\\]\\(([^)]+\\.(${IMAGE_EXTENSIONS}))\\)`,
  'gi'
);
/** Anything already hosted elsewhere: absolute URLs, protocol-relative, data URIs. */
const REMOTE_TARGET_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function detectImages(content: string): {
  content: string;
  images: ImageRef[];
} {
  const images: ImageRef[] = [];

  const capture = (imageName: string, originalSyntax: string): string => {
    // Remote images are already served by someone else -- uploading them as
    // attachments is impossible and rewriting them loses a working image.
    if (REMOTE_TARGET_RE.test(imageName)) return originalSyntax;
    const placeholder = `__OUTLINE_IMG_${images.length}__`;
    images.push({ originalSyntax, imageName, placeholder });
    return placeholder;
  };

  let result = replaceOutsideCode(content, EMBEDDED_IMAGE_WIKI_REGEX, (match, name) =>
    capture(name, match)
  );
  result = replaceOutsideCode(result, EMBEDDED_IMAGE_MD_REGEX, (match, _alt, target) =>
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
