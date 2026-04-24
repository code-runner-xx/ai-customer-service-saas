'use client';

import { useChat } from '@ai-sdk/react';
import type { Message } from 'ai';
import { useRef, useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { SendHorizonal, Loader2, MessageCircleQuestion } from 'lucide-react';

// ---------- Citation 类型 ----------
interface Citation {
  index: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  similarity: number;
}

// ---------- Props ----------
interface ChatWindowProps {
  tenantId: string;
  mode: 'playground' | 'public';
  visitorId?: string;
  // Step 17 方向 A:C 端匿名历史恢复时传入;playground 模式不用(刷新后无历史)
  initialMessages?: Message[];
  initialSessionId?: string;
}

// ---------- 子组件:空状态 ----------
function EmptyState({ mode }: { mode: 'playground' | 'public' }) {
  if (mode === 'public') {
    // 副标题的免责文案已搬家到输入框下方常驻(见主组件底部),这里只保留图标 + 问候语
    return (
      <div className="flex flex-col items-center justify-center h-full py-16 gap-2">
        <MessageCircleQuestion className="size-10 text-muted-foreground/60" />
        <p className="text-base font-medium text-foreground">您好，请问有什么可以帮您？</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center h-full py-16 gap-2">
      <p className="text-base font-medium text-foreground">试着问一个问题</p>
      <p className="text-sm text-muted-foreground">
        回答会基于你已上传到知识库的内容
      </p>
    </div>
  );
}

// ---------- 子组件:单条消息气泡 ----------
function MessageBubble({
  role,
  content,
}: {
  role: string;
  content: string;
}) {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm break-words ${
          isUser
            ? 'bg-accent-brand text-accent-brand-fg rounded-br-sm whitespace-pre-wrap'
            : 'bg-muted text-foreground rounded-bl-sm'
        }`}
      >
        {isUser ? (
          content
        ) : (
          // AI 消息用 react-markdown 渲染，支持加粗、列表、代码块、链接等
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => (
                <p className="leading-relaxed mb-2 last:mb-0">{children}</p>
              ),
              ul: ({ children }) => (
                <ul className="list-disc pl-4 space-y-0.5 mb-2 last:mb-0">{children}</ul>
              ),
              ol: ({ children }) => (
                <ol className="list-decimal pl-4 space-y-0.5 mb-2 last:mb-0">{children}</ol>
              ),
              li: ({ children }) => <li>{children}</li>,
              strong: ({ children }) => (
                <strong className="font-semibold">{children}</strong>
              ),
              em: ({ children }) => <em className="italic">{children}</em>,
              a: ({ href, children }) => (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:opacity-80"
                >
                  {children}
                </a>
              ),
              pre: ({ children }) => (
                <pre className="overflow-x-auto rounded-md bg-background/50 px-3 py-2 my-1.5 font-mono text-xs">
                  {children}
                </pre>
              ),
              code: ({ className, children }) => {
                // 代码块（fenced code）有 language-xxx className；内联代码没有
                const isBlock = Boolean(className?.startsWith('language-'));
                if (!isBlock) {
                  return (
                    <code className="rounded bg-background/50 px-1 py-0.5 font-mono text-xs">
                      {children}
                    </code>
                  );
                }
                return (
                  <code className={`font-mono ${className ?? ''}`}>
                    {children}
                  </code>
                );
              },
            }}
          >
            {content}
          </ReactMarkdown>
        )}
      </div>
    </div>
  );
}

// ---------- 子组件:citations 可展开 chip 列表 ----------
// 每个来源独立 toggle，多个可同时展开
function CitationsList({ citations }: { citations: Citation[] }) {
  const [openSet, setOpenSet] = useState<Set<number>>(new Set());

  const toggle = (index: number) => {
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div className="mt-2 ml-1 max-w-[75%] space-y-1.5">
      {/* chip 行 */}
      <div className="flex flex-wrap gap-1.5">
        {citations.map((c) => {
          const isOpen = openSet.has(c.index);
          return (
            <button
              key={c.chunkId}
              type="button"
              onClick={() => toggle(c.index)}
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                isOpen
                  ? 'border-accent-brand/30 bg-accent-brand/[0.06] text-accent-brand'
                  : 'border-border bg-[oklch(0.985_0_0)] text-muted-foreground hover:border-accent-brand/30 hover:text-foreground'
              }`}
            >
              来源 {c.index}
            </button>
          );
        })}
      </div>

      {/* 展开内容：按 index 顺序渲染，保持稳定排列 */}
      {citations
        .filter((c) => openSet.has(c.index))
        .map((c) => (
          <div
            key={c.chunkId}
            className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs"
          >
            <div className="mb-1 flex items-baseline gap-2">
              <span className="font-medium text-foreground">
                [来源 {c.index}]&nbsp;{c.documentTitle}
              </span>
              <span className="text-muted-foreground/70">
                相似度 {(c.similarity * 100).toFixed(0)}%
              </span>
            </div>
            <p className="leading-relaxed text-muted-foreground">
              {c.content.length > 280
                ? `${c.content.slice(0, 280)}…`
                : c.content}
            </p>
          </div>
        ))}
    </div>
  );
}

// ---------- 主组件 ----------
export default function ChatWindow({
  tenantId,
  mode,
  visitorId,
  initialMessages,
  initialSessionId,
}: ChatWindowProps) {
  // 跨请求复用 sessionId;Step 17 历史恢复时接收 initialSessionId,
  // 让后续新消息继续写入同一 session(否则刷新后发新消息会开新 session,下次刷新又看不到)
  const sessionIdRef = useRef<string | undefined>(initialSessionId);
  // 提交前保存 input,供 status=error 时还原
  const lastInputRef = useRef('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const {
    messages,
    data,
    status,
    input,
    handleInputChange,
    handleSubmit,
    setInput,
  } = useChat({
    api: '/api/chat',
    // Step 17:方向 A 历史回填(useChat v4 的 initialMessages 仅在首次挂载时读一次,非响应式)
    initialMessages,
    experimental_prepareRequestBody: ({ messages: msgs }) => ({
      messages: msgs.map((m) => ({ role: m.role, content: m.content })),
      tenantId,
      ...(visitorId ? { visitorId } : {}),
      sessionId: sessionIdRef.current,
    }),
    onError: (err) => {
      // 尝试解析 JSON 错误体（如 429 速率限制返回 {"error":"..."}）
      let message = err.message || '对话请求失败，请稍后重试';
      try {
        const parsed = JSON.parse(err.message) as unknown;
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'error' in parsed &&
          typeof (parsed as Record<string, unknown>).error === 'string'
        ) {
          message = (parsed as Record<string, string>).error;
        }
      } catch {
        // 非 JSON，直接用原始 message
      }
      toast.error(message);
    },
  });

  // 从 data parts 里取最新 sessionId 存到 ref
  useEffect(() => {
    if (!data?.length) return;
    for (let i = data.length - 1; i >= 0; i--) {
      const d = data[i];
      if (
        typeof d === 'object' &&
        d !== null &&
        !Array.isArray(d) &&
        (d as Record<string, unknown>).type === 'session' &&
        typeof (d as Record<string, unknown>).sessionId === 'string'
      ) {
        sessionIdRef.current = (d as Record<string, unknown>).sessionId as string;
        break;
      }
    }
  }, [data]);

  // status=error 时还原上次未发出的输入
  useEffect(() => {
    if (status === 'error' && lastInputRef.current) {
      setInput(lastInputRef.current);
    }
  }, [status, setInput]);

  // 新消息进来时自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 从 data parts 里取最新 citations
  const latestCitations: Citation[] = (() => {
    if (!data?.length) return [];
    for (let i = data.length - 1; i >= 0; i--) {
      const d = data[i];
      if (
        typeof d === 'object' &&
        d !== null &&
        !Array.isArray(d) &&
        (d as Record<string, unknown>).type === 'citations'
      ) {
        const cits = (d as Record<string, unknown>).citations;
        if (Array.isArray(cits)) return cits as Citation[];
      }
    }
    return [];
  })();

  const isStreaming = status === 'submitted' || status === 'streaming';

  // 统一提交入口:保存 input,再交给 useChat
  const submit = useCallback(
    (e?: { preventDefault?: () => void }) => {
      if (!input.trim() || isStreaming) return;
      lastInputRef.current = input;
      handleSubmit(e);
    },
    [input, isStreaming, handleSubmit],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // playground 模式顶部提示条
  const showBanner = mode === 'playground';

  return (
    <div className="flex flex-col h-full">
      {/* 顶部提示条(仅 playground) */}
      {showBanner && (
        <div className="shrink-0 border-b bg-muted/40 px-4 py-2.5 text-sm text-muted-foreground">
          这是知识库问答测试环境。回答严格基于你在知识库中上传的文档,引用以&nbsp;[来源&nbsp;N]&nbsp;形式标注。
        </div>
      )}

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 ? (
          <EmptyState mode={mode} />
        ) : (
          messages.map((message, i) => {
            const isLastAssistant =
              message.role === 'assistant' && i === messages.length - 1;
            // code-review(Step 17):citations 空时(拒答 / 未加载 / 历史回填的老消息)
            // latestCitations.length === 0 → showCitations=false → 不渲染空 chip 容器,无空白留痕
            const showCitations =
              isLastAssistant && latestCitations.length > 0;
            return (
              <div key={message.id}>
                <MessageBubble
                  role={message.role}
                  content={
                    typeof message.content === 'string' ? message.content : ''
                  }
                />
                {showCitations && (
                  <CitationsList citations={latestCitations} />
                )}
              </div>
            );
          })
        )}
        {/* 流式输出时在末尾显示加载指示 */}
        {isStreaming &&
          (messages.length === 0 ||
            messages[messages.length - 1]?.role === 'user') && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-2xl rounded-bl-sm px-4 py-2.5">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            </div>
          )}
        <div ref={messagesEndRef} />
      </div>

      {/* 输入区域 */}
      <div className="shrink-0 border-t bg-background px-4 py-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(e);
          }}
          className="flex items-end gap-2"
        >
          <Textarea
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="发送消息… (Shift+Enter 换行)"
            disabled={isStreaming}
            rows={1}
            className="min-h-10 max-h-24 resize-none py-2"
          />
          <Button
            type="submit"
            size="icon"
            disabled={isStreaming || !input.trim()}
            className="shrink-0 bg-accent-brand text-accent-brand-fg hover:bg-accent-brand/90"
          >
            {isStreaming ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <SendHorizonal className="size-4" />
            )}
          </Button>
        </form>
        {/* C 端常驻免责文案:从 EmptyState 副标题搬家至此,保证首轮消息后仍可见 */}
        {mode === 'public' && (
          <p className="mt-1.5 px-2 text-xs text-[oklch(0.708_0_0)]">
            回答基于产品知识库,如需人工服务请联系客服。
          </p>
        )}
      </div>
    </div>
  );
}
