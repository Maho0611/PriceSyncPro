#!/usr/bin/env node
// 维护脚本：从 OpenRouter 拉取最新模型价格，重新生成 official_prices.json 本地兜底快照
//
// 用法：node scripts/update-official-prices.js
//
// 转换规则需与 background.js 中的 transformOpenRouterModels 保持一致：
// - 跳过路由别名（id 以 "~" 开头）
// - 跳过缺失/非正数/动态计价（-1）/免费（0）的 prompt 价格
// - completion 价格缺失/非正数时用 prompt 价格兜底
// - 裸模型名取 id 路径最后一段，去掉 ":free" 后缀
// - 每 token 美元 × 1,000,000 换算为每 1M token 美元
// - 输出结构为 { prompt, completion }
// - 裸名冲突时保留先出现的值，并打印警告

const fs = require('fs');
const path = require('path');

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OUTPUT_PATH = path.join(__dirname, '..', 'official_prices.json');

function transformOpenRouterModels(models) {
  const prices = {};

  for (const model of models) {
    const id = model.id || '';
    if (id.startsWith('~')) continue;

    const pricing = model.pricing;
    if (!pricing) continue;

    const promptPrice = parseFloat(pricing.prompt);
    if (!Number.isFinite(promptPrice) || promptPrice <= 0) continue;

    const bareName = id.split('/').pop().replace(/:free$/, '');
    if (!bareName) continue;

    const promptPerMillion = Math.round(promptPrice * 1000000 * 1e6) / 1e6;

    let completionPrice = parseFloat(pricing.completion);
    if (!Number.isFinite(completionPrice) || completionPrice <= 0) {
      completionPrice = promptPrice;
    }
    const completionPerMillion = Math.round(completionPrice * 1000000 * 1e6) / 1e6;

    if (prices[bareName] !== undefined) {
      console.warn(
        `⚠️ 模型名冲突 "${bareName}"，保留先出现的值（忽略来自 ${id} 的数据）`
      );
      continue;
    }

    prices[bareName] = { prompt: promptPerMillion, completion: completionPerMillion };
  }

  return prices;
}

async function main() {
  console.log(`🌐 拉取 ${OPENROUTER_MODELS_URL} ...`);
  const response = await fetch(OPENROUTER_MODELS_URL);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const json = await response.json();
  if (!json || !Array.isArray(json.data)) {
    throw new Error('OpenRouter 响应格式异常：缺少 data 数组');
  }

  const prices = transformOpenRouterModels(json.data);
  const sortedPrices = Object.fromEntries(
    Object.entries(prices).sort(([a], [b]) => a.localeCompare(b))
  );

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(sortedPrices, null, 2) + '\n', 'utf-8');

  console.log(`✅ 已生成 ${OUTPUT_PATH}，共 ${Object.keys(sortedPrices).length} 个模型`);
}

main().catch((error) => {
  console.error('❌ 更新失败:', error.message);
  process.exit(1);
});
