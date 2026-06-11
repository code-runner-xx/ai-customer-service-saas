# AI 客服知识库 SaaS

企业级多租户 AI 知识库 + 智能客服 SaaS。企业主上传私有文档，系统自动切块向量化；终端用户通过公开链接或嵌入 Widget 与 AI 客服对话，回答严格基于知识库检索，引用原文不编造。

V2 已将线性 RAG 重构为 **LLM 自主决策的 Agent**（LangGraph 状态图 + 工具调用 + 召回-精排两阶段检索 + LangSmith 可观测）。**架构演进、量化对比与关键技术决策详见 [AGENT_UPGRADE.md](./AGENT_UPGRADE.md)。**

**线上 Demo**：[https://ai-customer-service-saas.vercel.app](https://ai-customer-service-saas.vercel.app)（Vercel Hobby 部署，可注册体验）

---

## 功能亮点

- **文档上传自动向量化**：支持 PDF / TXT / Word (.docx) / 网页 URL，切块后生成 1024 维 embedding 存入 pgvector
- **Agent 自主决策（V2）**：基于 LangGraph 状态图，由模型自主决定是否检索、检索几次、调用哪个工具，而非固定的线性流程
- **多工具调用（V2）**：知识库检索、列出文档、转人工、记录用户反馈共 4 个工具，模型按对话意图选择
- **召回-精排两阶段检索（V2）**：向量召回 top-20，经 `BAAI/bge-reranker-v2-m3` 精排取 top-5
- **知识库外稳定拒答（V2）**：对检索零命中或超出知识库范围的问题稳定拒答、不调用通用世界知识硬答，并清空错误引用
- **引用原文**：AI 回复末尾标注 `[来源 N]`，可展开查看原始文本片段
- **公开聊天页**：一键生成分享链接 `/chat/{userId}`，访客无需注册即可对话
- **C 端历史恢复**：访客刷新页面后保留对话上下文（基于 localStorage `visitorId` + tenantId 双条件查询）
- **嵌入 Widget**：一行 `<script>` 将悬浮聊天按钮嵌入任意第三方网站
- **全链路可观测（V2）**：接入 LangSmith，每次 LLM 调用、工具调用、状态转换可在 trace 平台查看

---

## 技术栈

| 层 | 技术 | 版本 |
|---|---|---|
| 框架 | Next.js App Router | 15.5.15 |
| 样式 | Tailwind CSS + shadcn/ui (base-nova) | 4.2.2 |
| 数据库 / Auth | Supabase (Postgres + pgvector + RLS) | — |
| AI SDK | Vercel AI SDK | 4.3.19 |
| Agent 框架 | @langchain/langgraph | 1.3.x |
| LangChain 核心 | @langchain/core / @langchain/openai | 1.x |
| 可观测 | langsmith | 0.7.x |
| AI 服务商 | SiliconFlow（OpenAI 兼容） | — |
| Embedding 模型 | BAAI/bge-m3 | 1024 维 |
| 对话模型 | deepseek-ai/DeepSeek-V3 | — |
| 重排模型 | BAAI/bge-reranker-v2-m3 | — |
| 文本切块 | @langchain/textsplitters | 1.0.x |
| PDF 解析 | unpdf（纯 ESM，扫描件硬拒，OCR 待 Step 18） | 1.6.x |
| Word 解析 | mammoth（仅 `.docx`，`.doc` 老格式不支持） | 1.12.x |
| 部署 | Vercel Hobby（请求体 4.5MB / `maxDuration` 60s） | — |
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

# 可选：LangSmith 可观测（不配则不上报 trace，业务零影响）
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=
LANGCHAIN_PROJECT=ai-customer-service-saas
```

> LangSmith 三项可选：要开 trace 则三个一起配（生产建议用独立 `LANGCHAIN_PROJECT` 名与本地分桶）；切勿只配 `LANGCHAIN_TRACING_V2=true` 而漏 `LANGCHAIN_API_KEY`（会产生 401 噪声）。

### 4. 初始化 Supabase 数据库

在 [Supabase Dashboard](https://supabase.com) 中打开你的项目，进入 **SQL Editor**，粘贴并执行以下 SQL：

```sql
create extension if not exists vector;
create extension if not exists pgcrypto;

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  content_type text not null check (content_type in ('pdf','txt','url','docx')),
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

-- 用户反馈表（V2 Step 24：record_user_feedback 工具写入）
create table public.user_feedback (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  message_id uuid references public.chat_messages(id) on delete set null,
  rating text not null check (rating in ('positive','negative')),
  comment text,
  created_at timestamptz default now()
);
create index user_feedback_session_idx on public.user_feedback(session_id);

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
alter table public.user_feedback   enable row level security;

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
create policy "own_feedback" on public.user_feedback
  for select using (
    exists (select 1 from public.chat_sessions s
            where s.id = user_feedback.session_id and s.user_id = auth.uid())
  );
```

### 5. 启动开发服务器

```bash
pnpm dev
```

### 6. 开始使用

访问 `http://localhost:3000`，注册账号后：

1. 进入**知识库**页面，上传 PDF / TXT / Word (.docx) 文件或粘贴网页 URL
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
  chat/ChatWindow.tsx   # 聊天窗口（B/C 端复用，含工具状态条）
lib/
  agent/                # V2 Agent：graph（LangGraph 状态图）、tools（4 工具）、
                        #   prompt（system prompt）、refusal（拒答检测）
  supabase/             # 三客户端（browser / server / admin）
  rag/                  # RAG 工具库（chunk、embed、loader、retrieve、rerank）
middleware.ts           # Session 刷新 + 路由守护
```

---

## 环境变量说明

| 变量 | 用途 | 获取方式 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 项目 API 地址 | Dashboard → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 前端匿名访问 Key | Dashboard → Settings → API → anon public |
| `SUPABASE_SERVICE_ROLE_KEY` | 服务端绕 RLS 访问 Key（勿泄露） | Dashboard → Settings → API → service_role |
| `SILICONFLOW_API_KEY` | SiliconFlow 推理 + Embedding + 重排 API Key | SiliconFlow 控制台 → API Keys |
| `SILICONFLOW_BASE_URL` | SiliconFlow API 地址 | 固定填 `https://api.siliconflow.cn/v1` |
| `NEXT_PUBLIC_APP_URL` | 应用访问地址（影响分享链接和 widget src） | 本地填 `http://localhost:3000`，生产填实际域名 |
| `LANGCHAIN_TRACING_V2` | 是否开启 LangSmith trace（可选） | 开启填 `true`，不用则留空 |
| `LANGCHAIN_API_KEY` | LangSmith API Key（开 trace 时必填） | LangSmith 控制台 → Settings → API Keys |
| `LANGCHAIN_PROJECT` | LangSmith 项目名（可选） | 自定义，生产建议独立名与本地分桶 |

---

## 常见问题

**Q：注册时报错 / 收不到验证邮件，或触发 429 错误**

Supabase 免费版内置邮件服务有严格速率限制（每小时约 3 封）。开发阶段可在 Dashboard → Authentication → Providers → Email 中关闭 **Confirm email**，生产环境务必重新开启并配置自定义 SMTP（见 [DEPLOYMENT.md](./DEPLOYMENT.md)）。

**Q：上传 Word 文档时服务器报错 `TypeError: Object.defineProperty called on non-object`**

`mammoth` 是老 CJS 库，与 Next.js 15 RSC 打包有互操作问题。确认 `next.config.ts` 中包含：

```ts
serverExternalPackages: ["mammoth"],
```

并且 `lib/rag/loader.ts` 中使用动态 import：

```ts
const { extractRawText } = await import('mammoth');
```

PDF 解析自 Step 15 起改用纯 ESM 的 `unpdf`，无此问题。

**Q：上传文件时报 400 / 请求格式错误**

前端已限制单文件最大 4.5MB（Vercel Hobby 请求体上限）。超过此限制 Next.js 会在到达业务层之前拦截请求并返回 400。请压缩或拆分文件后重试，或升级到 Vercel Pro 放宽该限制。

**Q：上传扫描件 / 图像 PDF 报错"暂不支持 OCR"**

当前版本对 PDF 启用启发式扫描件检测（页数 ≥ 2 且平均字符 < 50 字/页 → 判定为扫描件并拒绝）。请提供带文字层的 PDF。OCR 支持已规划在 Step 18，触发条件为真实需求 ≥ 3 份。

**Q：知识库里明明有的问题，AI 却回答"没有找到相关信息"**

V2 对知识库外问题会稳定拒答。若库内问题被误拒，通常是该问题与文档的语义相似度偏低。可在 Playground 中换一种问法，或确认相关文档已上传且状态为"就绪"。

---

## 协作说明

本项目使用 Anthropic 的 Claude 系列工具作为主要开发协作伙伴，
开发者与 AI 的分工如下,如实陈述以供有意了解 AI 协作开发的读者参考。

### 开发者承担

- 产品定位、功能优先级、上线时机
- 每一步的需求描述与边界界定
- 所有改动的人工审阅、本地验证、Vercel preview 验证
- 决定何时合并 main、何时放弃某个方向、何时记录为遗留债务
- 对最终产品质量负责

### Claude 承担

- **Claude Code**(Opus 4.8):全部应用代码的实际编写,包括 RAG 摄取/
  检索管线、LangGraph Agent 状态图与工具、Next.js 路由与组件、
  widget 嵌入脚本、TypeScript 类型设计、数据库 SQL 与 RLS 策略起草
- **Claude Design**:UI kit 视觉系统设计、组件原型迭代、
  设计 token 与 accent 色方案
- 踩坑记录、技术债务整理、commit message 撰写

### 工作流约束

每个开发步骤遵循"先报备 → 等确认 → 动手 → 验收 → 停下"的循环,
禁止跳步,禁止一次性大规模改动。所有 Claude Code 写入的 commit
带 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` 尾签,
git log 可查。

### 透明声明

代码层面绝大多数实际书写工作由 Claude Code 完成,开发者主要承担
"提出需求 → 审核产出 → 决定是否采纳"的角色。这个项目展示的是
**人机协作的工作流设计能力**和**AI 输出的判断力**,而不是开发者
独立的 coding throughput。

如对具体协作过程感兴趣,欢迎查看 commit history。