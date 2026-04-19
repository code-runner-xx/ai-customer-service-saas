"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ArrowLeft, FileText, Link2, UploadCloud } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_EXTS = ["pdf", "txt", "docx"] as const;
// input accept 和 drop 判定的 MIME/后缀白名单
const FILE_ACCEPT =
  ".pdf,.txt,.docx,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function getExt(name: string): string | null {
  const m = name.toLowerCase().match(/\.([^.]+)$/);
  return m ? m[1] : null;
}

function isAllowedFile(file: File): { ok: true } | { ok: false; reason: string } {
  // 显式识别老版 .doc 单独给提示(上游 API 也拦了一遍,前端早拦省得浪费一次请求)
  if (/\.doc$/i.test(file.name)) {
    return {
      ok: false,
      reason: "暂不支持 .doc 老格式,请在 Word 中另存为 .docx 后上传",
    };
  }
  const ext = getExt(file.name);
  if (!ext || !(ALLOWED_EXTS as readonly string[]).includes(ext)) {
    return { ok: false, reason: "仅支持 .pdf / .txt / .docx 文件" };
  }
  if (file.size === 0) {
    return { ok: false, reason: "文件为空" };
  }
  if (file.size > MAX_FILE_SIZE) {
    return {
      ok: false,
      reason: `文件过大,最大 ${MAX_FILE_SIZE / 1024 / 1024}MB`,
    };
  }
  return { ok: true };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export default function KnowledgeUploadPage() {
  const router = useRouter();

  // File tab state
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileUploading, setFileUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // URL tab state
  const [url, setUrl] = useState("");
  const [urlUploading, setUrlUploading] = useState(false);

  const handleFile = (picked: File | null | undefined) => {
    if (!picked) return;
    const check = isAllowedFile(picked);
    if (!check.ok) {
      toast.error(check.reason);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setFile(picked);
  };

  const handleFileSubmit = async () => {
    if (!file) return;
    setFileUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/ingest/file", {
        method: "POST",
        body: fd,
      });
      const body = (await res.json().catch(() => ({}))) as {
        id?: string;
        status?: string;
        chunkCount?: number;
        error?: string;
      };
      if (!res.ok) {
        toast.error(body.error ?? `上传失败:HTTP ${res.status}`);
        return;
      }
      toast.success(`已上传「${file.name}」,切出 ${body.chunkCount ?? 0} 个片段`);
      router.push("/knowledge");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上传失败");
    } finally {
      setFileUploading(false);
    }
  };

  const handleUrlSubmit = async () => {
    if (!url.trim()) return;
    setUrlUploading(true);
    try {
      const res = await fetch("/api/ingest/url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        id?: string;
        status?: string;
        chunkCount?: number;
        error?: string;
      };
      if (!res.ok) {
        toast.error(body.error ?? `抓取失败:HTTP ${res.status}`);
        return;
      }
      toast.success(`已抓取网页,切出 ${body.chunkCount ?? 0} 个片段`);
      router.push("/knowledge");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "抓取失败");
    } finally {
      setUrlUploading(false);
    }
  };

  const fileSubmitDisabled = !file || fileUploading;
  const urlValid = /^https?:\/\//i.test(url.trim());
  const urlSubmitDisabled = !urlValid || urlUploading;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <Link
          href="/knowledge"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          返回知识库
        </Link>
        <h1 className="text-2xl font-semibold mt-2">上传文档</h1>
        <p className="text-muted-foreground text-sm mt-1">
          上传后系统会自动切块并生成向量,通常几秒内完成
        </p>
      </div>

      <Tabs defaultValue="file">
        <TabsList>
          <TabsTrigger value="file">
            <FileText className="size-4" />
            文件
          </TabsTrigger>
          <TabsTrigger value="url">
            <Link2 className="size-4" />
            网址
          </TabsTrigger>
        </TabsList>

        <TabsContent value="file" className="mt-4 space-y-4">
          <label
            htmlFor="upload-file-input"
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const dropped = e.dataTransfer.files?.[0];
              handleFile(dropped);
            }}
            className={cn(
              "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed bg-background p-10 text-center cursor-pointer transition-colors",
              dragOver
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-muted/50",
            )}
          >
            <UploadCloud className="size-8 text-muted-foreground" />
            <div className="text-sm">
              <span className="font-medium">点击选择文件</span>
              <span className="text-muted-foreground"> 或拖拽到此处</span>
            </div>
            <div className="text-xs text-muted-foreground">
              支持 PDF、Word(.docx)、TXT,最大 10MB
            </div>
            <div className="text-xs text-muted-foreground/80">
              暂不支持 .doc 老格式和扫描件 PDF(图像 PDF)
            </div>
            <input
              id="upload-file-input"
              ref={fileInputRef}
              type="file"
              accept={FILE_ACCEPT}
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
          </label>

          {file ? (
            <div className="flex items-center justify-between rounded-md border bg-muted/30 p-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{file.name}</div>
                <div className="text-xs text-muted-foreground">
                  {formatSize(file.size)}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFile(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                disabled={fileUploading}
              >
                移除
              </Button>
            </div>
          ) : null}

          <Button
            onClick={handleFileSubmit}
            disabled={fileSubmitDisabled}
            size="lg"
          >
            {fileUploading ? "上传中…" : "开始上传"}
          </Button>
        </TabsContent>

        <TabsContent value="url" className="mt-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="upload-url-input">网页 URL</Label>
            <Input
              id="upload-url-input"
              type="url"
              placeholder="https://example.com/article"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={urlUploading}
            />
            <p className="text-xs text-muted-foreground">
              系统会抓取网页正文(去除脚本、导航、页脚等),再切块入库
            </p>
          </div>
          <Button
            onClick={handleUrlSubmit}
            disabled={urlSubmitDisabled}
            size="lg"
          >
            {urlUploading ? "抓取中…" : "开始抓取"}
          </Button>
        </TabsContent>
      </Tabs>
    </div>
  );
}
