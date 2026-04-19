import { z } from "zod";

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const MIN_TEXT_LENGTH = 20;
export const CHUNK_INSERT_BATCH = 100;

export const ALLOWED_FILE_EXTENSIONS = ["pdf", "txt", "docx"] as const;
export type AllowedExt = (typeof ALLOWED_FILE_EXTENSIONS)[number];

export const ingestUrlSchema = z.object({
  url: z
    .string()
    .url("请输入合法的 URL")
    .refine((u) => /^https?:\/\//i.test(u), {
      message: "URL 必须是 http 或 https 协议",
    }),
});

export type IngestUrlInput = z.infer<typeof ingestUrlSchema>;

export const uuidSchema = z.string().uuid("非法的 UUID");
