export type AnalyzeResult = {
  doc_id: string;
  valueFlag: "YES" | "NO" | "UNCERTAIN";
  signals: string[];
  score: number;
  page_count: number;
  text_length: number;
};

export type TriggerResult = {
  doc_id: string;
  actionable: boolean;
  title: string | null;
  action: string | null;
  reason: string | null;
};

export type ActionResult = {
  doc_id: string;
  action: string;
  result_url: string | null;
  preview: string | null;
  value_created: boolean;
};

export type UploadResult = {
  doc_id: string;
  file_name: string;
  page_count: number;
  size: number;
};

export type PageState =
  | "upload"
  | "analyzing"
  | "result"
  | "action"
  | "executing"
  | "done"
  | "error";
