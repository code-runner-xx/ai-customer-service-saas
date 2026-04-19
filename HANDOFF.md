# AI 客服知识库 SaaS —— 新会话交接文档

生成时间:2026-04-17(P5 完成版)
当前进度:**P1-P5(14/14 Step)代码全部实装,`tsc --noEmit` 零错误,`pnpm build` 通过,待执行上线前 checklist**

---

## 一、项目定位

企业级多租户 AI 知识库 + 智能客服 SaaS MVP。企业主(B 端)上传文档 → 自动切块向量化 → 生成公开链接给终端用户(C 端)对话问答,回答严格基于 RAG 检索,引用原文不胡编。

---

## 二、技术栈锁定(已全部上线运行)

| 层 | 实际选型 | 版本/备注 |
|---|---|---|
| 框架 | Next.js | **15.5.15**(偏离原计划 15,创建时默认装成 16,已回退) |
| UI | shadcn/ui | **base-nova 预设**(底层是 @base-ui/react,不是 Radix) |
| 样式 | Tailwind CSS 4 | |
| Auth + DB | Supabase | Postgres + pgvector + RLS |
| AI SDK | Vercel AI SDK | **v4.3.19**(不是 v6,createDataStreamResponse + streamText) |
| AI 服务商 | **SiliconFlow**(国内,OpenAI SDK 兼容) | baseURL: https://api.siliconflow.cn/v1 |
| Embedding | BAAI/bge-m3 | **1024 维**(不是 OpenAI 的 1536) |
| 对话模型 | deepseek-ai/DeepSeek-V3 | |
| Node | v24.14.1 | |
| 包管理器 | pnpm | v10.33.0 |

## 三、当前进度

| Phase | Step | 状态 |
|---|---|---|
| P1 项目骨架 | S1 初始化、S2 Supabase、S3 Auth、S4 Dashboard | ✅ |
| P2 知识库摄取 | S5 RAG 工具库、S6 摄取 API、S7 知识库前端 | ✅ |
| P3 RAG 对话 | S8 检索 + Chat API、S9 Playground 聊天页 | ✅ |
| P4 C 端页面 | S10 公开聊天页、S11 Deploy 页 | ✅ |
| P5 Widget + 打磨 | S12 widget.js、S13 Markdown + 打磨、S14 文档 | ✅ |

所有 14 个 Step 的验收方案已按手册逐条跑过,代码、静态检查、`pnpm build` 均通过。剩余事项全部是运维/上线准备,见第十节。

---

## 四、重要:已踩过的坑(新 Claude 必读,不要重复踩)

### 坑 1:base-nova / base-ui 不兼容老 Radix API
- `Button / DropdownMenuTrigger` 没有 `asChild`。按钮+链接用 `buttonVariants({...})` 套 className 到 `<Link>`
- `DropdownMenuLabel / DropdownMenuItem` 必须嵌在 `<DropdownMenuGroup>` 里,否则运行时 `MenuGroupRootContext is missing`
- 所有 `*.Group / *.Item / *.Label` 都强依赖父 Context
- 遇到 `XxxContext is missing` 先想是不是少包了一层

### 坑 2:server-only 使用规范
- 只在真读 secret(SUPABASE_SERVICE_ROLE_KEY / SILICONFLOW_API_KEY)的文件加
- 纯函数(chunk、loader、utils)不要加,否则 tsx 脚本和测试无法 import
- 已落地拆分样例:`lib/rag/embed-core.ts`(纯函数,传参)+ `lib/rag/embed.ts`(薄包装,读 env,带 server-only)

### 坑 3:pdf-parse CJS/ESM 互操作
- 顶层 import 会触发 `TypeError: Object.defineProperty called on non-object`
- 解法组合拳:
  - `lib/rag/loader.ts` 里用 `const { PDFParse } = await import('pdf-parse')` 动态 import
  - `next.config.ts` 加 `serverExternalPackages: ['pdf-parse']`
- 未来引入其他老 CJS 库(mammoth、xlsx 等)如果报类似错用同样方法修

### 坑 4:Supabase Confirm email 速率限制
- 免费版内置邮件服务每小时只能发 3-4 封,测试时容易触发 429
- 开发阶段临时关闭 Confirm email(Authentication → Providers → Email)
- **上线前务必重新打开并配自定义 SMTP**(已写入 P5 验收清单)

### 坑 5:11MB FormData 测试触发 Next.js 上游 body 拦截
- 返回 400 "请求格式错误"而非业务层期望的 413
- 功能上超大文件依然被拒绝,接受此行为

### 坑 6:useChat v4 使用规范
- `data` 字段是累积数组,用前按 `type` 过滤 + 取最后一条
- sessionId 透传用 `experimental_prepareRequestBody + ref` 方案(Step 9 已落地)
- `status` 比 `isLoading` 信息量大(submitted / streaming / ready / error)

### 坑 7:验收时容易被历史残留数据干扰
- 多轮对话测试前最好清空 `chat_sessions` 里相关 session
- UUID 复制粘贴时小心末尾 `\u00a0` 不间断空格,前端统一用对象.id 取值

---

## 五、Supabase 数据库状态

**4 张业务表 + 1 个 RPC 函数 + RLS 策略都已就绪**:

- `documents` / `document_chunks`(1024 维 embedding)
- `chat_sessions` / `chat_messages`
- `match_document_chunks(query_embedding vector(1024), tenant_id uuid, match_count int, min_similarity float)`
- RLS 策略:own_documents / own_chunks / own_sessions / own_messages

`document_chunks_embedding_idx` 是 ivfflat(lists=100)。

---

## 六、.env.local 变量(新会话不要碰真实值,修改时只改 .example)

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SILICONFLOW_API_KEY=
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

---

## 七、测试账号 & 测试数据

- 主测试账号 user.id(tenantId): **`afcd94f9-8a2f-4d5e-b4f3-36dee5e8320e`**
- 当前知识库里有效文档:
  - 1 份 PDF(CSDN 博客 springboot)
  - 1 份 URL(SiliconFlow 产品简介)
- Supabase Users 里有 2-3 个测试账号

---

## 八、项目铁律(新会话也要遵守)

1. 语言:UI/注释中文,代码标识符英文
2. 类型:TypeScript strict,禁用 any
3. 多租户隔离:所有业务查询带 user_id,C 端 admin client 必须显式 `WHERE user_id = tenantId`
4. **每步停顿**:完成后输出验收方案并停下等用户确认,禁止跳步
5. 不跑 dev / 不碰 secrets(只改 .env.local.example)

---

## 九、对新会话的开场指令

复制下面这段到新 Claude Code 会话:

```
读取项目根目录的 CLAUDE.md 和 HANDOFF.md。读完后:

1. 用 3-5 句话复述项目铁律(语言、类型、多租户隔离、每步停顿、secrets)
2. 复述"base-nova 兼容 / server-only 规范 / useChat v4 规范 / pdf-parse 动态 import / iframe CSP"5 个关键规则
3. 告诉我当前进度(应该是 P1-P5 全部完成,`tsc --noEmit` 和 `pnpm build` 均通过,待执行上线前 checklist)
4. 列出上线前 checklist(见 DEPLOYMENT.md 第 180-190 行):
   a) 重开 Supabase Confirm email 并配自定义 SMTP(Resend / SendGrid)
   b) `NEXT_PUBLIC_APP_URL` 更新为生产域名并 Redeploy
   c) 4 张业务表 RLS 均为 enabled
   d) 用无痕窗口访问 `{APP_URL}/chat/{ownId}` 自测能对话
   e) 用 `test-widget.html` 验证 widget 悬浮按钮 + 弹窗
   f) `SUPABASE_SERVICE_ROLE_KEY` 未泄露(未出现在 Git 记录 / 前端 bundle)

确认后等我下一步指令(上线 / 新功能 / bug 修复)。不要立即写代码。
```

---

## 十、上线前验收 checklist(对齐 DEPLOYMENT.md:180-190)

**必做项**:

- [ ] **Supabase Confirm email 重开 + SMTP**:Dashboard → Authentication → Providers → Email → 打开 Confirm email;Dashboard → Authentication → SMTP Settings 填入 Resend / SendGrid / AWS SES,避开内置邮件服务的 429 速率限制
- [ ] **`NEXT_PUBLIC_APP_URL` 生产域名**:Vercel Env Vars 里改为生产域名(如 `https://aics.yourdomain.com`),Deployments → 最新部署 → Redeploy 生效
- [ ] **RLS 自检**:Dashboard → Table Editor 逐个看 `documents` / `document_chunks` / `chat_sessions` / `chat_messages` 四张表,确认均显示 **RLS enabled**
- [ ] **C 端公开链接自测**:无痕窗口访问 `{APP_URL}/chat/{ownUserId}`,能进入聊天页、localStorage 有 `aics_visitor_id`、能收到流式回答、Supabase `chat_sessions` 出现 nanoid visitor_id
- [ ] **notFound 路径自测**:访问 `{APP_URL}/chat/00000000-0000-0000-0000-000000000000`,应显示"客服链接无效"页而非 500
- [ ] **速率限制自测**:无痕窗口连发 25 条消息,第 21 条起应收到 429 `{"error":"请求过于频繁…"}`
- [ ] **Widget 自测**:`test-widget.html` 里把 `t=` 参数换成生产 userId,用 `npx serve .` 起静态服务器访问,右下角蓝色按钮出现 + 点击弹出聊天窗 + 能对话 + 移动端(DevTools 手机模式)切换为全屏
- [ ] **Service Role Key 未泄露**:`git log -p | grep -i service_role` 应无命中;Vercel 环境变量 `SUPABASE_SERVICE_ROLE_KEY` 只在 Production 勾选,未暴露到前端 bundle
- [ ] **`pnpm build` 冒烟**:本地跑一次 `pnpm build`,无 webpack 报错、无 `Module not found`、无运行时崩溃(已跑过一次 ✅,上线前再跑一次)

**主测试账号**:user.id = `afcd94f9-8a2f-4d5e-b4f3-36dee5e8320e`

**不存在 tenantId(测 notFound)**:`00000000-0000-0000-0000-000000000000`

---

**P5 交接完成,14/14 Step 全通,可进入上线阶段。**