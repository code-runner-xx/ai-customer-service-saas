# CLAUDE.md — AI 客服知识库 SaaS 开发手册

> 本文件是 Claude Code 的**权威执行指南**。请严格按 Phase 顺序推进,**每完成一个 Step 必须停下**,输出"✅ 验收方案"让用户手动测试,用户回复"通过"后才能进入下一步。禁止跳步、禁止一次性写完多个 Phase、禁止擅自修改本文档中的 Schema 与目录结构。

---

## ⚠️ 版本锁定(Step 1 实装后记录,后续以此为准)

手册原计划与实际脚手架生态存在偏差,本块作为**事实版本**,后续步骤按此执行。新会话读本文件时请先看这一块再看下文技术栈。

| 项 | 手册原计划 | **实际锁定** | 说明 |
|---|---|---|---|
| Next.js | 15.x | **15.5.15** | create-next-app@15 产物,保持手册一致 |
| React | 19.x | 19.1.0 | Next 15 带入 |
| Tailwind | 3.x | **4.2.2** | create-next-app@15 默认装 Tailwind 4,已接受 |
| shadcn/ui 预设 | New York / Neutral(Radix) | **base-nova / `@base-ui/react`** | 新 shadcn CLI 默认预设,底层不再用 Radix |
| shadcn `form` 组件 | 安装 | **不安装**(registry 下载静默失败) | Auth 表单改用 react-hook-form 原生写法(`Controller` + `Input`) |
| Vercel AI SDK (`ai`) | 最新 | **^4.3.19**(未选 v6) | 从 CLI 默认 v6 主动降级,保持主流生态和流式 API 稳定 |
| `@ai-sdk/react` | 最新 | **^1.2.12** | 同上 |
| `@ai-sdk/openai` | 最新 | **^1.3.24** | 同上 |
| `openai` | 最新 | **^4.104.0** | 同上 |
| `zod` | 最新 | **^3.25.76**(未选 v4) | Step 3 要用到,v3 生态更成熟 |
| `langchain` | 最新 | **^0.3.37** | |
| `@langchain/textsplitters` | 最新 | **^0.1.0** | |
| 包管理器 | pnpm | pnpm 10.33.0 | |
| 目录 | 无 `src/` | 无 `src/` ✅ | |
| AI 服务商 | OpenAI | **SiliconFlow**(`https://api.siliconflow.cn/v1`,OpenAI SDK 兼容) | 一个 key 同时覆盖 embedding + 对话 |

> **写代码时**:如果发现某个 API 与上面锁定版本不符(比如看到 v6 写法),以锁定版本为准,不要擅自升级依赖。

---

## ⚠️ base-nova / base-ui 兼容注意事项(踩坑后补充,后续步骤遵守)

shadcn base-nova 预设的底层是 `@base-ui/react`,API 与老的 Radix 版 shadcn 有差异。已踩过的坑:

1. **`Button` 不支持 `asChild`**(`@base-ui/react/button` 用 `render` prop,不是 Slot)。需要"按钮+链接"时,改用 `buttonVariants({ size, variant })` 把 className 套到 `<Link>` 上:
   ```tsx
   <Link href="/x" className={buttonVariants({ size: "lg", variant: "outline" })}>文字</Link>
   ```
2. **`DropdownMenuTrigger` 也不支持 `asChild`**。直接把内容(如 `<Avatar>`)放进 `<DropdownMenuTrigger>`,自己加 `outline-none focus-visible:ring-2` 等样式让它仍像按钮。
3. **`DropdownMenuLabel` 必须嵌套在 `<DropdownMenuGroup>` 里**,不能直接放在 `<DropdownMenuContent>` 下,否则运行时报 `Base UI: MenuGroupRootContext is missing. Menu group parts must be used within <Menu.Group>`。`DropdownMenuItem` 同理建议放在 `Group` 内。标准结构:
   ```tsx
   <DropdownMenuContent>
     <DropdownMenuGroup>
       <DropdownMenuLabel>…</DropdownMenuLabel>
     </DropdownMenuGroup>
     <DropdownMenuSeparator />
     <DropdownMenuGroup>
       <DropdownMenuItem onClick={…}>…</DropdownMenuItem>
     </DropdownMenuGroup>
   </DropdownMenuContent>
   ```
4. **通用规律**:base-ui 的所有 `*.Group`、`*.Item`、`*.Label` 类子件都强制要求父 Context 存在,不要假定可以扁平嵌套。遇到类似的 "context is missing" 错误,先想想是不是缺了一层包裹。

---

## ⚠️ useChat v4 使用规范（Step 9 踩坑后补充）

本项目使用 `@ai-sdk/react@^1.2.12`（对应 `ai@^4.3.19`），API 与 v5/v6 差异较大。以下规范后续步骤遵守：

1. **`data` 字段是累积数组**：`useChat` 返回的 `data: JSONValue[]` 会在整个 hook 生命周期内累积所有请求的 data part（底层通过 SWR 缓存）。**使用前必须按 `type` 字段过滤 + 取最后一条**，不能假定 `data[0]` 就是当次请求的数据。
2. **sessionId 透传用 `experimental_prepareRequestBody` + ref**：在 hook 选项里声明 `experimental_prepareRequestBody: ({ messages }) => ({ messages, tenantId, sessionId: sessionIdRef.current })`，从 data part 的 `{ type: 'session', sessionId }` 里提取 sessionId 写进 `useRef`。不要用 `body` 选项（它是静态的，无法动态更新 sessionId）。
3. **`status` 优先于 `isLoading`**：`status` 提供 `'submitted' | 'streaming' | 'ready' | 'error'` 四态，比布尔值 `isLoading` 信息量大得多。用 `status` 判断 UI 状态（禁用输入框、转圈、错误提示）。
4. **流响应构造**：后端不要用 `toUIMessageStreamResponse()`（v5 API，v4 不存在）。正确写法是 `createDataStreamResponse({ execute: async (dataStream) => { ... } })`，在 `execute` 内先 `dataStream.writeData()` 推 sessionId，再 `result.mergeIntoDataStream(dataStream)`，最后 `await result.text` 后推 citations。
5. **`onFinish` 回调**：在 `streamText({ onFinish })` 里用 admin client 写库（user message + assistant message + citations）。回调内必须 `try/catch` 包裹——写库失败不能影响已流给用户的响应（流已经发出去了）。

---

## ⚠️ Node 库互操作坑(Step 6 踩坑后补充)

某些老 CJS Node 库在 Next.js 15 RSC 打包下会炸,典型症状是 import 阶段就抛 `TypeError: Object.defineProperty called on non-object`(根本进不到业务代码)。根因是这些库在 CJS 入口文件顶部有副作用语句(如 `Object.defineProperty(exports, Symbol.toStringTag, ...)`),而 webpack 为 RSC 生成的 `exports` 代理对象不可写。

**标准修复组合拳**(缺一不可):

1. **动态 import**:不要在文件顶部 `import X from 'x'`,改成在使用处 `const X = await import('x')`。这样打包时该模块不会在 RSC graph 顶层被求值。
2. **`next.config.ts` 加 `serverExternalPackages`**:把库名加进顶级 `serverExternalPackages: ['xxx']` 数组,让 Next.js 按 Node 原生外部依赖加载,**不要**参与 webpack 打包。Next.js 15 用的是顶级 `serverExternalPackages`,不是老版的 `experimental.serverComponentsExternalPackages`。
3. **改完必须重启 dev server**:`next.config.*` 变更 Next.js 一般会自动重启,但保险起见手动 Ctrl+C 再 `pnpm dev`。

**已踩的坑**:

- `pdf-parse` v2.4.5:已按上面两步修复。注意 v2 **只导出 `PDFParse` 类**,没有 v1 那种 default callable,正确写法:
  ```ts
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  return result.text;
  ```
  网上搜到的 `(await import('pdf-parse')).default(buffer)` 是 v1 API,在本项目会返回 undefined,不要照抄。

**将来再遇到类似症状**(import 阶段报 `Object.defineProperty called on non-object`、`exports is not defined`、`Cannot assign to read only property 'exports'` 之类):典型高危库包括 `mammoth`(docx)、`xlsx` / `exceljs`、部分 PDF/OCR 库,按"动态 import + `serverExternalPackages`"组合修复即可。`cheerio` 目前是 ESM 原生,静态 import 没问题。

---

## ⚠️ `server-only` 使用规范(Step 5 踩坑后补充)

`server-only` 的设计是:**只要被导入,非 RSC / 非 Next 服务端环境就会在 import 时抛错**(`This module cannot be imported from a Client Component module.`)。`tsx` 脚本、单元测试都属于"非 RSC 环境",会被直接拒绝。踩坑后约定如下规范,后续所有 Step 遵守:

1. **只在真正读 secret 的文件加 `import 'server-only';`**——例如读 `SUPABASE_SERVICE_ROLE_KEY`、`SILICONFLOW_API_KEY`、其他服务端专属凭证的模块。目的是防止这些文件被前端打包进 bundle 泄露 key。
2. **纯函数工具库不要加**。典型例子:字符串切块(`chunk.ts`)、HTML/PDF 解析(`loader.ts`)、通用 utils。这些即使只在服务端跑也不读 secret,加了就会让 `scripts/` 下的一次性脚本和将来的单元测试无法运行。
3. **同一文件既有纯函数又读 secret → 拆成两个文件**:
   - `xxx-core.ts`:无 `server-only`,把 secret 作为参数显式传入,保持纯函数可测。
   - `xxx.ts`:加 `server-only`,从 `process.env` 读 key,转调 `xxx-core`。生产代码(Route Handler / Server Action)导入这个薄包装。
   - 脚本和测试导入 `-core` 版本,自己从 `process.env` 取 key 传进去。
   - 已落地样例:`lib/rag/embed-core.ts`(纯函数,接 `{ apiKey, baseURL }`) + `lib/rag/embed.ts`(薄包装,读 env,带 `server-only`)。
4. **判断口径**:写一个新工具文件前先问自己"它是否直接 `process.env.XXX_KEY`"。是 → 加 `server-only`;否 → 不加。不要"为了保险"默认加。

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

## 0.5 P1 完成记录

- **P1 完成时间**:2026-04-14
- **已完成**:Step 1(初始化)、Step 2(Supabase 三客户端 + middleware)、Step 3(登录/注册页)、Step 4(Dashboard 布局 + 概览页 + Marketing 落地页),含 Step 4 头像下拉的 hotfix
- **主要踩坑**:
  1. `create-next-app@latest` 默认拉 Next.js 16,主动降级回 Next.js 15.5.15(见版本锁定块)
  2. shadcn CLI 默认预设从老 Radix New York 切到 `base-nova / @base-ui/react`,API 差异详见"base-nova / base-ui 兼容注意事项"小节
  3. Supabase 免费版内置邮件服务有严格速率限制,开启 Confirm email 测试触发 HTTP 429,开发阶段已临时关闭(Phase 5 上线前需重开 + 配 SMTP,见 Step 14 验收)
  4. base-ui 的 `DropdownMenuLabel` / `DropdownMenuItem` 必须嵌套在 `<DropdownMenuGroup>` 内,否则报 `MenuGroupRootContext is missing`
- **测试账号**:Supabase Authentication → Users 里已建若干测试账号(具体数量见控制台),登录/注册流程均已验证
- **下一步**:Phase 2 起点 = Step 5(`lib/rag/{chunk,embed,loader}.ts`),将由新会话继续

---

## 0.6 P2 完成记录

- **P2 完成时间**:2026-04-14
- **已完成**:Step 5(RAG 工具库 `lib/rag/{chunk,embed-core,embed,loader,ingest}.ts`)、Step 6(摄取 API `app/api/ingest/{file,url}/route.ts` + `app/api/documents/{route,[id]/route}.ts`)、Step 7(知识库前端 `/knowledge` 列表页 + `/knowledge/upload` 上传页,含状态筛选 Tabs、5 秒轮询、Dialog 二次确认删除、点击+拖拽双入口上传)
- **主要踩坑**(按踩坑顺序):
  1. **`server-only` 使用规范**:`lib/rag/embed.ts` 因 `import 'server-only'` 导致 `tsx` 脚本无法直接 import(`server-only` 非 RSC 环境就抛错)。解法:拆成 `embed-core.ts`(纯函数,无 `server-only`,把 `{ apiKey, baseURL }` 作为参数显式传入)+ `embed.ts`(带 `server-only` 的薄包装,从 `process.env` 读 key 后转调 core)。规律已写入"⚠️ `server-only` 使用规范"小节。
  2. **`pdf-parse` CJS/ESM 互操作炸库**:Next.js 15 RSC 打包下,顶层 `import { PDFParse } from 'pdf-parse'` 触发 `TypeError: Object.defineProperty called on non-object`(根因:pdf-parse v2.4.5 CJS 入口顶部有 `Object.defineProperty(exports, Symbol.toStringTag, ...)` 副作用,webpack RSC 的 exports 代理不可写)。解法组合拳:**动态 import**(`const { PDFParse } = await import('pdf-parse')`)+ `next.config.ts` 加顶级 `serverExternalPackages: ['pdf-parse']`(Next.js 15 是顶级字段,不是老版 `experimental.serverComponentsExternalPackages`)。规律已写入"⚠️ Node 库互操作坑"小节。另注:网上搜到的 `(await import('pdf-parse')).default(buffer)` 是 v1 API,在 v2 返回 undefined,不要照抄。
  3. **11MB FormData 测试触发 Next.js body size 上游拦截**:返回 400 "请求格式错误,需要 multipart/form-data" 而非业务层期望的 413,请求根本没到 route handler 的 10MB 校验分支。功能上超大文件依然被拒绝,前端已按 10MB 硬拦,接受此行为。
  4. **复制 UUID 带 `\u00a0` 不间断空格**:Step 6 curl 验收时末尾混入不间断空格导致 `DELETE /api/documents/:id` 400。Step 7 前端实现已统一用 `doc.id` 对象取值,不走字符串拼接,后续 Step 也应沿用此惯例。
- **测试账号**:Supabase Users 数量待自查
- **下一步**:**Phase 3 起点 = Step 8 — RAG 检索 + Chat API**
  - 要建的文件:`lib/rag/retrieve.ts`、`app/api/chat/route.ts`
  - 技术点:
    - `retrieveContext(query, tenantId, topK)` 调用 `match_document_chunks` RPC(已在 Supabase SQL 中定义),使用 admin client(C 端匿名场景也要能用,函数内按 `tenant_id` 过滤)
    - Chat API 用 Vercel AI SDK 的 `streamText`(锁定 `ai@^4.3.19`,不是 v6)指向 SiliconFlow `deepseek-ai/DeepSeek-V3`
    - System Prompt 见 CLAUDE.md Step 8 原文(严格依据知识上下文、无则拒答、末尾 `[来源 N]` 引用)
    - `onFinish` 里用 admin client 写 `chat_sessions`(若无 sessionId 则创建,`user_id=tenantId`、`visitor_id=visitorId 或 'playground'`)+ `chat_messages`(user + assistant,assistant 带 citations)
    - 通过 data part 回传 sessionId 和 citations 给前端
  - 将由新会话继续

---

## 0.7 P3 完成记录

- **P3 完成时间**：2026-04-15
- **已完成**：Step 8（RAG 检索 + Chat API：`lib/rag/retrieve.ts`、`app/api/chat/route.ts`）、Step 9（Playground 聊天页：`components/chat/ChatWindow.tsx`、`app/(dashboard)/playground/page.tsx`）
- **主要踩坑**：
  1. **Vercel AI SDK v4 没有 `toUIMessageStreamResponse`**（那是 v5 API）。v4.3.19 正确写法是 `createDataStreamResponse({ execute })` + `result.mergeIntoDataStream(dataStream)` + `dataStream.writeData()` 推送自定义数据（sessionId、citations）。
  2. **useChat v4 的 `data` 字段是累积数组**：所有请求的 data part 都会追加进 `data: JSONValue[]`，使用时必须按 `type` 过滤并取最后一条，不能假定 `data[0]` 就是当次请求的数据。
  3. **sessionId 透传方案**：`experimental_prepareRequestBody` + `useRef` 是声明式方案，已在 Step 9 落地验证。ref 在 `useEffect([data])` 里从 data part 提取 sessionId 并更新，`experimental_prepareRequestBody` 回调在每次请求时读 `ref.current`。
  4. **验收时容易被历史残留数据干扰**：测试多轮 session 前最好在 Supabase 清空之前的 playground session，或用 `ORDER BY created_at DESC LIMIT 1` 精确定位最新 session。
  5. **Dashboard layout 改为 `h-screen overflow-hidden`**：原 `min-h-screen` 无法让 ChatWindow 的 `h-full` + `overflow-y-auto` 正确约束滚动区域，改为 `h-screen` 后 main 区域有限定高度。
- **下一步**：**Phase 4 起点 = Step 10 — C 端公开聊天页**
  - 要建的文件：`app/chat/[tenantId]/page.tsx`
  - 技术点：
    - 服务端校验 tenantId UUID + 该用户有 documents
    - 客户端 `localStorage` 生成 visitorId（`nanoid`）
    - 复用 `<ChatWindow mode="public" visitorId={...} />`
    - `?embed=1` 隐藏 header、背景透明（为 Step 12 widget.js iframe 准备）
    - `/api/chat` 的 C 端分支加内存 Map 速率限制（60 秒 20 条）
  - 将由新会话继续

---

## 0.8 P4 完成记录

- **P4 完成时间**：2026-04-17
- **已完成**：Step 10（C 端公开聊天页：`app/chat/[tenantId]/{page,PublicChatClient,not-found}.tsx` + `middleware.ts` matcher 放行 + `app/api/chat/route.ts` 加内存 Map 速率限制）、Step 11（Deploy 页：`app/(dashboard)/deploy/page.tsx` + `_components/ShareLinkCard.tsx` + `_components/EmbedCodeCard.tsx`)
- **主要踩坑 / 决策**：
  1. **middleware matcher 同时放行 `/chat/*` 和 `/widget.js`**：用 negative lookahead `"/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|chat/|widget\\.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)).*)"`，避免 middleware 给匿名访问塞 Supabase cookie 刷新逻辑。之所以既要放行页面又要放行脚本路由，是因为 widget.js 本身是 Route Handler，经过 middleware 会带 cookie 做无意义的 session refresh。
  2. **租户存在性校验比手册更严**：`app/chat/[tenantId]/page.tsx` 查 documents 时额外带 `.eq('status','ready')`，租户即便有 `processing` 或 `failed` 文档也会 `notFound()`。手册只写"该用户有 documents"，但实际如果只有 processing 文档，访客进来也没法对话，不如直接 404。
  3. **visitorId SSR 安全**：`PublicChatClient.tsx` 必须把 `localStorage.getItem` 放进 `useEffect`，首次渲染返回占位 `<div class="h-full" />`，避免 useChat 以 `undefined` visitorId 初始化后再变更导致 hook 状态混乱。
  4. **B 端 playground 绕过限流**：`/api/chat` 的限流条件是 `!isOwner && visitorId`，B 端登录用户 `isOwner=true` 直接跳过。这与手册"C 端速率限制"设计一致，OK。
  5. **懒清理 rateLimitMap**：在内存 Map 超过 1000 key 时才扫描删除过期条目，避免每次请求都遍历全表。生产换 Redis 时此逻辑一起移除。
  6. **`NEXT_PUBLIC_APP_URL` fallback**：Deploy 页用 `?? 'http://localhost:3000'` 防止本地开发环境变量缺失导致白屏。
- **下一步**：**Phase 5 起点 = Step 12 widget.js**

---

## 0.9 P5 完成记录

- **P5 完成时间**：2026-04-17
- **已完成**：Step 12（widget.js：`app/widget.js/route.ts` + `next.config.ts` 加 `frame-ancestors *` CSP + `test-widget.html`)、Step 13（Markdown + 引用 + 打磨：`components/chat/ChatWindow.tsx` 引入 `react-markdown`/`remark-gfm` + citation 独立 toggle chip + `app/(dashboard)/knowledge/page.tsx` 状态筛选 Tabs + 骨架屏 + 空状态 + `app/error.tsx` 全局错误边界)、Step 14（文档：`README.md` + `DEPLOYMENT.md`，含上线前 checklist)
- **主要踩坑 / 决策**：
  1. **跨域 iframe 嵌入必须加 CSP `frame-ancestors *`**：手册原文未提及。Next.js 默认给所有页面加 `X-Frame-Options: SAMEORIGIN`，第三方域用 widget iframe 嵌入 `/chat/[tenantId]?embed=1` 会被浏览器拒。`next.config.ts` 用 `async headers()` 只对 `source: '/chat/:path*'` 放开 `Content-Security-Policy: frame-ancestors *`（现代浏览器优先级高于 `X-Frame-Options`，可覆盖默认），其他路径保持 SAMEORIGIN 不动。属于嵌入 Widget 必备配套，手册漏了。
  2. **widget 脚本零外部依赖原则**：所有 SVG 图标内联，样式用 inline style，DOM id 加 `__aics_` 前缀防止与宿主页面冲突。`window.__aics_loaded` 幂等标记防止多次加载 script 重复初始化。
  3. **citation chip 改为独立 toggle**：手册只说"可点击 chip，点击展开显示对应 chunk 原文"，实际实现用 `useState<Set<number>>` 让每条来源独立展开/折叠，允许同时展开多条做对比。
  4. **widget `NEXT_PUBLIC_APP_URL` fallback**：未配置时回落到 `request.nextUrl.origin`，本地开发跑 `npx serve test-widget.html` 时不会因缺环境变量炸掉脚本。
  5. **错误边界区分 dev/prod 文案**：`app/error.tsx` 在 `NODE_ENV==='development'` 下显示 `error.message`，生产环境只显示"请刷新页面或稍后重试"避免泄露内部信息。
  6. **EmbedCodeCard 提示文案已过时**：`"嵌入功能将在后续版本启用，当前复制的代码暂不生效"` 来自 Step 11 当时 Step 12 尚未实现。widget.js 已可用，该文案**不准确**但不影响功能——将来重构 Deploy 页时顺手删改。
- **MVP 结语**：至此 14 个 Step 全部完成，`tsc --noEmit` + `pnpm build` 均通过。上线前剩余事项严格按 `DEPLOYMENT.md` 的"上线前检查清单"逐条执行（重开 Confirm email + 配自定义 SMTP + RLS 自检 + `NEXT_PUBLIC_APP_URL` 更新为生产域名 + Service Role Key 未泄露）。

---

## 0.10 P6 完成记录

- **P6 完成时间**：2026-04-19
- **已完成**：Step 15（扩展文件格式支持）
  - 新增 Word `.docx` 上传：`lib/rag/loader.ts` 加 `loadDocx(buffer)`，底层 `mammoth.extractRawText({ buffer })`
  - PDF 解析器从 `pdf-parse` 升级为 `unpdf`：`loader.ts` 的 `loadPdf` 重写为 `const { extractText, getDocumentProxy } = await import('unpdf')` → `extractText(pdf, { mergePages: false })`
  - 扫描件（图像 PDF）启发式拦截：`SCANNED_PDF_CHAR_PER_PAGE_THRESHOLD = 50`，`totalPages >= 2 && avgPerPage < 50` 时抛错，错误文案"该 PDF 疑似扫描件或图像 PDF…当前版本暂不支持 OCR，请提供带文字层的 PDF"
  - DB 侧:`content_type` check 约束扩 `docx`,`DocumentContentType` TS 类型同步
  - 前端白名单扩 `.docx`:上传页 `ALLOWED_EXTS = ["pdf","txt","docx"]` + `FILE_ACCEPT` 同步 MIME、`.doc` 单独给友好提示"暂不支持 .doc 老格式,请在 Word 中另存为 .docx 后上传"
  - API `/api/ingest/file` 加 `docx` 分支 + `.doc` 显式 415 + loader 抛错兜底写 `documents.status='failed', error_message`
  - 知识库列表 Type 列渲染:`docx → "Word"`
  - 卸载 `pdf-parse` / `@types/pdf-parse`,安装 `mammoth@^1.12.0` + `unpdf@^1.6.0`,`next.config.ts` 的 `serverExternalPackages` 从 `["pdf-parse"]` 换成 `["mammoth"]`
- **主要踩坑 / 决策**：
  1. **mammoth 没有官方 `@types` 包**:DefinitelyTyped 查询无果。按项目"禁用 `any`"铁律,在 `loader.ts` 内声明局部类型 shim(`MammothExtractRawTextResult` + `MammothModule` interface),动态 import 后用 `as unknown as MammothModule` 收窄。比装 `@types/mammoth` 通用包(不存在)或污染 `tsconfig` 更干净。
  2. **mammoth 必须走动态 import + `serverExternalPackages`**:mammoth 和 pdf-parse 都是老 CJS 库,顶层静态 import 会在 Next.js 15 RSC 打包下重复触发 `Object.defineProperty called on non-object`。沿用 Step 6 踩过的组合拳:`const { extractRawText } = await import('mammoth')` + `next.config.ts` 顶级 `serverExternalPackages: ['mammoth']`。pdf-parse 移除后,数组里只留 mammoth。
  3. **unpdf 是纯 ESM 原生,但风格对齐其他 loader 也走动态 import**:`unpdf` 实际静态 import 可用,但保持 `loadPdf` / `loadDocx` 两个 loader 都是 `await import(...)` 的一致写法,读代码时不用区分哪个是动态哪个是静态。代价是每次调用多一次 micro-task,量级忽略。
  4. **扫描件阈值选 50 字/页**:纯扫描件平均每页能被文字层提取出来的字符数接近 0(偶尔有水印/页码干扰给几个字),带文字层的中文 PDF 通常至少 200+ 字/页,50 是安全分界。同时要求 `totalPages >= 2` 避免 1 页小文件(比如只有标题的单页 PDF)被误判。
  5. **catch 兜底写 `documents.failed`**:loader 层抛错时(扫描件判定 / mammoth 解析失败),`processAndStoreDocument` 还没跑到,`documents` 行停在 `processing` 会让前端"处理中"徽章永远转圈。route 的 catch 块里显式 `admin.from('documents').update({ status: 'failed', error_message: message.slice(0, 1000) })`,让知识库列表失败徽章 tooltip 能显示原因。`processAndStoreDocument` 自身也会转 failed,此处相当于幂等覆盖写。
  6. **Step 15 刻意不做 OCR 和异步化**:原始设计讨论过"轻/中/重"三档方案,用户选择分两步——Step 15 只升级解析器 + 拒绝扫描件,让方案保持"同步返回"不需要改 DB schema 或架构(ingestion job 队列);OCR + 异步化单独拆成 Step 18 预告,由用户以后有真实扫描件需求时再启动。
- **下一步**:**Step 16 — Vercel 部署**(待启动,不立即开始)

---

## 1. 技术栈(已锁定,勿改)

| 层 | 选型 |
|---|---|
| 框架 | Next.js 15 App Router + TypeScript |
| UI | Tailwind CSS + shadcn/ui (base-nova / `@base-ui/react`) |
| 数据库/Auth | Supabase (Postgres + pgvector + RLS) |
| AI SDK | Vercel AI SDK (`ai` + `@ai-sdk/openai`) |
| 切块 | `@langchain/textsplitters` 的 RecursiveCharacterTextSplitter |
| PDF | `unpdf`(Step 15 起替换 `pdf-parse`;扫描件目前硬拒,OCR 见 Step 18) |
| Word | `mammoth`(`.docx`,Step 15 起支持;`.doc` 老格式不支持) |
| 网页 | `cheerio` |
| Embedding | SiliconFlow `BAAI/bge-m3` (1024 维) |
| 对话模型 | SiliconFlow `deepseek-ai/DeepSeek-V3` |

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
SILICONFLOW_API_KEY=
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
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
  embedding vector(1024),
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
4. 添加组件:`npx shadcn@latest add button input label card dropdown-menu avatar separator sonner tabs table badge dialog textarea`(注:不安装 `form`,base-nova 预设下其 registry 下载失败;Auth 表单直接用 react-hook-form `Controller` + `Input`)。
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
2. `lib/rag/embed.ts`:导出 `embedTexts(texts: string[]): Promise<number[][]>`,用原生 `openai` 包 `new OpenAI({ baseURL: SILICONFLOW_BASE_URL, apiKey: SILICONFLOW_API_KEY })`,调用 `client.embeddings.create({ model: 'BAAI/bge-m3', input: batch })`,输出 **1024 维**(与 SQL schema `vector(1024)` 一致),批量 ≤100 条,失败重试 2 次。文件顶部加 `import 'server-only'`。
3. `lib/rag/loader.ts`:
   - `loadPdf(buffer: Buffer): Promise<string>` → pdf-parse
   - `loadTxt(buffer: Buffer): Promise<string>` → `buffer.toString('utf-8')`
   - `loadUrl(url: string): Promise<{ title: string; text: string }>` → fetch + cheerio,去除 script/style/nav/footer/header,取 body 文本

**✅ 验收方案**
- [ ] `tsc --noEmit` 通过
- [ ] (可选)让 Claude Code 写一个一次性 `scripts/test-rag.ts`,本地跑 `npx tsx --env-file=.env.local scripts/test-rag.ts` 验证能切块 + 生成 embedding(维度=1024)。验证完后删除脚本和 `tsx` devDependency。

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
- [ ] **上线前**到 Supabase Dashboard → Authentication → Sign In / Providers 重新开启 **Confirm email**,并配置自定义 SMTP(Resend / SendGrid 等)。开发阶段为绕开 Supabase 内置邮件服务的速率限制(HTTP 429)关闭了该开关,正式上线必须打开。

🎉 **MVP 完成。**

---

## 11. Phase 6 — 扩展格式支持(已完成)

### Step 15 — Word (.docx) + 完整 PDF 升级 ✅
详见 `0.10 P6 完成记录`。一句话回顾:`pdf-parse → unpdf`、新增 `mammoth` 解析 `.docx`、扫描件 PDF 启发式拦截(`< 50 字/页 + >= 2 页` 判图像 PDF)、loader 抛错兜底写 `documents.status='failed'`、`.doc` 老格式显式 415 拒绝,同步功能,未引入异步化。

---

## 12. Phase 7 — 上线部署

### Step 16 — Vercel 部署(下一步)
**做什么**
严格按 `DEPLOYMENT.md` 执行一次完整上线流程,目标产出:一个公网可访问、能邀请真实用户试用的生产环境。
1. **Supabase 生产项目**:若复用开发项目跳过;若另开,执行 `CLAUDE.md` 第 4 节 SQL + 上线前 checklist 的 RLS 自检
2. **SiliconFlow 生产 Key**:单独开一个,与本地开发 Key 分离,便于事故时吊销
3. **Vercel Import GitHub**:导入本仓库,Root Directory 留空,Framework 选 Next.js
4. **环境变量**:照 `.env.local.example` 全部填入 Vercel Project Settings → Environment Variables,**注意** `NEXT_PUBLIC_APP_URL` 要填 Vercel 分配的生产域名(或自定义域名)
5. **上线前 checklist**(照 `DEPLOYMENT.md` 第 180-190 行):
   - Supabase Dashboard 重开 Confirm email + 配自定义 SMTP(Resend / SendGrid)
   - Supabase Dashboard → Impersonate user 做 RLS 越权自测
   - 确认 Service Role Key 未出现在客户端 bundle
   - 本地跑一次 `pnpm build` 冒烟,零报错再 push
6. **部署后冒烟**:注册 → 登录 → 上传一个 PDF + 一个 docx → `/playground` 问答 → `/chat/{ownId}` 无痕窗口验公开页 → `test-widget.html` 改成生产域名验 widget

**✅ 验收方案**
- [ ] 公网域名访问首页成功
- [ ] 注册 → 收到确认邮件 → 激活后能登录
- [ ] 上传 PDF / docx / URL 均入库 `ready`
- [ ] `/playground` 问答流式正常 + `[来源 N]` 可展开
- [ ] 公开聊天页 `/chat/{ownId}` 无痕窗口可用,速率限制生效
- [ ] widget iframe 嵌入任意第三方静态页(本地 `test-widget.html` 换生产域名)可打开并对话
- [ ] Vercel 日志无 500 / 未处理异常

---

## 13. Phase 8 — C 端历史恢复

### Step 17 — C 端匿名历史恢复(方向 A)
**做什么**
目前 C 端访客刷新页面后对话历史丢失(只在 `useChat` 内存里),`chat_messages` 有持久化但前端不拉。Step 17 实现"匿名 + visitorId 恢复":
1. `localStorage.aics_visitor_id`(Step 10 已生成)作为访客身份
2. 页面挂载时请求新增接口 `GET /api/chat/history?tenantId=...&visitorId=...`(admin client,SQL 必须显式 `WHERE user_id = tenantId AND visitor_id = visitorId`,严格多租户隔离),取该 `visitor_id` 最近一条 `session` 的全部 `messages`,用 `useChat({ initialMessages })` 或 `setMessages` 回填
3. 保留"清空对话"按钮:本地清除 + 删远端 session(可选),用户主动触发才丢
4. **安全要点**:
   - 只接受 `visitorId` 作为恢复凭据,不做身份验证——属于"本机历史"级别,不是真正的身份系统
   - 换设备/清 localStorage 就找不回,这是已知权衡,不引入登录体系
   - 速率限制保留(读接口也要挂),避免有人爆 visitorId 空间
5. **方向 B 不做**:给 C 端接入 Magic Link 或 OTP 做真实身份恢复,跨设备可用,但引入新的登录流 + 邮件成本,暂不启动

**✅ 验收方案**
- [ ] 无痕窗口 `/chat/{tenantId}` 发若干消息 → 刷新 → 历史消息回填,引用 chip 仍可展开
- [ ] 清空 localStorage 的 `aics_visitor_id` → 刷新 → 变成新访客,历史消失
- [ ] 跨租户尝试:用 tenant A 的 visitorId 访问 tenant B 页面 → 拿不到 A 的历史(SQL 联查条件 `user_id = tenantId AND visitor_id = visitorId`,两个条件都要满足)

---

## 14. 预告(未启动)

### Step 18 — OCR + 异步化(原 Step 16,待定)
**背景**
Step 15 对扫描件做了硬拒绝,文案提示"当前版本暂不支持 OCR"。当真实用户带着图像 PDF 来且需求量够大时,再启动此 Step。

**要做的事(草案,到时细化)**
1. **OCR 引擎选型**:候选 `tesseract.js`(纯 JS,质量中等,部署零依赖)/ 云 OCR 服务(阿里 / 百度 / Textract,质量高但加 API 依赖和成本)
2. **异步化改造**:现有 `/api/ingest/file` 同步解析 + embedding,长 OCR 任务(单页 10-30 秒)会超时。需要把 ingest 拆成:
   - POST 立即返回 `documents.status='processing'`
   - 后台 Job 队列:候选 `QStash` / `Inngest` / Supabase Edge Functions + `pg_cron` / Vercel Cron
3. **前端轮询已就绪**:`knowledge/page.tsx` 已有 5 秒轮询,只要后台把 `status` 推到 `ready` 前端自动刷新,前端几乎不用改
4. **质量阀门**:OCR 识别结果置信度低的 chunk 打 `metadata.ocr_confidence`,检索时可按阈值过滤

**启动条件**
用户收集到 >=3 份真实扫描件需求,且愿意承担 OCR 引擎成本/部署复杂度后,重启此 Step。

---

## 15. 与 Claude Code 协作约定

- 开始任何一个 Step 前,Claude Code 先回答:**"我将开始 Step N,计划修改的文件是 … ,需要运行的命令是 … ,预计耗时 …,确认开始吗?"** 等用户回复"开始"再动手。
- 完成后固定输出三块:
  1. **变更摘要**(新建/修改/删除的文件列表)
  2. **✅ 验收方案**(手动步骤 + SQL 或 curl 命令)
  3. **下一步预告**(下一个 Step 是什么,在等用户"通过"信号)
- 遇到本文档未定义的问题,**先问用户**,不要自己发明方案。
- 若用户反馈"不通过",Claude Code 必须根据反馈修复,**不能跳到下一 Step**。
