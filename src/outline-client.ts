import { requestUrl, type RequestUrlParam } from 'obsidian';
import type { Transport } from './outline-api/custom-instance';
import {
  OutlineApiBase,
  UploadTimeoutError,
  type UploadAttemptResult,
} from './outline-api/outline-api-base';
import { getErrorMessage } from './utils/errors';

export type {
  Collection,
  Document,
  AttachmentsCreate200Data,
} from './outline-api/outline-api-base';

const obsidianTransport: Transport = async (url, init) => {
  const params: RequestUrlParam = {
    url,
    method: init.method,
    headers: init.headers,
    body: init.body,
    throw: false,
  };

  const response = await requestUrl(params);

  return {
    status: response.status,
    headers: new Headers(response.headers),
    json: async () => response.json,
  };
};

export class OutlineClient extends OutlineApiBase {
  constructor(baseUrl: string, apiKey: string, uploadTimeoutMs?: number) {
    let normalizedUrl: string;
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Invalid protocol');
      }
      normalizedUrl = parsed.origin;
    } catch {
      normalizedUrl = baseUrl.replace(/\/$/, '');
    }
    super(normalizedUrl, apiKey, obsidianTransport, uploadTimeoutMs);
  }

  async uploadAttachmentToStorage(
    uploadUrl: string,
    form: Record<string, unknown>,
    fileData: ArrayBuffer,
    contentType: string
  ): Promise<boolean> {
    const isLocalStorage = !uploadUrl.startsWith('http');
    const absoluteUrl = isLocalStorage
      ? `${this.baseUrl}${uploadUrl.startsWith('/') ? '' : '/'}${uploadUrl}`
      : uploadUrl;

    return this.retryUpload(async (): Promise<UploadAttemptResult> => {
      const boundary = `----FormBoundary${Math.random().toString(36).slice(2)}`;
      const parts: Uint8Array[] = [];
      const enc = new TextEncoder();

      for (const [key, value] of Object.entries(form)) {
        parts.push(
          enc.encode(
            `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(value)}\r\n`
          )
        );
      }
      parts.push(
        enc.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload"\r\nContent-Type: ${contentType}\r\n\r\n`
        )
      );
      parts.push(new Uint8Array(fileData));
      parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

      const totalLength = parts.reduce((sum, p) => sum + p.byteLength, 0);
      const body = new Uint8Array(totalLength);
      let offset = 0;
      for (const part of parts) {
        body.set(part, offset);
        offset += part.byteLength;
      }

      const headers: Record<string, string> = {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      };
      if (isLocalStorage) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      try {
        // requestUrl has no AbortSignal, so this can only stop waiting on a
        // stalled call, not cancel it -- see withUploadTimeout.
        const response = await this.withUploadTimeout(
          requestUrl({
            url: absoluteUrl,
            method: 'POST',
            headers,
            body: body.buffer,
            throw: false,
          })
        );
        if (response.status >= 200 && response.status < 300) return { ok: true };
        return { ok: false, status: response.status, message: `${response.status}` };
      } catch (e) {
        if (e instanceof UploadTimeoutError) {
          // requestUrl cannot be cancelled, so the original request is still
          // running in the background -- retrying now would pile a second
          // upload on top of it over an already-constrained connection.
          // Terminal by design; the note is retried whole on the next sync
          // run instead (pushIncomplete leaves its content hash unwritten).
          return { ok: false, message: e.message, terminal: true };
        }
        // getErrorMessage unwraps `cause`, matching the Node client's handling
        // of the same class of transport failure.
        return { ok: false, message: getErrorMessage(e) };
      }
    }, `attachment upload to ${absoluteUrl}`);
  }
}
