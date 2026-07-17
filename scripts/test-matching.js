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
  // 贪婪 preview/image/search/grounding 剥离曾误伤这些官方名本身就带这些词的模型
  ['gemini-3.1-pro-preview', null],
  ['gemini-3-pro-image-preview', null],
  ['gpt-5-search-api', null],
  ['gpt-4o-search-preview', null],
  ['sonar-pro-search', null],
  // -maxthinking/-nothinking 思考预算标记应被剥离，落到不带标记的基础模型
  ['gemini-3.1-pro-preview-maxthinking', null],
  ['gemini-3.1-pro-preview-nothinking', null],
  // 分辨率后缀猜不出对应基础模型，走人工别名表兜底
  ['gemini-3-image-preview-2k', null],
  // 双短横厂商前缀（非斜杠/点号）
  ['anthropic--claude-3-haiku', null],
  ['anthropic--claude-4-opus', null],
  ['anthropic--claude-4-sonnet', null],
  ['anthropic--claude-4.5-haiku', null],
  ['anthropic--claude-4.5-opus', null], // 需要词序互换变体（claude-opus-4.5）才能命中
  // 冒号功能后缀（网页搜索能力标记）
  ['openai/gpt-5.2:web-search', null],
  // image 分辨率/挡位后缀通用剥离（不再依赖逐条人工别名）
  ['gemini-3-pro-image-preview-2k', null],
  ['gemini-3-pro-image-preview-4k', null],
  ['gemini-3.1-flash-image-preview-2k', null],
  ['gemini-3.1-flash-image-preview-4k-think', null],
  // 4 位日期戳段剥离变体（变体层兜底）：尾部日期戳 / 中间日期戳段
  ['grok-4.20-0309', null],
  ['grok-4.20-0309-non-reasoning', null],
  // v3.5.0 起收录的非对话模型类型
  ['alibaba/qwen3-embedding-8b', null],   // 向量（Vercel embedding）
  ['text-embedding-3-large', null],       // 向量（LiteLLM 无前缀条目）
  ['voyage/rerank-2.5', null],            // 重排·按 token（Vercel reranking）
  ['rerank-v3.5', null],                  // 重排·按次查询价（LiteLLM input_cost_per_query）
  ['tts-1', null],                        // TTS·字符价折算（LiteLLM audio_speech）
  ['gpt-4o-mini-tts', null],              // TTS·token 计价
  ['gpt-4o-transcribe', null],            // STT·token 计价
  ['sora-2', null],                       // 视频·按秒基准价（LiteLLM video_generation）
  ['grok-imagine-image', null],           // 图像·按张整价（Vercel image）
];

const mustStayUnchanged = [
  'gpt-4.1',
  'glm-4.5-air',
  'claude-3-haiku',
  'deepseek-v4-flash',
];

// whisper 系模型按音频秒数计价（input_cost_per_second / transcription_duration_cost_per_second），
// New API 没有按时长计费的路径，$/秒无法换算成 $/token，预期未匹配（宁可不匹配，不要匹配错）
const mustStayUnmatched = [
  'whisper-1',
];

// 带 4 位日期戳的官方模型名必须匹配自身（日期戳剥离只在变体层兜底，不能破坏前几层精确匹配）
const dateStubModelsMustMatchThemselves = [
  'grok-4-0709',
  'gpt-4-1106-preview',
];

// -Nk 是这些模型合法的上下文窗口标记（不含 image 词），不应被 image 分辨率剥离规则误伤
const contextWindowSuffixMustMatchThemselves = [
  'mistral-7b-instruct-4k',
  'kimi-latest-8k',
  'gpt-4-32k',
];

// 这些是"-thinking"变体本身就是独立计价的官方模型，不能被当作装饰性标记剥离掉
const thinkingVariantsMustMatchThemselves = [
  'kimi-k2-thinking',
  'qwen3-max-thinking',
  'deepseek-v4-flash-thinking',
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

console.log('\n=== -thinking 变体必须匹配自身（不能被当作装饰性标记剥离） ===');
for (const modelName of thinkingVariantsMustMatchThemselves) {
  const match = matchOfficialPrice(modelName, officialPrices);
  const ok = !!match && match.matchedName === modelName;
  console.log(
    `${ok ? '✅' : '❌'} ${modelName} -> ${match ? `${match.matchedName} (${match.source})` : 'null'}`
  );
  if (!ok) failed++;
}

console.log('\n=== -Nk 上下文窗口标记必须匹配自身（不能被 image 分辨率规则误伤） ===');
for (const modelName of contextWindowSuffixMustMatchThemselves) {
  const match = matchOfficialPrice(modelName, officialPrices);
  const ok = !!match && match.matchedName === modelName;
  console.log(
    `${ok ? '✅' : '❌'} ${modelName} -> ${match ? `${match.matchedName} (${match.source})` : 'null'}`
  );
  if (!ok) failed++;
}

console.log('\n=== 必须保持未匹配（whisper 系按秒计价无法映射，非 bug） ===');
for (const modelName of mustStayUnmatched) {
  const match = matchOfficialPrice(modelName, officialPrices);
  const ok = !match;
  console.log(`${ok ? '✅' : '❌'} ${modelName} -> ${match ? `${match.matchedName} (${match.source})（应为 null）` : 'null (符合预期)'}`);
  if (!ok) failed++;
}

console.log('\n=== 带 4 位日期戳的官方名必须匹配自身（日期戳剥离不能破坏精确匹配） ===');
for (const modelName of dateStubModelsMustMatchThemselves) {
  const match = matchOfficialPrice(modelName, officialPrices);
  const ok = !!match && match.matchedName === modelName;
  console.log(
    `${ok ? '✅' : '❌'} ${modelName} -> ${match ? `${match.matchedName} (${match.source})` : 'null'}`
  );
  if (!ok) failed++;
}

if (failed > 0) {
  console.error(`\n❌ ${failed} 项失败`);
  process.exit(1);
} else {
  console.log('\n✅ 全部通过');
}
