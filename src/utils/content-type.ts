const CONTENT_TYPE_MAP: Record<string, string> = {
  // images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  // audio
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  aac: 'audio/aac',
  webm: 'video/webm',
  // video
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  // documents
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  rtf: 'application/rtf',
  epub: 'application/epub+zip',
  // Not treated as inline images (poor browser support for HEIC/TIFF), but
  // real files people actually have -- iPhone photos and scans -- that were
  // silently dropped by the allowlist restriction below rather than
  // uploaded with a generic content type as before. Files with an extension
  // still outside this map render as an unresolved link, not an upload
  // failure, which is the deliberate trade-off that keeps a dotted note
  // title like "Chapter 1.2" from being hunted for on disk -- see
  // isAttachmentExtension below.
  heic: 'image/heic',
  heif: 'image/heif',
  tiff: 'image/tiff',
  tif: 'image/tiff',
};

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
const ATTACHMENT_EXTENSIONS = new Set(Object.keys(CONTENT_TYPE_MAP));

export function getContentType(ext: string): string {
  return CONTENT_TYPE_MAP[ext.toLowerCase()] ?? 'application/octet-stream';
}

/** Images embed inline with `![]()`; everything else renders as a file link. */
export function isImageExtension(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase().replace(/^\./, ''));
}

/**
 * Whether an embed target names a real attachment.
 *
 * Deliberately a known-extension list rather than "anything after a dot": note
 * titles routinely contain dots (`![[Chapter 1.2]]`, `![[Meeting 2024.01]]`),
 * and treating those as attachments turns a perfectly good document link into
 * "*(Image not found: Chapter 1.2)*".
 */
export function isAttachmentExtension(ext: string): boolean {
  return ATTACHMENT_EXTENSIONS.has(ext.toLowerCase().replace(/^\./, ''));
}
