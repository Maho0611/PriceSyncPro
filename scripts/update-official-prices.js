#!/usr/bin/env node
// 维护脚本：从 OpenRouter + LiteLLM + Vercel AI Gateway 拉取最新模型价格，重新生成 official_prices.json 本地兜底快照
//
// 用法：node scripts/update-official-prices.js
//
// 转换规则需与 background.js 中的 transformOpenRouterModels / transformLiteLLMModels / transformVercelModels 保持一致：
// - OpenRouter：跳过路由别名（id 以 "~" 开头）、跳过缺失/非正数/动态计价（-1）/免费（0）的 prompt 价格，
//   completion 价格缺失/非正数时用 prompt 价格兜底，裸模型名取 id 路径最后一段并去掉 ":free" 后缀；
//   若存在 input_cache_read/input_cache_write 则一并提取为 cacheRead/cacheWrite
// - LiteLLM：mode === "chat" 的条目产出 {prompt, completion, cacheRead?, cacheWrite?, billingMode:'ratio'}，
//   裸模型名兜底补充（不覆盖已有 key，OpenRouter 优先），完整部署式 key 只保留 litellm_provider 属于
//   bedrock/bedrock_converse/azure/azure_ai/vertex_ai 的条目；mode === "image_generation" 且带
//   output_cost_per_image/input_cost_per_image（真实按次整价）的条目产出 {flatPrice, billingMode:'flat'}，
//   拒绝分辨率/画质/步数前缀的多段 key，裸名冲突时"无厂商前缀"key 优先；其余 mode 跳过
// - Vercel AI Gateway：只保留 type === "language" 的条目，裸模型名取 id 路径最后一段（无日期戳/版本号，
//   不产出 full 表）；若存在 input_cache_read/input_cache_write 则一并提取为 cacheRead/cacheWrite
// - 按 token 计价的字段都按 每 token 美元 × 1,000,000 换算为每 1M token 美元；flatPrice 是整次价格，不换算
// - 输出结构为 { bare: { 裸模型名: PriceEntry }, full: { 完整部署名: PriceEntry } }，PriceEntry 见上

const fs = require('fs');
const path = require('path');

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const VERCEL_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models';
const OUTPUT_PATH = path.join(__dirname, '..', 'official_prices.json');

const LITELLM_FULL_KEY_PROVIDERS = new Set([
  'bedrock',
  'bedrock_converse',
  'azure',
  'azure_ai',
  'vertex_ai',
]);

function toPerMillion(pricePerToken) {
  return Math.round(pricePerToken * 1000000 * 1e6) / 1e6;
}

function transformOpenRouterModels(models) {
  const bare = {};

  for (const model of models) {
    const id = model.id || '';
    if (id.startsWith('~')) continue;

    const pricing = model.pricing;
    if (!pricing) continue;

    const promptPrice = parseFloat(pricing.prompt);
    if (!Number.isFinite(promptPrice) || promptPrice <= 0) continue;

    const bareName = id.split('/').pop().replace(/:free$/, '');
    if (!bareName) continue;

    const promptPerMillion = toPerMillion(promptPrice);

    let completionPrice = parseFloat(pricing.completion);
    if (!Number.isFinite(completionPrice) || completionPrice <= 0) {
      completionPrice = promptPrice;
    }
    const completionPerMillion = toPerMillion(completionPrice);

    if (bare[bareName] !== undefined) {
      console.warn(
        `⚠️ OpenRouter 模型名冲突 "${bareName}"，保留先出现的值（忽略来自 ${id} 的数据）`
      );
      continue;
    }

    const entry = { prompt: promptPerMillion, completion: completionPerMillion, billingMode: 'ratio' };

    const cacheReadPrice = parseFloat(pricing.input_cache_read);
    const cacheWritePrice = parseFloat(pricing.input_cache_write);
    if (Number.isFinite(cacheReadPrice) && cacheReadPrice > 0) {
      entry.cacheRead = toPerMillion(cacheReadPrice);
    }
    if (Number.isFinite(cacheWritePrice) && cacheWritePrice > 0) {
      entry.cacheWrite = toPerMillion(cacheWritePrice);
    }

    bare[bareName] = entry;
  }

  return { bare, full: {} };
}

function transformLiteLLMModels(data) {
  const bare = {};
  const full = {};

  // 记录 bare 表里当前哪些裸名是由"无厂商前缀"key 写入的，用于 image_generation
  // 分支的冲突优先级判断（不依赖 Object.entries 的文件遍历顺序）
  const bareNameIsUnprefixed = new Set();

  for (const [key, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== 'object') continue;

    if (entry.mode === 'chat') {
      const promptPrice = parseFloat(entry.input_cost_per_token);
      if (!Number.isFinite(promptPrice) || promptPrice <= 0) continue;

      let completionPrice = parseFloat(entry.output_cost_per_token);
      if (!Number.isFinite(completionPrice) || completionPrice <= 0) {
        completionPrice = promptPrice;
      }

      const priceEntry = {
        prompt: toPerMillion(promptPrice),
        completion: toPerMillion(completionPrice),
        billingMode: 'ratio',
      };

      const cacheReadPrice = parseFloat(entry.cache_read_input_token_cost);
      const cacheWritePrice = parseFloat(entry.cache_creation_input_token_cost);
      if (Number.isFinite(cacheReadPrice) && cacheReadPrice > 0) {
        priceEntry.cacheRead = toPerMillion(cacheReadPrice);
      }
      if (Number.isFinite(cacheWritePrice) && cacheWritePrice > 0) {
        priceEntry.cacheWrite = toPerMillion(cacheWritePrice);
      }

      const bareName = key.split('/').pop();
      if (bareName && bare[bareName] === undefined) {
        bare[bareName] = priceEntry;
      }

      if (LITELLM_FULL_KEY_PROVIDERS.has(entry.litellm_provider)) {
        full[key] = priceEntry;
      }
    } else if (entry.mode === 'image_generation') {
      // 只接受"裸名"或"厂商/模型"两段式 key，拒绝分辨率/画质/步数前缀的多段 key
      const segments = key.split('/');
      if (segments.length > 2) continue;

      // 部分模型（如 gpt-image-1.5）的分辨率档位 key 只有两段（没有质量前缀），
      // 第一段是尺寸字符串而非厂商名，同样需要拒绝
      if (segments.length === 2 && /^\d+-x-\d+$/.test(segments[0])) continue;

      const flatOutput = parseFloat(entry.output_cost_per_image);
      const flatInput = parseFloat(entry.input_cost_per_image);
      let flatPrice;
      if (Number.isFinite(flatOutput) && flatOutput > 0) {
        flatPrice = flatOutput;
      } else if (Number.isFinite(flatInput) && flatInput > 0) {
        flatPrice = flatInput;
      } else {
        continue; // per-pixel 或 per-image-token 计价，无法映射为"按次"价格，跳过
      }

      // 注意：flatPrice 已经是整次价格，不能再走 toPerMillion() 换算
      const priceEntry = { flatPrice, billingMode: 'flat' };

      const bareName = key.split('/').pop();
      if (bareName) {
        const isUnprefixedKey = key === bareName;
        const currentIsUnprefixed = bareNameIsUnprefixed.has(bareName);
        if (bare[bareName] === undefined || (isUnprefixedKey && !currentIsUnprefixed)) {
          bare[bareName] = priceEntry;
          if (isUnprefixedKey) bareNameIsUnprefixed.add(bareName);
        }
      }

      if (LITELLM_FULL_KEY_PROVIDERS.has(entry.litellm_provider)) {
        full[key] = priceEntry;
      }
    } else {
      continue; // audio_transcription / audio_speech / video_generation / embedding 等，超出范围
    }
  }

  return { bare, full };
}

function transformVercelModels(models) {
  const bare = {};

  for (const model of models) {
    const id = model.id || '';
    if (model.type !== 'language') continue;

    const pricing = model.pricing;
    if (!pricing) continue;

    const promptPrice = parseFloat(pricing.input);
    if (!Number.isFinite(promptPrice) || promptPrice <= 0) continue;

    const bareName = id.split('/').pop();
    if (!bareName) continue;

    const promptPerMillion = toPerMillion(promptPrice);

    let completionPrice = parseFloat(pricing.output);
    if (!Number.isFinite(completionPrice) || completionPrice <= 0) {
      completionPrice = promptPrice;
    }
    const completionPerMillion = toPerMillion(completionPrice);

    if (bare[bareName] !== undefined) {
      console.warn(
        `⚠️ Vercel 模型名冲突 "${bareName}"，保留先出现的值（忽略来自 ${id} 的数据）`
      );
      continue;
    }

    const entry = { prompt: promptPerMillion, completion: completionPerMillion, billingMode: 'ratio' };

    const cacheReadPrice = parseFloat(pricing.input_cache_read);
    const cacheWritePrice = parseFloat(pricing.input_cache_write);
    if (Number.isFinite(cacheReadPrice) && cacheReadPrice > 0) {
      entry.cacheRead = toPerMillion(cacheReadPrice);
    }
    if (Number.isFinite(cacheWritePrice) && cacheWritePrice > 0) {
      entry.cacheWrite = toPerMillion(cacheWritePrice);
    }

    bare[bareName] = entry;
  }

  return { bare, full: {} };
}

function sortObject(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

async function fetchJson(url) {
  console.log(`🌐 拉取 ${url} ...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return await response.json();
}

async function main() {
  const merged = { bare: {}, full: {} };

  const settled = await Promise.allSettled([
    fetchJson(OPENROUTER_MODELS_URL).then((json) => {
      if (!json || !Array.isArray(json.data)) {
        throw new Error('OpenRouter 响应格式异常：缺少 data 数组');
      }
      return { id: 'openrouter', prices: transformOpenRouterModels(json.data) };
    }),
    fetchJson(LITELLM_PRICES_URL).then((json) => {
      if (!json || typeof json !== 'object') {
        throw new Error('LiteLLM 响应格式异常');
      }
      return { id: 'litellm', prices: transformLiteLLMModels(json) };
    }),
    fetchJson(VERCEL_MODELS_URL).then((json) => {
      if (!json || !Array.isArray(json.data)) {
        throw new Error('Vercel AI Gateway 响应格式异常：缺少 data 数组');
      }
      return { id: 'vercel', prices: transformVercelModels(json.data) };
    }),
  ]);

  let okCount = 0;
  for (const result of settled) {
    if (result.status !== 'fulfilled') {
      console.error(`❌ 拉取失败:`, result.reason.message);
      continue;
    }
    okCount++;
    const { id, prices } = result.value;
    console.log(
      `✅ ${id}：${Object.keys(prices.bare).length} 个裸名 / ${Object.keys(prices.full).length} 个全名`
    );
    for (const [name, price] of Object.entries(prices.bare)) {
      if (merged.bare[name] === undefined) merged.bare[name] = price;
    }
    for (const [name, price] of Object.entries(prices.full)) {
      if (merged.full[name] === undefined) merged.full[name] = price;
    }
  }

  if (okCount === 0) {
    throw new Error('所有价格源均拉取失败');
  }

  const output = {
    bare: sortObject(merged.bare),
    full: sortObject(merged.full),
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf-8');

  console.log(
    `✅ 已生成 ${OUTPUT_PATH}，共 ${Object.keys(output.bare).length} 个裸名 / ${Object.keys(output.full).length} 个全名`
  );
}

main().catch((error) => {
  console.error('❌ 更新失败:', error.message);
  process.exit(1);
});
