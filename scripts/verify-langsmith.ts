// V2 Step 21:验证 LangSmith trace 管道接通
// 通过 @langchain/openai 的 ChatOpenAI 调一次 SiliconFlow DeepSeek-V3。
// 当 LANGCHAIN_TRACING_V2=true 且 LANGCHAIN_API_KEY 已设置时,
// @langchain/core 内置 LangSmith callback 会自动把本次调用上报到 LangSmith。
//
// 注意:本脚本是 tsx 运行环境,不能加 'server-only'(EXPERIENCE 主题 1.2)

import { ChatOpenAI } from '@langchain/openai';

async function main() {
  // 必需 env:模型本身要能跑通
  const requiredEnvs = ['SILICONFLOW_API_KEY', 'SILICONFLOW_BASE_URL'] as const;
  for (const key of requiredEnvs) {
    if (!process.env[key]) {
      console.error(`[失败] 缺少环境变量 ${key},无法发起模型调用`);
      process.exit(1);
    }
  }

  // 软检查:trace 是附加能力,不阻断模型调用
  if (!process.env.LANGCHAIN_API_KEY) {
    console.warn(
      '⚠️ LANGCHAIN_API_KEY 未设置,模型仍会回答但 trace 不会上报到 LangSmith',
    );
  }

  const llm = new ChatOpenAI({
    model: 'deepseek-ai/DeepSeek-V3',
    apiKey: process.env.SILICONFLOW_API_KEY,
    configuration: { baseURL: process.env.SILICONFLOW_BASE_URL },
  });

  const res = await llm.invoke('用一句话介绍你自己。');
  console.log('[模型回答]', res.content);
  console.log(
    '✅ 请到 https://smith.langchain.com 的 ai-customer-service-saas 项目查看本次 trace(输入/输出/token/延迟)',
  );
}

main().catch((err) => {
  console.error('[失败]', err);
  process.exit(1);
});
