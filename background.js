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

// 将 OpenRouter /models 响应转换为 { bare: {裸模型名: {prompt, completion}}, full: {} }
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

    bare[bareName] = { prompt: promptPerMillion, completion: completionPerMillion };
  }

  return { bare, full: {} };
}

// 将 LiteLLM model_prices_and_context_window.json 转换为 { bare, full }
// https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json
function transformLiteLLMModels(data) {
  const bare = {};
  const full = {};

  for (const [key, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.mode !== "chat") continue; // 只保留对话模型，跳过 embedding/audio 等

    const promptPrice = parseFloat(entry.input_cost_per_token);
    if (!Number.isFinite(promptPrice) || promptPrice <= 0) continue;

    let completionPrice = parseFloat(entry.output_cost_per_token);
    if (!Number.isFinite(completionPrice) || completionPrice <= 0) {
      completionPrice = promptPrice;
    }

    const priceEntry = {
      prompt: toPerMillion(promptPrice),
      completion: toPerMillion(completionPrice),
    };

    // 裸模型名兜底补充：不覆盖已有 key（合并阶段仍以 OpenRouter 优先）
    const bareName = key.split("/").pop();
    if (bareName && bare[bareName] === undefined) {
      bare[bareName] = priceEntry;
    }

    // 完整部署式 key：只保留厂商路由命名复杂的 provider，原样保留 LiteLLM 的 key
    if (LITELLM_FULL_KEY_PROVIDERS.has(entry.litellm_provider)) {
      full[key] = priceEntry;
    }
  }

  return { bare, full };
}

// 将 Vercel AI Gateway /v1/models 响应转换为 { bare: {裸模型名: {prompt, completion}}, full: {} }
// https://ai-gateway.vercel.sh/v1/models —— id 形如 "google/gemini-3-pro-preview"，无日期戳/版本号，
// 结构与 OpenRouter 类似，只当作裸名补充源，不产出完整部署式 key
function transformVercelModels(models) {
  const bare = {};

  for (const model of models) {
    const id = model.id || "";

    // 只保留对话语言模型，跳过 embedding/image/video/reranking/transcription/realtime/speech
    if (model.type !== "language") continue;

    const pricing = model.pricing;
    if (!pricing) continue;

    const promptPrice = parseFloat(pricing.input);
    if (!Number.isFinite(promptPrice) || promptPrice <= 0) continue;

    const bareName = id.split("/").pop();
    if (!bareName) continue;

    const promptPerMillion = toPerMillion(promptPrice);

    let completionPrice = parseFloat(pricing.output);
    if (!Number.isFinite(completionPrice) || completionPrice <= 0) {
      completionPrice = promptPrice;
    }
    const completionPerMillion = toPerMillion(completionPrice);

    if (bare[bareName] !== undefined) {
      console.warn(
        `⚠️ Vercel 价格转换：模型名冲突 "${bareName}"，保留先出现的值（忽略来自 ${id} 的数据）`
      );
      continue;
    }

    bare[bareName] = { prompt: promptPerMillion, completion: completionPerMillion };
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
  return chrome.storage.local.set({ [key]: { prices, fetchedAt } });
}

// 单个价格源：缓存优先，未命中/强制刷新则联网拉取，失败回退旧缓存
async function getSourcePricing(source, forceRefresh) {
  const cache = await getPriceCache(source.id);
  const cacheIsFresh = cache && Date.now() - cache.fetchedAt < source.ttlMs;

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

// 获取所有官方价格来源并合并：一个来源失败不影响其他来源，全部失败才整体报错
// 合并后结构：{ bare: {裸模型名: {prompt, completion}}, full: {完整部署名: {prompt, completion}} }
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

    for (const [name, price] of Object.entries(prices.bare || {})) {
      if (merged.bare[name] === undefined) merged.bare[name] = price;
    }
    for (const [name, price] of Object.entries(prices.full || {})) {
      if (merged.full[name] === undefined) merged.full[name] = price;
    }
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
