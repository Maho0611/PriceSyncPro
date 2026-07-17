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
// 注意：v3.5.0 起 embedding/rerank/tts/stt/image/video 类模型价格已收录（Vercel 按 type
// 分发 + LiteLLM 无前缀条目），不再预期整类未匹配；whisper 系按音频秒数计价的模型仍无法
// 映射（New API 无按时长计费路径），预期落在未匹配，不需要人工登记
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

  // 4 位纯数字段（月日型日期戳，如 grok-4.20-0309 / grok-4.20-0309-non-reasoning /
  // tts-1-1106）：生成剥离该段的变体。只能放在变体层，绝不能进 cleanStructuralCore 的
  // 前置剥离规则——grok-4-0709、gpt-4-1106-preview 这类带日期戳的名字本身就是官方表的
  // 独立 key，前置剥离会破坏它们在前几层的精确匹配；而到达变体层说明原样匹配已经全部
  // 失败，此时剥离才是安全的兜底
  const dateStubStripped = name.replace(/-\d{4}(?=-|$)/g, '');
  if (dateStubStripped !== name && dateStubStripped.length > 0) {
    variants.add(dateStubStripped);
  }

  return Array.from(variants);
}

// 对单个模型名做模糊匹配，在官方价格表中查找对应价格
// prices 结构：{ bare: {裸模型名: PriceEntry}, full: {完整部署名: PriceEntry} }
// PriceEntry 按计价模式二选一：{prompt, completion, cacheRead?, cacheWrite?, type?, billingMode:'ratio'}
// 或 {flatPrice, flatUnit?, type?, billingMode:'flat'}（flatUnit: 'call'=每次整价（缺省）/
// 'second'=每秒基准价；type: 非对话模型的语义类型标记，见 background.js PriceEntry 文档）
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

  // 第一点五层：裸表原始名精确匹配——渠道名与官方 bare key 完全一致时必须原样命中，
  // 绝不能先过清理层。cleanStructuralCore 会剥离尾部日期戳，而官方表里"带日期戳的 key"
  // 与"基础版 key"常常同时存在且价格不同（如 gpt-4o-2024-05-13 $5/M vs gpt-4o $2.5/M、
  // mistral-large-2402 $8/M vs mistral-large $2/M），先剥离再查表会把带戳模型错配到
  // 基础版价格，造成真实计费错误；cohere.command-a-reasoning-08-2025 这类带点号前缀的
  // key 更是会被前缀剥离弄到完全无法命中自身
  if (bare[modelName]) {
    return { matchedName: modelName, source: 'bare', ...bare[modelName] };
  }
  if (lastSegment !== modelName && bare[lastSegment]) {
    return { matchedName: lastSegment, source: 'bare', ...bare[lastSegment] };
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

// 格式化数字为表达式字面量：避免浮点误差产生过长小数（如 0.1 + 0.2 = 0.30000000000000004）
function formatExprNumber(value) {
  return Math.round(value * 1e6) / 1e6;
}

// 构建长上下文分级计价的 New API billing_setting 表达式（tiered_expr 语法）。
// 表达式里的系数单位是"美元/1M token"（New API v1 表达式版本约定，见其 quotaConversion 换算），
// 与本插件内部经 toPerMillion() 换算后的价格单位一致，不需要套用 ModelRatio 专属的 /2 换算。
//
// cr/cc（缓存读写）是否写进表达式，必须在两档（standard/long_context）里保持一致：
// New API 用 AST 静态分析整个表达式引用了哪些变量来决定"是否把对应 token 从 p/c 里扣除"，
// 这个检测是对整条表达式一次性做的，不是按三元分支各自独立判断。如果只在其中一档引用了
// cr，另一档缺失该项，该档实际命中时缓存 token 仍会被扣出但没有对应计价项，等于被免费计费。
// 因此这里采用"两档都有才写入 cr/cc，否则两档都不写"的对称规则，避免这个陷阱。
function buildTieredExpr(match) {
  const long = match.longContext;
  const standardPrompt = formatExprNumber(match.prompt);
  const standardCompletion = formatExprNumber(match.completion);
  const longPrompt = formatExprNumber(long.prompt);
  const longCompletion = formatExprNumber(long.completion != null ? long.completion : match.completion);

  const includeCacheRead = match.cacheRead != null && long.cacheRead != null;
  const includeCacheWrite = match.cacheWrite != null && long.cacheWrite != null;

  const buildTerm = (prompt, completion, cacheRead, cacheWrite) => {
    let term = `p * ${prompt} + c * ${completion}`;
    if (includeCacheRead) term += ` + cr * ${formatExprNumber(cacheRead)}`;
    if (includeCacheWrite) term += ` + cc * ${formatExprNumber(cacheWrite)}`;
    return term;
  };

  const standardTerm = buildTerm(standardPrompt, standardCompletion, match.cacheRead, match.cacheWrite);
  const longTerm = buildTerm(longPrompt, longCompletion, long.cacheRead, long.cacheWrite);

  const expr = `len <= ${long.thresholdTokens} ? tier("standard", ${standardTerm}) : tier("long_context", ${longTerm})`;

  return {
    expr,
    thresholdTokens: long.thresholdTokens,
    longPromptPrice: long.prompt,
    longCompletionPrice: long.completion != null ? long.completion : match.completion,
    // 展示字段必须和 includeCacheRead/includeCacheWrite 门控一致——否则会出现 UI 显示了
    // 长上下文档的缓存读/写价格，但表达式因两档不对称实际没有计入该项的误导性展示
    // （用户以为这个价格会生效，实际上这部分 token 被计入基础 p/c 按普通价格计费）
    longCacheReadPrice: includeCacheRead ? long.cacheRead : undefined,
    longCacheWritePrice: includeCacheWrite ? long.cacheWrite : undefined
  };
}

// 把单个官方价格匹配对象（matchOfficialPrice 的返回，或兜底候选的 PriceEntry）构造成
// 统一的 result 形状（flat/ratio/tiered 三种，见 buildMatchResults 的形状注释）。
// 正常匹配与兜底候选共用这一份构造逻辑，保证候选一旦被选中，行数据与正常匹配完全同构
function buildResultFromMatch(modelName, match) {
  if (match.billingMode === 'flat') {
    // 按次固定计价：与倍率家族互斥，不计算/不携带 modelRatio/completionRatio/cacheRatio/createCacheRatio
    const flatResult = {
      modelName,
      matched: true,
      matchedName: match.matchedName,
      source: match.source,
      billingMode: 'flat',
      flatPrice: match.flatPrice,
      modelPrice: match.flatPrice
    };
    if (match.flatUnit) flatResult.flatUnit = match.flatUnit;
    if (match.type) flatResult.modelType = match.type;
    return flatResult;
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
  if (match.type) result.modelType = match.type;

  if (match.cacheRead != null && match.prompt > 0) {
    result.cacheReadPrice = match.cacheRead;
    result.cacheRatio = Math.round((match.cacheRead / match.prompt) * 10000) / 10000;
  }
  if (match.cacheWrite != null && match.prompt > 0) {
    result.cacheWritePrice = match.cacheWrite;
    result.createCacheRatio = Math.round((match.cacheWrite / match.prompt) * 10000) / 10000;
  }

  // 长上下文分级定价（如存在）：billingMode 升级为 'tiered'，同时保留上面算好的
  // modelRatio/completionRatio/cacheRatio/createCacheRatio 作为兜底——New API 的
  // tiered_expr 与 ModelRatio 两条计费路径互相独立，写分级表达式的同时一并写入
  // 阈值以下那档的普通倍率，防止 New API 已知 bug（#4523：保存 tiered_expr 后
  // ModelRatio 被清空导致 model_price_error）把模型计费彻底打断
  if (match.longContext) {
    const tiered = buildTieredExpr(match);
    result.billingMode = 'tiered';
    result.billingExpr = tiered.expr;
    result.longContextThreshold = tiered.thresholdTokens;
    result.longContextPromptPrice = tiered.longPromptPrice;
    result.longContextCompletionPrice = tiered.longCompletionPrice;
    if (tiered.longCacheReadPrice != null) result.longContextCacheReadPrice = tiered.longCacheReadPrice;
    if (tiered.longCacheWritePrice != null) result.longContextCacheWritePrice = tiered.longCacheWritePrice;
  }

  return result;
}

// ============================================================
// 兜底匹配：五层规则 + 变体层全部失败后，基于"名字包含关系"生成候选。
// 这是启发式推断（价格可能不精确），因此绝不自动生效——由 UI 层下拉框手动选择，
// 或用户显式打开"自动兜底"开关后才按排序取首个候选
// ============================================================

// 兜底候选的最短比较长度：比较名或官方 key 短于此长度时不参与包含关系判断，
// 防止 "o1"⊂"o1-preview"、"ai"⊂"xai-..." 这类超短名产生大量荒谬候选
const FALLBACK_MIN_PROBE_LENGTH = 3;

// 每条规则最多保留的候选数：候选仅供人工挑选/自动取首个，过长的尾部没有意义
const FALLBACK_MAX_CANDIDATES_PER_RULE = 10;

// 为一个未匹配的模型名生成兜底候选列表。
// 规则1：比较名是官方 key 的子串（官方名更长，如 grok-4.20-fast ⊄ 但 gemini-3 ⊂ gemini-3-pro）
//        → 按 key 长度升序（更短 ≈ 与渠道名更接近，多出的修饰越少价格越可信）
// 规则2：官方 key 是比较名的子串（官方名更短，如 grok-4.20 ⊂ grok-4.20-fast）
//        → 按 key 长度降序（更长 ≈ 更具体，grok-4.20 优先于 grok-4）
// 返回 [{key, rule, entry}]，规则1组整体排在规则2组之前；等长按字典序保证结果确定性。
// 比较名用 cleanSafeCore（斜杠取段/厂商前缀/括号等安全清理），与官方 key 都转小写比较
function buildFallbackCandidates(modelName, bare) {
  const probe = cleanSafeCore(modelName).toLowerCase();
  if (probe.length < FALLBACK_MIN_PROBE_LENGTH) return [];

  const rule1 = []; // probe ⊂ key
  const rule2 = []; // key ⊂ probe
  for (const key of Object.keys(bare || {})) {
    if (key.length < FALLBACK_MIN_PROBE_LENGTH) continue;
    const lowerKey = key.toLowerCase();
    if (lowerKey === probe) continue; // 等名早已被精确匹配层命中，出现在这里说明大小写等差异已被前层处理过
    if (lowerKey.includes(probe)) {
      rule1.push(key);
    } else if (probe.includes(lowerKey)) {
      rule2.push(key);
    }
  }

  rule1.sort((a, b) => a.length - b.length || a.localeCompare(b));
  rule2.sort((a, b) => b.length - a.length || a.localeCompare(b));

  const picked = [
    ...rule1.slice(0, FALLBACK_MAX_CANDIDATES_PER_RULE).map(key => ({ key, rule: 1 })),
    ...rule2.slice(0, FALLBACK_MAX_CANDIDATES_PER_RULE).map(key => ({ key, rule: 2 })),
  ];

  return picked.map(({ key, rule }) => ({ key, rule, entry: bare[key] }));
}

// 对一批模型名逐个做模糊匹配，构造统一的匹配结果数组。
// 按渠道模式（analyzeChannelPricing）和按 New API 内置价格模式（analyzeGlobalPricing）
// 共用这一份逻辑，保证两种入口产出的 results 形状完全一致，下游 renderMatchTable /
// buildSelectionFromResult / syncSelectedPrices 无需区分来源。
// 返回项形状：
//   未匹配： { modelName, matched:false, [fallbackCandidates] }
//   按次：   { modelName, matched:true, matchedName, source, billingMode:'flat', flatPrice, modelPrice,
//            [flatUnit], [modelType] }（flatUnit:'second' 表示每秒基准价，如视频模型）
//   按倍率： { modelName, matched:true, matchedName, source, billingMode:'ratio', promptPrice, completionPrice,
//            modelRatio, completionRatio, [cacheReadPrice, cacheRatio], [cacheWritePrice, createCacheRatio],
//            [modelType] }
//   分级：   同按倍率，billingMode 升级为 'tiered'，另加 billingExpr / longContext* 展示字段
// modelType（如存在）标记非对话模型的语义类型（embedding/rerank/tts/stt/image/video/realtime），
// 仅用于 UI 徽标展示，不参与同步写回。
//
// 兜底（仅在五层规则 + 变体层全部未命中后触发，绝不影响正常匹配）：
//   fallbackCandidates: [{...同 matched result 的展示/同步字段, matchedName, rule:1|2}]，
//   按"规则1（渠道名 ⊂ 官方名）短者优先，规则2（官方名 ⊂ 渠道名）长者优先"排序。
//   options.autoFallback=true 且有候选时，直接取首个候选升级为 matched:true、
//   source:'fallback-auto'，同时保留 fallbackCandidates 供 UI 改选；
//   autoFallback=false 时保持 matched:false，仅携带候选供 UI 渲染手动下拉框
function buildMatchResults(modelNames, prices, options = {}) {
  const autoFallback = options.autoFallback === true;
  const bare = (prices && prices.bare) || prices || {};

  return modelNames.map(modelName => {
    const match = matchOfficialPrice(modelName, prices);
    if (match) {
      return buildResultFromMatch(modelName, match);
    }

    const candidates = buildFallbackCandidates(modelName, bare);
    if (candidates.length === 0) {
      return { modelName, matched: false };
    }

    // 每个候选都构造成完整的 result 形状（含全部展示/同步字段），UI 选中后可整体替换行数据
    const fallbackCandidates = candidates.map(({ key, rule, entry }) => {
      const candidateResult = buildResultFromMatch(modelName, {
        matchedName: key,
        source: 'fallback',
        ...entry
      });
      candidateResult.rule = rule;
      return candidateResult;
    });

    if (autoFallback) {
      // 排序已保证首个即最优（规则1最短者，其次规则2最长者）
      const best = { ...fallbackCandidates[0], source: 'fallback-auto', fallbackCandidates };
      return best;
    }

    return { modelName, matched: false, fallbackCandidates };
  });
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
// 读取现有配置。返回 { config, readOk }：
//   config[key] = 远端该 option 的 map（modelName -> value）
//   readOk[key] = 是否确认读到了权威结果（包括"该 option 合法为空"）。
// 关键：只有 readOk[key] === true 时，调用方才能安全地对该 key 做"全量写回"——因为写回是
// 整表替换，若基于一个因读取失败而退化成 {} 的 base 合并，会把远端该 key 下所有未被本次选中
// 的模型一并删除（全局模式下可清空整个实例的定价表）。读取失败（网络错误/HTTP 非 ok/
// success:false/401/403）一律 readOk=false，调用方必须跳过对该 key 的写入。
async function fetchExistingConfig(apiUrl, keys) {
  const config = {};
  const readOk = {};
  keys.forEach(key => { config[key] = {}; readOk[key] = false; });

  try {
    const cookieData = await getCookiesFromAPI(apiUrl);
    if (!cookieData || !cookieData.success || !cookieData.newApiUser) {
      // 未登录/拿不到用户身份：所有 key 都视为读取失败，调用方跳过写入
      return { config, readOk };
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
          if (data.success) {
            // success 即视为权威读取结果——data.data 缺失代表该 option 合法为空，
            // 此时 config[key] 保持 {}，readOk 置 true（允许安全全量写回）
            if (data.data) {
              const parsed = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
              config[key] = parseConfigValue(parsed, key);
            }
            readOk[key] = true;
            console.log(`✓ 读取到 ${key}:`, Object.keys(config[key]).length, '个模型');
          } else {
            console.warn(`⚠️ 读取 ${key} 返回 success:false，将跳过对该 key 的写入`);
          }
        } else if (res.status !== 401 && res.status !== 403) {
          console.warn(`⚠️ 读取 ${key} 失败: HTTP ${res.status}，将跳过对该 key 的写入`);
        }
      } catch (keyError) {
        // 单个 key 读取失败（网络错误/JSON 解析失败等）只影响这一个 key，readOk 保持 false，
        // 调用方会跳过对它的写入——绝不能基于退化成 {} 的 base 全量写回，否则会把远端该 key
        // 下所有未被本次选中的模型一并覆盖删除
        console.warn(`⚠️ 读取 ${key} 时出错:`, keyError.message);
      }
    }
  } catch (error) {
    // 静默处理：这些错误是预期的（用户未登录或不在正确页面）
    if (chrome.runtime.getManifest().version_name?.includes('dev')) {
      console.debug('获取现有配置失败（预期行为）:', error.message);
    }
  }

  return { config, readOk };
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
        // request.autoFallback=true 时，未匹配的模型按名称包含关系自动选取兜底候选
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

        const results = buildMatchResults(modelNames, prices, { autoFallback: request.autoFallback === true });

        const matchedCount = results.filter(r => r.matched).length;
        console.log(`✅ 匹配完成: ${matchedCount}/${results.length} 个模型命中官方价格`);

        sendResponse({
          success: true,
          apiUrl,
          results
        });
      }
      else if (request.action === 'analyzeGlobalPricing') {
        // 只读：枚举 New API 全局层面已知的模型（内置默认价格表 + 所有已配置模型 +
        // 所有启用渠道实际提供的模型），对每个模型名做模糊匹配。不局限于单个渠道。
        // 全程不修改任何渠道的 models/model_mapping。
        const apiUrl = getCurrentApiUrl();

        const cookieData = await getCookiesFromAPI(apiUrl);
        if (!cookieData || !cookieData.success || !cookieData.newApiUser) {
          throw new Error('无法获取登录状态，请确保已登录 New API 后台');
        }

        const headers = {
          'New-API-User': cookieData.newApiUser
        };

        // 来源 1：option map 里已配置价格的模型名。ModelRatio/ModelPrice 的 key 是显式配价
        // 的模型（含 New API 内置默认表，未被覆盖时即完整内置表）；CompletionRatioMeta 是
        // GetOptions 合成的虚拟 option，其 key 是所有配置模型名的权威超集（还含仅靠硬编码
        // 补全规则计价的模型）。三者取并集即得"New API 内置/已配置"的模型全集。
        const optionModelKeys = ['ModelRatio', 'ModelPrice', 'CompletionRatioMeta'];
        const { config: existingConfig } = await fetchExistingConfig(apiUrl, optionModelKeys);

        const modelNameSet = new Set();
        for (const key of optionModelKeys) {
          for (const name of Object.keys(existingConfig[key] || {})) {
            const trimmed = (name || '').trim();
            if (trimmed) modelNameSet.add(trimmed);
          }
        }

        // 来源 2：/api/pricing 里所有启用渠道实际提供的模型（补上还没单独配过价但渠道已在
        // 服务的模型）。这一步失败不致命——降级为只用 option map 的模型名，记 warning。
        let warning;
        try {
          const pricingResponse = await fetch(`${apiUrl}/api/pricing`, {
            method: 'GET',
            headers: headers,
            credentials: 'include'
          });
          if (pricingResponse.ok) {
            const pricingData = await pricingResponse.json();
            const list = Array.isArray(pricingData.data) ? pricingData.data : [];
            for (const item of list) {
              const name = (item && item.model_name || '').trim();
              if (name) modelNameSet.add(name);
            }
            console.log(`✅ /api/pricing 提供 ${list.length} 个模型`);
          } else if (pricingResponse.status !== 401 && pricingResponse.status !== 403) {
            warning = `/api/pricing 读取失败: HTTP ${pricingResponse.status}`;
            console.warn(`⚠️ ${warning}`);
          }
        } catch (pricingError) {
          warning = `/api/pricing 读取失败: ${pricingError.message}`;
          console.warn(`⚠️ ${warning}`);
        }

        const modelNames = Array.from(modelNameSet);
        console.log(`✅ New API 全局共枚举到 ${modelNames.length} 个模型`);

        if (modelNames.length === 0) {
          throw new Error('未能从 New API 枚举到任何已配置模型，请确认已登录管理员账号');
        }

        const prices = await loadOfficialPrices();

        const results = buildMatchResults(modelNames, prices, { autoFallback: request.autoFallback === true });

        const matchedCount = results.filter(r => r.matched).length;
        console.log(`✅ 匹配完成: ${matchedCount}/${results.length} 个模型命中官方价格`);

        sendResponse({
          success: true,
          apiUrl,
          results,
          warning
        });
      }
      else if (request.action === 'syncSelectedPrices') {
        // 只把用户勾选的模型价格写回对应的 New API 配置 key，
        // 精确按 key 合并——只覆盖被勾选的 key，其余现有配置原样保留，绝不改动模型名。
        // 三个计费家族互斥：按次固定计价（ModelPrice，flatPrice 单位由 flatUnit 标记——
        // 'call' 每次整价、'second' 每秒基准价（视频任务 New API 自身按 ModelPrice×秒数×
        // 分辨率系数放大），两者都直接写 ModelPrice 数值，无需换算）、按倍率计价（ModelRatio/
        // CompletionRatio/CacheRatio/CreateCacheRatio）、长上下文分级表达式计价（billing_setting.billing_mode/
        // billing_setting.billing_expr，New API 计费优先级最高，一旦设置会完全忽略 ModelPrice
        // 与倍率家族）。模型切换计费模式时，必须删除其他家族里的残留条目，否则 New API 会按
        // 残留配置优先计费，导致新写入的配置完全不生效。
        // tiered 模式的模型同时也会写入 ModelRatio/CompletionRatio（阈值以下那档价格）作为
        // 兜底——防止 New API 已知 bug（#4523：保存 tiered_expr 后 ModelRatio 被清空导致
        // model_price_error）让模型直接计费报错。
        const { apiUrl, selections } = request;

        if (!Array.isArray(selections) || selections.length === 0) {
          throw new Error('没有选中任何模型');
        }

        const updatesByKey = {
          ModelRatio: {},
          CompletionRatio: {},
          CacheRatio: {},
          CreateCacheRatio: {},
          ModelPrice: {},
          'billing_setting.billing_mode': {},
          'billing_setting.billing_expr': {}
        };
        const flatModelNames = [];
        const ratioModelNames = [];
        const tieredModelNames = [];

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

            if (sel.billingMode === 'tiered' && sel.billingExpr) {
              updatesByKey['billing_setting.billing_mode'][sel.modelName] = 'tiered_expr';
              updatesByKey['billing_setting.billing_expr'][sel.modelName] = sel.billingExpr;
              tieredModelNames.push(sel.modelName);
            }
          }
        });

        console.log(`🔄 准备同步 ${selections.length} 个模型的价格...`);

        // ModelRatio/CompletionRatio/ModelPrice 三个 key 只要本次选中了任意模型就必须读取+写入——
        // 不是因为这三个 key 一定有新数据，而是因为跨家族"删除残留"逻辑必须在这三个 key 上生效。
        // CacheRatio/CreateCacheRatio 只要本次有任意按倍率同步的模型（含 tiered，因为 tiered 也会
        // 写入倍率兜底）就读取+写入——缓存残留不是计费关键（模型若实际按 ModelPrice/分级表达式计费，
        // 残留的缓存倍率会被忽略），所以只需覆盖 ratio 场景。
        const keysToTouch = ['ModelRatio', 'CompletionRatio', 'ModelPrice'];
        if (ratioModelNames.length > 0) {
          keysToTouch.push('CacheRatio', 'CreateCacheRatio');
        }
        // billing_setting.billing_mode/billing_expr 是 New API 计费优先级最高的家族（一旦某模型
        // 存在 tiered_expr，会完全盖过 ModelPrice 与倍率家族）。因此它的残留清理是计费关键的：
        // 任何模型本次转成 flat 或转成普通 ratio（不再分级）时，都必须清掉其可能残留的 tiered_expr，
        // 否则 New API 会继续按旧表达式计费、无视本次写入的 ModelPrice/ModelRatio。这必须在 flat
        // 场景也生效——不能像缓存 key 那样只在 ratioModelNames>0 时处理，否则"整批都是 flat 模型、
        // 其中某个曾是分级计价"这一场景下残留表达式永远清不掉。selections 非空时该条件恒为真。
        if (ratioModelNames.length > 0 || flatModelNames.length > 0) {
          keysToTouch.push('billing_setting.billing_mode', 'billing_setting.billing_expr');
        }

        const { config: existingConfig, readOk } = await fetchExistingConfig(apiUrl, keysToTouch);

        // 若任何要写的 key 读取失败，直接中止整次同步——绝不基于不完整的 base 做全量写回，
        // 否则会把远端该 key 下未被本次选中的模型全部删除（全局模式下等于清空定价表）。
        const failedReads = keysToTouch.filter(key => !readOk[key]);
        if (failedReads.length > 0) {
          throw new Error(
            `读取现有配置失败（${failedReads.join(', ')}），已中止同步以避免覆盖删除其他模型的价格。请检查登录状态/网络后重试。`
          );
        }

        const RATIO_FAMILY_KEYS = ['ModelRatio', 'CompletionRatio', 'CacheRatio', 'CreateCacheRatio'];
        const CACHE_KEYS = ['CacheRatio', 'CreateCacheRatio'];
        const TIERED_KEYS = ['billing_setting.billing_mode', 'billing_setting.billing_expr'];
        for (const key of keysToTouch) {
          const merged = mergeSelectedOnly(existingConfig[key] || {}, updatesByKey[key]);
          if (key === 'ModelPrice') {
            // 本次以 ratio/tiered 方式同步的模型，若在 ModelPrice 里有残留（曾被判定为按次计价），
            // 必须删除——否则该模型会一直按旧的按次价格计费，新写入的配置完全不生效
            ratioModelNames.forEach(name => delete merged[name]);
          } else if (RATIO_FAMILY_KEYS.includes(key)) {
            // 本次以 flat 方式同步的模型，若在倍率家族 key 里有残留，删除（非计费关键，保持配置干净）
            flatModelNames.forEach(name => delete merged[name]);
            if (CACHE_KEYS.includes(key)) {
              // 本次以 ratio/tiered 方式同步、但这次没有缓存价格的模型，清除其残留的缓存倍率，
              // 确保这次被显式重新同步的模型的缓存价格状态与本轮匹配结果完全一致
              ratioModelNames.forEach(name => {
                if (updatesByKey[key][name] === undefined) delete merged[name];
              });
            }
          } else if (TIERED_KEYS.includes(key)) {
            // 本次以 flat 方式同步的模型，若曾是分级计价，残留的表达式配置必须删除——
            // New API 的分级表达式计费优先级最高，残留会让 ModelPrice 完全不生效
            flatModelNames.forEach(name => delete merged[name]);
            // 本次以 ratio 方式重新同步、但这次不再是分级计价的模型（源数据不再带长上下文档位，
            // 或用户重新匹配后降级为普通倍率），同样必须删除残留表达式，否则新写入的 ModelRatio
            // 会被 New API 忽略——分级表达式一旦存在，倍率家族完全不生效
            ratioModelNames.forEach(name => {
              if (!tieredModelNames.includes(name)) delete merged[name];
            });
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
  module.exports = { cleanCoreName, generateNameVariants, matchOfficialPrice, MANUAL_ALIAS_TABLE, buildTieredExpr, buildMatchResults, buildFallbackCandidates, buildResultFromMatch };
}
