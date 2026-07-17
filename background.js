// PriceSyncPro Extension - Background Service Worker
// 这个脚本在后台运行，处理扩展的生命周期事件

chrome.runtime.onInstalled.addListener(() => {
  console.log("PriceSyncPro Extension 已安装");
});

// 点击工具栏图标时打开侧边栏（而不是弹出 popup）
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("设置侧边栏行为失败:", error));

// 工具函数：异步延迟
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 从 session Cookie 中提取用户 ID
function extractUserIdFromSession(sessionValue) {
  try {
    // Session 格式: base64编码的数据
    // 解码后包含 "id" 字段
    const decoded = atob(sessionValue);
    console.log("📜 Session 解码内容:", decoded);

    // 尝试提取 ID（通常在 session 中有 id 字段）
    // 格式可能是: ...id\x03int\x04\x02\x00\x02... 或类似
    const idMatch = decoded.match(/id[^\d]*(\d+)/);
    if (idMatch) {
      return idMatch[1];
    }

    // 如果没有找到，返回 1 作为默认值（管理员通常是 ID 1）
    return "1";
  } catch (e) {
    console.warn("解析 session 失败:", e);
    return "1"; // 默认返回 1
  }
}

// ============================================================
// 官方价格数据源：OpenRouter + LiteLLM + Vercel AI Gateway 聚合价格表，多源合并
// ============================================================

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const VERCEL_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";

const PRICE_CACHE_PREFIX = "priceCache_";
const OPENROUTER_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const LITELLM_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
const VERCEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

// LiteLLM 数据量很大（2000+ 条目），完整部署式 key 只保留厂商路由命名复杂的
// provider（Bedrock/Azure/Vertex），用于精确匹配 bedrock/anthropic.xxx-2025xxxx-v1:0
// 这类渠道原始命名，避免把全部条目塞进 chrome.storage.local
const LITELLM_FULL_KEY_PROVIDERS = new Set([
  "bedrock",
  "bedrock_converse",
  "azure",
  "azure_ai",
  "vertex_ai",
]);

// 每 token 美元 → 每 1M token 美元
function toPerMillion(pricePerToken) {
  return Math.round(pricePerToken * 1000000 * 1e6) / 1e6;
}

// PriceEntry 里除基础价格（prompt/completion/flatPrice/billingMode）之外的补充字段。
// 无论是跨价格源合并，还是单个源内部同一裸名有多个厂商前缀 key 冲突，这些字段都采用
// "先到先得基础价格 + 后续来源/条目回填补充字段"的规则，而不是整条记录先到先得——
// 否则较早出现但不带这些字段的条目会让后续条目里完整的缓存/长上下文价格被整条丢弃。
const PRICE_ENTRY_SUPPLEMENTARY_FIELDS = ["cacheRead", "cacheWrite", "longContext"];

// 将 OpenRouter /models 响应转换为 { bare: {裸模型名: {prompt, completion, cacheRead?, cacheWrite?, billingMode: 'ratio'}}, full: {} }
// 裸模型名提取规则与 content.js 的 cleanCoreName 保持一致（取路径最后一段）
function transformOpenRouterModels(models) {
  const bare = {};

  for (const model of models) {
    const id = model.id || "";

    // 跳过路由别名（如 ~openai/gpt-mini-latest），这些不是可比价的真实模型
    if (id.startsWith("~")) continue;

    const pricing = model.pricing;
    if (!pricing) continue;

    const promptPrice = parseFloat(pricing.prompt);

    // 跳过缺失、动态计价（-1）或免费（0）的条目，对价格匹配没有意义
    if (!Number.isFinite(promptPrice) || promptPrice <= 0) continue;

    // 裸模型名：取路径最后一段，去掉 :free 等后缀
    const bareName = id.split("/").pop().replace(/:free$/, "");
    if (!bareName) continue;

    const promptPerMillion = toPerMillion(promptPrice);

    // completion 价格缺失/非正数时，用 prompt 价格兜底（completionRatio 退化为 1）
    let completionPrice = parseFloat(pricing.completion);
    if (!Number.isFinite(completionPrice) || completionPrice <= 0) {
      completionPrice = promptPrice;
    }
    const completionPerMillion = toPerMillion(completionPrice);

    if (bare[bareName] !== undefined) {
      console.warn(
        `⚠️ OpenRouter 价格转换：模型名冲突 "${bareName}"，保留先出现的值（忽略来自 ${id} 的数据）`
      );
      continue;
    }

    const entry = { prompt: promptPerMillion, completion: completionPerMillion, billingMode: 'ratio' };

    // 缓存读写价格（如存在）：与 prompt/completion 同单位换算为每 1M token 美元
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

// 长上下文分级定价字段解析：仅 LiteLLM 数据源带有 "_above_Nk_tokens" 后缀字段
// （如 input_cost_per_token_above_200k_tokens），OpenRouter/Vercel 均无此类字段。
// 阈值不固定（实测见过 128k/200k/256k/272k/512k），用正则从字段名解析而非硬编码。
// 排除 "_priority"（服务优先级档位）与 "_above_1hr_above_Nk_tokens"（缓存时长档位）等
// 非上下文长度维度的变体——这些变体的 base 字段名部分不会精确落在下面的映射表里。
const LONG_CONTEXT_TIER_PATTERN = /^(.+)_above_(\d+)k_tokens$/;
const LONG_CONTEXT_FIELD_MAP = {
  input_cost_per_token: 'prompt',
  output_cost_per_token: 'completion',
  cache_read_input_token_cost: 'cacheRead',
  cache_creation_input_token_cost: 'cacheWrite',
};

// 多个阈值档位同时存在时只取最大阈值一档，避免生成过于复杂的分级表达式；
// 没有基础输入价格（prompt）的档位没有意义，直接跳过
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

// 将 LiteLLM model_prices_and_context_window.json 转换为 { bare, full }
// chat 模式条目产出 {prompt, completion, cacheRead?, cacheWrite?, longContext?, billingMode:'ratio'}；
// image_generation 模式条目（仅限有 output_cost_per_image/input_cost_per_image 的按次计价）
// 产出 {flatPrice, flatUnit:'call', billingMode:'flat'}；
// embedding/rerank 产出倍率计价（cohere 系重排只有按次查询价时产出按次计价）；
// audio_speech 产出倍率计价（字符价按 1字符≈1token 折算，与 New API 内置 tts-1=7.5 的换算惯例一致）；
// audio_transcription 只收 token 计价条目（whisper 系按秒计价无法映射，跳过）；
// video_generation 产出 {flatPrice, flatUnit:'second'}（每秒基准价，New API 视频任务按
// ModelPrice×秒数×分辨率系数计费，见其 relay/relay_task.go + relay/channel/task/*/adaptor.go）。
// 新增五类 mode 的裸名只收"无厂商前缀"的 key——novita/scaleway 等第三方渠道对同一裸名
// 标的是自家转售价（与官方价不一致且互相打架），不能进裸名表；完整部署式 key 照旧只保留
// 五大 provider。其余 mode（responses/completion/ocr/moderation/search 等）跳过
// https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json
function transformLiteLLMModels(data) {
  const bare = {};
  const full = {};

  // 记录 bare 表里当前哪些裸名是由"无厂商前缀"key 写入的，用于 image_generation
  // 分支的冲突优先级判断（不依赖 Object.entries 的文件遍历顺序）
  const bareNameIsUnprefixed = new Set();

  for (const [key, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== "object") continue;

    if (entry.mode === "chat") {
      const promptPrice = parseFloat(entry.input_cost_per_token);
      if (!Number.isFinite(promptPrice) || promptPrice <= 0) continue;

      let completionPrice = parseFloat(entry.output_cost_per_token);
      if (!Number.isFinite(completionPrice) || completionPrice <= 0) {
        completionPrice = promptPrice;
      }

      const priceEntry = {
        prompt: toPerMillion(promptPrice),
        completion: toPerMillion(completionPrice),
        billingMode: "ratio",
      };

      // 缓存读写价格（如存在）：与 prompt/completion 同单位换算为每 1M token 美元
      const cacheReadPrice = parseFloat(entry.cache_read_input_token_cost);
      const cacheWritePrice = parseFloat(entry.cache_creation_input_token_cost);
      if (Number.isFinite(cacheReadPrice) && cacheReadPrice > 0) {
        priceEntry.cacheRead = toPerMillion(cacheReadPrice);
      }
      if (Number.isFinite(cacheWritePrice) && cacheWritePrice > 0) {
        priceEntry.cacheWrite = toPerMillion(cacheWritePrice);
      }

      // 长上下文分级定价（如存在）：超过 thresholdTokens 后适用的价格档位
      const longContext = extractLongContextTier(entry);
      if (longContext) {
        priceEntry.longContext = longContext;
      }

      // 裸模型名兜底补充：基础价格不覆盖已有 key（合并阶段仍以 OpenRouter 优先），但
      // cacheRead/cacheWrite/longContext 等补充字段用字段级回填——LiteLLM 文件本身对同一
      // 裸名有多个厂商前缀 key（如 deepinfra/google/gemini-2.5-pro 先于 gemini-2.5-pro
      // 出现），先出现的 key 若不带这些补充字段，会导致后出现的 key 即使带着完整的缓存/
      // 长上下文价格也被整条跳过（已用真实数据复现：gemini-2.5-pro 的长上下文价格因此丢失）。
      // 不能原地 mutate existing——first-encountered 的这个对象可能同时被更早那次循环写入
      // full[某个key]，原地修改 existing[field] 会连带污染那个看似无关的 full 条目
      // （已用真实数据复现：370+ 对 bare/full 条目共享同一对象引用）。回填时整体替换成新对象。
      const bareName = key.split("/").pop();
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

      // 完整部署式 key：只保留厂商路由命名复杂的 provider，原样保留 LiteLLM 的 key
      if (LITELLM_FULL_KEY_PROVIDERS.has(entry.litellm_provider)) {
        full[key] = priceEntry;
      }
    } else if (entry.mode === "image_generation") {
      // 只接受"裸名"或"厂商/模型"两段式 key，拒绝分辨率/画质/步数前缀的多段 key
      // （如 "hd/1024-x-1024/dall-e-3"、"low/1024-x-1024/gpt-image-1-mini"），
      // 避免同一裸名下按 JSON 遍历顺序随机选中某个分辨率档位的价格——宁可不匹配，不要匹配错
      const segments = key.split("/");
      if (segments.length > 2) continue;

      // 部分模型（如 gpt-image-1.5）的分辨率档位 key 只有两段（如 "1024-x-1024/gpt-image-1.5"，
      // 没有质量前缀），第一段是尺寸字符串而非厂商名，同样需要拒绝——否则会被误当成
      // "厂商/模型" 两段式 key 接受，把本应排除的按图像 token 计价模型错配成按次计价
      if (segments.length === 2 && /^\d+-x-\d+$/.test(segments[0])) continue;

      // output_cost_per_image / input_cost_per_image 是"每张图"整价（按次），
      // 与 output_cost_per_image_token / input_cost_per_image_token（如 gpt-image-1 系列，
      // 按"图像 token"计价，本质是另一种 token 计价）完全不同，此处只接受前者，不做混淆
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

      // 注意：flatPrice 已经是整次价格，不能再走 toPerMillion() 换算（否则会放大 100 万倍）
      const priceEntry = { flatPrice, billingMode: "flat", flatUnit: "call", type: "image" };

      const bareName = key.split("/").pop();
      if (bareName) {
        const isUnprefixedKey = key === bareName;
        const currentIsUnprefixed = bareNameIsUnprefixed.has(bareName);
        // 冲突优先级：无厂商前缀的裸名 key 优先于任何"厂商/模型"两段式 key
        // （已核实同名不同价的真实冲突存在，如 dall-e-3 裸名 $0.04 vs aiml/dall-e-3 $0.052）
        if (bare[bareName] === undefined || (isUnprefixedKey && !currentIsUnprefixed)) {
          bare[bareName] = priceEntry;
          if (isUnprefixedKey) bareNameIsUnprefixed.add(bareName);
        }
      }

      if (LITELLM_FULL_KEY_PROVIDERS.has(entry.litellm_provider)) {
        full[key] = priceEntry;
      }
    } else if (entry.mode === "embedding" || entry.mode === "rerank") {
      // 向量/重排：优先 token 计价（input_cost_per_token）映射为倍率计价——New API 对
      // embedding/rerank 请求都走标准文本 quota 路径（quota = input tokens × ModelRatio，
      // 无输出 token，CompletionRatio 不参与），见其 relay/embedding_handler.go 与
      // relay/rerank_handler.go。cohere 系重排（rerank-v3.5 等）token 价为 0、只有
      // input_cost_per_query 按次查询价（$/query），映射为按次计价（ModelPrice）
      const modelType = entry.mode === "embedding" ? "embedding" : "rerank";
      const isUnprefixed = !key.includes("/");

      const promptPrice = parseFloat(entry.input_cost_per_token);
      let priceEntry = null;
      if (Number.isFinite(promptPrice) && promptPrice > 0) {
        // 向量/重排没有输出 token，output_cost_per_token 通常为 0；completion 用 prompt
        // 兜底只为保持 PriceEntry 形状完整（completionRatio 退化为 1，实际不会产生输出计费）
        let completionPrice = parseFloat(entry.output_cost_per_token);
        if (!Number.isFinite(completionPrice) || completionPrice <= 0) {
          completionPrice = promptPrice;
        }
        priceEntry = {
          prompt: toPerMillion(promptPrice),
          completion: toPerMillion(completionPrice),
          billingMode: "ratio",
          type: modelType,
        };
      } else {
        const queryPrice = parseFloat(entry.input_cost_per_query);
        if (Number.isFinite(queryPrice) && queryPrice > 0) {
          priceEntry = { flatPrice: queryPrice, billingMode: "flat", flatUnit: "call", type: modelType };
        }
      }
      if (!priceEntry) continue;

      if (isUnprefixed && bare[key] === undefined) {
        bare[key] = priceEntry;
      }
      if (LITELLM_FULL_KEY_PROVIDERS.has(entry.litellm_provider)) {
        full[key] = priceEntry;
      }
    } else if (entry.mode === "audio_speech") {
      // TTS：优先 token 计价（gpt-4o-mini-tts / gemini-tts 系），无 token 价时用字符计价
      // （tts-1 $15/1M 字符）。New API 对 TTS 输入按"估算文本 token"计费，字符价按
      // 1 字符≈1 token 直接折算为每 1M 价格——与 New API 内置默认表的换算惯例一致
      // （其内置 tts-1 ModelRatio=7.5 正是 $15/1M ÷ 2）
      const isUnprefixed = !key.includes("/");
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
        billingMode: "ratio",
        type: "tts",
      };
      if (isUnprefixed && bare[key] === undefined) bare[key] = priceEntry;
      if (LITELLM_FULL_KEY_PROVIDERS.has(entry.litellm_provider)) full[key] = priceEntry;
    } else if (entry.mode === "audio_transcription") {
      // STT：只收 token 计价条目（gpt-4o-transcribe 系）。whisper-1 等只有
      // input_cost_per_second 按音频秒数计价的条目跳过——New API 没有按时长计费的路径
      // （其 STT 按上游 usage 或估算 token 计费），$/秒无法换算成 $/token，
      // 宁可不匹配，不要匹配错
      const isUnprefixed = !key.includes("/");
      const promptPrice = parseFloat(entry.input_cost_per_token);
      if (!Number.isFinite(promptPrice) || promptPrice <= 0) continue;

      let completionPrice = parseFloat(entry.output_cost_per_token);
      if (!Number.isFinite(completionPrice) || completionPrice <= 0) {
        completionPrice = promptPrice;
      }
      const priceEntry = {
        prompt: toPerMillion(promptPrice),
        completion: toPerMillion(completionPrice),
        billingMode: "ratio",
        type: "stt",
      };
      if (isUnprefixed && bare[key] === undefined) bare[key] = priceEntry;
      if (LITELLM_FULL_KEY_PROVIDERS.has(entry.litellm_provider)) full[key] = priceEntry;
    } else if (entry.mode === "video_generation") {
      // 视频生成：按秒计价（output_cost_per_video_per_second / output_cost_per_second）
      // 映射为按次家族、flatUnit 标记为 'second'——New API 对视频任务的计费公式是
      // ModelPrice × 秒数 × 分辨率系数，因此 ModelPrice 应填 $/秒基准价。
      // seedance 等按"视频 token"计价的条目无法映射为每秒基准价，跳过
      const isUnprefixed = !key.includes("/");
      let perSecond = parseFloat(entry.output_cost_per_video_per_second);
      if (!Number.isFinite(perSecond) || perSecond <= 0) {
        perSecond = parseFloat(entry.output_cost_per_second);
      }
      if (!Number.isFinite(perSecond) || perSecond <= 0) continue;

      const priceEntry = { flatPrice: perSecond, billingMode: "flat", flatUnit: "second", type: "video" };
      if (isUnprefixed && bare[key] === undefined) bare[key] = priceEntry;
      if (LITELLM_FULL_KEY_PROVIDERS.has(entry.litellm_provider)) full[key] = priceEntry;
    } else {
      continue; // responses / completion / ocr / moderation / search 等，超出范围
    }
  }

  return { bare, full };
}

// 将 Vercel AI Gateway /v1/models 响应转换为 { bare: {裸模型名: PriceEntry}, full: {} }
// https://ai-gateway.vercel.sh/v1/models —— id 形如 "google/gemini-3-pro-preview"，无日期戳/版本号，
// 只当作裸名补充源，不产出完整部署式 key。按 type 分发：
//   language/embedding/reranking/realtime → token 计价（input/output 为每 token 美元）
//   speech(TTS) → input 是每字符价，按 1字符≈1token 折算（transcription 带按秒字段的跳过）
//   transcription(STT) → 只收 token 计价条目（whisper 系按音频秒数计价无法映射，跳过）
//   image → pricing.image（每张整价）优先映射为按次；gpt-image 系只有 token 价则按倍率
//   video → video_duration_pricing 里取 720p 档（New API sora 适配器的基准尺寸即 720 档、
//           分辨率系数 1），无 720p 时取最便宜档，映射为每秒基准价（flatUnit:'second'）
function transformVercelModels(models) {
  const bare = {};

  // Vercel type -> PriceEntry.type 语义标记（language 不打标记，保持与 OpenRouter/LiteLLM
  // chat 条目形状一致；标记仅用于 UI 展示，不参与计费换算）
  const VERCEL_TOKEN_TYPE_TAG = {
    language: undefined,
    embedding: "embedding",
    reranking: "rerank",
    speech: "tts",
    transcription: "stt",
    realtime: "realtime",
  };

  for (const model of models) {
    const id = model.id || "";

    const pricing = model.pricing;
    if (!pricing) continue;

    const bareName = id.split("/").pop();
    if (!bareName) continue;

    let entry = null;

    if (Object.prototype.hasOwnProperty.call(VERCEL_TOKEN_TYPE_TAG, model.type)) {
      // token 计价类：input/output 是每 token 美元（speech 的 input 是每字符价，
      // 按 1字符≈1token 折算，与 New API 内置 tts-1=7.5 的换算惯例一致）
      if (model.type === "transcription" && pricing.transcription_duration_cost_per_second) {
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
        billingMode: "ratio",
      };
      if (VERCEL_TOKEN_TYPE_TAG[model.type]) {
        entry.type = VERCEL_TOKEN_TYPE_TAG[model.type];
      }

      // 缓存读写价格（如存在）：与 prompt/completion 同单位换算为每 1M token 美元
      const cacheReadPrice = parseFloat(pricing.input_cache_read);
      const cacheWritePrice = parseFloat(pricing.input_cache_write);
      if (Number.isFinite(cacheReadPrice) && cacheReadPrice > 0) {
        entry.cacheRead = toPerMillion(cacheReadPrice);
      }
      if (Number.isFinite(cacheWritePrice) && cacheWritePrice > 0) {
        entry.cacheWrite = toPerMillion(cacheWritePrice);
      }
    } else if (model.type === "image") {
      // pricing.image 是"每张图"整价（按次）；gpt-image 系没有 image 字段、只有
      // input/output token 价（本质是另一种 token 计价），映射为倍率计价。
      // 两者都有时（如 seedream-5.0-pro）以每张整价为准——按次是该类模型的实际计费形态
      const perImage = parseFloat(pricing.image);
      if (Number.isFinite(perImage) && perImage > 0) {
        entry = { flatPrice: perImage, billingMode: "flat", flatUnit: "call", type: "image" };
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
          billingMode: "ratio",
          type: "image",
        };
        const cacheReadPrice = parseFloat(pricing.input_cache_read);
        if (Number.isFinite(cacheReadPrice) && cacheReadPrice > 0) {
          entry.cacheRead = toPerMillion(cacheReadPrice);
        }
      }
    } else if (model.type === "video") {
      // video_duration_pricing: [{resolution, cost_per_second}]，取 720p 档为基准价；
      // 无 720p 档时取最便宜档（宁可少收，不要多收）。video_token_pricing（seedance 系
      // 按"视频 token"计价）无法映射为每秒基准价，落到 perSecond===null 跳过
      const tiers = Array.isArray(pricing.video_duration_pricing)
        ? pricing.video_duration_pricing
        : [];
      let perSecond = null;
      for (const tier of tiers) {
        const cost = parseFloat(tier && tier.cost_per_second);
        if (!Number.isFinite(cost) || cost <= 0) continue;
        if (tier.resolution === "720p") {
          perSecond = cost;
          break;
        }
        if (perSecond === null || cost < perSecond) perSecond = cost;
      }
      if (perSecond === null) continue;

      entry = { flatPrice: perSecond, billingMode: "flat", flatUnit: "second", type: "video" };
    } else {
      continue; // 未知类型，跳过
    }

    if (bare[bareName] !== undefined) {
      console.warn(
        `⚠️ Vercel 价格转换：模型名冲突 "${bareName}"，保留先出现的值（忽略来自 ${id} 的数据）`
      );
      continue;
    }

    bare[bareName] = entry;
  }

  return { bare, full: {} };
}

// 带简单重试地拉取 JSON（三个数据源都是标准公开接口，无需 Cloudflare 绕过那套重逻辑）
async function fetchJsonWithRetry(url, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      console.warn(`⚠️ 拉取 ${url} 失败 (尝试 ${attempt}/${attempts}):`, error.message);
      if (attempt < attempts) await sleep(1000);
    }
  }
  throw lastError;
}

async function fetchOpenRouterModels() {
  const json = await fetchJsonWithRetry(OPENROUTER_MODELS_URL);
  if (!json || !Array.isArray(json.data)) {
    throw new Error("OpenRouter 响应格式异常：缺少 data 数组");
  }
  return json.data;
}

async function fetchLiteLLMPrices() {
  const json = await fetchJsonWithRetry(LITELLM_PRICES_URL);
  if (!json || typeof json !== "object") {
    throw new Error("LiteLLM 响应格式异常");
  }
  return json;
}

async function fetchVercelModels() {
  const json = await fetchJsonWithRetry(VERCEL_MODELS_URL);
  if (!json || !Array.isArray(json.data)) {
    throw new Error("Vercel AI Gateway 响应格式异常：缺少 data 数组");
  }
  return json.data;
}

const PRICE_SOURCES = [
  // 放在前面的来源在裸模型名冲突时优先保留
  {
    id: "openrouter",
    ttlMs: OPENROUTER_CACHE_TTL_MS,
    fetchRaw: fetchOpenRouterModels,
    transform: transformOpenRouterModels,
  },
  {
    id: "litellm",
    ttlMs: LITELLM_CACHE_TTL_MS,
    fetchRaw: fetchLiteLLMPrices,
    transform: transformLiteLLMModels,
  },
  {
    id: "vercel",
    ttlMs: VERCEL_CACHE_TTL_MS,
    fetchRaw: fetchVercelModels,
    transform: transformVercelModels,
  },
];

// 按来源分别缓存到 chrome.storage.local
function getPriceCache(sourceId) {
  const key = PRICE_CACHE_PREFIX + sourceId;
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      resolve(result[key] || null);
    });
  });
}

function setPriceCache(sourceId, prices, fetchedAt) {
  const key = PRICE_CACHE_PREFIX + sourceId;
  return chrome.storage.local.set({
    [key]: { prices, fetchedAt, extVersion: chrome.runtime.getManifest().version },
  });
}

// 单个价格源：缓存优先，未命中/强制刷新则联网拉取，失败回退旧缓存。
// 缓存里存的是 transform 之后的结果——插件升级往往伴随 transform 规则变化（如 v3.5.0
// 新增五类模型收录），旧版本写入的缓存在 TTL 内看似新鲜、实际是旧规则的产物，会让新
// 功能在长达 TTL 的时间里"看起来没生效"。因此缓存带插件版本戳，版本不一致视为未命中
// 强制重拉；仅在联网彻底失败的兜底路径才允许吃旧版本缓存（旧结构向前兼容，聊胜于无）
async function getSourcePricing(source, forceRefresh) {
  const cache = await getPriceCache(source.id);
  const cacheVersionOk = cache && cache.extVersion === chrome.runtime.getManifest().version;
  const cacheIsFresh =
    cacheVersionOk && Date.now() - cache.fetchedAt < source.ttlMs;

  if (!forceRefresh && cacheIsFresh) {
    return { success: true, prices: cache.prices, fetchedAt: cache.fetchedAt };
  }

  try {
    const raw = await source.fetchRaw();
    const prices = source.transform(raw);
    const fetchedAt = Date.now();
    await setPriceCache(source.id, prices, fetchedAt);
    console.log(
      `✅ ${source.id} 价格已更新：${Object.keys(prices.bare).length} 个裸名 / ${Object.keys(prices.full).length} 个全名`
    );
    return { success: true, prices, fetchedAt };
  } catch (error) {
    console.error(`❌ 拉取 ${source.id} 价格最终失败:`, error.message);
    if (cache) {
      console.warn(`⚠️ ${source.id} 使用过期缓存作为回退`);
      return {
        success: true,
        prices: cache.prices,
        fetchedAt: cache.fetchedAt,
        warning: error.message,
      };
    }
    return { success: false, error: error.message };
  }
}

// 按字段合并单张价格表（bare 或 full）：基础价格（prompt/completion/flatPrice/billingMode）
// 仍按来源优先级"先到先得"，但 cacheRead/cacheWrite/longContext 等补充字段即使基础价格已被
// 更高优先级来源占用，也会从后续来源回填——避免 OpenRouter 抢先写入了不带缓存价格的条目后，
// LiteLLM 对同一裸名带的缓存/长上下文价格被整条丢弃（已用线上数据实测复现：gpt-4o、
// deepseek-chat 等模型的缓存价格曾因此完全无法同步到 New API）
function mergePriceTable(target, source) {
  for (const [name, price] of Object.entries(source || {})) {
    if (target[name] === undefined) {
      target[name] = price;
      continue;
    }
    // 不能原地 mutate existing——同一个 PriceEntry 对象可能被 bare 表和 full 表同时引用
    // （transformLiteLLMModels 里 bare[bareName] 与 full[key] 常指向同一对象），原地修改
    // 会连带污染看似无关的其他 key。回填时改为整体替换成新对象，原对象保持不变。
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

// 获取所有官方价格来源并合并：一个来源失败不影响其他来源，全部失败才整体报错
// 合并后结构：{ bare: {裸模型名: PriceEntry}, full: {完整部署名: PriceEntry} }
// PriceEntry 按计价模式二选一：
//   按 token 倍率计价：{prompt, completion, cacheRead?, cacheWrite?, longContext?, type?, billingMode: 'ratio'}
//   按次/按秒固定计价：{flatPrice, flatUnit?, type?, billingMode: 'flat'}
// longContext（如存在）：{thresholdTokens, prompt, completion, cacheRead?, cacheWrite?}，
// 超过 thresholdTokens 后适用的价格档位，仅 LiteLLM 数据源会产出（OpenRouter/Vercel 无此字段）
// flatUnit：'call'（每次整价，图像/按查询计价的重排）或 'second'（每秒基准价，视频任务——
// New API 按 ModelPrice×秒数×分辨率系数计费）；旧条目缺省按 'call' 处理
// type（如存在）：非对话模型的语义类型 embedding/rerank/tts/stt/image/video/realtime，
// 仅用于 UI 徽标展示与人工核对，不参与计费换算；缺省即对话语言模型
// 旧快照/缓存条目没有 billingMode 字段，下游读取时统一按 'ratio' 处理（语义正确，无需迁移）
async function getOfficialPricing(forceRefresh = false) {
  const settled = await Promise.allSettled(
    PRICE_SOURCES.map((source) => getSourcePricing(source, forceRefresh))
  );

  const merged = { bare: {}, full: {} };
  const okSourceIds = [];
  const warnings = [];
  let latestFetchedAt = 0;

  settled.forEach((result, index) => {
    const sourceId = PRICE_SOURCES[index].id;

    if (result.status !== "fulfilled" || !result.value.success) {
      const reason = result.status === "fulfilled" ? result.value.error : result.reason;
      warnings.push(`${sourceId}: ${reason}`);
      return;
    }

    const { prices, fetchedAt, warning } = result.value;
    okSourceIds.push(sourceId);
    latestFetchedAt = Math.max(latestFetchedAt, fetchedAt);
    if (warning) warnings.push(`${sourceId}: ${warning}`);

    mergePriceTable(merged.bare, prices.bare);
    mergePriceTable(merged.full, prices.full);
  });

  if (okSourceIds.length === 0) {
    return { success: false, error: warnings.join("; ") || "所有价格源均拉取失败" };
  }

  return {
    success: true,
    prices: merged,
    fetchedAt: latestFetchedAt,
    source: okSourceIds.join("+"),
    warning: warnings.length > 0 ? warnings.join("; ") : undefined,
  };
}

// 处理来自 Content Script 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 处理获取 Cookie
  if (request.action === "getCookies") {
    chrome.cookies.getAll(
      {
        url: request.url,
      },
      (cookies) => {
        console.log("📋 获取到的所有 Cookies:", cookies);
        console.log(
          "📋 Cookie 名称列表:",
          cookies.map((c) => c.name)
        );

        const sessionCookie = cookies.find((c) => c.name === "session");

        if (sessionCookie) {
          const userId = extractUserIdFromSession(sessionCookie.value);
          console.log(`✓ 从 session 提取用户 ID: ${userId}`);

          sendResponse({
            success: true,
            newApiUser: userId,
            allCookies: cookies,
            sessionValue: sessionCookie.value,
          });
        } else {
          console.error("❌ 未找到 session Cookie");
          sendResponse({
            success: false,
            error: "未找到 session Cookie，请确保已登录",
            availableCookies: cookies.map((c) => c.name),
          });
        }
      }
    );

    return true; // 异步响应
  }

  // 处理获取官方价格数据（OpenRouter + LiteLLM，联网 + 缓存）
  if (request.action === "getOfficialPricing") {
    getOfficialPricing(request.forceRefresh || false).then(sendResponse);
    return true; // 异步响应
  }
});
