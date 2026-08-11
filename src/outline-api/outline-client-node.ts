import { OutlineApiBase, type UploadAttemptResult } from './outline-api-base';
import { getErrorMessage } from '../utils/errors';

export class OutlineClientNode extends OutlineApiBase {
  constructor(baseUrl: string, apiKey: string) {
    super(baseUrl, apiKey);
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

      try {
        const res = await fetch(absoluteUrl, { method: 'POST', headers, body: formData });
        if (res.ok) return { ok: true };
        const body = await res.text().catch(() => '');
        return {
          ok: false,
          status: res.status,
          message: `${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
        };
      } catch (e) {
        // getErrorMessage unwraps `cause`, where Node's fetch hides the real
        // transport error behind the bare string "fetch failed".
        return { ok: false, message: getErrorMessage(e) };
      }
    }, `attachment upload to ${absoluteUrl}`);
  }
}
