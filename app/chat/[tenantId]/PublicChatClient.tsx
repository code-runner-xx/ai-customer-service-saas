'use client';

import { useEffect, useState } from 'react';
import { nanoid } from 'nanoid';
import type { Message } from 'ai';
import ChatWindow from '@/components/chat/ChatWindow';

interface Props {
  tenantId: string;
}

// 对齐 GET /api/chat/history 返回结构
interface HistoryResponse {
  messages: Message[];
  sessionId: string | null;
}

export default function PublicChatClient({ tenantId }: Props) {
  const [visitorId, setVisitorId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);

  useEffect(() => {
    // 必须在 useEffect 里读写 localStorage,避免 SSR 阶段访问 window 报错
    let id = localStorage.getItem('aics_visitor_id');
    if (!id) {
      id = nanoid();
      localStorage.setItem('aics_visitor_id', id);
    }
    setVisitorId(id);
  }, []);

  useEffect(() => {
    if (!visitorId) return;
    // Step 17 方向 A:visitorId 就绪后拉一次历史。
    // useChat v4 的 initialMessages 不是响应式的,只在挂载时读一次,
    // 所以必须等 history 结果就绪后再挂载 ChatWindow —— fetch 未完成期间继续占位。
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/chat/history?tenantId=${encodeURIComponent(tenantId)}&visitorId=${encodeURIComponent(visitorId)}`,
        );
        if (!res.ok) {
          // 429 / 500 等非 2xx 一律降级为"无历史",用户至少能开始新对话
          if (!cancelled) setHistory({ messages: [], sessionId: null });
          return;
        }
        const json = (await res.json()) as HistoryResponse;
        if (!cancelled) setHistory(json);
      } catch {
        // 网络异常也降级为"无历史"
        if (!cancelled) setHistory({ messages: [], sessionId: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visitorId, tenantId]);

  if (visitorId === null || history === null) {
    // visitorId 或 history 未就绪,占位 —— 避免 ChatWindow 在 initialMessages 未定时先挂一次
    return <div className="h-full" />;
  }

  return (
    <div className="h-full">
      <ChatWindow
        tenantId={tenantId}
        mode="public"
        visitorId={visitorId}
        initialMessages={history.messages}
        initialSessionId={history.sessionId ?? undefined}
      />
    </div>
  );
}
