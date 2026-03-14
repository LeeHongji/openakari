/** Slack file upload types. Kept separate from slack.ts for import clarity. */

export interface FileUpload {
  buffer: Buffer;
  filename?: string;
  title?: string;
  altText?: string;
}

/** @deprecated Use FileUpload instead. */
export type ImageUpload = FileUpload;

export interface UploadResult {
  ok: boolean;
  count: number;
  error?: string;
}
