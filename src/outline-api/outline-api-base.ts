import { configure, type Transport } from './custom-instance';
import {
  authInfo,
  collectionsList,
  documentsInfo,
  documentsCreate,
  documentsUpdate,
  documentsSearch,
  attachmentsCreate,
} from './generated-client/outlineAPI';
import type { Collection, Document, AttachmentsCreate200Data } from './generated-client/outlineAPI';
import type { IOutlineApi, AuthCheck } from './types';
import { getErrorMessage } from '../utils/errors';

export type { Collection, Document, AttachmentsCreate200Data };
export type { AuthCheck };

/**
 * Builds an error that names the endpoint, the status and the server's own
 * message, so a caller can report the real cause. Returning `null` here
 * instead is what made a rate-limited bulk push undiagnosable.
 */
function apiError(endpoint: string, status: number, data: unknown): Error {
  const detail =
    data && typeof data === 'object' && 'message' in data
      ? String((data as { message: unknown }).message)
      : '';
  return new Error(`[Outline API] ${status} on ${endpoint}${detail ? `: ${detail}` : ''}`);
}

export abstract class OutlineApiBase implements IOutlineApi {
  protected baseUrl: string;
  protected apiKey: string;

  constructor(baseUrl: string, apiKey: string, transport?: Transport) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    configure({ baseUrl: this.baseUrl, apiKey: this.apiKey, transport });
  }

  /**
   * Checks the connection and reports *why* it failed.
   *
   * The old version returned 'Unknown' whenever a 200 came back, so an access
   * proxy answering with an HTML login page read as a successful connection.
   * Presence of the user object -- not the status code -- is what proves we
   * actually reached Outline.
   */
  async checkConnection(): Promise<AuthCheck> {
    let res;
    try {
      res = await authInfo();
    } catch (e) {
      return {
        ok: false,
        reason: `Could not reach the server: ${getErrorMessage(e)}`,
      };
    }

    if ((res as { parseFailed?: boolean }).parseFailed) {
      return {
        ok: false,
        reason:
          'The server replied, but not with JSON. Something other than Outline answered — ' +
          'usually an access proxy or SSO login page in front of the API.',
      };
    }
    // The generated client narrows `status` to the documented codes, but any
    // HTTP status can arrive in practice.
    const status: number = res.status;
    if (status === 401 || status === 403) {
      return { ok: false, reason: 'Outline rejected the API key (unauthorized).' };
    }
    if (status !== 200) {
      return { ok: false, reason: `Outline returned HTTP ${status}.` };
    }

    // Checking `status` through a local widened to `number` loses the union
    // narrowing on `data`, so reassert the success shape here.
    const body = res.data as { data?: { user?: { name?: string } } } | undefined;
    const user = body?.data?.user;
    if (!user) {
      return {
        ok: false,
        reason: 'Got a 200 with no user in the response — this does not look like Outline.',
      };
    }
    return { ok: true, user: user.name ?? 'Unknown' };
  }

  async validateAuth(): Promise<string | null> {
    const result = await this.checkConnection();
    return result.ok ? result.user : null;
  }

  async listCollections(): Promise<Collection[] | null> {
    try {
      const res = await collectionsList({ limit: 100 });
      if (res.status !== 200) return null;
      return res.data.data ?? null;
    } catch {
      return null;
    }
  }

  async getDocument(id: string): Promise<Document | null> {
    try {
      const res = await documentsInfo({ id });
      if (res.status !== 200) return null;
      return res.data.data ?? null;
    } catch {
      return null;
    }
  }

  async createDocument(params: {
    title: string;
    text: string;
    collectionId: string;
    publish: boolean;
    parentDocumentId?: string;
  }): Promise<Document | null> {
    const res = await documentsCreate(params);
    if (res.status !== 200) throw apiError('/documents.create', res.status, res.data);
    return res.data.data ?? null;
  }

  async updateDocument(params: {
    id: string;
    title: string;
    text: string;
    publish: boolean;
  }): Promise<Document | null> {
    const res = await documentsUpdate(params);
    if (res.status !== 200) throw apiError('/documents.update', res.status, res.data);
    return res.data.data ?? null;
  }

  async searchDocumentByTitle(
    title: string,
    collectionId: string,
    parentDocumentId?: string
  ): Promise<Document | null> {
    try {
      const res = await documentsSearch({
        query: title,
        collectionId,
        limit: 25,
      });
      if (res.status !== 200) return null;
      const exact = res.data.data?.find(
        (r) =>
          r.document?.title?.toLowerCase() === title.toLowerCase() &&
          (r.document?.parentDocumentId ?? undefined) === parentDocumentId
      );
      return exact?.document ?? null;
    } catch {
      return null;
    }
  }

  async createAttachment(params: {
    name: string;
    contentType: string;
    size: number;
    documentId?: string;
  }): Promise<AttachmentsCreate200Data | null> {
    // Unlike a document write this degrades rather than throws: a note whose
    // audio could not be reserved is still worth publishing. The reason is
    // logged so a failed upload is diagnosable instead of a silent "0/1".
    try {
      const res = await attachmentsCreate(params);
      if (res.status !== 200) {
        console.error(apiError('/attachments.create', res.status, res.data).message);
        return null;
      }
      return res.data.data ?? null;
    } catch (e) {
      console.error(
        `[Outline API] /attachments.create failed for ${params.name}: ${getErrorMessage(e)}`
      );
      return null;
    }
  }

  abstract uploadAttachmentToStorage(
    uploadUrl: string,
    form: Record<string, unknown>,
    fileData: ArrayBuffer,
    contentType: string
  ): Promise<boolean>;
}
