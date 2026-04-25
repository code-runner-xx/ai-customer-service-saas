# AI 客服知识库 SaaS —— 新会话交接文档

生成时间:2026-04-24(Step 20 完成版 / C 端视觉美化已上线)
当前进度:**P1-P5 MVP(14/14 Step)+ Step 15 docx/PDF 升级 + Step 16 Vercel 上线 + Step 17 C 端匿名历史恢复 + Step 19 5 条技术债务收尾 + Step 20 C 端视觉美化(accent-brand token + Widget tooltip),全部闭环。生产域名 `https://ai-customer-service-saas.vercel.app` 已真实跑通。下一步方向:由用户决定(B 端美化 / 性能优化 / Step 18 OCR & 异步化任选)。**

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
| PDF 解析 | **unpdf**(Step 15 从 pdf-parse 升级) | 扫描件硬拒(`<50 字/页 && 页数≥2`),OCR 留 Step 18 |
| Word 解析 | **mammoth**(Step 15 新增) | 只支持 `.docx`,`.doc` 老格式显式 415 |
| 网页抓取 | cheerio | Step 19 收紧广告选择器 + 行级 `cleanNoise` |
| Node | v24.14.1 | |
| 包管理器 | pnpm | v10.33.0 |

---

## 三、当前进度

| Phase | Step | 状态 | 备注 |
|---|---|---|---|
| P1 项目骨架 | S1-S4 | ✅ | |
| P2 知识库摄取 | S5-S7 | ✅ | |
| P3 RAG 对话 | S8-S9 | ✅ | |
| P4 C 端页面 | S10-S11 | ✅ | |
| P5 Widget + 打磨 | S12-S14 | ✅ | MVP 14 Step 完成 |
| P6 格式扩展 | S15 Word + unpdf 升级 | ✅ | 2026-04-19 |
| P7 上线 | S16 Vercel 部署 | ✅ | 2026-04-20,最小可行路径(未拆生产 Supabase、未配 SMTP、未自定义域名,刻意跳过) |
| P8 C 端体验 | S17 匿名历史恢复 | ✅ | 2026-04-22,方向 A(visitorId + localStorage),双条件过滤 |
| — | **S19 技术债务打包收尾** | ✅ | 2026-04-22,5 条(a/b/e/g/h)集中修 |
| P9 C 端视觉 | **S20 视觉美化** | ✅ | 2026-04-24,Linear-style indigo accent-brand,Public Chat + Widget,B 端 25+ 处按钮零触碰 |
| — | S18 OCR + 异步化 | ⏸ 预告,未启动 | 触发条件:扫描件真实需求 ≥ 3 份 **或** 单文件 embedding 超时投诉首次出现 |

> **Step 编号说明**:Step 18 保留给 OCR + 异步化,本次打包修技术债用 Step 19 避开冲突。

代码、`tsc --noEmit`、`pnpm build`、Vercel 生产部署均通过,真实用户可访问。

### Step 20 视觉美化交付速览(2026-04-24)

**范围**:Public Chat + Widget(严格 C 端,B 端零影响)

**改动文件**(3 文件 +57 净增):
- `app/globals.css` +6:新增 `--accent-brand` / `--accent-brand-fg` 两个 oklch token + `@theme` 映射
- `components/chat/ChatWindow.tsx` +7 净增:5 处改动
- `app/widget.js/route.ts` +44 净增:8 处改动

**视觉成果**:
- Linear-style indigo `oklch(0.488 0.196 264)` 作为单一品牌强调色,稀缺出现
- 用户气泡 / 发送按钮 / citation chip active 染 accent
- citation chip resting 加极淡底色 `oklch(0.985 0 0)`
- C 端空状态加 `MessageCircleQuestion` 图标
- public 模式输入框下方常驻免责文案
- Widget FAB 关闭/打开两态切换(accent / 深灰 `oklch(0.3 0 0)`)
- Widget tooltip 中文化"有什么可以帮您?" + 3px 圆角指针(方案 a:常驻闭合态可见)
- `375px @media query` 右边距 16px,大屏保持 24px
- Widget input 高度 40px(实测 41.6px,达 iOS/Android HIG 标准)

**协作流程**:Claude Design 三轮迭代出 design system → Claude Code 分 Step A/B/C 落地 → 本地 dev 验收 → Vercel Preview 验证 → 合并 main → 生产部署

**验收数据**:B 端 25+ 处 `--primary` 按钮零影响;bundle First Load shared = 102 kB 持平;`tsc --noEmit` 零错;`pnpm build` 5.1s 零错零警告

**新增遗留债 (j)**:品牌名不一致——`app/chat/[tenantId]/page.tsx` 用"AI 智能客服",其他页面用"AI 客服"。历史遗留,5 分钟字符串替换可清理,以后单独做

---

## 四、生产环境状态

- **生产域名**:https://ai-customer-service-saas.vercel.app
- **部署平台**:Vercel Hobby(免费版)
  - 请求体上限 **4.5MB**(Step 19 已前后端统一)
  - Function `maxDuration` 默认 10s,三个 RAG/Chat 路由显式拉到 **60s**(`export const maxDuration = 60`)
  - 多实例 Serverless → 内存 Map 跨实例不共享(见技术债务 d)
- **GitHub 仓库**:https://github.com/code-runner-xx/ai-customer-service-saas
  - 主分支 `main` 接 Vercel 自动部署,push 即发布
- **Supabase 项目**:开发 / 生产**共用同一项目**(Step 16 决策,观察期内不拆)
  - 事故时数据与本地开发混杂,后续有真客户前必须拆分
- **SiliconFlow API Key**:复用本地开发 Key(Step 16 决策,未分离)
  - 吊销时需同步更新本地 `.env.local`
- **SMTP / Confirm email**:**未配**,注册不收确认邮件直接登录
- **自定义域名**:未配,用 Vercel 自动分配 `*.vercel.app`

---

## 五、重要:已踩过的坑(新 Claude 必读,不要重复踩)

### 坑 1:base-nova / base-ui 不兼容老 Radix API
- `Button / DropdownMenuTrigger` 没有 `asChild`。按钮+链接用 `buttonVariants({...})` 套 className 到 `<Link>`
- `DropdownMenuLabel / DropdownMenuItem` 必须嵌在 `<DropdownMenuGroup>` 里,否则运行时 `MenuGroupRootContext is missing`
- 所有 `*.Group / *.Item / *.Label` 都强依赖父 Context
- 遇到 `XxxContext is missing` 先想是不是少包了一层

### 坑 2:server-only 使用规范
- 只在真读 secret(SUPABASE_SERVICE_ROLE_KEY / SILICONFLOW_API_KEY)的文件加
- 纯函数(chunk、loader、utils)不要加,否则 tsx 脚本和测试无法 import
- 已落地拆分样例:`lib/rag/embed-core.ts`(纯函数,传参)+ `lib/rag/embed.ts`(薄包装,读 env,带 server-only)

### 坑 3:老 CJS 库动态 import + serverExternalPackages
- `pdf-parse`(已在 Step 15 换掉)/ `mammoth`(Step 15 新增) 都是 CJS 顶层副作用库
- 顶层 import 会触发 `TypeError: Object.defineProperty called on non-object`(webpack RSC 的 exports 代理不可写)
- 解法组合拳(二者缺一不可):
  - `loader.ts` 里用 `await import('mammoth')` 动态 import
  - `next.config.ts` 顶级 `serverExternalPackages: ['mammoth']`(Step 15 已从 `['pdf-parse']` 替换为 `['mammoth']`,unpdf 是纯 ESM 不必加)
- 未来引入其他老库(xlsx / exceljs / tesseract 等)报同类错,套同样组合拳

### 坑 4:Supabase Confirm email 速率限制
- 免费版内置邮件服务每小时只能发 3-4 封,测试时容易触发 429
- 开发 / Step 16 上线阶段均关闭 Confirm email(Authentication → Providers → Email)
- 服务真实客户前必须重开并配自定义 SMTP(见第十节"待执行"清单)

### 坑 5:Vercel Hobby 4.5MB body 上限
- 请求体超 4.5MB(含 multipart 开销)会被 Vercel 上游拦,返回 400 "请求格式错误",根本不到 route handler
- Step 19 (h) 前后端统一按 4.5MB 拦,避免浪费一次请求
- 放宽需换 Vercel 付费 plan 或走 Blob 直传,属架构改动

### 坑 6:useChat v4 使用规范
- `data` 字段是累积数组,用前按 `type` 过滤 + 取最后一条
- sessionId 透传用 `experimental_prepareRequestBody + ref`(Step 9 落地)
- `status` 比 `isLoading` 信息量大(submitted / streaming / ready / error)
- **`initialMessages` 非响应式**(Step 17 踩):只在首次挂载时读,后续 state 变更不刷新。公开聊天页必须 visitorId + history 双 ready 才挂载 ChatWindow,不能先挂再等 history

### 坑 7:验收时容易被历史残留数据干扰
- 多轮对话测试前最好清空 `chat_sessions` 里相关 session
- UUID 复制粘贴时小心末尾 `\u00a0` 不间断空格,前端统一用对象.id 取值

### 坑 8:跨域 iframe 嵌入必须加 CSP `frame-ancestors *`(Step 12)
- Next.js 默认给所有页面加 `X-Frame-Options: SAMEORIGIN`,第三方域嵌入 `/chat/[tenantId]?embed=1` 会被浏览器拒
- `next.config.ts` 用 `async headers()` **只对 `/chat/:path*`** 开 `Content-Security-Policy: frame-ancestors *`(现代浏览器优先级高于 `X-Frame-Options`)
- 其他路径保持 SAMEORIGIN 不动
- widget.js 路由本身也要在 middleware matcher 放行(避免 middleware 给匿名访问塞 Supabase cookie)

### 坑 9:Vercel AI SDK v4 不是 v5/v6(Step 8-9)
- 没有 `toUIMessageStreamResponse`(那是 v5 API)
- 正确写法:`createDataStreamResponse({ execute })` → `result.mergeIntoDataStream(dataStream)` → `dataStream.writeData()` 推自定义数据(sessionId、citations)
- `onFinish` 里写库必须 try/catch 包裹——流已经发给用户,写库失败不能反过来影响已流响应

### 坑 10:admin client 绕 RLS 必须显式双条件(Step 17)
- C 端匿名场景用 admin client 查 `chat_sessions`,SQL 必须显式 `WHERE user_id = tenantId AND visitor_id = visitorId`
- 缺一即跨租户泄漏:只按 `visitor_id` 过滤,A 租户访客的 visitorId 在 B 租户页面可偷到 A 的历史
- `chat_messages` 表没有 `user_id` 列,只能靠 session_id 间接隔离,session 查询条件必须严

### 坑 11:SiliconFlow embedding input 数组硬上限 32 条(Step 19 (a))
- 官方文档 `docs.siliconflow.cn/cn/api-reference/embeddings/create-embeddings`:**"the maximum array size is 32"**
- 原 `BATCH_SIZE = 100` 直接违反,返回 413(body 为空所以单看错误信息找不到根因)
- 已改 `BATCH_SIZE = 24`(32 × 75% 安全垫),同时保留 `MAX_BATCH_CHARS = 300_000` 作防御性兜底
- BAAI/bge-m3 **单条** 8192 tokens 上限不是问题(chunkSize=800 字 ≈ 1600 tokens,单条远远不会爆)

### 坑 12:拒答时写库和 UI 都不能带 citations(Step 19 (b))
- 模型按 system prompt 输出拒答文本("抱歉,我在知识库中没有找到相关信息…")时,前端 citations chip 仍渲染(虽然数组为空 guard 已有,但数据链路里拒答不该带引用)
- 修复方式:`app/api/chat/route.ts` 的 `streamText({ onFinish })` 里按文本匹配 `REFUSAL_MARKERS = ['没有找到相关信息', '联系人工客服']` 双命中即视为拒答,把 `finalCitations` 置空;`dataStream.writeData` 推送放在 `await result.text` 之后,用清洗过的 `finalCitations`;写库同步清洗,保证 `chat_messages.citations` 也干净

### 坑 13:loader 出口 `cleanNoise` vs chunk.ts 过短块过滤分工(Step 19 (e))
- `cleanNoise`(`lib/rag/loader.ts`):**行级**原文清理,整行命中规则 → 整行丢弃,**只**在 `loadPdf` / `loadUrl` 出口调
- `chunk.ts` 的 `trim().length < 20` 过滤:**块级**过滤,RecursiveCharacterTextSplitter 切块后再丢短碎片
- 两层互补,修改规则要对号入座,不要混
- cheerio 广告选择器要用四选择器组合 `[class*="ads"], [class*="ad-"], [class^="ad-"], [class$="-ad"]`,**不要**用 `[class*="ad"]`(会误伤 `header` / `card`——含字母序列 "ead" / "ard")

---

## 六、Supabase 数据库状态

**4 张业务表 + 1 个 RPC 函数 + RLS 策略都已就绪**:

- `documents` / `document_chunks`(1024 维 embedding)
  - `documents.content_type` check 约束:`pdf / txt / url / docx`(Step 15 扩 docx)
- `chat_sessions` / `chat_messages`
- `match_document_chunks(query_embedding vector(1024), tenant_id uuid, match_count int, min_similarity float)`
- RLS 策略:`own_documents` / `own_chunks` / `own_sessions` / `own_messages`

`document_chunks_embedding_idx` 是 ivfflat(lists=100)。

完整初始化 SQL 见 `CLAUDE.md` 第 4 节(Step 15 后版本,含 `docx`)。

---

## 七、.env.local 变量(新会话不要碰真实值,修改时只改 .example)

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SILICONFLOW_API_KEY=
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
NEXT_PUBLIC_APP_URL=http://localhost:3000   # 生产:https://ai-customer-service-saas.vercel.app
```

Vercel Env Vars 中 `NEXT_PUBLIC_APP_URL` 已填生产域名。改 `NEXT_PUBLIC_*` 需 Vercel Redeploy **且关闭 Build Cache**,否则新值不会烘焙进客户端 bundle。

---

## 八、测试账号 & 测试数据

- **主测试账号 A / user.id(tenantId)**:`afcd94f9-8a2f-4d5e-b4f3-36dee5e8320e`
  - 有若干知识库文档(PDF / Word / URL 混合,Step 19 验收时含 2.3MB 中文 txt 切出 507 chunks)
  - 用于 Playground + 公开聊天页主验收
- **测试账号 B**:Step 17 验收组 4(跨租户隔离)临时创建,UUID 未记录;若需重测跨租户,在 Supabase Authentication → Users 另建一个新邮箱账号,拿其 user.id 作 tenantId 即可
- **不存在 tenantId(测 notFound)**:`00000000-0000-0000-0000-000000000000`
- Supabase Users 总数自查 Dashboard

---

## 九、项目铁律(新会话也要遵守)

1. 语言:UI/注释中文,代码标识符英文
2. 类型:TypeScript strict,禁用 any(必要时 `unknown` 收窄)
3. 多租户隔离:所有业务查询带 user_id;C 端 admin client 必须显式 `WHERE user_id = tenantId`(Step 17 加强:`AND visitor_id = visitorId`)
4. **每步停顿**:完成后输出验收方案并停下等用户确认,禁止跳步
5. 不跑 dev / 不碰 secrets(只改 .env.local.example)
6. CJS 老库上新 Next 前先评估互操作风险,套"动态 import + serverExternalPackages"组合

---

## 十、上线 checklist —— 已执行 vs 待执行

### ✅ 已执行(Step 16 上线 + Step 17/19 回补)

- [x] **Vercel 部署**:GitHub 仓库接入,`main` 分支自动构建发布,生产域名 `ai-customer-service-saas.vercel.app` 可访问
- [x] **RLS 自检**:4 张业务表均显示 RLS enabled,跨租户 SQL 注入已实测(Step 17 组 4)
- [x] **C 端公开链接自测**:无痕窗口 `{APP_URL}/chat/{A-UUID}` 能对话,localStorage `aics_visitor_id` 正常生成,`chat_sessions` 有 nanoid visitor_id 写入
- [x] **notFound 路径自测**:访问 `{APP_URL}/chat/00000000-0000-0000-0000-000000000000` 显示 not-found 页
- [x] **widget 自测**:`test-widget.html` 改成生产域名访问,右下角按钮 + 弹窗正常,移动端全屏
- [x] **Service Role Key 未泄露**:未出现在 Git 记录或前端 bundle,Vercel Env Vars 仅 Production 生效
- [x] **`pnpm build` 冒烟**:零 webpack 报错 / 零 Module not found / 零运行时崩溃
- [x] **公开页刷新历史恢复**(Step 17):visitorId + tenantId 双条件过滤,跨设备丢失是已知权衡
- [x] **embedding 413 / 拒答空 chip / 加载清洁 / 过期文案 / 4.5MB 拦截**(Step 19 全部闭环)
- [x] **C 端视觉美化**(Step 20):accent-brand token + ChatWindow + Widget tooltip + 375px 响应式,B 端零触碰 + bundle First Load shared 持平 102 kB

### ⏸ 待执行(上生产服务真实客户时才必要,自用/演示阶段暂不做)

- [ ] **重开 Supabase Confirm email + 配自定义 SMTP**(Resend / SendGrid / AWS SES),避开内置邮件服务 429
- [ ] **自定义域名**:在 Vercel 接入独立域名,`NEXT_PUBLIC_APP_URL` 更新并 Redeploy(Build Cache 关闭)
- [ ] **Upstash Redis 上速率限制**:替换 `lib/rate-limit.ts` 的内存 Map(Serverless 多实例失效,见技术债 d)
- [ ] **Supabase 项目拆分**:开 production 独立项目,与开发环境数据隔离,事故时互不影响
- [ ] **SiliconFlow Key 分离**:生产单独开 Key,吊销不牵连本地开发

---

## 十一、剩余技术债务(非自用阻塞,真客户需求触发再做)

| 编号 | 债务 | 当前状态 | 触发条件 |
|---|---|---|---|
| (d) | 速率限制内存 Map 在 Vercel Serverless 多实例下不共享,攻击者轮询不同实例可绕过 | 保留 | 真实滥用出现 → 换 Upstash Redis |
| (e2) | 文档类网站(如 SiliconFlow 官网)导航菜单 / 搜索栏被 cheerio 抓进正文,Step 19 cleanNoise 覆盖不到 | 保留 | 真实客户抱怨知识库混入导航文本 → 按站点定制白名单(如只取 `article` / `main`) |
| Step 18 (OCR) | 扫描件 PDF 硬拒,无 OCR 支持 | 预告 | 扫描件真实需求 ≥ 3 份 |
| Step 18 (异步化) | 单文件超长(如 2.3MB 中文 txt 估算 40-80s embedding)触顶 Vercel Hobby 60s `maxDuration` | 预告 | 首次出现 embedding 超时投诉(两个触发点合并走 Step 18) |
| (j) | 全站品牌名不一致——`app/chat/[tenantId]/page.tsx` 用"AI 智能客服",其他页面用"AI 客服" | 保留 | 5 分钟字符串替换,以后单独做(Step 20 新增) |

---

## 十二、对新会话的开场指令

当前方向:**网页美化打磨(UI/UX 层,不动业务逻辑)**。复制下面这段到新 Claude Code 会话:

```
读取项目根目录的 CLAUDE.md 和 HANDOFF.md。读完后:

1. 用 3-5 句话复述项目铁律(语言、类型、多租户隔离、每步停顿、secrets、CJS 库互操作)
2. 复述至少 6 个关键坑(base-nova 兼容 / server-only 规范 / 动态 import + serverExternalPackages /
   useChat v4 / iframe CSP / admin client 双条件 / embedding 32 条数上限 / 拒答清洗 citations /
   cleanNoise vs chunk 分工,任选 6 个)
3. 告诉我当前进度(应该是 P1-P5 MVP 14/14 + Step 15 / 16 / 17 / 19 全部闭环,生产域名
   https://ai-customer-service-saas.vercel.app 已上线,Step 18 预告未启动)
4. 确认进入"美化打磨阶段":
   - 方向:UI/UX 视觉 + 交互体验优化,不动业务逻辑 / 不动数据库 / 不动 API 契约
   - 范围预期:Marketing 落地页、Auth 登录注册页、Dashboard 布局、Knowledge 列表 / 上传页、
     Playground 聊天页、C 端公开聊天页、Deploy 页、Widget 按钮/弹窗视觉
   - 每一步动手前先给"修改计划+变更文件清单+预计视觉效果",等用户说"开始"再动代码
   - 美化过程中若发现业务逻辑 bug,先停下报备,不要顺手修

5. 等用户指派第一个美化目标(可能是某个页面 / 某个组件 / 某个视觉系统统一)

不要立即写代码,不要提前规划全局设计系统,等用户先选方向。
```

---

**Step 19 交接完成。P1-P5 MVP + 生产上线 + C 端历史 + 5 条技术债全部闭环,可进入 UI/UX 美化阶段。**
