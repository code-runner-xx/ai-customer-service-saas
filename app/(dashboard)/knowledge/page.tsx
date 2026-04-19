"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import type { DocumentRow, DocumentStatus } from "@/lib/types/document";

type FilterValue = "all" | DocumentStatus;

const FILTER_TABS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "processing", label: "处理中" },
  { value: "ready", label: "就绪" },
  { value: "failed", label: "失败" },
];

function getStatusBadge(status: DocumentStatus): {
  variant: "default" | "secondary" | "destructive" | "outline";
  label: string;
} {
  switch (status) {
    case "ready":
      return { variant: "default", label: "就绪" };
    case "processing":
      return { variant: "secondary", label: "处理中" };
    case "failed":
      return { variant: "destructive", label: "失败" };
  }
}

function getContentTypeLabel(contentType: DocumentRow["content_type"]): string {
  switch (contentType) {
    case "pdf":
      return "PDF";
    case "txt":
      return "TXT";
    case "docx":
      return "Word";
    case "url":
      return "网页";
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function KnowledgePage() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterValue>("all");
  const [deleteTarget, setDeleteTarget] = useState<DocumentRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const fetchDocuments = useCallback(async (): Promise<DocumentRow[]> => {
    const res = await fetch("/api/documents", { cache: "no-store" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `加载失败:HTTP ${res.status}`);
    }
    const body = (await res.json()) as { documents: DocumentRow[] };
    return body.documents;
  }, []);

  const scheduleNext = useCallback(
    (docs: DocumentRow[]) => {
      if (!mountedRef.current) return;
      const hasProcessing = docs.some((d) => d.status === "processing");
      if (!hasProcessing) return;
      timerRef.current = setTimeout(async () => {
        try {
          const next = await fetchDocuments();
          if (!mountedRef.current) return;
          setDocuments(next);
          scheduleNext(next);
        } catch {
          // 轮询失败静默,下一次交互再重试
        }
      }, 5000);
    },
    [fetchDocuments],
  );

  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      try {
        const docs = await fetchDocuments();
        if (!mountedRef.current) return;
        setDocuments(docs);
        scheduleNext(docs);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "加载失败");
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    })();

    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [fetchDocuments, scheduleNext]);

  const filtered = useMemo(() => {
    if (filter === "all") return documents;
    return documents.filter((d) => d.status === filter);
  }, [documents, filter]);

  const counts = useMemo(
    () => ({
      all: documents.length,
      processing: documents.filter((d) => d.status === "processing").length,
      ready: documents.filter((d) => d.status === "ready").length,
      failed: documents.filter((d) => d.status === "failed").length,
    }),
    [documents],
  );

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/documents/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (res.status === 204) {
        setDocuments((prev) => prev.filter((d) => d.id !== deleteTarget.id));
        toast.success(`已删除「${deleteTarget.title}」`);
        setDeleteTarget(null);
      } else {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(body.error ?? `删除失败:HTTP ${res.status}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">知识库</h1>
          <p className="text-muted-foreground text-sm mt-1">
            管理用于 AI 客服问答的文档,支持 PDF / TXT / 网址
          </p>
        </div>
        <Link
          href="/knowledge/upload"
          className={buttonVariants({ variant: "default" })}
        >
          <Upload className="size-4" />
          上传文档
        </Link>
      </div>

      <Tabs
        value={filter}
        onValueChange={(v) => setFilter(v as FilterValue)}
      >
        <TabsList>
          {FILTER_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
              {!loading && counts[t.value] > 0 && (
                <Badge
                  variant="secondary"
                  className="ml-1.5 px-1.5 py-0 text-xs"
                >
                  {counts[t.value]}
                </Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        {FILTER_TABS.map((t) => (
          <TabsContent key={t.value} value={t.value} className="mt-4">
            <div className="rounded-lg border bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>标题</TableHead>
                    <TableHead className="w-20">类型</TableHead>
                    <TableHead className="w-24">状态</TableHead>
                    <TableHead className="w-20 text-right">Chunks</TableHead>
                    <TableHead className="w-44">创建时间</TableHead>
                    <TableHead className="w-16 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    // 骨架屏：4 行灰色占位动画，替代纯文字"加载中"
                    Array.from({ length: 4 }).map((_, i) => (
                      <TableRow key={i}>
                        <TableCell>
                          <div className="h-4 animate-pulse rounded bg-muted w-3/4" />
                        </TableCell>
                        <TableCell>
                          <div className="h-4 animate-pulse rounded bg-muted w-10" />
                        </TableCell>
                        <TableCell>
                          <div className="h-4 animate-pulse rounded bg-muted w-14" />
                        </TableCell>
                        <TableCell>
                          <div className="h-4 animate-pulse rounded bg-muted w-8 ml-auto" />
                        </TableCell>
                        <TableCell>
                          <div className="h-4 animate-pulse rounded bg-muted w-32" />
                        </TableCell>
                        <TableCell />
                      </TableRow>
                    ))
                  ) : filtered.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-16">
                        {documents.length === 0 ? (
                          // 全局空状态：图标 + 说明文案 + 上传按钮
                          <div className="flex flex-col items-center gap-3 text-center">
                            <FileText className="size-10 text-muted-foreground/50" />
                            <div>
                              <p className="font-medium text-foreground">
                                还没有文档
                              </p>
                              <p className="text-sm text-muted-foreground mt-0.5">
                                上传第一份文档，开始构建你的知识库
                              </p>
                            </div>
                            <Link
                              href="/knowledge/upload"
                              className={buttonVariants({
                                variant: "default",
                                size: "sm",
                              })}
                            >
                              <Upload className="mr-1.5 size-3.5" />
                              上传文档
                            </Link>
                          </div>
                        ) : (
                          // 筛选后空状态：简单文字即可
                          <p className="text-center text-muted-foreground">
                            当前筛选下没有文档
                          </p>
                        )}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filtered.map((doc) => {
                      const badge = getStatusBadge(doc.status);
                      return (
                        <TableRow key={doc.id}>
                          <TableCell className="max-w-[280px] truncate font-medium">
                            {doc.source_url ? (
                              <a
                                href={doc.source_url}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:underline"
                              >
                                {doc.title}
                              </a>
                            ) : (
                              doc.title
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {getContentTypeLabel(doc.content_type)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={badge.variant}
                              title={
                                doc.status === "failed" && doc.error_message
                                  ? doc.error_message
                                  : undefined
                              }
                            >
                              {badge.label}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {doc.chunk_count ?? 0}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatDate(doc.created_at)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => setDeleteTarget(doc)}
                              aria-label="删除"
                            >
                              <Trash2 className="size-4 text-destructive" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        ))}
      </Tabs>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除文档</DialogTitle>
            <DialogDescription>
              将永久删除「{deleteTarget?.title}」及其所有 chunks(
              {deleteTarget?.chunk_count ?? 0} 条),此操作不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
              disabled={deleting}
            >
              {deleting ? "删除中…" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
