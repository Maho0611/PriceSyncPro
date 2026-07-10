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
// 注意：image 分辨率/挡位后缀已有通用规则处理（见 stripImageResolutionSuffix），
// 此处这条别名是该规则生效前遗留的示例，保留作为"清理后核心名"层的命中示例
// 注意：embedding 类模型（如 qwen3-embedding-8b）没有 prompt/completion 双向计价概念，
// 三个价格源均不收录对话模型之外的 embedding 定价，预期落在未匹配，不需要人工登记
const MANUAL_ALIAS_TABLE = {
  'gemini-3-image-preview-2k': 'gemini-3-pro-image-preview',
};

// 剥离双短横厂商前缀，如 anthropic--claude-3-haiku -> claude-3-haiku
// 官方价格表中不存在任何本身含双短横的合法 key，剥离不会误伤
function stripDoubleDashVendorPrefix(name) {
  return name.replace(/^[a-z0-9]{2,20}--(?=[a-zA-Z])/i, '');
}

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

// 结构性核心名：只做斜杠取段 + 厂商前缀剥离 + 日期/版本号剥离，不做任何装饰性词汇删除
// 用于在套用装饰性清理规则之前，先尝试原样命中官方表——因为 preview/image/search 等
// 词汇本身也是大量官方模型名的合法组成部分（如 gemini-3.1-pro-preview），必须先试原样匹配
function cleanStructuralCore(modelName) {
  let coreName = modelName;

  // 如果包含斜杠，提取最后一段
  if (modelName.includes('/')) {
    const parts = modelName.split('/');
    coreName = parts[parts.length - 1];
  }

  // 剥离厂商前缀（anthropic--claude-3-haiku -> claude-3-haiku）
  coreName = stripDoubleDashVendorPrefix(coreName);

  // 剥离厂商/区域路由前缀（bedrock/anthropic.xxx -> xxx）
  coreName = stripDottedVendorPrefix(coreName);

  // AWS Bedrock / Azure 部署式命名常见的尾部日期戳与版本号
  const structuralSuffixPatterns = [
    /-\d{4}-\d{2}-\d{2}$/,  // 尾部日期：-2025-08-07
    /-\d{8}$/,              // 尾部日期：-20250929
    /-v\d+:\d+$/,           // AWS Bedrock 版本号：-v1:0
    /:\d+$/,                // 裸修订号：:0
    /-v\d+$/,               // 简单版本号：-v1
  ];

  for (let round = 0; round < 3; round++) {
    const before = coreName;
    for (const pattern of structuralSuffixPatterns) {
      coreName = coreName.replace(pattern, '');
    }
    coreName = coreName.trim();
    if (coreName === before) break;
  }

  return coreName;
}

// 清理模型名的第二层：结构性核心名基础上，套用"安全"的装饰性清理规则——
// 这些规则清除的都是明确不会与官方模型名冲突的标记（括号、-cli、-droid、-thinking 等），
// 不包含 grounding/image/preview/search 这类本身可能是官方模型名合法组成部分的贪婪规则
function cleanSafeCore(modelName) {
  let coreName = cleanStructuralCore(modelName);

  const safeSuffixPatterns = [
    /\s*\(.*?\)/g,        // 括号内容：(反代Notion-stream)、(反代Lmarena)、(可搜尋)
    /\s*\[.*?\]/g,        // 方括号内容：[满血1m]、[免审]
    /\s*-cli$/g,          // -cli 后缀
    /\s*-droid$/g,        // -droid 后缀
    /\s*-high$/g,         // -high 后缀
    /-(?:max|no|min|low|mid)thinking$/gi, // 思考预算标记：-maxthinking / -nothinking 等
    /\s*-thinking$/g,     // -thinking 后缀
    /[:_-]web[-_]?search$/gi,  // 网页搜索能力标记：:web-search / -web_search 等
    /:online$/gi,         // 联网能力标记：:online
    /:browsing$/gi,       // 浏览能力标记：:browsing
    /\s*反代.*$/g,        // 中文反代标记
    /\s*可搜尋.*$/g,      // 中文可搜索标记
  ];

  for (let round = 0; round < 3; round++) {
    const before = coreName;
    for (const pattern of safeSuffixPatterns) {
      coreName = coreName.replace(pattern, '');
    }
    coreName = coreName.trim();
    if (coreName === before) break;
  }

  return coreName;
}

// 剥离 image 类模型的分辨率/挡位尾部后缀（如 -2k、-4k、-4k-think），仅当核心名含 image
// 时才生效，避免误伤 mistral-7b-instruct-4k 这类不含 image、-Nk 表示合法上下文窗口标记的模型
// 官方价格表中没有任何按分辨率挡位区分定价的 image 模型，剥离后落到不带挡位的基础价格
function stripImageResolutionSuffix(name) {
  if (!/image/i.test(name)) return name;
  let result = name;
  for (let i = 0; i < 2; i++) {
    const stripped = result.replace(/-\d+k(-\w+)?$/i, '');
    if (stripped === result) break;
    result = stripped;
  }
  return result;
}

// 清理模型名，得到用于匹配的"核心名"（不改变原始模型名，只用于查表）
// 在安全核心名基础上，最后才套用贪婪的装饰性词汇清理规则（grounding/image/preview/search）
function cleanCoreName(modelName) {
  let coreName = cleanSafeCore(modelName);

  // 贪婪清理：这些词汇也可能是官方模型名的合法组成部分（如 gemini-3.1-pro-preview），
  // 因此只作为最后兜底，前面的结构性/安全核心名查找层应优先命中
  const greedySuffixPatterns = [
    /\s*grounding.*$/g,   // grounding 相关后缀
    /\s*image.*$/g,       // image 相关后缀
    /\s*preview.*$/g,     // preview 相关后缀
    /\s*search.*$/g,      // search 相关后缀
  ];

  for (let round = 0; round < 3; round++) {
    const before = coreName;
    for (const pattern of greedySuffixPatterns) {
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

  // 段位名与版本号词序互换：xxx-<版本号>-<段位名> <-> xxx-<段位名>-<版本号>
  // 不同价格源对同一模型的命名词序不一致（如 claude-4-sonnet vs claude-sonnet-4），
  // 用正则捕获组而非写死具体版本号，未来新版本号自动适配
  const tierNamePattern = /^(.+)-(\d[\d.]*)-(opus|sonnet|haiku|pro|flash|mini|nano|max|air)$/i;
  const versionAfterTierPattern = /^(.+)-(opus|sonnet|haiku|pro|flash|mini|nano|max|air)-(\d[\d.]*)$/i;
  const swapMatch1 = name.match(tierNamePattern);
  if (swapMatch1) {
    variants.add(`${swapMatch1[1]}-${swapMatch1[3]}-${swapMatch1[2]}`);
  }
  const swapMatch2 = name.match(versionAfterTierPattern);
  if (swapMatch2) {
    variants.add(`${swapMatch2[1]}-${swapMatch2[3]}-${swapMatch2[2]}`);
  }

  return Array.from(variants);
}

// 对单个模型名做模糊匹配，在官方价格表中查找对应价格
// prices 结构：{ bare: {裸模型名: PriceEntry}, full: {完整部署名: PriceEntry} }
// PriceEntry 按计价模式二选一：{prompt, completion, cacheRead?, cacheWrite?, billingMode:'ratio'} 或 {flatPrice, billingMode:'flat'}
// 返回 null（未匹配）或 { matchedName, source, ...PriceEntry }
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
  const structuralCore = cleanStructuralCore(modelName);
  const safeCore = cleanSafeCore(modelName);
  const imageResCore = stripImageResolutionSuffix(safeCore);
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

  // 第三层：结构性核心名精确匹配（不做装饰性词汇删除，优先原样命中）
  // preview/image/search/grounding 等词汇本身也是大量官方模型名的合法组成部分
  // （如 gemini-3.1-pro-preview），必须先试原样匹配，避免被后续贪婪清理误伤
  if (bare[structuralCore]) {
    return { matchedName: structuralCore, source: 'bare', ...bare[structuralCore] };
  }

  // 第四层：安全核心名精确匹配（清理括号/-cli/-thinking 等明确不冲突的标记）
  if (safeCore !== structuralCore && bare[safeCore]) {
    return { matchedName: safeCore, source: 'bare', ...bare[safeCore] };
  }

  // 第四点五层：image 分辨率/挡位后缀剥离后精确匹配（如 xxx-image-preview-2k -> xxx-image-preview）
  if (imageResCore !== safeCore && bare[imageResCore]) {
    return { matchedName: imageResCore, source: 'bare', ...bare[imageResCore] };
  }

  // 第五层：完整清理（含贪婪的 grounding/image/preview/search 删除）后的核心名精确匹配
  if (coreName !== imageResCore && bare[coreName]) {
    return { matchedName: coreName, source: 'bare', ...bare[coreName] };
  }

  // 第六层：核心名的机械变体（点号/破折号互换、大小写等）
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

// 获取现有配置（用于合并时保留其他模型不受影响）；keys 为需要读取的 option key 列表
async function fetchExistingConfig(apiUrl, keys) {
  const config = {};
  keys.forEach(key => { config[key] = {}; });

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

    for (const key of keys) {
      try {
        const res = await fetch(`${apiUrl}/api/option/?key=${key}`, {
          credentials: 'include',
          headers: headers
        });
        if (res.ok) {
          const data = await res.json();
          if (data.success && data.data) {
            const parsed = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
            config[key] = parseConfigValue(parsed, key);
            console.log(`✓ 读取到 ${key}:`, Object.keys(config[key]).length, '个模型');
          }
        } else if (res.status !== 401 && res.status !== 403) {
          console.warn(`⚠️ 读取 ${key} 失败: HTTP ${res.status}`);
        }
      } catch (keyError) {
        // 单个 key 读取失败（网络错误/JSON 解析失败等）只影响这一个 key，
        // 不能让它连带其余 key 也退化为空对象——否则后续合并写入会把远端该 key
        // 下所有未被本次选中的模型一并覆盖丢失
        console.warn(`⚠️ 读取 ${key} 时出错:`, keyError.message);
      }
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

          if (match.billingMode === 'flat') {
            // 按次固定计价：与倍率家族互斥，不计算/不携带 modelRatio/completionRatio/cacheRatio/createCacheRatio
            return {
              modelName,
              matched: true,
              matchedName: match.matchedName,
              source: match.source,
              billingMode: 'flat',
              flatPrice: match.flatPrice,
              modelPrice: match.flatPrice
            };
          }

          const modelRatio = Math.round((match.prompt / 2) * 10000) / 10000;
          const completionRatio = match.prompt > 0
            ? Math.round((match.completion / match.prompt) * 10000) / 10000
            : 1;

          const result = {
            modelName,
            matched: true,
            matchedName: match.matchedName,
            source: match.source,
            billingMode: 'ratio',
            promptPrice: match.prompt,
            completionPrice: match.completion,
            modelRatio,
            completionRatio
          };

          if (match.cacheRead != null && match.prompt > 0) {
            result.cacheReadPrice = match.cacheRead;
            result.cacheRatio = Math.round((match.cacheRead / match.prompt) * 10000) / 10000;
          }
          if (match.cacheWrite != null && match.prompt > 0) {
            result.cacheWritePrice = match.cacheWrite;
            result.createCacheRatio = Math.round((match.cacheWrite / match.prompt) * 10000) / 10000;
          }

          return result;
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
        // 只把用户勾选的模型价格写回对应的 New API 配置 key，
        // 精确按 key 合并——只覆盖被勾选的 key，其余现有配置原样保留，绝不改动模型名。
        // 按次计价（ModelPrice）与倍率家族（ModelRatio/CompletionRatio/CacheRatio/CreateCacheRatio）
        // 互斥：模型切换计费模式时，必须删除另一家族里的残留条目，否则 New API 会按残留的
        // ModelPrice 优先计费，导致新写入的倍率配置完全不生效。
        const { apiUrl, selections } = request;

        if (!Array.isArray(selections) || selections.length === 0) {
          throw new Error('没有选中任何模型');
        }

        const updatesByKey = { ModelRatio: {}, CompletionRatio: {}, CacheRatio: {}, CreateCacheRatio: {}, ModelPrice: {} };
        const flatModelNames = [];
        const ratioModelNames = [];

        selections.forEach(sel => {
          if (sel.billingMode === 'flat') {
            updatesByKey.ModelPrice[sel.modelName] = sel.modelPrice;
            flatModelNames.push(sel.modelName);
          } else {
            updatesByKey.ModelRatio[sel.modelName] = sel.modelRatio;
            updatesByKey.CompletionRatio[sel.modelName] = sel.completionRatio;
            if (sel.cacheRatio != null) updatesByKey.CacheRatio[sel.modelName] = sel.cacheRatio;
            if (sel.createCacheRatio != null) updatesByKey.CreateCacheRatio[sel.modelName] = sel.createCacheRatio;
            ratioModelNames.push(sel.modelName);
          }
        });

        console.log(`🔄 准备同步 ${selections.length} 个模型的价格...`);

        // ModelRatio/CompletionRatio/ModelPrice 三个 key 只要本次选中了任意模型就必须读取+写入——
        // 不是因为这三个 key 一定有新数据，而是因为跨家族"删除残留"逻辑必须在这三个 key 上生效。
        // CacheRatio/CreateCacheRatio 只要本次有任意按倍率同步的模型就必须读取+写入——
        // 否则某个按倍率模型这次同步没有缓存价格（源数据缓存价格消失，或本轮匹配结果不含缓存价格），
        // 其在远端的旧缓存倍率会永久残留，且无法通过"这批里有没有模型带缓存数据"来判断要不要处理它。
        const keysToTouch = ['ModelRatio', 'CompletionRatio', 'ModelPrice'];
        if (ratioModelNames.length > 0) {
          keysToTouch.push('CacheRatio', 'CreateCacheRatio');
        }

        const existingConfig = await fetchExistingConfig(apiUrl, keysToTouch);

        const RATIO_FAMILY_KEYS = ['ModelRatio', 'CompletionRatio', 'CacheRatio', 'CreateCacheRatio'];
        const CACHE_KEYS = ['CacheRatio', 'CreateCacheRatio'];
        for (const key of keysToTouch) {
          const merged = mergeSelectedOnly(existingConfig[key] || {}, updatesByKey[key]);
          if (key === 'ModelPrice') {
            // 本次以 ratio 方式同步的模型，若在 ModelPrice 里有残留（曾被判定为按次计价），必须删除——
            // 否则该模型会一直按旧的按次价格计费，新写入的 ModelRatio/CompletionRatio 完全不生效
            ratioModelNames.forEach(name => delete merged[name]);
          } else if (RATIO_FAMILY_KEYS.includes(key)) {
            // 本次以 flat 方式同步的模型，若在倍率家族 key 里有残留，删除（非计费关键，保持配置干净）
            flatModelNames.forEach(name => delete merged[name]);
            if (CACHE_KEYS.includes(key)) {
              // 本次以 ratio 方式同步、但这次没有缓存价格的模型，清除其残留的缓存倍率，
              // 确保这次被显式重新同步的模型的缓存价格状态与本轮匹配结果完全一致
              ratioModelNames.forEach(name => {
                if (updatesByKey[key][name] === undefined) delete merged[name];
              });
            }
          }
          await updateOption(apiUrl, key, merged);
        }

        console.log(`✅ 已同步 ${selections.length} 个模型的价格`);

        sendResponse({
          success: true,
          stats: {
            syncedCount: selections.length,
            keysWritten: keysToTouch
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
