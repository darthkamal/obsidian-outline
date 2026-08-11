import { OutlineApiBase } from './outline-api-base';
import { getErrorMessage } from '../utils/errors';

/**
 * A single attempt loses an upload to any transient transport problem, and
 * attachments are not routed through customInstance's retry.
 *
 * Retrying does not rescue an upload that is simply too slow to finish: over a
 * ~1 Mbit link a 14MB attachment exceeds the server's timeout on every attempt.
 * That is a network condition to fix at the network, not here.
 */
const UPLOAD_ATTEMPTS = 3;
/** Multiplied by the attempt number; a dropped socket recovers quickly. */
const UPLOAD_RETRY_DELAY_MS = 500;

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

    const formData = new FormData();
    for (const [key, value] of Object.entries(form)) {
      formData.append(key, String(value));
    }
    formData.append('file', new Blob([fileData], { type: contentType }), 'upload');

    const headers: Record<string, string> = {};
    if (!uploadUrl.startsWith('http')) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    // Reporting stays here rather than throwing: a note whose audio failed is
    // still worth publishing. But a bare `false` made six lost uploads in a
    // real run indistinguishable from a size limit, a 429, or a dropped socket.
    for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
      const last = attempt === UPLOAD_ATTEMPTS;
      try {
        const res = await fetch(absoluteUrl, {
          method: 'POST',
          headers,
          body: formData,
        });
        if (res.ok) return true;

        // A refusal is a decision, not a hiccup: retrying will not change it.
        const body = await res.text().catch(() => '');
        console.error(
          `[Outline API] ${res.status} uploading attachment to ${absoluteUrl}` +
            (body ? `: ${body.slice(0, 200)}` : '')
        );
        return false;
      } catch (e) {
        // getErrorMessage unwraps `cause`, where Node's fetch hides the real
        // transport error behind the bare string "fetch failed".
        const detail = getErrorMessage(e);
        if (last) {
          console.error(
            `[Outline API] attachment upload to ${absoluteUrl} failed ` +
              `after ${UPLOAD_ATTEMPTS} attempts: ${detail}`
          );
          return false;
        }
        console.warn(
          `[Outline API] attachment upload to ${absoluteUrl} failed ` +
            `(attempt ${attempt}/${UPLOAD_ATTEMPTS}): ${detail}; retrying`
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * UPLOAD_RETRY_DELAY_MS));
      }
    }
    return false;
  }
}
