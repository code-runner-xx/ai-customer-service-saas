# 生产部署指南

本文档说明如何将 AI 客服知识库 SaaS 部署到生产环境（Vercel + Supabase）。

---

## 前置准备

- [Supabase](https://supabase.com) 账号
- [SiliconFlow](https://siliconflow.cn) 账号
- [Vercel](https://vercel.com) 账号
- GitHub 仓库（已推送项目代码）

---

## 第一步：配置 Supabase

### 1.1 新建项目

1. 登录 [Supabase Dashboard](https://supabase.com/dashboard)
2. 点击 **New project**，填写项目名称，选择数据库密码（妥善保存）
3. 地区建议选择 **Southeast Asia（新加坡）** 或距离用户最近的节点
4. 等待项目初始化完成（约 1 分钟）

### 1.2 执行初始化 SQL

1. 进入项目 → **SQL Editor** → **New query**
2. 粘贴以下 SQL，点击 **Run**：

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

3. 确认执行成功（无红色报错），在 **Table Editor** 中应看到 4 张新建的表

### 1.3 获取 API Keys

进入项目 → **Settings** → **API**，复制以下三个值备用：

| 变量名 | 对应字段 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon / public |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role（点击 Reveal 展示） |

> **安全提示**：`service_role` Key 拥有绕过 RLS 的完整权限，只能在服务端使用，绝不能暴露到前端或提交到 Git。

---

## 第二步：获取 SiliconFlow API Key

1. 注册并登录 [SiliconFlow 控制台](https://cloud.siliconflow.cn)
2. 进入 **API Keys** → **创建 API Key**
3. 复制生成的 Key（格式为 `sk-...`），此 Key 同时用于 Embedding（BAAI/bge-m3）和对话（DeepSeek-V3）

---

## 第三步：Vercel 部署

### 3.1 导入项目

1. 登录 [Vercel Dashboard](https://vercel.com/dashboard)
2. 点击 **Add New → Project**
3. 选择 GitHub 仓库，点击 **Import**

### 3.2 配置环境变量

在 **Configure Project** 页面展开 **Environment Variables**，逐条添加：

| 变量名 | 值 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key |
| `SILICONFLOW_API_KEY` | SiliconFlow API Key |
| `SILICONFLOW_BASE_URL` | `https://api.siliconflow.cn/v1` |
| `NEXT_PUBLIC_APP_URL` | 部署后的域名，如 `https://your-app.vercel.app`（先填 Vercel 分配的域名，绑定自定义域名后再更新） |

### 3.3 部署

点击 **Deploy**，等待构建完成（约 2-3 分钟）。构建日志无错误后，点击生成的链接验证应用可访问。

---

## 第四步：绑定自定义域名（可选）

1. 进入 Vercel 项目 → **Settings** → **Domains**
2. 输入你的域名，按提示在 DNS 服务商处添加 CNAME 或 A 记录
3. 等待 DNS 生效（通常 5-30 分钟）
4. 域名验证通过后，回到 **Environment Variables**，将 `NEXT_PUBLIC_APP_URL` 更新为新域名（如 `https://aics.yourdomain.com`）
5. 进入 **Deployments** → 最新部署旁 **⋯** → **Redeploy**，使环境变量变更生效

> **注意**：`NEXT_PUBLIC_APP_URL` 直接影响分享链接（`/chat/{userId}`）和 Widget 脚本 src，域名变更后必须重新部署才能生效。

---

## 上线前检查清单

完成部署后，逐条确认以下事项：

- [ ] **重新开启 Supabase Confirm email**：Dashboard → Authentication → Providers → Email → 打开 **Confirm email** 开关（开发阶段为避免 429 已临时关闭）
- [ ] **配置自定义 SMTP**：Dashboard → Authentication → SMTP Settings → 填入 Resend / SendGrid / AWS SES 等 SMTP 信息，避免内置邮件服务的速率限制
- [ ] **`NEXT_PUBLIC_APP_URL` 已更新为生产域名**：检查部署页面显示的分享链接是否为正式域名
- [ ] **RLS 策略已启用**：Dashboard → Table Editor → 依次检查 `documents`、`document_chunks`、`chat_sessions`、`chat_messages` 四张表，确认均显示 **RLS enabled**
- [ ] **C 端公开链接可用**：用无痕浏览器访问 `{APP_URL}/chat/{你的userId}`，确认能正常对话
- [ ] **Widget 可用**：将 Deploy 页面的嵌入代码粘贴到测试 HTML，确认悬浮按钮出现、点击后弹出聊天窗口
- [ ] **`SUPABASE_SERVICE_ROLE_KEY` 未泄露**：确认该 Key 仅在 Vercel 环境变量中，未出现在 Git 提交记录或前端 bundle 中

---

## 常见部署问题

**构建失败：`Module not found`**

确认本地 `pnpm install` 后所有依赖已锁定到 `pnpm-lock.yaml`，并已提交到 Git。

**运行时报错：`SUPABASE_SERVICE_ROLE_KEY is not defined`**

Vercel 环境变量未生效，检查是否点击了 Save 并重新部署。

**C 端聊天页在 iframe 中空白**

确认 `next.config.ts` 中已为 `/chat/*` 路径添加 `Content-Security-Policy: frame-ancestors *` 响应头（见代码库中的配置）。
