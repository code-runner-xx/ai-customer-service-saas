// V2 Step 27.5.1 — 拒答清洗共享模块(从 app/api/chat/route.ts L49-72 抽出)
//
// 抽离原因:技术债 (o)② 评估脚本(scripts/eval/run-refusal-eval.ts,
// 后续 Step 落地)需要 tsx 直接复用同一份拒答判定,而 route.ts 自身走 server-only
// 链(@/lib/supabase/server + admin),tsx 不能 import。
// 按用户红线"不要另写"(铁律 4 + 主题 15.3 同源原则):正则、函数体、注释字节级保留,
// route.ts 改成 import 同一份,行为零变化。
//
// 本文件不带 server-only,无 fs/process.env/admin 依赖,可被 tsx 脚本直接 import。
//
// 下方注释整段从 route.ts L49-67 搬出,字节级保留 ──────────────────────────────────
// 拒答检测(Step 23.3c 启用,Step 27.4 marker 加固)
// System prompt 仍指示 LLM 输出"抱歉,我在知识库中没有找到相关信息,建议您联系人工客服。"
// 保留 prompt 规范约束(LLM 越规范输出 marker 越易命中,正向引导)。
//
// 但 V2 Agent 化后 LLM 有自然化倾向会插字,如"没有找到【关于火星时间的】相关信息"(27.3 实测 9 字)
// → 旧 includes 找连续子串太脆,marker 1 漏判 → AND 整体 false → citations 未清(27.3 dev 手测⑤ 实证)。
//
// 27.4 改造:把单个长 marker 改成"语义核心片段组 + 允许中间插字"的正则,保持 AND 双条件(主题 7.2)
//   - PATTERN_A(语义"没查到内容"):(没有找到|未找到|查不到|找不到) 与 (相关信息|相关内容|相关资料)
//     之间允许插 0-60 字 ★ Step 27.5.2 第二轮放宽(原 27.4 为 {0,30});
//     {0,60} 上限不贪婪挡远距误命中,61 字超界仍立即 false
//   - PATTERN_B(语义"建议转人工"):(联系人工|人工客服|转人工) 任一
//   - 判定 = A.test && B.test(主题 7.2 AND 防误判初衷;主题 16.4 判文本不判 collector)
//
// 命中 → finalCitations 置空,DB 和前端 data part 同步不渲染引用 chip;
// 天然覆盖"Agent 调了检索、collector 非空、但模型输出拒答文本"的 case。
//
// 已知遗留(主题 18.2 不藏风险):双条件 AND 固有妥协 — 正常长回答里 A B 各自独立出现会被
// 误判 true(如"找不到该型号产品的相关信息,可以致电技术支持热线,也可以联系人工客服。"),
// 留给技术债 (o) 完整解(分数判/语义判),本 Step 不引入分数判 / collector 长度判 / LLM 自评。
//
// Step 27.5.2 第二轮放宽算法(治丙类,守主题 7.5 红线):
//   - prefix baseline 实测最长插字 ≈ 32 字(SQL JOIN 那种 query 包装句),原 30 字上限漏判
//   - 算法:真实客服 query 平均 ≈ 30 字,包装"关于'<query>'的" ≈ +5 字,
//          自然化冗余"您要的 / 对应的 / 这个" ≈ +10 字,共 45 字 + 33% 安全垫 = 60 字
//   - 第二组备选不扩(postfix-ext 实测 20/20 题模型话术全部收敛说"相关信息",
//     无"具体信息""详细资料"等变体,不为加而加)
//   - 上限保护(主题 7.5):{0,60} 而非 .* / .+,61 字超界 false 仍挡跨远距误命中
//   - 双条件 AND 保留(主题 7.2):误判比漏判危险
export const REFUSAL_PATTERN_A = /(没有找到|未找到|查不到|找不到)[\s\S]{0,60}(相关信息|相关内容|相关资料)/;
export const REFUSAL_PATTERN_B = /(联系人工|人工客服|转人工)/;
export function isRefusalText(text: string): boolean {
  return REFUSAL_PATTERN_A.test(text) && REFUSAL_PATTERN_B.test(text);
}
