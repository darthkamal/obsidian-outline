import { OutlineApiBase, type UploadAttemptResult } from './outline-api-base';
import { getErrorMessage } from '../utils/errors';

export class OutlineClientNode extends OutlineApiBase {
  constructor(baseUrl: string, apiKey: string, uploadTimeoutMs?: number) {
    super(baseUrl, apiKey, undefined, uploadTimeoutMs);
  }

  async uploadAttachmentToStorage(
    uploadUrl: string,
    form: Record<string, unknown>,
    fileData: ArrayBuffer,
    contentType: string
  ): Promise<boolean> {
    const absoluteUrl = uploadUrl.startsWith('http')
      ? uploadUrl
      : `${this.baseUrl}${uploadUrl.startsWith('/') ? '' : '/'}${uploadUrl}`;

    const headers: Record<string, string> = {};
    if (!uploadUrl.startsWith('http')) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    return this.retryUpload(async (): Promise<UploadAttemptResult> => {
      const formData = new FormData();
      for (const [key, value] of Object.entries(form)) {
        formData.append(key, String(value));
      }
      formData.append('file', new Blob([fileData], { type: contentType }), 'upload');

      // AbortController actually cancels a stalled request, rather than just
      // giving up on waiting for it -- see UPLOAD_TIMEOUT_MS.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.uploadTimeoutMs);
      try {
        const res = await fetch(absoluteUrl, {
          method: 'POST',
          headers,
          body: formData,
          signal: controller.signal,
        });
        if (res.ok) return { ok: true };
        const body = await res.text().catch(() => '');
        return {
          ok: false,
          status: res.status,
          message: `${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
        };
      } catch (e) {
        if (controller.signal.aborted) {
          return {
            ok: false,
            message: `timed out after ${Math.round(this.uploadTimeoutMs / 1000)}s (stalled connection)`,
          };
        }
        // getErrorMessage unwraps `cause`, where Node's fetch hides the real
        // transport error behind the bare string "fetch failed".
        return { ok: false, message: getErrorMessage(e) };
      } finally {
        clearTimeout(timer);
      }
    }, `attachment upload to ${absoluteUrl}`);
  }
}
