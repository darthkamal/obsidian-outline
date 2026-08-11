/**
 * Re-exports generated types and defines the IOutlineApi abstraction.
 *
 * Uses the Orval-generated types directly so that client implementations
 * can return API responses without type coercion.
 */

import type {
  Collection,
  Document,
  Attachment,
  AttachmentsCreate200Data,
} from './generated-client/outlineAPI';

export type { Collection, Document, Attachment, AttachmentsCreate200Data };

/** Result of a connection check, carrying the failure reason for the UI. */
export type AuthCheck = { ok: true; user: string } | { ok: false; reason: string };

export interface IOutlineApi {
  /** Returns the authenticated user's name, or null on failure. */
  validateAuth(): Promise<string | null>;
  /** Same check as validateAuth, but explains what went wrong. */
  checkConnection(): Promise<AuthCheck>;
  listCollections(): Promise<Collection[] | null>;
  getDocument(id: string): Promise<Document | null>;
  createDocument(params: {
    title: string;
    text: string;
    collectionId: string;
    publish: boolean;
    parentDocumentId?: string;
  }): Promise<Document | null>;
  updateDocument(params: {
    id: string;
    title: string;
    text: string;
    publish: boolean;
  }): Promise<Document | null>;
  searchDocumentByTitle(
    title: string,
    collectionId: string,
    parentDocumentId?: string
  ): Promise<Document | null>;
  createAttachment(params: {
    name: string;
    contentType: string;
    size: number;
    documentId?: string;
  }): Promise<AttachmentsCreate200Data | null>;
  uploadAttachmentToStorage(
    uploadUrl: string,
    form: Record<string, unknown>,
    fileData: ArrayBuffer,
    contentType: string
  ): Promise<boolean>;
}
