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

// 导入 pricing-engine（需要通过消息传递）
let officialPrices = null;
let pricingEngine = null;

/**
 * 转换 One Hub API 格式到标准格式
 * 支持两种格式：
 * 1. 数组格式: [{ model, type, channel_type, input, output }, ...]
 * 2. 对象格式: { data: { "model-name": { groups, owned_by, price: {...} }, ... } }
 * 标准格式: { model_name, quota_type, model_ratio, completion_ratio, model_price }
 */
function convertOneHubFormat(data) {
  // 格式 1: 数组格式（官方价格 API）
  if (Array.isArray(data) && data.length > 0 && data[0].model && data[0].type && data[0].input !== undefined) {
    console.log('🔄 检测到 One Hub 官方价格 API 格式（数组），开始转换...');
    
    const converted = data.map(item => {
      // One Hub 使用 "tokens" 表示按量计费
      const isTokenBased = item.type === 'tokens';
      
      // 转换为标准格式
      const standardItem = {
        model_name: item.model,
        quota_type: isTokenBased ? 0 : 1, // 0=按量, 1=按次
        model_ratio: item.input || 0,
        completion_ratio: item.output && item.input ? (item.output / item.input) : 1,
        model_price: isTokenBased ? 0 : item.input || 0
      };
      
      return standardItem;
    });
    
    console.log(`✅ One Hub 官方格式转换完成: ${converted.length} 个模型`);
    console.log('📊 转换示例:', converted.slice(0, 2));
    
    return converted;
  }
  
  // 格式 2: 对象格式（实例 available_model API）
  if (data && typeof data === 'object' && data.data && typeof data.data === 'object') {
    console.log('🔄 检测到 One Hub 实例 API 格式（对象），开始转换...');
    
    const converted = [];
    const modelsData = data.data;
    
    for (const [modelName, modelInfo] of Object.entries(modelsData)) {
      if (!modelInfo || !modelInfo.price) continue;
      
      const priceInfo = modelInfo.price;
      const modelType = priceInfo.model || modelName;
      const type = priceInfo.type || 'times';
      
      // 判断计费类型
      // One Hub 使用 "times" 表示按次计费，"tokens" 表示按量计费
      const isPerUse = type === 'times';
      
      // 提取价格（One Hub 的价格单位需要转换）
      // One Hub 存储的是内部单位，需要除以 500 转换为美元
      // 特殊处理：0 或负数表示免费
      const ONE_HUB_PRICE_DIVISOR = 500;
      const rawInput = priceInfo.input || 0;
      const rawOutput = priceInfo.output || 0;
      
      // 检查是否为免费模型（价格为 0 或负数）
      const isFree = rawInput <= 0 && rawOutput <= 0;
      
      let inputPrice = 0;
      let outputPrice = 0;
      
      if (!isFree) {
        inputPrice = rawInput / ONE_HUB_PRICE_DIVISOR;
        outputPrice = rawOutput / ONE_HUB_PRICE_DIVISOR;
        
        // 🔧 关键修复：New API 的 ModelRatio 是倍率，不是价格
        // 我们需要除以 2 来得到正确的倍率（New API 内部会乘以 2）
        if (!isPerUse) {
          // 按量计费：从 $/1K 转换为倍率
          // 步骤1: inputPrice 已经是 $/1K（例如 0.012）
          // 步骤2: 乘以 1000 转换为 $/1M（例如 12）
          // 步骤3: 除以 2 得到 New API 的倍率（例如 6）
          inputPrice = (inputPrice * 1000) / 2;
          outputPrice = (outputPrice * 1000) / 2;
          console.log(`  🔧 ${modelType} (按量): 原始 ${rawInput}/${ONE_HUB_PRICE_DIVISOR} = $${rawInput / ONE_HUB_PRICE_DIVISOR}/1K → $/1M=${(rawInput / ONE_HUB_PRICE_DIVISOR) * 1000} → 倍率=${inputPrice}`);
        } else {
          console.log(`  🔧 ${modelType} (按次): 原始 input=${rawInput}, output=${rawOutput} → 转换后 $${inputPrice}, $${outputPrice}`);
        }
      } else {
        console.log(`  🆓 ${modelType} (免费): input=${rawInput}, output=${rawOutput} → Free`);
      }
      
      // 转换为标准格式
      const standardItem = {
        model_name: modelType,
        quota_type: isPerUse ? 1 : 0, // 0=按量, 1=按次
        // 对于按次计费：直接使用转换后的价格
        // 对于按量计费：这是倍率（会被 New API 乘以内部基础价 2）
        model_ratio: inputPrice,
        completion_ratio: inputPrice > 0 ? (outputPrice / inputPrice) : 1,
        model_price: isPerUse ? inputPrice : 0,
        // 标记这是 One Hub 直接价格格式
        _isOneHubDirectPrice: true
      };
      
      converted.push(standardItem);
    }
    
    console.log(`✅ One Hub 实例格式转换完成: ${converted.length} 个模型`);
    console.log('📊 转换示例:', converted.slice(0, 2));
    
    return converted;
  }
  
  // 不是 One Hub 格式，返回原数据
  return data;
}

// 从 background 请求 OpenRouter 价格数据（联网 + 缓存）
function requestOpenRouterPricing(forceRefresh = false) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'getOpenRouterPricing', forceRefresh },
      (response) => resolve(response)
    );
  });
}

// 加载本地兜底价格快照（OpenRouter 快照，随插件打包）
async function loadLocalPriceSnapshot() {
  const response = await fetch(chrome.runtime.getURL('official_prices.json'));
  return await response.json();
}

// 加载官方价格数据库：OpenRouter 联网优先，本地快照兜底
async function loadOfficialPrices() {
  if (officialPrices) return officialPrices;

  const remote = await requestOpenRouterPricing(false);
  if (remote && remote.success) {
    console.log(
      `✓ 官方价格数据来源: OpenRouter (${remote.source})，更新于 ${new Date(remote.fetchedAt).toLocaleString()}`
    );
    if (remote.warning) {
      console.warn('⚠️ OpenRouter 实时拉取失败，已回退到过期缓存:', remote.warning);
    }
    officialPrices = remote.prices;
    return officialPrices;
  }

  console.warn('⚠️ OpenRouter 价格不可用，回退到本地快照:', remote && remote.error);

  try {
    officialPrices = await loadLocalPriceSnapshot();
    console.log('✓ 官方价格数据来源: 本地 OpenRouter 快照（打包于插件内）');
    return officialPrices;
  } catch (error) {
    console.error('加载官方价格数据失败:', error);
    throw new Error('无法加载官方价格数据库');
  }
}

// 初始化 Pricing Engine
function initPricingEngine(upstreamData) {
  return {
    rawData: upstreamData,
    officialPrices: officialPrices,
    
    // 提取原始模型名称（用于官方价格匹配）
    extractOriginalModelName(modelName) {
      // 这个函数用于从上游模型名中提取"核心模型名"，用于在官方价格库中查找
      // 规则：去除所有前缀和后缀，只保留最纯粹的模型名
      
      let coreName = modelName;
      
      // 如果包含斜杠，提取最后一段
      if (modelName.includes('/')) {
        const parts = modelName.split('/');
        coreName = parts[parts.length - 1];  // 总是取最后一段用于价格匹配
      }
      
      // 🔧 修复：只清理真正的描述性后缀，保留版本号
      const suffixPatterns = [
        /\s*\(.*?\)/g,        // 括号内容：(反代Notion-stream)、(反代Lmarena)、(可搜尋)
        /\s*\[.*?\]/g,        // 方括号内容：[满血1m]、[免审]
        /\s*-cli$/g,          // -cli 后缀
        /\s*-droid$/g,        // -droid 后缀
        /\s*-high$/g,         // -high 后缀
        /\s*-thinking$/g,     // -thinking 后缀
        /\s*反代.*$/g,       // 中文反代标记
        /\s*可搜尋.*$/g,     // 中文可搜索标记
        /\s*grounding.*$/g,   // grounding 相关后缀
        /\s*image.*$/g,      // image 相关后缀
        /\s*preview.*$/g,    // preview 相关后缀
        /\s*search.*$/g,     // search 相关后缀
      ];
      
      // 依次应用所有后缀清理规则
      for (const pattern of suffixPatterns) {
        coreName = coreName.replace(pattern, '');
      }
      
      // 去除首尾空格
      coreName = coreName.trim();
      
      // 调试信息
      if (modelName !== coreName) {
        console.log(`🔧 清理模型名: "${modelName}" → "${coreName}"`);
      }
      
      // 直接匹配
      if (this.officialPrices[coreName]) {
        return coreName;
      }
      
      // 尝试变体匹配
      const variants = this.generateNameVariants(coreName);
      for (const variant of variants) {
        if (this.officialPrices[variant]) {
          console.log(`🔧 变体匹配: "${coreName}" → "${variant}"`);
          return variant;
        }
      }
      
      return coreName;
    },
    
    // 智能提取模型名（用于生成最终配置的模型名）
    extractSmartModelName(modelName) {
      // 这个函数用于生成最终的模型名（添加用户前缀后的名称）
      // 规则：
      // 1. 如果有描述性前缀（抗截断、假流式、[满血1m] 等）→ 保留
      // 2. 如果有常规提供商前缀（Qwen/、THUDM/等）→ 去除中间层，只保留模型名
      
      if (!modelName.includes('/')) {
        return modelName;  // 无前缀，直接返回
      }
      
      const parts = modelName.split('/');
      
      // 描述性前缀关键词（中文）
      const descriptivePrefixes = [
        '假流式', '流式', '抗截断', '流式抗截断',
        '免审', '审核', '无审核', '快速',
        '稳定', '高速', '优化', '加速',
        '满血', '满额', '长文本', '超长'
      ];
      
      // 检查是否为描述性前缀的函数
      const isDescriptive = (part) => {
        // 1. 包含方括号标签（如 [满血1m]、[免审]、[抗截断]）
        if (part.includes('[') || part.includes(']')) {
          return true;
        }
        // 2. 包含中文描述性关键词
        return descriptivePrefixes.some(prefix => part.includes(prefix));
      };
      
      if (parts.length === 2) {
        // 两段格式：A/B
        const firstPart = parts[0];
        
        // 检查第一段是否为描述性前缀
        if (isDescriptive(firstPart)) {
          return modelName;  // 保留完整：如 "抗截断/claude-3.5-sonnet" 或 "[满血1m]/gemini-2.5-pro"
        } else {
          return parts[1];  // 去除提供商：如 "Qwen/Qwen3" → "Qwen3"
        }
      } else if (parts.length >= 3) {
        // 三段或更多格式：A/B/C...
        const secondPart = parts[1];
        
        // 检查第二段是否为描述性前缀
        if (isDescriptive(secondPart)) {
          // 保留描述性前缀+模型：如 "小丑/[满血1m]/gemini-2.5-pro" → "[满血1m]/gemini-2.5-pro"
          return parts.slice(1).join('/');
        } else {
          // 去除中间层，只保留最后一段：如 "SLA/Qwen/Qwen3-VL" → "Qwen3-VL"
          return parts[parts.length - 1];
        }
      }
      
      return modelName;
    },
    
    // 生成模型名称变体
    generateNameVariants(name) {
      const variants = new Set([name]);
      
      // 点号和破折号互换
      const withDots = name.replace(/(\d)-(\d)/g, '$1.$2');
      const withDashes = name.replace(/(\d)\.(\d)/g, '$1-$2');
      variants.add(withDots);
      variants.add(withDashes);
      
      // B/b 大小写
      const lowerB = name.replace(/(\d+\.?\d*)B\b/gi, (match, num) => `${num}b`);
      const upperB = name.replace(/(\d+\.?\d*)b\b/gi, (match, num) => `${num}B`);
      variants.add(lowerB);
      variants.add(upperB);
      
      // 下划线和连字符
      const withUnderscores = name.replace(/-/g, '_');
      const withHyphens = name.replace(/_/g, '-');
      variants.add(withUnderscores);
      variants.add(withHyphens);
      
      // 大小写变体
      variants.add(name.toLowerCase());
      variants.add(name.toUpperCase());
      
      return Array.from(variants);
    },
    
    // 检测是否为特殊价格格式的网站
    // 参数：apiUrl - 上游API的URL
    isDirectPriceWebsite(apiUrl = '') {
      const hostname = window.location.hostname;
      const href = window.location.href;
      
      // 检测 api.dev88.tech 或任何包含 dev88 的域名/URL
      const isDev88 = hostname.includes('dev88') ||
                     href.includes('dev88') ||
                     apiUrl.includes('dev88');
      
      console.log('🔍 网站检测:');
      console.log('   - window.location.hostname:', hostname);
      console.log('   - window.location.href:', href);
      console.log('   - API URL:', apiUrl);
      console.log('   - 检测结果:', isDev88 ? '✅ 特殊价格网站' : '❌ 标准网站');
      
      return isDev88;
    },
    
    // 推断基础价格
    inferBasePrice() {
      // 🔧 One Hub 直接价格模式检测
      const hasOneHubDirectPrice = this.rawData.some(m => m._isOneHubDirectPrice);
      if (hasOneHubDirectPrice) {
        console.log('🌐 检测到 One Hub 直接价格格式：model_ratio 直接代表价格（已转换为美元）');
        return {
          basePrice: 1,
          confidence: 100,
          matchedModels: this.rawData.length,
          totalModels: this.rawData.length,
          isOneHubDirectPrice: true
        };
      }
      
      // 🔧 特殊网站：直接价格模式
      if (this.isDirectPriceWebsite(this.apiUrl || window._currentApiUrl || '')) {
        console.log('🌐 检测到特殊网站（直接价格模式）：model_ratio 直接代表价格');
        return {
          basePrice: 1,
          confidence: 100,
          matchedModels: this.rawData.length,
          totalModels: this.rawData.length
        };
      }
      
      const candidates = [];
      let matchCount = 0;
      
      for (const model of this.rawData) {
        // 只处理按量计费的模型
        if (model.quota_type !== 0) continue;
        if (!model.model_ratio || model.model_ratio === 0) continue;
        
        // 提取原始模型名（去除前缀，尝试各种变体）
        const modelName = this.extractOriginalModelName(model.model_name || model.id);
        
        // 查找官方价格
        if (this.officialPrices[modelName]) {
          const officialPrice = this.officialPrices[modelName];
          const calculatedBase = officialPrice / model.model_ratio;
          const roundedBase = Math.round(calculatedBase * 100) / 100;
          candidates.push(roundedBase);
          matchCount++;
          
          console.log(`✓ 匹配: ${model.model_name || model.id} → ${modelName} | 官方$${officialPrice} / ${model.model_ratio} = $${roundedBase}`);
        }
      }
      
      if (candidates.length === 0) {
        throw new Error('无法推断基础价格：没有找到匹配的官方价格数据。\n\n建议：\n1. 检查上游数据中的模型名称是否正确\n2. 确认官方价格数据库是否包含这些模型\n3. 尝试使用"手动设置基础价"功能');
      }
      
      // 🔧 修复：改进众数计算，确保结果稳定
      const frequency = {};
      candidates.forEach(price => {
        const key = price.toFixed(2);
        frequency[key] = (frequency[key] || 0) + 1;
      });
      
      // 按价格排序，确保相同价格总是得到相同结果
      const sortedPrices = Object.entries(frequency).sort((a, b) => {
        // 优先按频率排序，频率相同则按价格排序
        if (b[1] !== a[1]) {
          return b[1] - a[1]; // 频率降序
        }
        return parseFloat(a[0]) - parseFloat(b[0]); // 价格升序
      });
      
      let maxFreq = 0;
      let basePrice = 0;
      let secondMaxFreq = 0;
      
      if (sortedPrices.length > 0) {
        const [priceStr, freq] = sortedPrices[0];
        maxFreq = freq;
        basePrice = parseFloat(priceStr);
        
        // 计算第二高频，用于检测是否有多众数
        if (sortedPrices.length > 1) {
          const [, secondFreq] = sortedPrices[1];
          secondMaxFreq = secondFreq;
        }
      }
      
      const confidence = Math.round((maxFreq / candidates.length) * 100);
      
      // 🔧 修复：低置信度时的特殊处理
      let finalBasePrice = basePrice;
      let finalConfidence = confidence;
      
      if (confidence < 50) {
        // 低置信度：检查是否有明显的众数优势
        if (maxFreq === secondMaxFreq && maxFreq > 1) {
          // 有多个众数且频率相同，选择最小的价格（最保守的估计）
          const minPrice = Math.min(...candidates);
          finalBasePrice = minPrice;
          finalConfidence = confidence;
          console.log(`⚠️ 低置信度但有多个众数，选择最保守价格: $${minPrice}`);
        } else if (maxFreq === 1) {
          // 所有价格都只出现一次，选择中位数
          const sortedCandidates = [...candidates].sort((a, b) => a - b);
          const midIndex = Math.floor(sortedCandidates.length / 2);
          finalBasePrice = sortedCandidates[midIndex];
          finalConfidence = Math.round((1 / candidates.length) * 100);
          console.log(`⚠️ 所有价格频率相同，使用中位数: $${finalBasePrice}`);
        }
      }
      
      console.log(`\n📊 推断结果:`);
      console.log(`   基础价: $${finalBasePrice}`);
      console.log(`   置信度: ${finalConfidence}%`);
      console.log(`   匹配模型: ${matchCount}/${this.rawData.length}`);
      console.log(`   候选价格: [${candidates.map(p => `$${p}`).join(', ')}]`);
      
      return {
        basePrice: finalBasePrice,
        confidence: finalConfidence,
        matchedModels: matchCount,
        totalModels: this.rawData.length
      };
    },
    
    // 计算所有模型价格
    calculatePricing(basePrice) {
      const results = [];
      const hasOneHubDirectPrice = this.rawData.some(m => m._isOneHubDirectPrice);
      const isDirectPrice = this.isDirectPriceWebsite(this.apiUrl || window._currentApiUrl || '');
      
      // 🔧 修复：One Hub 格式已经完成转换，不需要额外的倍数
      const priceMultiplier = (hasOneHubDirectPrice || !isDirectPrice) ? 1 : 2;
      
      if (hasOneHubDirectPrice) {
        console.log('💰 使用 One Hub 直接价格模式（已转换为美元，无需额外处理）');
      } else if (isDirectPrice) {
        console.log('💰 使用直接价格模式，转换系数: 2x');
      } else {
        console.log('💰 使用标准价格模式，转换系数: 1x');
      }
      
      for (const model of this.rawData) {
        let inputPrice, outputPrice, pricingMode, modelRatio, completionRatio;
        
        if (model.quota_type === 1) {
          // 按次计费
          pricingMode = '按次计费';
          inputPrice = model.model_price || 0;
          outputPrice = inputPrice;
          modelRatio = null;
          completionRatio = null;
        } else {
          // 按量计费
          pricingMode = '按量计费';
          modelRatio = (model.model_ratio !== undefined && model.model_ratio !== null)
            ? model.model_ratio : 1;
          completionRatio = (model.completion_ratio !== undefined && model.completion_ratio !== null)
            ? model.completion_ratio : 1;
          
          // 🔧 One Hub 直接价格模式
          if (hasOneHubDirectPrice || model._isOneHubDirectPrice) {
            // One Hub 直接价格：model_ratio 已经是转换后的美元价格（包含了$/1K到$/1M的1000倍转换）
            // 无需任何额外处理，直接使用
            inputPrice = modelRatio;
            console.log(`  💰 One Hub模式 - ${model.model_name}: 直接使用 modelRatio = $${inputPrice}`);
          }
          // 🔧 其他直接价格模式
          else if (isDirectPrice) {
            // 直接价格模式：model_ratio 就是价格，乘以转换系数（通常为2）
            inputPrice = modelRatio * priceMultiplier;
            console.log(`  💰 直接价格模式 - ${model.model_name}: ${modelRatio} × ${priceMultiplier} = $${inputPrice}`);
          }
          // 标准模式
          else {
            // 标准模式：basePrice × modelRatio
            inputPrice = basePrice * modelRatio;
            console.log(`  💰 标准模式 - ${model.model_name}: ${basePrice} × ${modelRatio} = $${inputPrice}`);
          }
          outputPrice = inputPrice * completionRatio;
        }
        
        // 四舍五入到 4 位小数
        inputPrice = Math.round(inputPrice * 10000) / 10000;
        outputPrice = Math.round(outputPrice * 10000) / 10000;
        
        const fullModelName = model.model_name || model.id;
        
        // ✅ Bug #021 修复：originalName 只用于显示，不再用于配置生成
        // 配置的 key 和 value 都将包含用户前缀（在后续步骤中添加）
        const originalName = this.extractSmartModelName(fullModelName);
        
        results.push({
          modelName: fullModelName,
          originalName: originalName,  // 用于显示的名称（去除上游渠道前缀）
          smartName: originalName,     // ✅ Bug #021: 用于配置生成的名称（将在后续添加用户前缀）
          quotaType: model.quota_type,
          pricingMode,
          inputPrice,
          outputPrice,
          modelRatio,
          completionRatio
        });
      }
      
      return results;
    }
  };
}

// 获取当前页面的 API 基础 URL
function getCurrentApiUrl() {
  // 从当前页面 URL 提取基础域名
  const url = new URL(window.location.href);
  return `${url.protocol}//${url.host}`;
}

// 获取现有配置
async function fetchExistingConfig(apiUrl) {
  const config = {
    ModelPrice: {},
    ModelRatio: {},
    CompletionRatio: {}
  };

  try {
    // 获取 Cookie（包括 New-API-User）
    const cookieData = await getCookiesFromAPI(apiUrl);
    if (!cookieData || !cookieData.success || !cookieData.newApiUser) {
      // 静默处理：这是预期的情况（用户未登录或不在正确页面）
      return config;
    }
    
    const headers = {
      'New-API-User': cookieData.newApiUser
    };
    
    console.log('📖 读取现有配置，使用 New-API-User:', cookieData.newApiUser);
    
    // ModelPrice
    const priceRes = await fetch(`${apiUrl}/api/option/?key=ModelPrice`, {
      credentials: 'include',
      headers: headers
    });
    if (priceRes.ok) {
      const data = await priceRes.json();
      if (data.success && data.data) {
        config.ModelPrice = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
        console.log('✓ 读取到 ModelPrice:', Object.keys(config.ModelPrice).length, '个模型');
      }
    } else if (priceRes.status !== 401 && priceRes.status !== 403) {
      // 只输出非认证错误（401/403 是预期的）
      console.warn(`⚠️ 读取 ModelPrice 失败: HTTP ${priceRes.status}`);
    }

    // ModelRatio
    const ratioRes = await fetch(`${apiUrl}/api/option/?key=ModelRatio`, {
      credentials: 'include',
      headers: headers
    });
    if (ratioRes.ok) {
      const data = await ratioRes.json();
      if (data.success && data.data) {
        config.ModelRatio = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
        console.log('✓ 读取到 ModelRatio:', Object.keys(config.ModelRatio).length, '个模型');
      }
    } else if (ratioRes.status !== 401 && ratioRes.status !== 403) {
      console.warn(`⚠️ 读取 ModelRatio 失败: HTTP ${ratioRes.status}`);
    }

    // CompletionRatio
    const completionRes = await fetch(`${apiUrl}/api/option/?key=CompletionRatio`, {
      credentials: 'include',
      headers: headers
    });
    if (completionRes.ok) {
      const data = await completionRes.json();
      if (data.success && data.data) {
        config.CompletionRatio = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
        console.log('✓ 读取到 CompletionRatio:', Object.keys(config.CompletionRatio).length, '个模型');
      }
    } else if (completionRes.status !== 401 && completionRes.status !== 403) {
      console.warn(`⚠️ 读取 CompletionRatio 失败: HTTP ${completionRes.status}`);
    }
  } catch (error) {
    // 静默处理：这些错误是预期的（用户未登录或不在正确页面）
    // 只在开发模式下输出详细信息
    if (chrome.runtime.getManifest().version_name?.includes('dev')) {
      console.debug('获取现有配置失败（预期行为）:', error.message);
    }
  }

  return config;
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

// 使用 Background Script 发起跨域请求（绕过 CORS）
async function fetchCORS(url, options = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      action: 'fetchCORS',
      url: url,
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body || undefined
    }, (response) => {
      if (response && response.success) {
        resolve(response.data);
      } else {
        reject(new Error(response?.error || '跨域请求失败'));
      }
    });
  });
}

// 更新单个配置项
async function updateOption(apiUrl, key, value) {
  // 使用 Chrome Cookies API 获取 Cookie
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

// 生成 SQL
function generateSQL(results, prefix) {
  const modelPrices = {};
  const modelRatios = {};
  const completionRatios = {};
  
  let perUseCount = 0;
  let usageBasedCount = 0;
  
  results.forEach(m => {
    // ✅ Bug #021 修复：使用 smartName 生成最终配置
    const finalModelName = prefix ? prefix + m.smartName : m.smartName;
    
    if (m.quotaType === 1) {
      modelPrices[finalModelName] = parseFloat(m.inputPrice.toFixed(4));
      perUseCount++;
    } else {
      if (m.modelRatio !== undefined && m.modelRatio !== null) {
        modelRatios[finalModelName] = m.modelRatio;
      }
      if (m.completionRatio !== undefined && m.completionRatio !== null) {
        completionRatios[finalModelName] = m.completionRatio;
      }
      usageBasedCount++;
    }
  });

  let sql = '-- ==========================================\n';
  sql += '-- New API 完整定价配置更新 SQL\n';
  sql += '-- ==========================================\n';
  sql += '-- 生成时间：' + new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'}) + '\n';
  sql += `-- 模型前缀：${prefix || '(无前缀)'}\n`;
  sql += `-- 总模型数：${results.length}\n`;
  sql += `-- 按次计费：${perUseCount} | 按量计费：${usageBasedCount}\n\n`;

  if (Object.keys(modelPrices).length > 0) {
    sql += '-- ModelPrice (按次计费)\n';
    sql += 'UPDATE options SET value = \'' + JSON.stringify(modelPrices, null, 2).replace(/'/g, "''") + '\'\n';
    sql += 'WHERE `key` = \'ModelPrice\';\n\n';
  }

  if (Object.keys(modelRatios).length > 0) {
    sql += '-- ModelRatio (按量计费)\n';
    sql += 'UPDATE options SET value = \'' + JSON.stringify(modelRatios, null, 2).replace(/'/g, "''") + '\'\n';
    sql += 'WHERE `key` = \'ModelRatio\';\n\n';
  }

  if (Object.keys(completionRatios).length > 0) {
    sql += '-- CompletionRatio (按量计费)\n';
    sql += 'UPDATE options SET value = \'' + JSON.stringify(completionRatios, null, 2).replace(/'/g, "''") + '\'\n';
    sql += 'WHERE `key` = \'CompletionRatio\';\n\n';
  }

  sql += '-- ✅ SQL 生成完成！';

  return {
    sql,
    stats: {
      modelPriceCount: Object.keys(modelPrices).length,
      modelRatioCount: Object.keys(modelRatios).length,
      completionRatioCount: Object.keys(completionRatios).length
    }
  };
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
      
      if (request.action === 'analyzePricing') {
        // 分析上游价格
        await loadOfficialPrices();
        
        // 使用 Background Script 获取上游数据（绕过 CORS）
        console.log('🌐 通过 Background Script 获取上游数据:', request.upstreamUrl);
        
        // 保存 API URL 供后续使用
        window._currentApiUrl = request.upstreamUrl;
        
        // 尝试获取上游数据，如果失败则提供更友好的错误消息
        let upstreamData;
        try {
          upstreamData = await fetchCORS(request.upstreamUrl);
        } catch (error) {
          // 如果是 403 错误（可能是 Cloudflare 保护），提供更详细的说明
          if (error.message.includes('403')) {
            throw new Error(
              '无法访问上游 API（HTTP 403）\n\n' +
              '💡 可能原因：\n' +
              '1. 网站启用了 Cloudflare 保护\n' +
              '2. 需要先在浏览器中访问该网站完成验证\n' +
              '3. 网站可能限制了 API 访问\n\n' +
              '🔧 解决方法：\n' +
              '1. 在浏览器新标签页中打开该网站\n' +
              '2. 完成 Cloudflare 验证（如果有）\n' +
              '3. 然后重新尝试同步\n\n' +
              `目标 URL: ${request.upstreamUrl}`
            );
          }
          // 其他错误直接抛出
          throw error;
        }
        
        console.log('📦 原始上游数据:', upstreamData);
        console.log('📦 数据结构分析:', {
          type: typeof upstreamData,
          isArray: Array.isArray(upstreamData),
          hasData: upstreamData?.data !== undefined,
          hasModels: upstreamData?.models !== undefined,
          hasSuccess: upstreamData?.success !== undefined,
          dataIsArray: Array.isArray(upstreamData?.data)
        });
        
        // 🔧 增强版数据格式兼容处理
        if (!Array.isArray(upstreamData)) {
          // 如果返回的是对象，尝试提取数组
          if (upstreamData.data && Array.isArray(upstreamData.data)) {
            upstreamData = upstreamData.data;
            console.log('✓ 从 data 字段提取数组，模型数量:', upstreamData.length);
          } else if (upstreamData.models && Array.isArray(upstreamData.models)) {
            upstreamData = upstreamData.models;
            console.log('✓ 从 models 字段提取数组，模型数量:', upstreamData.length);
          } else if (upstreamData.success && upstreamData.data && typeof upstreamData.data === 'object') {
            // 🆕 处理 {success: true, data: {...}} 格式（One Hub 对象格式）
            console.log('🔄 检测到包含 success 的对象格式，尝试 One Hub 转换...');
            const converted = convertOneHubFormat(upstreamData);
            if (Array.isArray(converted)) {
              upstreamData = converted;
              console.log('✓ One Hub 格式转换成功，模型数量:', upstreamData.length);
            } else {
              throw new Error(`上游数据格式错误：期望数组或包含 data/models 字段的对象，收到 ${typeof upstreamData}。请检查上游 URL 是否正确。`);
            }
          } else {
            // 🆕 最后尝试 One Hub 对象格式转换
            const converted = convertOneHubFormat(upstreamData);
            if (Array.isArray(converted)) {
              upstreamData = converted;
              console.log('✓ One Hub 格式转换成功，模型数量:', upstreamData.length);
            } else {
              throw new Error(`上游数据格式错误：期望数组或包含 data/models 字段的对象，收到 ${typeof upstreamData}。请检查上游 URL 是否正确。`);
            }
          }
        } else {
          // 🆕 如果已经是数组，检查是否为 One Hub 数组格式
          const converted = convertOneHubFormat(upstreamData);
          if (converted !== upstreamData) {
            // 转换成功，使用转换后的数据
            upstreamData = converted;
            console.log('✓ One Hub 数组格式转换成功');
          }
        }
        
        if (upstreamData.length === 0) {
          throw new Error('上游数据为空，无法分析价格');
        }
        
        // 统计计费类型
        const perUseCount = upstreamData.filter(m => m.quota_type === 1).length;
        const usageBasedCount = upstreamData.filter(m => m.quota_type === 0).length;
        console.log(`📊 模型统计: 按次计费 ${perUseCount} 个，按量计费 ${usageBasedCount} 个`);
        
        // 初始化引擎
        const engine = initPricingEngine(upstreamData);
        
        // 保存 API URL 到引擎
        engine.apiUrl = request.upstreamUrl;
        
        let basePrice = 0;
        let confidence = 0;
        
        // 只有在有按量计费模型时才推断基础价
        if (usageBasedCount > 0) {
          try {
            const inference = engine.inferBasePrice();
            basePrice = inference.basePrice;
            confidence = inference.confidence;
            console.log(`✓ 成功推断基础价: $${basePrice} (置信度: ${confidence}%)`);
          } catch (error) {
            console.warn('⚠️ 推断基础价失败:', error.message);
            console.warn('⚠️ 将使用默认基础价 $0（所有按量计费模型价格将为 0）');
            basePrice = 0;
            confidence = 0;
          }
        } else {
          console.log('ℹ️ 所有模型均为按次计费，无需推断基础价');
        }
        
        // 🔍 调试：记录基础价格，确保表格和同步使用相同价格
        console.log(`🔍 分析阶段 - 使用基础价格: $${basePrice}`);
        
        // 计算所有模型价格
        const results = engine.calculatePricing(basePrice);
        
        // 🔍 调试：验证计算结果
        console.log('🔍 分析阶段 - 计算结果预览:');
        results.slice(0, 3).forEach((r, i) => {
          console.log(`  [${i}] ${r.modelName} → 输入: $${r.inputPrice}, 输出: $${r.outputPrice}`);
        });
        
        // 获取当前 API URL
        const apiUrl = getCurrentApiUrl();
        
        sendResponse({
          success: true,
          results: results,
          basePrice: basePrice,
          confidence: confidence,
          apiUrl: apiUrl,
          stats: {
            total: upstreamData.length,
            perUse: perUseCount,
            usageBased: usageBasedCount
          }
        });
      }
      else if (request.action === 'syncToBackend') {
        // 同步到后台
        const { results, apiUrl, prefix } = request;
        
        // 准备数据
        const modelPrices = {};
        const modelRatios = {};
        const completionRatios = {};
        
        results.forEach(m => {
          // ✅ Bug #021 修复：Key 和 Value 都包含用户前缀
          const finalModelName = prefix ? prefix + m.smartName : m.smartName;
          
          console.log(`🔍 处理模型: ${finalModelName}`);
          console.log(`   - 原始名称: ${m.modelName}`);
          console.log(`   - 智能提取: ${m.smartName}`);
          console.log(`   - 最终名称: ${finalModelName}`);
          console.log(`   - quotaType: ${m.quotaType} (${m.quotaType === 1 ? '按次计费' : '按量计费'})`);
          console.log(`   - inputPrice: ${m.inputPrice}`);
          console.log(`   - modelRatio: ${m.modelRatio}`);
          
          if (m.quotaType === 1) {
            // ✅ 按次计费：只需要一个数字（输入价格）
            modelPrices[finalModelName] = parseFloat(m.inputPrice.toFixed(4));
            console.log(`   → 添加到 ModelPrice: ${modelPrices[finalModelName]}`);
          } else {
            // ✅ 按量计费：需要 ratio 值
            if (m.modelRatio !== undefined && m.modelRatio !== null) {
              modelRatios[finalModelName] = parseFloat(m.modelRatio);
              console.log(`   → 添加到 ModelRatio: ${modelRatios[finalModelName]}`);
            }
            if (m.completionRatio !== undefined && m.completionRatio !== null) {
              completionRatios[finalModelName] = parseFloat(m.completionRatio);
              console.log(`   → 添加到 CompletionRatio: ${completionRatios[finalModelName]}`);
            }
          }
        });
        
        console.log('📊 准备同步的数据:');
        console.log('  - ModelPrice:', Object.keys(modelPrices).length, '个', modelPrices);
        console.log('  - ModelRatio:', Object.keys(modelRatios).length, '个', modelRatios);
        console.log('  - CompletionRatio:', Object.keys(completionRatios).length, '个', completionRatios);
        
        // 获取现有配置
        const existingConfig = await fetchExistingConfig(apiUrl);
        
        // ✅ Bug #022 修复：New API 的 ModelPrice 只接受数字值
        // 需要过滤掉按量计费模式的字符串映射（那些值应该在 ModelRatio 中）
        // ✅ Bug #022 修复：解析 New API 返回的配置数据结构
        // New API 返回的是对象数组：[{key: "ModelPrice", value: "JSON字符串"}]
        // 我们需要找到对应的配置项并解析其 value 字段
        console.log('📋 解析现有配置...');
        
        function parseConfigValue(configData, targetKey) {
          // 如果已经是对象格式（之前的逻辑），直接返回
          if (configData && typeof configData === 'object' && !Array.isArray(configData)) {
            console.log(`  ✓ ${targetKey} 已是对象格式:`, Object.keys(configData).length, '个模型');
            return configData;
          }
          
          // 如果是数组格式，查找目标 key
          if (Array.isArray(configData)) {
            console.log(`  🔍 在数组中查找 ${targetKey}...`);
            const configItem = configData.find(item => item.key === targetKey);
            
            if (!configItem || !configItem.value) {
              console.log(`  ⚠️ 未找到配置: ${targetKey}`);
              return {};
            }
            
            try {
              // 解析 JSON 字符串
              const parsed = JSON.parse(configItem.value);
              console.log(`  ✓ 成功解析 ${targetKey}:`, Object.keys(parsed).length, '个模型');
              return parsed;
            } catch (e) {
              console.error(`  ❌ 解析 ${targetKey} 失败:`, e);
              return {};
            }
          }
          
          console.warn(`  ⚠️ ${targetKey} 数据格式未知，返回空对象`);
          return {};
        }
        
        // 解析三个配置项
        const cleanModelPrices = parseConfigValue(existingConfig.ModelPrice, 'ModelPrice');
        const cleanModelRatios = parseConfigValue(existingConfig.ModelRatio, 'ModelRatio');
        const cleanCompletionRatios = parseConfigValue(existingConfig.CompletionRatio, 'CompletionRatio');
        
        console.log('📊 解析结果:');
        console.log('  - ModelPrice:', Object.keys(cleanModelPrices).length, '个模型');
        console.log('  - ModelRatio:', Object.keys(cleanModelRatios).length, '个模型');
        console.log('  - CompletionRatio:', Object.keys(cleanCompletionRatios).length, '个模型');
        
        // ✅ Bug #018 修复：智能合并配置，只更新当前前缀的模型，保留其他前缀的模型
        console.log('🔄 开始智能合并配置...');
        console.log(`  - 当前前缀: "${prefix || '(无前缀)'}"`);
        console.log(`  - 新增模型数量: ${Object.keys(modelPrices).length} 个`);
        
        // 智能合并函数：只更新当前前缀的模型，保留其他前缀的模型
        function smartMerge(existingConfig, newConfig, prefix) {
          const merged = { ...existingConfig };
          
          // ✅ 关键修复：只有在前缀不为空时才清理旧配置
          if (prefix && prefix.trim() !== '') {
            console.log(`  - 清理前缀 "${prefix}" 的旧配置...`);
            let removedCount = 0;
            for (const key in merged) {
              if (key.startsWith(prefix)) {
                delete merged[key];
                removedCount++;
              }
            }
            console.log(`  - 已清理 ${removedCount} 个旧模型`);
          } else {
            // 无前缀模式：保留所有现有配置，只覆盖同名模型
            console.log('  - 无前缀模式：保留现有配置，添加/覆盖新模型');
          }
          
          // 添加新配置（会覆盖同名的旧配置）
          for (const [key, value] of Object.entries(newConfig)) {
            merged[key] = value;
          }
          
          return merged;
        }
        
        const mergedModelPrices = smartMerge(cleanModelPrices, modelPrices, prefix);
        const mergedModelRatios = smartMerge(cleanModelRatios, modelRatios, prefix);
        const mergedCompletionRatios = smartMerge(cleanCompletionRatios, completionRatios, prefix);
        
        console.log('✅ 智能合并完成:');
        console.log('  - ModelPrice: 总共', Object.keys(mergedModelPrices).length, '个模型 (新增', Object.keys(modelPrices).length, '个)');
        console.log('  - ModelRatio: 总共', Object.keys(mergedModelRatios).length, '个模型 (新增', Object.keys(modelRatios).length, '个)');
        console.log('  - CompletionRatio: 总共', Object.keys(mergedCompletionRatios).length, '个模型 (新增', Object.keys(completionRatios).length, '个)');
        
        // 更新配置
        if (Object.keys(modelPrices).length > 0) {
          await updateOption(apiUrl, 'ModelPrice', mergedModelPrices);
        }
        if (Object.keys(modelRatios).length > 0) {
          await updateOption(apiUrl, 'ModelRatio', mergedModelRatios);
          await updateOption(apiUrl, 'CompletionRatio', mergedCompletionRatios);
        }
        
        sendResponse({
          success: true,
          stats: {
            modelPriceCount: Object.keys(modelPrices).length,
            modelRatioCount: Object.keys(modelRatios).length,
            completionRatioCount: Object.keys(completionRatios).length
          }
        });
      }
      else if (request.action === 'getChannelList') {
        // 获取渠道列表
        console.log('📋 开始获取渠道列表...');
        
        const apiUrl = getCurrentApiUrl();
        
        // 获取认证信息
        const cookieData = await getCookiesFromAPI(apiUrl);
        if (!cookieData || !cookieData.success || !cookieData.newApiUser) {
          throw new Error('无法获取登录状态，请确保已登录 New API 后台');
        }
        
        const headers = {
          'New-API-User': cookieData.newApiUser
        };
        
        // 获取所有渠道（不分页，获取全部）
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
      else if (request.action === 'syncChannelModels') {
        // 同步渠道模型列表
        const { channelId, prefix, tokenGroup, upstreamUrl } = request;
        
        console.log(`🔄 开始同步渠道 ${channelId} 的模型列表，前缀: ${prefix || '(无)'}，令牌组: ${tokenGroup || '(全部)'}`);
        console.log(`📡 上游 URL: ${upstreamUrl || '(未提供)'}`);
        
        // 获取当前 API URL（后台 API）
        const apiUrl = getCurrentApiUrl();
        
        // 获取认证信息
        const cookieData = await getCookiesFromAPI(apiUrl);
        if (!cookieData || !cookieData.success || !cookieData.newApiUser) {
          throw new Error('无法获取登录状态，请确保已登录 New API 后台');
        }
        
        const headers = {
          'New-API-User': cookieData.newApiUser
        };
        
        // 步骤1: 从上游获取模型列表
        console.log(`🔄 步骤 1: 从渠道 ${channelId} 获取模型列表...`);
        const fetchModelsUrl = `${apiUrl}/api/channel/fetch_models/${channelId}`;
        
        let upstreamModels = [];
        let usedFallback = false;
        
        try {
          const modelsResponse = await fetch(fetchModelsUrl, {
            method: 'GET',
            headers: headers,
            credentials: 'include'
          });
          
          if (!modelsResponse.ok) {
            if (modelsResponse.status === 401 || modelsResponse.status === 403) {
              console.log(`⚠️ /models 接口返回 ${modelsResponse.status}，尝试使用 /pricing 接口...`);
              throw new Error('AUTH_FALLBACK');
            }
            throw new Error(`获取模型列表失败 (HTTP ${modelsResponse.status})`);
          }
          
          const modelsData = await modelsResponse.json();
          console.log('📦 上游返回数据:', modelsData);
          console.log('📦 数据类型检查:', {
            hasSuccess: 'success' in modelsData,
            successValue: modelsData.success,
            hasData: 'data' in modelsData,
            dataType: Array.isArray(modelsData.data) ? 'array' : typeof modelsData.data,
            dataLength: Array.isArray(modelsData.data) ? modelsData.data.length : 'N/A'
          });
          
          if (!modelsData.success) {
            const errorMsg = modelsData.message || '未知错误';
            console.log('❌ 上游返回失败:', errorMsg);
            if (errorMsg.includes('401') || errorMsg.includes('403') ||
                errorMsg.includes('unauthorized') || errorMsg.includes('status code: 403')) {
              console.log('⚠️ /models 接口认证失败，尝试使用 /pricing 接口...');
              throw new Error('AUTH_FALLBACK');
            }
            throw new Error(`获取模型列表失败：${errorMsg}`);
          }
          
          if (!modelsData.data) {
            console.error('❌ modelsData.data 不存在');
            throw new Error('上游返回数据缺少 data 字段');
          }
          
          if (!Array.isArray(modelsData.data)) {
            console.error('❌ modelsData.data 不是数组，类型:', typeof modelsData.data);
            throw new Error(`上游返回数据格式错误：data 字段应为数组，实际为 ${typeof modelsData.data}`);
          }
          
          upstreamModels = modelsData.data;
          console.log(`✅ 获取到 ${upstreamModels.length} 个模型`);
          
        } catch (error) {
          if (error.message === 'AUTH_FALLBACK') {
            // 使用 /pricing 接口作为备选方案
            const pricingUrl = upstreamUrl || `${apiUrl}/api/pricing`;
            console.log(`⚠️ 认证错误（401/403），回退到 /pricing: ${pricingUrl}`);
            
            // 发送进度消息到popup
            chrome.runtime.sendMessage({
              action: 'syncProgress',
              message: '⚠️ 无法直接获取模型列表，正在从定价接口获取...'
            });
            
            // 如果是上游 URL，使用 fetchCORS；否则使用普通 fetch
            let pricingData;
            if (upstreamUrl) {
              console.log('🌐 从上游 URL 获取 pricing 数据（通过 CORS）');
              pricingData = await fetchCORS(pricingUrl);
            } else {
              console.log('🏠 从后台 API 获取 pricing 数据');
              const pricingResponse = await fetch(pricingUrl, {
                method: 'GET',
                headers: headers,
                credentials: 'include'
              });
              
              if (!pricingResponse.ok) {
                throw new Error(`/pricing 接口也失败了 (HTTP ${pricingResponse.status})`);
              }
              
              pricingData = await pricingResponse.json();
            }
            
            console.log('📦 /pricing 返回数据:', pricingData);
            
            // 🔧 OneHub格式检测和转换
            if (pricingData.success && pricingData.data && typeof pricingData.data === 'object' && !Array.isArray(pricingData.data)) {
              console.log('🔄 检测到OneHub对象格式，开始转换...');
              const converted = convertOneHubFormat(pricingData);
              if (Array.isArray(converted)) {
                pricingData.data = converted;
                console.log(`✅ OneHub格式转换成功: ${converted.length} 个模型`);
              } else {
                throw new Error('/pricing 接口返回OneHub格式但转换失败');
              }
            }
            
            if (!pricingData.success || !pricingData.data || !Array.isArray(pricingData.data)) {
              throw new Error('/pricing 接口数据格式错误');
            }
            
            // 从 pricing data 中提取模型名称，根据令牌组过滤
            let filteredData = pricingData.data;
            
            if (tokenGroup && tokenGroup.trim() !== '') {
              console.log(`🔍 应用令牌组过滤: "${tokenGroup}"`);
              filteredData = pricingData.data.filter(item => {
                // enable_groups 可能是字符串或数组
                const groups = item.enable_groups;
                if (!groups) {
                  // OneHub转换后的数据没有enable_groups，默认包含
                  console.log(`  ⚠️ 模型 ${item.model_name} 无令牌组信息，默认包含`);
                  return true;
                }
                
                if (typeof groups === 'string') {
                  return groups === tokenGroup;
                } else if (Array.isArray(groups)) {
                  return groups.includes(tokenGroup);
                }
                return false;
              });
              console.log(`✓ 过滤后剩余 ${filteredData.length} 个模型`);
            }
            
            upstreamModels = filteredData.map(item => item.model_name);
            usedFallback = true;
            console.log(`✅ 从 /pricing 提取到 ${upstreamModels.length} 个模型`);
            
          } else {
            throw error;
          }
        }
        
        // 步骤2: 处理模型名称（添加前缀）
        const modelsWithPrefix = upstreamModels.map(modelName => {
          return prefix ? `${prefix}${modelName}` : modelName;
        });
        
        console.log('📝 处理后的模型列表（前3个）:', modelsWithPrefix.slice(0, 3));
        
        // 步骤3: 生成 model_mapping（映射关系）
        const modelMapping = {};
        upstreamModels.forEach(originalName => {
          const nameWithPrefix = prefix ? `${prefix}${originalName}` : originalName;
          modelMapping[nameWithPrefix] = originalName;
        });
        
        console.log('🗺️ 生成的 model_mapping（前3个）:',
          Object.entries(modelMapping).slice(0, 3).reduce((obj, [k, v]) => {
            obj[k] = v;
            return obj;
          }, {})
        );
        
        // 步骤4: 获取渠道当前配置
        console.log('📖 读取渠道当前配置...');
        const channelResponse = await fetch(`${apiUrl}/api/channel/${channelId}`, {
          method: 'GET',
          headers: headers,
          credentials: 'include'
        });
        
        if (!channelResponse.ok) {
          throw new Error(`获取渠道配置失败 (HTTP ${channelResponse.status})`);
        }
        
        const channelData = await channelResponse.json();
        console.log('📦 渠道当前配置:', channelData);
        
        if (!channelData.success || !channelData.data) {
          throw new Error('获取渠道配置失败');
        }
        
        const currentChannel = channelData.data;
        
        // 步骤5: 更新渠道配置
        console.log('🔄 准备更新渠道配置...');
        
        // 更新 headers 添加 Content-Type
        const updateHeaders = {
          ...headers,
          'Content-Type': 'application/json'
        };
        
        // 构建更新数据（保留其他字段，只更新 models 和 model_mapping）
        const updateData = {
          ...currentChannel,
          models: modelsWithPrefix.join(','),
          model_mapping: JSON.stringify(modelMapping)
        };
        
        console.log('📤 发送更新请求:', {
          url: `${apiUrl}/api/channel/`,
          modelsCount: modelsWithPrefix.length,
          mappingCount: Object.keys(modelMapping).length
        });
        
        const updateResponse = await fetch(`${apiUrl}/api/channel/`, {
          method: 'PUT',
          headers: updateHeaders,
          credentials: 'include',
          body: JSON.stringify(updateData)
        });
        
        if (!updateResponse.ok) {
          const errorText = await updateResponse.text();
          console.error('❌ 更新失败:', errorText);
          throw new Error(`更新渠道配置失败 (HTTP ${updateResponse.status}): ${errorText}`);
        }
        
        const updateResult = await updateResponse.json();
        console.log('✅ 更新结果:', updateResult);
        
        if (!updateResult.success) {
          throw new Error(`更新渠道配置失败: ${updateResult.message || '未知错误'}`);
        }
        
        sendResponse({
          success: true,
          stats: {
            totalModels: upstreamModels.length,
            prefix: prefix || '(无)',
            channelId: channelId,
            usedFallback: usedFallback
          },
          message: usedFallback
            ? '无法直接获取模型列表，已从定价信息中提取'
            : undefined
        });
      }
      else if (request.action === 'createChannel') {
        // 创建渠道
        const { channelData } = request;
        
        console.log('🔧 开始创建渠道:', channelData);
        
        const apiUrl = getCurrentApiUrl();
        
        // 获取认证信息
        const cookieData = await getCookiesFromAPI(apiUrl);
        if (!cookieData || !cookieData.success || !cookieData.newApiUser) {
          throw new Error('无法获取登录状态，请确保已登录 New API 后台');
        }
        
        const headers = {
          'Content-Type': 'application/json',
          'New-API-User': cookieData.newApiUser
        };
        
        // 发送创建请求
        const response = await fetch(`${apiUrl}/api/channel/`, {
          method: 'POST',
          headers: headers,
          credentials: 'include',
          body: JSON.stringify({
            mode: 'single',
            channel: channelData
          })
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error('❌ 创建渠道失败:', errorText);
          throw new Error(`创建渠道失败 (HTTP ${response.status}): ${errorText}`);
        }
        
        const result = await response.json();
        console.log('✅ 渠道创建结果:', result);
        
        if (!result.success) {
          throw new Error(`创建渠道失败: ${result.message || '未知错误'}`);
        }
        
        sendResponse({
          success: true,
          data: result.data
        });
      }
      else if (request.action === 'createVendor') {
        // 创建供货商
        const { vendorData } = request;
        
        console.log('🏭 开始创建供货商:', vendorData);
        
        const apiUrl = getCurrentApiUrl();
        
        // 获取认证信息
        const cookieData = await getCookiesFromAPI(apiUrl);
        if (!cookieData || !cookieData.success || !cookieData.newApiUser) {
          throw new Error('无法获取登录状态，请确保已登录 New API 后台');
        }
        
        const headers = {
          'Content-Type': 'application/json',
          'New-API-User': cookieData.newApiUser
        };
        
        // 发送创建请求
        const response = await fetch(`${apiUrl}/api/vendors/`, {
          method: 'POST',
          headers: headers,
          credentials: 'include',
          body: JSON.stringify(vendorData)
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error('❌ 创建供货商失败:', errorText);
          throw new Error(`创建供货商失败 (HTTP ${response.status}): ${errorText}`);
        }
        
        const result = await response.json();
        console.log('✅ 供货商创建结果:', result);
        
        if (!result.success) {
          throw new Error(`创建供货商失败: ${result.message || '未知错误'}`);
        }
        
        sendResponse({
          success: true,
          data: result.data
        });
      }
      else if (request.action === 'createModel') {
        // 创建模型配置
        const { modelData } = request;
        
        console.log('📦 开始创建模型配置:', modelData);
        
        const apiUrl = getCurrentApiUrl();
        
        // 获取认证信息
        const cookieData = await getCookiesFromAPI(apiUrl);
        if (!cookieData || !cookieData.success || !cookieData.newApiUser) {
          throw new Error('无法获取登录状态，请确保已登录 New API 后台');
        }
        
        const headers = {
          'Content-Type': 'application/json',
          'New-API-User': cookieData.newApiUser
        };
        
        // 发送创建请求
        const response = await fetch(`${apiUrl}/api/models/`, {
          method: 'POST',
          headers: headers,
          credentials: 'include',
          body: JSON.stringify(modelData)
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error('❌ 创建模型配置失败:', errorText);
          throw new Error(`创建模型配置失败 (HTTP ${response.status}): ${errorText}`);
        }
        
        const result = await response.json();
        console.log('✅ 模型配置创建结果:', result);
        
        if (!result.success) {
          throw new Error(`创建模型配置失败: ${result.message || '未知错误'}`);
        }
        
        sendResponse({
          success: true,
          data: result.data
        });
      }
      else if (request.action === 'generateSQL') {
        // 生成 SQL
        const { results, prefix } = request;
        const { sql, stats } = generateSQL(results, prefix);
        
        sendResponse({
          success: true,
          sql: sql,
          stats: stats
        });
      }
    } catch (error) {
      // 记录详细错误信息
      await logError(request.action || 'unknown', error, {
        requestData: {
          action: request.action,
          hasUpstreamUrl: !!request.upstreamUrl,
          hasResults: !!request.results,
          resultsCount: request.results?.length
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