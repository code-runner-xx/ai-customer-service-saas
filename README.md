# AI 客服知识库 SaaS

企业级多租户 AI 知识库 + 智能客服 SaaS MVP。企业主上传私有文档，系统自动切块向量化；终端用户通过公开链接或嵌入 Widget 与 AI 客服对话，回答严格基于 RAG 检索，引用原文不编造。

---

## 功能亮点

- **文档上传自动向量化**：支持 PDF / TXT / 网页 URL，切块后生成 1024 维 embedding 存入 pgvector
- **RAG 检索问答**：每次对话实时检索最相关 chunks，交给大模型生成回答
- **引用原文**：AI 回复末尾标注 `[来源 N]`，可展开查看原始文本片段
- **公开聊天页**：一键生成分享链接 `/chat/{userId}`，访客无需注册即可对话
- **嵌入 Widget**：一行 `<script>` 将悬浮聊天按钮嵌入任意第三方网站

---

## 技术栈

| 层 | 技术 | 版本 |
|---|---|---|
| 框架 | Next.js App Router | 15.5.15 |
| 样式 | Tailwind CSS + shadcn/ui (base-nova) | 4.2.2 |
| 数据库 / Auth | Supabase (Postgres + pgvector + RLS) | — |
| AI SDK | Vercel AI SDK | 4.3.19 |
| AI 服务商 | SiliconFlow（OpenAI 兼容） | — |
| Embedding 模型 | BAAI/bge-m3 | 1024 维 |
| 对话模型 | deepseek-ai/DeepSeek-V3 | — |
| 文本切块 | @langchain/textsplitters | 0.1.x |
| 包管理器 | pnpm | 10.x |

---

## 快速开始

### 1. 克隆仓库

```bash
git clone <仓库地址>
cd ai-customer-service-saas
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 配置环境变量

```bash
cp .env.local.example .env.local
```

打开 `.env.local`，填入以下值（获取方式见[环境变量说明](#环境变量说明)）：

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SILICONFLOW_API_KEY=sk-...
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### 4. 初始化 Supabase 数据库

在 [Supabase Dashboard](https://supabase.com) 中打开你的项目，进入 **SQL Editor**，粘贴并执行以下 SQL：

```sql
create extension if not exists vector;
create extension if not exists pgcrypto;

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  content_type text not null check (content_type in ('pdf','txt','url')),
  source_url text,
  status text not null default 'processing' check (status in ('processing','ready','failed')),
  error_message text,
  char_count int default 0,
  chunk_count int default 0,
  created_at timestamptz default now()
);
create index documents_user_id_idx on public.documents(user_id);

create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  embedding vector(1024),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create index document_chunks_user_id_idx on public.document_chunks(user_id);
create index document_chunks_document_id_idx on public.document_chunks(document_id);
create index document_chunks_embedding_idx on public.document_chunks
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  visitor_id text not null,
  created_at timestamptz default now()
);
create index chat_sessions_user_id_idx on public.chat_sessions(user_id);
create index chat_sessions_visitor_idx on public.chat_sessions(visitor_id);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  citations jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);
create index chat_messages_session_id_idx on public.chat_messages(session_id);

create or replace function match_document_chunks(
  query_embedding vector(1024),
  tenant_id uuid,
  match_count int default 5,
  min_similarity float default 0.3
)
returns table (id uuid, document_id uuid, content text, similarity float, metadata jsonb)
language sql stable as $$
  select dc.id, dc.document_id, dc.content,
         1 - (dc.embedding <=> query_embedding) as similarity,
         dc.metadata
  from public.document_chunks dc
  where dc.user_id = tenant_id
    and 1 - (dc.embedding <=> query_embedding) > min_similarity
  order by dc.embedding <=> query_embedding
  limit match_count;
$$;

alter table public.documents       enable row level security;
alter table public.document_chunks enable row level security;
alter table public.chat_sessions   enable row level security;
alter table public.chat_messages   enable row level security;

create policy "own_documents" on public.documents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_chunks" on public.document_chunks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_sessions" on public.chat_sessions
  for select using (auth.uid() = user_id);
create policy "own_messages" on public.chat_messages
  for select using (
    exists (select 1 from public.chat_sessions s
            where s.id = chat_messages.session_id and s.user_id = auth.uid())
  );
```

### 5. 启动开发服务器

```bash
pnpm dev
```

### 6. 开始使用

访问 `http://localhost:3000`，注册账号后：

1. 进入**知识库**页面，上传 PDF / TXT 文件或粘贴网页 URL
2. 等待状态变为"就绪"后，进入 **Playground** 测试问答效果
3. 在**部署**页面复制分享链接或嵌入代码

---

## 目录结构

```
app/
  (marketing)/          # 落地页
  (auth)/               # 登录 / 注册页
  (dashboard)/          # B 端后台（知识库、Playground、部署）
  chat/[tenantId]/      # C 端公开聊天页
  api/                  # Route Handlers（ingest、chat、documents）
  widget.js/            # Widget 嵌入脚本路由
components/
  ui/                   # shadcn 组件
  chat/ChatWindow.tsx   # 聊天窗口（B/C 端复用）
lib/
  supabase/             # 三客户端（browser / server / admin）
  rag/                  # RAG 工具库（chunk、embed、loader、retrieve）
middleware.ts           # Session 刷新 + 路由守护
```

---

## 环境变量说明

| 变量 | 用途 | 获取方式 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 项目 API 地址 | Dashboard → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 前端匿名访问 Key | Dashboard → Settings → API → anon public |
| `SUPABASE_SERVICE_ROLE_KEY` | 服务端绕 RLS 访问 Key（勿泄露） | Dashboard → Settings → API → service_role |
| `SILICONFLOW_API_KEY` | SiliconFlow 推理 + Embedding API Key | SiliconFlow 控制台 → API Keys |
| `SILICONFLOW_BASE_URL` | SiliconFlow API 地址 | 固定填 `https://api.siliconflow.cn/v1` |
| `NEXT_PUBLIC_APP_URL` | 应用访问地址（影响分享链接和 widget src） | 本地填 `http://localhost:3000`，生产填实际域名 |

---

## 常见问题

**Q：注册时报错 / 收不到验证邮件，或触发 429 错误**

Supabase 免费版内置邮件服务有严格速率限制（每小时约 3 封）。开发阶段可在 Dashboard → Authentication → Providers → Email 中关闭 **Confirm email**，生产环境务必重新开启并配置自定义 SMTP（见 [DEPLOYMENT.md](./DEPLOYMENT.md)）。

**Q：上传 PDF 时服务器报错 `TypeError: Object.defineProperty called on non-object`**

`pdf-parse` 库与 Next.js 15 RSC 打包有 CJS/ESM 互操作问题。确认 `next.config.ts` 中包含：

```ts
serverExternalPackages: ["pdf-parse"],
```

并且 `lib/rag/loader.ts` 中使用动态 import：

```ts
const { PDFParse } = await import('pdf-parse');
```

**Q：上传文件时报 400 / 请求格式错误**

前端已限制单文件最大 10MB，超过此限制 Next.js 会在到达业务层之前拦截请求并返回 400。请压缩或拆分文件后重试。
