// PriceSyncPro Extension - Content Script
// 这个脚本注入到页面中，可以访问页面的 Cookie 和发起同源请求

/**
 * 记录错误日志到 storage
 * @param {string} action - 操作名称
 * @param {Error} error - 错误对象
 * @param {object} context - 额外上下文信息
 */
async function logError(action, error, context = {}) {
  const errorLog = {
    action,
    message: error.message,
    stack: error.stack,
    context,
    timestamp: Date.now(),
    url: window.location.href
  };

  console.error(`❌ [${action}] 错误:`, errorLog);

  try {
    const { errorLogs = [] } = await chrome.storage.local.get('errorLogs');
    errorLogs.push(errorLog);
    // 保留最近 50 条错误日志
    await chrome.storage.local.set({
      errorLogs: errorLogs.slice(-50)
    });
  } catch (storageError) {
    console.error('保存错误日志失败:', storageError);
  }
}

let officialPrices = null;

// 从 background 请求官方价格数据（OpenRouter + LiteLLM，联网 + 缓存）
function requestOfficialPricing(forceRefresh = false) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'getOfficialPricing', forceRefresh },
      (response) => resolve(response)
    );
  });
}

// 加载本地兜底价格快照（随插件打包）
async function loadLocalPriceSnapshot() {
  const response = await fetch(chrome.runtime.getURL('official_prices.json'));
  return await response.json();
}

// 加载官方价格数据库：联网优先（OpenRouter + LiteLLM 合并），本地快照兜底
// 数据结构：{ bare: { 裸模型名: {prompt, completion} }, full: { 完整部署名: {prompt, completion} } }
async function loadOfficialPrices() {
  if (officialPrices) return officialPrices;

  const remote = await requestOfficialPricing(false);
  if (remote && remote.success) {
    console.log(
      `✓ 官方价格数据来源: ${remote.source}，更新于 ${new Date(remote.fetchedAt).toLocaleString()}`
    );
    if (remote.warning) {
      console.warn('⚠️ 官方价格实时拉取部分失败，已回退到过期缓存:', remote.warning);
    }
    officialPrices = remote.prices;
    return officialPrices;
  }

  console.warn('⚠️ 官方价格不可用，回退到本地快照:', remote && remote.error);

  try {
    officialPrices = await loadLocalPriceSnapshot();
    console.log('✓ 官方价格数据来源: 本地快照（打包于插件内）');
    return officialPrices;
  } catch (error) {
    console.error('加载官方价格数据失败:', error);
    throw new Error('无法加载官方价格数据库');
  }
}

// ============================================================
// 模糊匹配：仅用于在官方价格表中查找对应价格
// 绝不用于生成/改写任何写回 New API 的模型名
// ============================================================

// 人工别名兜底表：渠道原始模型名（或清理后的核心名） -> 官方价格表 key
// 优先级高于机械清理规则，用于个别正则规则也覆盖不到的顽固案例
const MANUAL_ALIAS_TABLE = {
};

// 剥离点号厂商/区域路由前缀，如 anthropic. / us. / global. / eu. / apac.
// 仅当点号前是纯字母时才剥离，避免误伤 glm-4.5、claude-3.5-haiku 这类合法版本号
function stripDottedVendorPrefix(name) {
  let result = name;
  for (let i = 0; i < 3; i++) {
    const stripped = result.replace(/^[a-z]{2,15}\.(?=[a-zA-Z])/i, '');
    if (stripped === result) break;
    result = stripped;
  }
  return result;
}

// 清理模型名，得到用于匹配的"核心名"（不改变原始模型名，只用于查表）
function cleanCoreName(modelName) {
  let coreName = modelName;

  // 如果包含斜杠，提取最后一段
  if (modelName.includes('/')) {
    const parts = modelName.split('/');
    coreName = parts[parts.length - 1];
  }

  // 剥离厂商/区域路由前缀（bedrock/anthropic.xxx -> xxx）
  coreName = stripDottedVendorPrefix(coreName);

  // 只清理真正的描述性后缀，保留版本号
  const suffixPatterns = [
    /\s*\(.*?\)/g,        // 括号内容：(反代Notion-stream)、(反代Lmarena)、(可搜尋)
    /\s*\[.*?\]/g,        // 方括号内容：[满血1m]、[免审]
    /\s*-cli$/g,          // -cli 后缀
    /\s*-droid$/g,        // -droid 后缀
    /\s*-high$/g,         // -high 后缀
    /\s*-thinking$/g,     // -thinking 后缀
    /\s*反代.*$/g,        // 中文反代标记
    /\s*可搜尋.*$/g,      // 中文可搜索标记
    /\s*grounding.*$/g,   // grounding 相关后缀
    /\s*image.*$/g,       // image 相关后缀
    /\s*preview.*$/g,     // preview 相关后缀
    /\s*search.*$/g,      // search 相关后缀
    // AWS Bedrock / Azure 部署式命名常见的尾部日期戳与版本号
    /-\d{4}-\d{2}-\d{2}$/,  // 尾部日期：-2025-08-07
    /-\d{8}$/,              // 尾部日期：-20250929
    /-v\d+:\d+$/,           // AWS Bedrock 版本号：-v1:0
    /:\d+$/,                // 裸修订号：:0
    /-v\d+$/,               // 简单版本号：-v1
  ];

  // 多轮清理：日期+版本号叠加出现时，单轮 replace 可能清不干净（如 -20250929-v1:0）
  for (let round = 0; round < 3; round++) {
    const before = coreName;
    for (const pattern of suffixPatterns) {
      coreName = coreName.replace(pattern, '');
    }
    coreName = coreName.trim();
    if (coreName === before) break;
  }

  return coreName.trim();
}

// 生成模型名称变体（点号/破折号互换、大小写变体等）
function generateNameVariants(name) {
  const variants = new Set([name]);

  const withDots = name.replace(/(\d)-(\d)/g, '$1.$2');
  const withDashes = name.replace(/(\d)\.(\d)/g, '$1-$2');
  variants.add(withDots);
  variants.add(withDashes);

  const lowerB = name.replace(/(\d+\.?\d*)B\b/gi, (match, num) => `${num}b`);
  const upperB = name.replace(/(\d+\.?\d*)b\b/gi, (match, num) => `${num}B`);
  variants.add(lowerB);
  variants.add(upperB);

  const withUnderscores = name.replace(/-/g, '_');
  const withHyphens = name.replace(/_/g, '-');
  variants.add(withUnderscores);
  variants.add(withHyphens);

  variants.add(name.toLowerCase());
  variants.add(name.toUpperCase());

  return Array.from(variants);
}

// 对单个模型名做模糊匹配，在官方价格表中查找对应价格
// prices 结构：{ bare: {裸模型名: {prompt, completion}}, full: {完整部署名: {prompt, completion}} }
// 返回 null（未匹配）或 { matchedName, source, prompt, completion }
function matchOfficialPrice(modelName, prices) {
  const full = (prices && prices.full) || {};
  const bare = (prices && prices.bare) || prices || {};

  // 第一层：完整部署名精确匹配（原始名 / 斜杠取最后一段两种形式都试）
  if (full[modelName]) {
    return { matchedName: modelName, source: 'exact-full', ...full[modelName] };
  }
  const lastSegment = modelName.includes('/') ? modelName.split('/').pop() : modelName;
  if (lastSegment !== modelName && full[lastSegment]) {
    return { matchedName: lastSegment, source: 'exact-full', ...full[lastSegment] };
  }

  // 第二层：人工别名兜底表（原始名 / 清理后的核心名）
  const coreName = cleanCoreName(modelName);
  if (MANUAL_ALIAS_TABLE[modelName]) {
    const aliasKey = MANUAL_ALIAS_TABLE[modelName];
    if (bare[aliasKey]) {
      return { matchedName: aliasKey, source: 'alias', ...bare[aliasKey] };
    }
  }
  if (MANUAL_ALIAS_TABLE[coreName]) {
    const aliasKey = MANUAL_ALIAS_TABLE[coreName];
    if (bare[aliasKey]) {
      return { matchedName: aliasKey, source: 'alias', ...bare[aliasKey] };
    }
  }

  // 第三层：清理后的核心名精确匹配
  if (bare[coreName]) {
    return { matchedName: coreName, source: 'bare', ...bare[coreName] };
  }

  // 第四层：核心名的机械变体（点号/破折号互换、大小写等）
  const variants = generateNameVariants(coreName);
  for (const variant of variants) {
    if (bare[variant]) {
      return { matchedName: variant, source: 'bare', ...bare[variant] };
    }
  }

  return null;
}

// 获取当前页面的 API 基础 URL
function getCurrentApiUrl() {
  const url = new URL(window.location.href);
  return `${url.protocol}//${url.host}`;
}

// 使用 Chrome Cookies API 获取 Cookie
async function getCookiesFromAPI(url) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      action: 'getCookies',
      url: url
    }, (response) => {
      resolve(response);
    });
  });
}

// 解析 New API 返回的配置数据结构
// New API 的 /api/option/?key=X 正常应返回该 key 的对象，但某些部署会返回全量选项数组
// [{key: "ModelRatio", value: "JSON字符串"}]，需要从数组中定位目标 key 再解析
function parseConfigValue(configData, targetKey) {
  if (configData && typeof configData === 'object' && !Array.isArray(configData)) {
    return configData;
  }

  if (Array.isArray(configData)) {
    const configItem = configData.find(item => item.key === targetKey);
    if (!configItem || !configItem.value) return {};
    try {
      return JSON.parse(configItem.value);
    } catch (e) {
      console.error(`解析 ${targetKey} 失败:`, e);
      return {};
    }
  }

  return {};
}

// 获取现有的 ModelRatio / CompletionRatio 配置（用于合并时保留其他模型不受影响）
async function fetchExistingConfig(apiUrl) {
  const config = {
    ModelRatio: {},
    CompletionRatio: {}
  };

  try {
    const cookieData = await getCookiesFromAPI(apiUrl);
    if (!cookieData || !cookieData.success || !cookieData.newApiUser) {
      // 静默处理：这是预期的情况（用户未登录或不在正确页面）
      return config;
    }

    const headers = {
      'New-API-User': cookieData.newApiUser
    };

    console.log('📖 读取现有配置，使用 New-API-User:', cookieData.newApiUser);

    const ratioRes = await fetch(`${apiUrl}/api/option/?key=ModelRatio`, {
      credentials: 'include',
      headers: headers
    });
    if (ratioRes.ok) {
      const data = await ratioRes.json();
      if (data.success && data.data) {
        const parsed = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
        config.ModelRatio = parseConfigValue(parsed, 'ModelRatio');
        console.log('✓ 读取到 ModelRatio:', Object.keys(config.ModelRatio).length, '个模型');
      }
    } else if (ratioRes.status !== 401 && ratioRes.status !== 403) {
      console.warn(`⚠️ 读取 ModelRatio 失败: HTTP ${ratioRes.status}`);
    }

    const completionRes = await fetch(`${apiUrl}/api/option/?key=CompletionRatio`, {
      credentials: 'include',
      headers: headers
    });
    if (completionRes.ok) {
      const data = await completionRes.json();
      if (data.success && data.data) {
        const parsed = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
        config.CompletionRatio = parseConfigValue(parsed, 'CompletionRatio');
        console.log('✓ 读取到 CompletionRatio:', Object.keys(config.CompletionRatio).length, '个模型');
      }
    } else if (completionRes.status !== 401 && completionRes.status !== 403) {
      console.warn(`⚠️ 读取 CompletionRatio 失败: HTTP ${completionRes.status}`);
    }
  } catch (error) {
    // 静默处理：这些错误是预期的（用户未登录或不在正确页面）
    if (chrome.runtime.getManifest().version_name?.includes('dev')) {
      console.debug('获取现有配置失败（预期行为）:', error.message);
    }
  }

  return config;
}

// 更新单个配置项
async function updateOption(apiUrl, key, value) {
  const cookieData = await getCookiesFromAPI(apiUrl);
  console.log('🍪 Cookie 数据:', cookieData);

  if (!cookieData || !cookieData.success) {
    throw new Error('无法获取 Cookie，请确保：\n1. 已登录 New API 后台\n2. 刷新页面后重试');
  }

  const newApiUser = cookieData.newApiUser;
  if (!newApiUser) {
    throw new Error('未找到登录状态（New-API-User Cookie）。请确保已登录 New API 后台。');
  }

  console.log('✓ 找到 New-API-User:', newApiUser);

  const headers = {
    'Content-Type': 'application/json',
    'New-API-User': newApiUser
  };

  console.log('📤 发送请求:', {
    url: `${apiUrl}/api/option/`,
    method: 'PUT',
    headers: headers
  });

  const response = await fetch(`${apiUrl}/api/option/`, {
    method: 'PUT',
    headers: headers,
    credentials: 'include',
    body: JSON.stringify({
      key: key,
      value: JSON.stringify(value)
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('❌ 请求失败:', errorText);
    throw new Error(`更新 ${key} 失败 (HTTP ${response.status}): ${errorText}`);
  }

  const result = await response.json();
  if (!result.success) {
    throw new Error(`更新 ${key} 失败: ${result.message || '未知错误'}`);
  }

  console.log(`✅ 成功更新 ${key}`);
  return result;
}

// 精确按 key 合并：只覆盖 updates 里出现的 key，其余现有配置原样保留
function mergeSelectedOnly(existing, updates) {
  return { ...existing, ...updates };
}

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      // Ping 测试（用于检测 content script 是否已加载）
      if (request.action === 'ping') {
        sendResponse({ success: true, message: 'pong' });
        return;
      }

      if (request.action === 'getChannelList') {
        // 获取渠道列表
        console.log('📋 开始获取渠道列表...');

        const apiUrl = getCurrentApiUrl();

        const cookieData = await getCookiesFromAPI(apiUrl);
        if (!cookieData || !cookieData.success || !cookieData.newApiUser) {
          throw new Error('无法获取登录状态，请确保已登录 New API 后台');
        }

        const headers = {
          'New-API-User': cookieData.newApiUser
        };

        console.log(`📡 请求渠道列表: ${apiUrl}/api/channel/?page_size=1000`);

        const channelsResponse = await fetch(`${apiUrl}/api/channel/?page_size=1000`, {
          method: 'GET',
          headers: headers,
          credentials: 'include'
        });

        if (!channelsResponse.ok) {
          throw new Error(`获取渠道列表失败 (HTTP ${channelsResponse.status})`);
        }

        const channelsData = await channelsResponse.json();
        console.log('📦 渠道列表数据:', channelsData);

        if (!channelsData.success || !channelsData.data) {
          throw new Error('渠道列表数据格式错误');
        }

        // 支持两种数据格式：直接数组或包含 items 的对象
        const channelList = Array.isArray(channelsData.data)
          ? channelsData.data
          : (channelsData.data.items || []);

        if (!Array.isArray(channelList) || channelList.length === 0) {
          throw new Error('渠道列表为空');
        }

        // 过滤掉禁用的渠道（status !== 1 表示禁用）
        const enabledChannels = channelList.filter(ch => ch.status === 1);

        console.log(`📊 渠道统计: 总共 ${channelList.length} 个，启用 ${enabledChannels.length} 个`);

        const channels = enabledChannels.map(ch => ({
          id: ch.id,
          name: ch.name,
          type: ch.type,
          baseUrl: ch.base_url,
          tag: ch.tag,
          models: ch.models ? ch.models.split(',').length : 0,
          status: ch.status
        }));

        console.log(`✅ 获取到 ${channels.length} 个启用的渠道`);

        sendResponse({
          success: true,
          channels: channels
        });
      }
      else if (request.action === 'analyzeChannelPricing') {
        // 只读：读取渠道当前已配置的模型名列表，对每个模型名做模糊匹配，
        // 从 OpenRouter 官方价格表中查找价格。全程不修改渠道的 models/model_mapping。
        const { channelId } = request;

        const apiUrl = getCurrentApiUrl();

        const cookieData = await getCookiesFromAPI(apiUrl);
        if (!cookieData || !cookieData.success || !cookieData.newApiUser) {
          throw new Error('无法获取登录状态，请确保已登录 New API 后台');
        }

        const headers = {
          'New-API-User': cookieData.newApiUser
        };

        console.log(`📖 读取渠道 ${channelId} 当前配置...`);
        const channelResponse = await fetch(`${apiUrl}/api/channel/${channelId}`, {
          method: 'GET',
          headers: headers,
          credentials: 'include'
        });

        if (!channelResponse.ok) {
          throw new Error(`获取渠道配置失败 (HTTP ${channelResponse.status})`);
        }

        const channelData = await channelResponse.json();
        if (!channelData.success || !channelData.data) {
          throw new Error('获取渠道配置失败');
        }

        const currentChannel = channelData.data;
        const modelNames = (currentChannel.models || '')
          .split(',')
          .map(name => name.trim())
          .filter(name => name.length > 0);

        console.log(`✅ 渠道当前共有 ${modelNames.length} 个模型`);

        const prices = await loadOfficialPrices();

        const results = modelNames.map(modelName => {
          const match = matchOfficialPrice(modelName, prices);
          if (!match) {
            return { modelName, matched: false };
          }

          const modelRatio = Math.round((match.prompt / 2) * 10000) / 10000;
          const completionRatio = match.prompt > 0
            ? Math.round((match.completion / match.prompt) * 10000) / 10000
            : 1;

          return {
            modelName,
            matched: true,
            matchedName: match.matchedName,
            source: match.source,
            promptPrice: match.prompt,
            completionPrice: match.completion,
            modelRatio,
            completionRatio
          };
        });

        const matchedCount = results.filter(r => r.matched).length;
        console.log(`✅ 匹配完成: ${matchedCount}/${results.length} 个模型命中官方价格`);

        sendResponse({
          success: true,
          apiUrl,
          results
        });
      }
      else if (request.action === 'syncSelectedPrices') {
        // 只把用户勾选的模型价格写回 ModelRatio/CompletionRatio，
        // 精确按 key 合并——只覆盖被勾选的 key，其余现有配置原样保留，绝不改动模型名。
        const { apiUrl, selections } = request;

        if (!Array.isArray(selections) || selections.length === 0) {
          throw new Error('没有选中任何模型');
        }

        const modelRatioUpdates = {};
        const completionRatioUpdates = {};

        selections.forEach(sel => {
          modelRatioUpdates[sel.modelName] = sel.modelRatio;
          completionRatioUpdates[sel.modelName] = sel.completionRatio;
        });

        console.log(`🔄 准备同步 ${selections.length} 个模型的价格...`);

        const existingConfig = await fetchExistingConfig(apiUrl);

        const mergedModelRatios = mergeSelectedOnly(existingConfig.ModelRatio, modelRatioUpdates);
        const mergedCompletionRatios = mergeSelectedOnly(existingConfig.CompletionRatio, completionRatioUpdates);

        await updateOption(apiUrl, 'ModelRatio', mergedModelRatios);
        await updateOption(apiUrl, 'CompletionRatio', mergedCompletionRatios);

        console.log(`✅ 已同步 ${selections.length} 个模型的价格`);

        sendResponse({
          success: true,
          stats: {
            syncedCount: selections.length
          }
        });
      }
    } catch (error) {
      // 记录详细错误信息
      await logError(request.action || 'unknown', error, {
        requestData: {
          action: request.action,
          channelId: request.channelId
        }
      });

      sendResponse({
        success: false,
        error: error.message,
        errorDetails: {
          name: error.name,
          stack: error.stack?.split('\n').slice(0, 3).join('\n'), // 前3行堆栈
          timestamp: Date.now()
        }
      });
    }
  })();

  // 返回 true 表示异步响应
  return true;
});

console.log('✅ PriceSyncPro Extension 已加载');

// 仅供 Node 测试脚本使用，浏览器环境中 module 未定义，不影响扩展运行
if (typeof module !== 'undefined') {
  module.exports = { cleanCoreName, generateNameVariants, matchOfficialPrice, MANUAL_ALIAS_TABLE };
}
