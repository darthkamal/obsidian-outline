/**
 * An embedded local file: image, audio, video, PDF, anything that is not a
 * note. `imageName` is the target exactly as written in the note.
 */
export interface ImageRef {
  originalSyntax: string;
  imageName: string;
  placeholder: string;
  /** Images render inline; other attachments render as a file link. */
  isImage: boolean;
}

export interface TransformContext {
  content: string;
  meta: {
    fileName: string;
    filePath: string;
    frontmatter: Record<string, unknown>;
    plugins: Record<string, Record<string, unknown>>;
  };
}

export interface TransformerInstance {
  name: string;
  transform(ctx: TransformContext): TransformContext;
}

export type TransformerPlugin<Options = void> = (opts?: Options) => TransformerInstance;
