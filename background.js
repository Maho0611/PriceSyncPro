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
// OpenRouter 价格数据源
// ============================================================

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_CACHE_KEY = "openRouterPriceCacheV2";
const OPENROUTER_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时

// 将 OpenRouter /models 响应转换为 { 裸模型名: { prompt: 每1M token美元输入价, completion: 每1M token美元输出价 } }
// 裸模型名提取规则与 content.js 的 extractOriginalModelName 保持一致（取路径最后一段）
function transformOpenRouterModels(models) {
  const prices = {};

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

    // 每 token 美元 → 每 1M token 美元
    const promptPerMillion = Math.round(promptPrice * 1000000 * 1e6) / 1e6;

    // completion 价格缺失/非正数时，用 prompt 价格兜底（completionRatio 退化为 1）
    let completionPrice = parseFloat(pricing.completion);
    if (!Number.isFinite(completionPrice) || completionPrice <= 0) {
      completionPrice = promptPrice;
    }
    const completionPerMillion = Math.round(completionPrice * 1000000 * 1e6) / 1e6;

    if (prices[bareName] !== undefined) {
      console.warn(
        `⚠️ OpenRouter 价格转换：模型名冲突 "${bareName}"，保留先出现的值（忽略来自 ${id} 的数据）`
      );
      continue;
    }

    prices[bareName] = { prompt: promptPerMillion, completion: completionPerMillion };
  }

  return prices;
}

// 从 chrome.storage.local 读取缓存
function getOpenRouterCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get([OPENROUTER_CACHE_KEY], (result) => {
      resolve(result[OPENROUTER_CACHE_KEY] || null);
    });
  });
}

// 写入缓存
function setOpenRouterCache(prices, fetchedAt) {
  return chrome.storage.local.set({
    [OPENROUTER_CACHE_KEY]: { prices, fetchedAt },
  });
}

// 拉取 OpenRouter 最新价格（带简单重试，OpenRouter 是标准公开 API，无需 Cloudflare 绕过那套重逻辑）
async function fetchOpenRouterModels() {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(OPENROUTER_MODELS_URL);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const json = await response.json();
      if (!json || !Array.isArray(json.data)) {
        throw new Error("OpenRouter 响应格式异常：缺少 data 数组");
      }
      return json.data;
    } catch (error) {
      lastError = error;
      console.warn(`⚠️ 拉取 OpenRouter 价格失败 (尝试 ${attempt}/2):`, error.message);
      if (attempt < 2) await sleep(1000);
    }
  }
  throw lastError;
}

// 获取 OpenRouter 价格：缓存优先，未命中/强制刷新则联网拉取，失败回退旧缓存
async function getOpenRouterPricing(forceRefresh = false) {
  const cache = await getOpenRouterCache();
  const cacheIsFresh =
    cache && Date.now() - cache.fetchedAt < OPENROUTER_CACHE_TTL_MS;

  if (!forceRefresh && cacheIsFresh) {
    return { success: true, prices: cache.prices, fetchedAt: cache.fetchedAt, source: "cache" };
  }

  try {
    const models = await fetchOpenRouterModels();
    const prices = transformOpenRouterModels(models);
    const fetchedAt = Date.now();
    await setOpenRouterCache(prices, fetchedAt);
    console.log(`✅ OpenRouter 价格已更新：${Object.keys(prices).length} 个模型`);
    return { success: true, prices, fetchedAt, source: "live" };
  } catch (error) {
    console.error("❌ 拉取 OpenRouter 价格最终失败:", error.message);
    if (cache) {
      console.warn("⚠️ 使用过期缓存作为回退");
      return {
        success: true,
        prices: cache.prices,
        fetchedAt: cache.fetchedAt,
        source: "stale-cache",
        warning: error.message,
      };
    }
    return { success: false, error: error.message };
  }
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

  // 处理获取 OpenRouter 价格数据（联网 + 缓存）
  if (request.action === "getOpenRouterPricing") {
    getOpenRouterPricing(request.forceRefresh || false).then(sendResponse);
    return true; // 异步响应
  }
});
