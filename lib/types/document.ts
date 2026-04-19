export type DocumentStatus = "processing" | "ready" | "failed";
export type DocumentContentType = "pdf" | "txt" | "docx" | "url";

export interface DocumentRow {
  id: string;
  title: string;
  content_type: DocumentContentType;
  source_url: string | null;
  status: DocumentStatus;
  char_count: number | null;
  chunk_count: number | null;
  error_message: string | null;
  created_at: string;
}
