// V2 Step 21:验证 @langchain/textsplitters 1.0.1 升级后,chunk.ts 行为不变
// 纯本地切块,不需要任何 key。
// 注意:本脚本是 tsx 运行环境,不能加 'server-only'(EXPERIENCE 主题 1.2)

import { chunkText } from '../lib/rag/chunk';

async function main() {
  const testText = '这是第一段测试文本。'.repeat(100);
  const chunks = await chunkText(testText);

  console.log('[chunk 验证] 切块数:', chunks.length);
  console.log('[chunk 验证] 首块长度:', chunks[0]?.length);
  console.log('[chunk 验证] 首块预览:', chunks[0]?.slice(0, 50));
}

main().catch((err) => {
  console.error('[失败]', err);
  process.exit(1);
});
