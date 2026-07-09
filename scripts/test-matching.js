// 临时测试脚本：验证模型名匹配算法（阶段一 + 阶段二）
// 用法：node scripts/test-matching.js
// 不进主流程，验证完可删除或保留作为回归测试

// content.js 顶层会调用 chrome.runtime.onMessage.addListener，此处用最小 stub 满足加载
global.chrome = {
  runtime: { onMessage: { addListener: () => {} } },
};

const path = require('path');
const { cleanCoreName, matchOfficialPrice } = require(path.join(__dirname, '..', 'content.js'));
const officialPrices = require(path.join(__dirname, '..', 'official_prices.json'));

const mustMatch = [
  ['bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4.5'],
  ['azure/gpt-5-mini-2025-08-07', 'gpt-5-mini'],
  ['us.anthropic.claude-3-5-haiku-20241022-v1:0', null], // 只要求 matched，不锁定具体 matchedName
  ['global.anthropic.claude-opus-4-1', null],
  ['azure_ai/deepseek-r1', null],
];

const mustStayUnchanged = [
  'gpt-4.1',
  'glm-4.5-air',
  'claude-3-haiku',
  'deepseek-v4-flash',
];

let failed = 0;

console.log('=== 必须命中的用例 ===');
for (const [modelName, expectedCore] of mustMatch) {
  const match = matchOfficialPrice(modelName, officialPrices);
  const ok = !!match;
  console.log(
    `${ok ? '✅' : '❌'} ${modelName} -> ${match ? `${match.matchedName} (${match.source}) prompt=${match.prompt}` : 'null'}`
  );
  if (!ok) failed++;
  if (ok && expectedCore) {
    // 只做粗校验：清理后的核心名是否包含期望片段
    const core = cleanCoreName(modelName);
    if (!core.includes(expectedCore.split('.')[0].split('-')[0])) {
      console.log(`   ⚠️ 清理后核心名 "${core}" 与预期 "${expectedCore}" 差异较大，请人工检查`);
    }
  }
}

console.log('\n=== 必须保持不变（防止正则误伤）的用例 ===');
for (const modelName of mustStayUnchanged) {
  const cleaned = cleanCoreName(modelName);
  const ok = cleaned === modelName;
  console.log(`${ok ? '✅' : '❌'} ${modelName} -> cleanCoreName: "${cleaned}"`);
  if (!ok) failed++;
}

console.log('\n=== 原始匹配结果（清理前后对比） ===');
for (const modelName of mustStayUnchanged) {
  const match = matchOfficialPrice(modelName, officialPrices);
  console.log(`${modelName} -> ${match ? `${match.matchedName} (${match.source})` : 'null (未匹配)'}`);
}

if (failed > 0) {
  console.error(`\n❌ ${failed} 项失败`);
  process.exit(1);
} else {
  console.log('\n✅ 全部通过');
}
