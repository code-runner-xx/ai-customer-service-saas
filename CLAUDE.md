# CLAUDE.md — AI 客服知识库 SaaS 开发手册

> 本文件是 Claude Code 的**权威执行指南**。请严格按 Phase 顺序推进,**每完成一个 Step 必须停下**,输出"✅ 验收方案"让用户手动测试,用户回复"通过"后才能进入下一步。禁止跳步、禁止一次性写完多个 Phase、禁止擅自修改本文档中的 Schema 与目录结构。

---

## 0. 项目铁律(Claude Code 必读)

1. **语言**:所有 UI 文案、注释、commit message 使用简体中文;代码标识符使用英文。
2. **类型**:全程 TypeScript strict,不允许 `any`(必要时用 `unknown` 收窄)。
3. **多租户隔离**:所有业务查询必须带 `user_id` 过滤,或依赖 Supabase RLS;C 端匿名接口使用 Service Role Key 时,SQL 内**必须显式**带 `WHERE user_id = tenantId`。
4. **不要自作主张**:如果本手册未写清楚的细节,先在回答开头列出"❓ 待确认"问用户,而不是自己发明方案。
5. **每步停顿**:每完成一个 Step,必须输出"✅ 验收方案"(含手动测试步骤 + 数据库验证 SQL),然后**停止工作**等用户确认。
6. **不要运行 `npm run dev`**:由用户自己运行。你可以运行 `tsc --noEmit`、`next build`、`eslint` 做静态检查。
7. **Secrets**:永远不要把真实 key 写进代码或 commit;只改 `.env.local.example`。

---

## 1. 技术栈(已锁定,勿改)

| 层 | 选型 |
|---|---|
| 框架 | Next.js 15 App Router + TypeScript |
| UI | Tailwind CSS + shadcn/ui (New York / Neutral) |
| 数据库/Auth | Supabase (Postgres + pgvector + RLS) |
| AI SDK | Vercel AI SDK (`ai` + `@ai-sdk/openai`) |
| 切块 | `@langchain/textsplitters` 的 RecursiveCharacterTextSplitter |
| PDF | `pdf-parse` |
| 网页 | `cheerio` |
| Embedding | OpenAI `text-embedding-3-small` (1536 维) |
| 对话模型 | OpenAI `gpt-4o-mini` |

### 必装依赖
```bash
pnpm add @supabase/supabase-js @supabase/ssr ai @ai-sdk/openai @ai-sdk/react openai \
  langchain @langchain/textsplitters pdf-parse cheerio \
  zod react-hook-form @hookform/resolvers lucide-react nanoid \
  react-markdown remark-gfm sonner
pnpm add -D @types/pdf-parse
```

---

## 2. 环境变量(`.env.local.example`)

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
OPENAI_API_KEY=
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

---

## 3. 目录结构(作为最终目标)

```
app/
  (marketing)/page.tsx
  (auth)/login/page.tsx
  (auth)/register/page.tsx
  (dashboard)/
    layout.tsx
    dashboard/page.tsx
    knowledge/page.tsx
    knowledge/upload/page.tsx
    playground/page.tsx
    deploy/page.tsx
  chat/[tenantId]/page.tsx
  api/
    ingest/file/route.ts
    ingest/url/route.ts
    chat/route.ts
    documents/route.ts
    documents/[id]/route.ts
  widget.js/route.ts
components/
  ui/                    # shadcn
  chat/ChatWindow.tsx
  knowledge/UploadForm.tsx
  knowledge/DocumentList.tsx
lib/
  supabase/{client,server,admin}.ts
  rag/{embed,chunk,loader,retrieve}.ts
  utils.ts
middleware.ts
```

---

## 4. Supabase 初始化 SQL(用户手动执行)

> Claude Code:**不要**尝试运行这段 SQL,提醒用户在 Supabase Dashboard → SQL Editor 里粘贴执行即可。

```sql
create extension if not exists vector;
create extension if not exists pgcrypto;

-- documents
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

-- document_chunks
create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  embedding vector(1536),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create index document_chunks_user_id_idx on public.document_chunks(user_id);
create index document_chunks_document_id_idx on public.document_chunks(document_id);
create index document_chunks_embedding_idx on public.document_chunks
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- chat_sessions
create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  visitor_id text not null,
  created_at timestamptz default now()
);
create index chat_sessions_user_id_idx on public.chat_sessions(user_id);
create index chat_sessions_visitor_idx on public.chat_sessions(visitor_id);

-- chat_messages
create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  citations jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);
create index chat_messages_session_id_idx on public.chat_messages(session_id);

-- 向量匹配函数
create or replace function match_document_chunks(
  query_embedding vector(1536),
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

-- RLS
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

---

## 5. 执行流程总览

共 **5 个 Phase、14 个 Step**。每 Step 完成后停下等验收。

| Phase | Steps | 产出 |
|---|---|---|
| P1 项目骨架 | S1 初始化 → S2 Supabase 客户端 → S3 Auth 页面 → S4 Dashboard 布局 | 能登录,进后台 |
| P2 知识库摄取 | S5 RAG 工具库 → S6 摄取 API → S7 知识库前端 | 能上传文档并入库 |
| P3 RAG 对话 | S8 检索 + Chat API → S9 Playground | 后台能问答 |
| P4 C 端页面 | S10 公开聊天页 → S11 Deploy 页 | 分享链接可用 |
| P5 Widget 与打磨 | S12 widget.js → S13 Markdown/引用打磨 → S14 README/部署文档 | 可嵌入第三方站点 |

---

## 6. Phase 1 — 项目骨架

### Step 1 — 初始化项目
**做什么**
1. 在当前空目录执行 `npx create-next-app@latest . --ts --tailwind --app --eslint --import-alias "@/*"`(不要 src 目录)。
2. 安装第 1 节所有依赖。
3. `npx shadcn@latest init`(New York / Neutral / CSS vars)。
4. 添加组件:`npx shadcn@latest add button input label card form dropdown-menu avatar separator sonner tabs table badge dialog textarea`。
5. 创建 `.env.local.example`(见第 2 节)。
6. 在 `app/layout.tsx` 挂载 `<Toaster />`(sonner)。

**✅ 验收方案**
- [ ] `tsc --noEmit` 无错误
- [ ] `ls components/ui | wc -l` ≥ 12
- [ ] 用户手动跑 `pnpm dev` 打开 `http://localhost:3000` 看到 Next.js 默认页
- [ ] `.env.local.example` 存在且字段齐全

---

### Step 2 — Supabase 三客户端 + Middleware
**做什么**
1. `lib/supabase/client.ts`:`createBrowserClient`。
2. `lib/supabase/server.ts`:`createServerClient` + Next.js `cookies()`(注意 Next 15 的 `await cookies()`)。
3. `lib/supabase/admin.ts`:`createClient` 用 `SUPABASE_SERVICE_ROLE_KEY`,导出 `createAdminClient()` 函数,**只允许在 Route Handler/Server Action 内调用**,文件顶部加 `import 'server-only'`。
4. `middleware.ts`:刷新 session;未登录访问 `/dashboard|/knowledge|/playground|/deploy` 重定向 `/login`;已登录访问 `/login|/register` 重定向 `/dashboard`。

**✅ 验收方案**
- [ ] `tsc --noEmit` 通过
- [ ] 用户在 `.env.local` 填真实 Supabase key 后,`pnpm dev` 不报错
- [ ] 手动访问 `/dashboard` 应被跳转到 `/login`

---

### Step 3 — Auth 页面(登录 / 注册)
**做什么**
1. `app/(auth)/login/page.tsx`:react-hook-form + zod 校验邮箱密码,调用 `supabase.auth.signInWithPassword`,成功后 `router.push('/dashboard')`,失败用 `toast.error`。
2. `app/(auth)/register/page.tsx`:`signUp`,成功后提示"请查收验证邮件"(若 Supabase 开启邮箱确认)或直接跳 dashboard。
3. 居中卡片式布局,含跳转另一页的链接。

**✅ 验收方案**
- [ ] 用户在 Supabase Auth 里创建一个测试账号,能从 `/login` 登入并跳到 `/dashboard`
- [ ] 错误密码显示 toast 错误
- [ ] `/register` 能创建新账号(可先在 Supabase 后台关闭邮箱验证以便测试)

---

### Step 4 — Dashboard 布局 + 概览页
**做什么**
1. `app/(dashboard)/layout.tsx`:左侧导航(概览 / 知识库 / 测试聊天 / 部署),顶部右侧用户头像下拉菜单(显示邮箱 + 登出)。
2. `app/(dashboard)/dashboard/page.tsx`(Server Component):查询当前用户的 `documents`、`chat_sessions`、`chat_messages` 总数,用三张 Card 展示。
3. `app/(marketing)/page.tsx`:简单落地页,含"登录 / 免费开始"按钮。

**✅ 验收方案**
- [ ] 登录后能看到侧边栏导航,点击各项能跳转(目标页面可暂时是占位空页)
- [ ] 概览页数字显示为 0(因为还没数据)
- [ ] 登出按钮能清除 session 跳回 `/login`
- [ ] Supabase Dashboard → Authentication 能看到当前用户

🛑 **P1 完成,等待用户说"P1 通过"后再进 P2。**

---

## 7. Phase 2 — 知识库摄取

### Step 5 — RAG 工具库
**做什么**
1. `lib/rag/chunk.ts`:导出 `chunkText(text: string): Promise<string[]>`,用 `RecursiveCharacterTextSplitter({ chunkSize: 800, chunkOverlap: 150 })`,过滤 `trim().length < 20` 的块。
2. `lib/rag/embed.ts`:导出 `embedTexts(texts: string[]): Promise<number[][]>`,调用 `openai.embeddings.create({ model: 'text-embedding-3-small', input: batch })`,批量 ≤100 条,失败重试 2 次。
3. `lib/rag/loader.ts`:
   - `loadPdf(buffer: Buffer): Promise<string>` → pdf-parse
   - `loadTxt(buffer: Buffer): Promise<string>` → `buffer.toString('utf-8')`
   - `loadUrl(url: string): Promise<{ title: string; text: string }>` → fetch + cheerio,去除 script/style/nav/footer/header,取 body 文本

**✅ 验收方案**
- [ ] `tsc --noEmit` 通过
- [ ] (可选)让 Claude Code 写一个一次性 `scripts/test-rag.ts`,本地跑 `tsx scripts/test-rag.ts` 验证能切块 + 生成 embedding(维度=1536)。验证完后删除脚本。

---

### Step 6 — 摄取 API
**做什么**
1. `app/api/ingest/file/route.ts` (POST,`multipart/form-data`,字段 `file`):
   - 用 `server.ts` 客户端取 `user`,未登录 401
   - 根据 MIME 走 loader,得到纯文本
   - 插入 `documents`(status='processing')→ chunk → embed → 批量 insert `document_chunks`(每条都写 `user_id`)→ 更新 `documents` status='ready'、`chunk_count`、`char_count`
   - 任何一步失败:更新 status='failed' + `error_message`,返回 500
2. `app/api/ingest/url/route.ts` (POST JSON `{url}`):同上,`content_type='url'`、`source_url=url`、`title` 取网页 `<title>`。
3. `app/api/documents/route.ts` GET:返回当前用户所有 documents(按 `created_at desc`)。
4. `app/api/documents/[id]/route.ts` DELETE:删除指定 document(RLS 会自动限制只能删自己的)。

> 批量插入 chunks 使用 admin client 提速,但每行显式带 `user_id`。

**✅ 验收方案**
- [ ] 用 curl 或 Postman:
```bash
  curl -X POST http://localhost:3000/api/ingest/url \
    -H "Content-Type: application/json" \
    -H "Cookie: <浏览器登录后复制>" \
    -d '{"url":"https://zh.wikipedia.org/wiki/人工智能"}'
```
- [ ] 在 Supabase SQL Editor:
```sql
  select id, title, status, chunk_count from documents order by created_at desc limit 5;
  select count(*) from document_chunks where document_id = '<上面的 id>';
```
  应看到 status='ready',chunk_count > 0,chunks 数匹配。
- [ ] DELETE 请求后对应 documents 和 chunks 全部消失(cascade)。

---

### Step 7 — 知识库前端
**做什么**
1. `app/(dashboard)/knowledge/page.tsx`:表格展示 documents(标题 / 类型 / 状态徽章 / chunk 数 / 时间 / 删除按钮)。右上角"上传文档"按钮跳 `/knowledge/upload`。前端用 `useEffect` + `setInterval(5s)` 轮询 `/api/documents` 刷新直到没有 `processing`。
2. `app/(dashboard)/knowledge/upload/page.tsx`:Tabs 两栏:
   - 文件:拖拽上传 + 点选,限 `.pdf,.txt`,≤10MB,POST `/api/ingest/file`
   - 网址:Input + 校验 URL 格式,POST `/api/ingest/url`
   - 成功 toast + 跳回列表

**✅ 验收方案**
- [ ] 从 UI 上传一份 PDF 和一个 URL,列表自动从 `processing` 变 `ready`
- [ ] 错误情况(超大文件 / 无效 URL)有 toast 提示
- [ ] 删除按钮能删除文档,列表刷新

🛑 **P2 完成,等用户说"P2 通过"。**

---

## 8. Phase 3 — RAG 对话

### Step 8 — 检索 + Chat API
**做什么**
1. `lib/rag/retrieve.ts`:`retrieveContext(query, tenantId, topK=5)` → 调 embed → `supabase.rpc('match_document_chunks', { query_embedding, tenant_id: tenantId, match_count: topK })` → 返回 `{ chunks, contextText }`,`contextText` 按 `[来源 1] ...\n\n[来源 2] ...` 拼接。使用 admin client 调用,因为 C 端匿名场景也要能用(函数内已按 tenant_id 过滤)。
2. `app/api/chat/route.ts` (POST):
   - 入参:`{ messages: UIMessage[], tenantId: string, sessionId?: string, visitorId?: string }`
   - 校验 `tenantId` 是 UUID;若 cookie 里有登录用户且 `user.id === tenantId` → B 端模式;否则 C 端模式,必须有 `visitorId`
   - 取 messages 最后一条 user 文本作为 query → `retrieveContext`
   - System Prompt:
```
     你是企业专属客服助手。严格依据下方【知识上下文】回答用户问题。
     规则:
     1. 若上下文中没有相关信息,回答"抱歉,我在知识库中没有找到相关信息,建议您联系人工客服。",禁止编造。
     2. 回答末尾以 [来源 N] 标注引用编号。
     3. 用中文、简洁、分点作答。

     【知识上下文】
     {contextText}
```
   - 用 `streamText({ model: openai('gpt-4o-mini'), system, messages })`
   - `onFinish` 里用 admin client:若无 sessionId 则创建 session(user_id=tenantId,visitor_id=visitorId 或 'playground'),写入 user message + assistant message(含 citations = chunks 映射)
   - 返回 `result.toUIMessageStreamResponse()`
   - 通过 data part 回传 `sessionId` 和 `citations` 给前端

**✅ 验收方案**
- [ ] `tsc --noEmit` 通过
- [ ] 用户用 Postman / curl 发一条消息,能看到流式 SSE 返回
- [ ] Supabase 里能查到新的 `chat_sessions` 和 `chat_messages` 行

---

### Step 9 — Playground 聊天页
**做什么**
1. `components/chat/ChatWindow.tsx`:props `{ tenantId, mode: 'playground'|'public', visitorId? }`。用 `@ai-sdk/react` 的 `useChat({ api: '/api/chat', body: { tenantId, visitorId } })`。消息气泡(用户右、AI 左),AI 消息下方渲染 citations(可折叠)。底部输入框 + 发送,Enter 发送、Shift+Enter 换行。
2. `app/(dashboard)/playground/page.tsx`:Server Component 取当前 `user.id`,渲染 `<ChatWindow tenantId={user.id} mode="playground" />`,顶部提示语。

**✅ 验收方案**
- [ ] 问一个知识库里有的问题 → 流式答案 + `[来源 N]`
- [ ] 问一个无关问题 → "抱歉,我在知识库中没有找到相关信息…"
- [ ] 刷新页面后之前消息不保留(MVP 阶段正常);Supabase 里 `chat_messages` 有持久化记录
- [ ] 同一页面连续多轮对话,后端日志显示复用同一 `session_id`

🛑 **P3 完成。**

---

## 9. Phase 4 — C 端公开页

### Step 10 — 公开聊天页
**做什么**
1. `app/chat/[tenantId]/page.tsx`(在 middleware matcher 中排除此路径):
   - 服务端校验 `tenantId` 是 UUID 且用 admin client 查 `documents` 表中是否存在该 user_id 的任意记录;不存在 → `notFound()`
   - 客户端组件里:从 `localStorage.getItem('aics_visitor_id')` 读,没有则 `nanoid()` 生成并写回
   - 渲染全屏 `<ChatWindow tenantId={tenantId} mode="public" visitorId={visitorId} />`
   - 顶部极简 header;若 search param `?embed=1` 则隐藏 header、背景透明
2. 在 `/api/chat/route.ts` 的 C 端分支加简单速率限制:内存 Map 记录 `${visitorId}` 最近 60 秒消息数,>20 返回 429。顶部注释 `TODO: 生产环境替换为 Upstash / Redis`。

**✅ 验收方案**
- [ ] 无痕窗口访问 `/chat/{你的userId}` 能对话
- [ ] 访问 `/chat/00000000-0000-0000-0000-000000000000` 显示 404
- [ ] 连续快速发 25 条消息触发 429
- [ ] Supabase 里 `chat_sessions.visitor_id` 是 nanoid 字符串

---

### Step 11 — Deploy 页面
**做什么**
`app/(dashboard)/deploy/page.tsx`:
- 分享链接块:`{NEXT_PUBLIC_APP_URL}/chat/{user.id}` + 复制按钮 + 新窗口打开
- 嵌入代码块:`<script src="{APP_URL}/widget.js?t={user.id}" async></script>` + 复制按钮(此时 widget.js 尚未实现,标注"P5 可用")
- 底部统计卡片:文档数、会话数、消息数

**✅ 验收方案**
- [ ] 复制按钮能复制链接(toast 提示)
- [ ] 新窗口打开就是可用的 C 端聊天页
- [ ] 统计数字与数据库一致

🛑 **P4 完成。**

---

## 10. Phase 5 — Widget 与打磨

### Step 12 — widget.js 路由
**做什么**
`app/widget.js/route.ts`(GET,Content-Type: `application/javascript; charset=utf-8`):
- 从 `request.nextUrl.searchParams` 取 `t`(tenantId),校验 UUID,非法返回空脚本
- 返回一段 IIFE 字符串:
  - 右下角 56×56 圆形按钮(内联 SVG)
  - 点击弹出 380×560 iframe(移动端 `100vw/100vh`),`src=${APP_URL}/chat/${t}?embed=1`
  - `z-index: 2147483000`
  - 暴露 `window.AICS = { open, close, toggle }`

**✅ 验收方案**
- [ ] 新建一个本地 `test.html` 含 `<script src="http://localhost:3000/widget.js?t={userId}" async></script>`,用任意静态服务器打开(如 `npx serve`),右下角出现按钮,点击弹出聊天窗
- [ ] 在窗内发消息能正常对话
- [ ] 移动端(Chrome DevTools 切换到手机模式)窗口全屏显示

---

### Step 13 — Markdown 渲染 + 引用交互 + 打磨
**做什么**
1. `ChatWindow` 里 AI 消息用 `react-markdown` + `remark-gfm` 渲染
2. AI 消息下方的 `[来源 N]` 做成可点击 chip,点击展开显示对应 chunk 原文(从 data part 的 citations 读)
3. 知识库列表支持按 status 筛选(全部 / 处理中 / 就绪 / 失败)
4. 所有 loading 加 skeleton,所有空列表加空状态插画或文案
5. 全局错误边界 `app/error.tsx`

**✅ 验收方案**
- [ ] AI 返回带 `**加粗**`、列表、代码块能正确渲染
- [ ] 点击 `[来源 1]` 能看到原文
- [ ] 筛选器工作正常

---

### Step 14 — README + 部署文档
**做什么**
1. `README.md`:产品简介、技术栈、本地运行步骤(含 Supabase SQL 粘贴步骤)、环境变量说明、常见问题
2. `DEPLOYMENT.md`:
   - Supabase 项目创建 → SQL 执行 → 取 3 个 key
   - OpenAI key 获取
   - Vercel Import GitHub → 环境变量 → Deploy
   - 自定义域名 → 更新 `NEXT_PUBLIC_APP_URL`
   - RLS 越权自测方法(Supabase Dashboard → Impersonate user)

**✅ 验收方案**
- [ ] 一个没见过项目的人按 README 能在 15 分钟内本地跑起来
- [ ] `pnpm build` 成功无警告
- [ ] 全部 Phase 的验收项复查一遍

🎉 **MVP 完成。**

---

## 11. 与 Claude Code 协作约定

- 开始任何一个 Step 前,Claude Code 先回答:**"我将开始 Step N,计划修改的文件是 … ,需要运行的命令是 … ,预计耗时 …,确认开始吗?"** 等用户回复"开始"再动手。
- 完成后固定输出三块:
  1. **变更摘要**(新建/修改/删除的文件列表)
  2. **✅ 验收方案**(手动步骤 + SQL 或 curl 命令)
  3. **下一步预告**(下一个 Step 是什么,在等用户"通过"信号)
- 遇到本文档未定义的问题,**先问用户**,不要自己发明方案。
- 若用户反馈"不通过",Claude Code 必须根据反馈修复,**不能跳到下一 Step**。
