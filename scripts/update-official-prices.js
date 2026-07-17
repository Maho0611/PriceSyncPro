#!/usr/bin/env node
// 维护脚本：从 OpenRouter + LiteLLM + Vercel AI Gateway 拉取最新模型价格，重新生成 official_prices.json 本地兜底快照
//
// 用法：node scripts/update-official-prices.js
//
// 转换规则需与 background.js 中的 transformOpenRouterModels / transformLiteLLMModels / transformVercelModels 保持一致：
// - OpenRouter：跳过路由别名（id 以 "~" 开头）、跳过缺失/非正数/动态计价（-1）/免费（0）的 prompt 价格，
//   completion 价格缺失/非正数时用 prompt 价格兜底，裸模型名取 id 路径最后一段并去掉 ":free" 后缀；
//   若存在 input_cache_read/input_cache_write 则一并提取为 cacheRead/cacheWrite
// - LiteLLM：mode === "chat" 的条目产出 {prompt, completion, cacheRead?, cacheWrite?, longContext?, billingMode:'ratio'}，
//   longContext 从 "_above_Nk_tokens" 后缀字段解析（多档位只取最大阈值一档），
//   裸模型名兜底补充（不覆盖已有 key，OpenRouter 优先），完整部署式 key 只保留 litellm_provider 属于
//   bedrock/bedrock_converse/azure/azure_ai/vertex_ai 的条目；mode === "image_generation" 且带
//   output_cost_per_image/input_cost_per_image（真实按次整价）的条目产出 {flatPrice, flatUnit:'call', billingMode:'flat'}，
//   拒绝分辨率/画质/步数前缀的多段 key，裸名冲突时"无厂商前缀"key 优先；
//   mode === "embedding"/"rerank" 产出倍率计价（token 价为 0 但有 input_cost_per_query 的重排产出按次计价）；
//   mode === "audio_speech" 产出倍率计价（无 token 价时字符价按 1字符≈1token 折算）；
//   mode === "audio_transcription" 只收 token 计价条目（whisper 系按秒计价跳过）；
//   mode === "video_generation" 按秒价产出 {flatPrice, flatUnit:'second', billingMode:'flat'}；
//   新增五类 mode 的裸名只收"无厂商前缀"的 key（第三方渠道转售价不进裸名表）；其余 mode 跳过
// - Vercel AI Gateway：按 type 分发——language/embedding/reranking/realtime/speech/transcription
//   走 token 计价（speech 的 input 是每字符价按 1字符≈1token 折算；transcription 带按秒字段的跳过），
//   image 优先 pricing.image 每张整价（按次），无则用 token 价（gpt-image 系），
//   video 从 video_duration_pricing 取 720p 档（无则最便宜档）为每秒基准价；
//   裸模型名取 id 路径最后一段（无日期戳/版本号，不产出 full 表）；
//   若存在 input_cache_read/input_cache_write 则一并提取为 cacheRead/cacheWrite
// - 非 language/chat 类条目带 type 语义标记（embedding/rerank/tts/stt/image/video/realtime），仅用于 UI 展示
// - 按 token 计价的字段都按 每 token 美元 × 1,000,000 换算为每 1M token 美元；flatPrice 是整次/每秒价格，不换算
// - 多源合并时基础价格（prompt/completion/flatPrice/billingMode）按来源优先级先到先得，但
//   cacheRead/cacheWrite/longContext 等补充字段即使基础价格已被占用，仍从后续来源回填缺失字段
//   （field-level backfill，而非整条记录级别的先到先得——避免 OpenRouter 抢先占位但不带缓存价格的
//   条目，导致 LiteLLM 对同一裸名带的缓存/长上下文价格被整条丢弃）
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

// 长上下文分级定价字段解析：见 background.js 中 extractLongContextTier 的同名实现与注释
const LONG_CONTEXT_TIER_PATTERN = /^(.+)_above_(\d+)k_tokens$/;
const LONG_CONTEXT_FIELD_MAP = {
  input_cost_per_token: 'prompt',
  output_cost_per_token: 'completion',
  cache_read_input_token_cost: 'cacheRead',
  cache_creation_input_token_cost: 'cacheWrite',
};

function extractLongContextTier(entry) {
  const tiersByThreshold = {};
  for (const key of Object.keys(entry)) {
    const match = key.match(LONG_CONTEXT_TIER_PATTERN);
    if (!match) continue;
    const mappedName = LONG_CONTEXT_FIELD_MAP[match[1]];
    if (!mappedName) continue;
    const value = parseFloat(entry[key]);
    if (!Number.isFinite(value) || value < 0) continue;
    const thresholdTokens = parseInt(match[2], 10) * 1000;
    if (!tiersByThreshold[thresholdTokens]) tiersByThreshold[thresholdTokens] = {};
    tiersByThreshold[thresholdTokens][mappedName] = value;
  }

  const thresholds = Object.keys(tiersByThreshold).map(Number);
  if (thresholds.length === 0) return undefined;

  const maxThreshold = Math.max(...thresholds);
  const tier = tiersByThreshold[maxThreshold];
  if (tier.prompt == null) return undefined;

  const longContext = { thresholdTokens: maxThreshold, prompt: toPerMillion(tier.prompt) };
  if (tier.completion != null) longContext.completion = toPerMillion(tier.completion);
  if (tier.cacheRead != null) longContext.cacheRead = toPerMillion(tier.cacheRead);
  if (tier.cacheWrite != null) longContext.cacheWrite = toPerMillion(tier.cacheWrite);
  return longContext;
}

// 按字段合并单张价格表：见 background.js 中 mergePriceTable 的同名实现与注释
const PRICE_ENTRY_SUPPLEMENTARY_FIELDS = ['cacheRead', 'cacheWrite', 'longContext'];

function mergePriceTable(target, source) {
  for (const [name, price] of Object.entries(source || {})) {
    if (target[name] === undefined) {
      target[name] = price;
      continue;
    }
    // 不能原地 mutate existing——见 background.js 中 mergePriceTable 的同名注释：
    // 同一个 PriceEntry 对象可能被 bare 表和 full 表同时引用，原地修改会连带污染
    // 看似无关的其他 key。回填时改为整体替换成新对象，原对象保持不变。
    const existing = target[name];
    let patch = null;
    for (const field of PRICE_ENTRY_SUPPLEMENTARY_FIELDS) {
      if (existing[field] === undefined && price[field] !== undefined) {
        if (!patch) patch = {};
        patch[field] = price[field];
      }
    }
    if (patch) {
      target[name] = { ...existing, ...patch };
    }
  }
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

      const longContext = extractLongContextTier(entry);
      if (longContext) {
        priceEntry.longContext = longContext;
      }

      // 裸模型名兜底补充：基础价格不覆盖已有 key，但 cacheRead/cacheWrite/longContext 等
      // 补充字段用字段级回填——见 background.js 中 transformLiteLLMModels 的同名逻辑与注释。
      // 不能原地 mutate existing，理由同上（避免污染共享同一对象引用的 full 表条目）。
      const bareName = key.split('/').pop();
      if (bareName) {
        if (bare[bareName] === undefined) {
          bare[bareName] = priceEntry;
        } else {
          const existing = bare[bareName];
          let patch = null;
          for (const field of PRICE_ENTRY_SUPPLEMENTARY_FIELDS) {
            if (existing[field] === undefined && priceEntry[field] !== undefined) {
              if (!patch) patch = {};
              patch[field] = priceEntry[field];
            }
          }
          if (patch) {
            bare[bareName] = { ...existing, ...patch };
          }
        }
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
      const priceEntry = { flatPrice, billingMode: 'flat', flatUnit: 'call', type: 'image' };

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
    } else if (entry.mode === 'embedding' || entry.mode === 'rerank') {
      // 向量/重排：token 计价优先映射为倍率；cohere 系重排只有按次查询价时映射为按次。
      // 裸名只收无厂商前缀的 key（第三方渠道转售价不进裸名表），
      // 详见 background.js 中 transformLiteLLMModels 的同名分支与注释
      const modelType = entry.mode === 'embedding' ? 'embedding' : 'rerank';
      const isUnprefixed = !key.includes('/');

      const promptPrice = parseFloat(entry.input_cost_per_token);
      let priceEntry = null;
      if (Number.isFinite(promptPrice) && promptPrice > 0) {
        let completionPrice = parseFloat(entry.output_cost_per_token);
        if (!Number.isFinite(completionPrice) || completionPrice <= 0) {
          completionPrice = promptPrice;
        }
        priceEntry = {
          prompt: toPerMillion(promptPrice),
          completion: toPerMillion(completionPrice),
          billingMode: 'ratio',
          type: modelType,
        };
      } else {
        const queryPrice = parseFloat(entry.input_cost_per_query);
        if (Number.isFinite(queryPrice) && queryPrice > 0) {
          priceEntry = { flatPrice: queryPrice, billingMode: 'flat', flatUnit: 'call', type: modelType };
        }
      }
      if (!priceEntry) continue;

      if (isUnprefixed && bare[key] === undefined) {
        bare[key] = priceEntry;
      }
      if (LITELLM_FULL_KEY_PROVIDERS.has(entry.litellm_provider)) {
        full[key] = priceEntry;
      }
    } else if (entry.mode === 'audio_speech') {
      // TTS：token 计价优先，无 token 价时字符价按 1字符≈1token 折算，
      // 详见 background.js 中 transformLiteLLMModels 的同名分支与注释
      const isUnprefixed = !key.includes('/');
      let promptPrice = parseFloat(entry.input_cost_per_token);
      if (!Number.isFinite(promptPrice) || promptPrice <= 0) {
        promptPrice = parseFloat(entry.input_cost_per_character);
      }
      if (!Number.isFinite(promptPrice) || promptPrice <= 0) continue;

      let completionPrice = parseFloat(entry.output_cost_per_token);
      if (!Number.isFinite(completionPrice) || completionPrice <= 0) {
        completionPrice = promptPrice;
      }
      const priceEntry = {
        prompt: toPerMillion(promptPrice),
        completion: toPerMillion(completionPrice),
        billingMode: 'ratio',
        type: 'tts',
      };
      if (isUnprefixed && bare[key] === undefined) bare[key] = priceEntry;
      if (LITELLM_FULL_KEY_PROVIDERS.has(entry.litellm_provider)) full[key] = priceEntry;
    } else if (entry.mode === 'audio_transcription') {
      // STT：只收 token 计价条目（whisper 系按秒计价无法映射，跳过），
      // 详见 background.js 中 transformLiteLLMModels 的同名分支与注释
      const isUnprefixed = !key.includes('/');
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
        type: 'stt',
      };
      if (isUnprefixed && bare[key] === undefined) bare[key] = priceEntry;
      if (LITELLM_FULL_KEY_PROVIDERS.has(entry.litellm_provider)) full[key] = priceEntry;
    } else if (entry.mode === 'video_generation') {
      // 视频生成：按秒价映射为按次家族、flatUnit:'second'（每秒基准价），
      // 详见 background.js 中 transformLiteLLMModels 的同名分支与注释
      const isUnprefixed = !key.includes('/');
      let perSecond = parseFloat(entry.output_cost_per_video_per_second);
      if (!Number.isFinite(perSecond) || perSecond <= 0) {
        perSecond = parseFloat(entry.output_cost_per_second);
      }
      if (!Number.isFinite(perSecond) || perSecond <= 0) continue;

      const priceEntry = { flatPrice: perSecond, billingMode: 'flat', flatUnit: 'second', type: 'video' };
      if (isUnprefixed && bare[key] === undefined) bare[key] = priceEntry;
      if (LITELLM_FULL_KEY_PROVIDERS.has(entry.litellm_provider)) full[key] = priceEntry;
    } else {
      continue; // responses / completion / ocr / moderation / search 等，超出范围
    }
  }

  return { bare, full };
}

function transformVercelModels(models) {
  const bare = {};

  // Vercel type -> PriceEntry.type 语义标记，详见 background.js 中 transformVercelModels
  // 的同名实现与注释（按 type 分发的完整规则）
  const VERCEL_TOKEN_TYPE_TAG = {
    language: undefined,
    embedding: 'embedding',
    reranking: 'rerank',
    speech: 'tts',
    transcription: 'stt',
    realtime: 'realtime',
  };

  for (const model of models) {
    const id = model.id || '';

    const pricing = model.pricing;
    if (!pricing) continue;

    const bareName = id.split('/').pop();
    if (!bareName) continue;

    let entry = null;

    if (Object.prototype.hasOwnProperty.call(VERCEL_TOKEN_TYPE_TAG, model.type)) {
      if (model.type === 'transcription' && pricing.transcription_duration_cost_per_second) {
        continue; // whisper 系按音频秒数计价，New API 无按时长计费路径，无法映射
      }

      const promptPrice = parseFloat(pricing.input);
      if (!Number.isFinite(promptPrice) || promptPrice <= 0) continue;

      let completionPrice = parseFloat(pricing.output);
      if (!Number.isFinite(completionPrice) || completionPrice <= 0) {
        completionPrice = promptPrice;
      }

      entry = {
        prompt: toPerMillion(promptPrice),
        completion: toPerMillion(completionPrice),
        billingMode: 'ratio',
      };
      if (VERCEL_TOKEN_TYPE_TAG[model.type]) {
        entry.type = VERCEL_TOKEN_TYPE_TAG[model.type];
      }

      const cacheReadPrice = parseFloat(pricing.input_cache_read);
      const cacheWritePrice = parseFloat(pricing.input_cache_write);
      if (Number.isFinite(cacheReadPrice) && cacheReadPrice > 0) {
        entry.cacheRead = toPerMillion(cacheReadPrice);
      }
      if (Number.isFinite(cacheWritePrice) && cacheWritePrice > 0) {
        entry.cacheWrite = toPerMillion(cacheWritePrice);
      }
    } else if (model.type === 'image') {
      const perImage = parseFloat(pricing.image);
      if (Number.isFinite(perImage) && perImage > 0) {
        entry = { flatPrice: perImage, billingMode: 'flat', flatUnit: 'call', type: 'image' };
      } else {
        const promptPrice = parseFloat(pricing.input);
        if (!Number.isFinite(promptPrice) || promptPrice <= 0) continue;

        let completionPrice = parseFloat(pricing.output);
        if (!Number.isFinite(completionPrice) || completionPrice <= 0) {
          completionPrice = promptPrice;
        }
        entry = {
          prompt: toPerMillion(promptPrice),
          completion: toPerMillion(completionPrice),
          billingMode: 'ratio',
          type: 'image',
        };
        const cacheReadPrice = parseFloat(pricing.input_cache_read);
        if (Number.isFinite(cacheReadPrice) && cacheReadPrice > 0) {
          entry.cacheRead = toPerMillion(cacheReadPrice);
        }
      }
    } else if (model.type === 'video') {
      const tiers = Array.isArray(pricing.video_duration_pricing)
        ? pricing.video_duration_pricing
        : [];
      let perSecond = null;
      for (const tier of tiers) {
        const cost = parseFloat(tier && tier.cost_per_second);
        if (!Number.isFinite(cost) || cost <= 0) continue;
        if (tier.resolution === '720p') {
          perSecond = cost;
          break;
        }
        if (perSecond === null || cost < perSecond) perSecond = cost;
      }
      if (perSecond === null) continue;

      entry = { flatPrice: perSecond, billingMode: 'flat', flatUnit: 'second', type: 'video' };
    } else {
      continue; // 未知类型，跳过
    }

    if (bare[bareName] !== undefined) {
      console.warn(
        `⚠️ Vercel 模型名冲突 "${bareName}"，保留先出现的值（忽略来自 ${id} 的数据）`
      );
      continue;
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
    mergePriceTable(merged.bare, prices.bare);
    mergePriceTable(merged.full, prices.full);
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
