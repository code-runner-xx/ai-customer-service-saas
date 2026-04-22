import { z } from "zod";

// Step 19 (h):Vercel Hobby 请求体上限 4.5MB(含 multipart 开销),故前后端统一按此值。
// 换付费 plan 或走 Blob 直传可放宽,属架构级改动不在本 Step 范围。
export const MAX_FILE_SIZE = 4.5 * 1024 * 1024; // 4.5MB
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
