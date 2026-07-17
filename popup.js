// PriceSyncPro Extension - Popup Script
// 这个脚本运行在插件的弹出窗口中

let currentResults = null;
let currentApiUrl = '';
// 当前分析模式：'channel'（按选中渠道的模型）| 'global'（New API 全局内置/已启用模型）。
// 决定 updateSmartSyncButton 是否要求先选渠道，以及同步前用哪条分析路径产出的结果。
let currentMode = 'channel';

// 侧边栏常驻场景下，标签页切换/导航不会重新加载本脚本，
// 需要主动感知变化并重新检测登录状态、刷新渠道列表，
// 避免一直显示"面板打开那一刻"的旧标签页状态
chrome.tabs.onActivated.addListener(() => {
  resetAnalysisState();
  checkLoginStatus();
  loadChannelList();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) {
    resetAnalysisState();
    checkLoginStatus();
    loadChannelList();
  }
});

// 切换/刷新目标标签页时，之前分析出的结果（尤其 global 模式的全量结果）已经不再对应当前
// 上下文，必须整体清空并复位，避免残留的已勾选结果被误同步到（可能已切换的）实例上。
// 声明为 hoisted function 以便上方的 tab 监听器在运行时调用。
function resetAnalysisState() {
  currentMode = 'channel';
  currentApiUrl = '';
  currentMatchResults = [];
  if (typeof resultsSection !== 'undefined' && resultsSection) {
    resultsSection.classList.remove('show');
  }
  if (typeof resultsTableBody !== 'undefined' && resultsTableBody) {
    resultsTableBody.innerHTML = '';
  }
  if (typeof updateSmartSyncButton === 'function') {
    updateSmartSyncButton();
  }
}

// ========================================
// 全局键盘快捷键
// ========================================
document.addEventListener('keydown', (e) => {
  // Esc 键：关闭所有打开的对话框
  if (e.key === 'Escape') {
    if (confirmModal.classList.contains('show')) {
      confirmModal.classList.remove('show');
    }
  }

  // Ctrl+Enter 或 Cmd+Enter：同步选中价格
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!smartSyncBtn.disabled) {
      smartSyncBtn.click();
    }
  }
});

// DOM 元素
const smartSyncBtn = document.getElementById('smartSyncBtn');
const smartSyncBtnText = document.getElementById('smartSyncBtnText');
const batchUpdateBtn = document.getElementById('batchUpdateBtn');
const syncBuiltinBtn = document.getElementById('syncBuiltinBtn');
const syncModeHint = document.getElementById('syncModeHint');
const syncModeText = document.getElementById('syncModeText');
const channelSelect = document.getElementById('channelSelect');
const refreshChannelsBtn = document.getElementById('refreshChannelsBtn');
const channelHint = document.getElementById('channelHint');
const tableSearchInput = document.getElementById('tableSearchInput');
const selectAllCheckbox = document.getElementById('selectAllCheckbox');
const autoFallbackToggle = document.getElementById('autoFallbackToggle');

// 渠道列表缓存
let channelsList = [];

// 当前渠道的匹配结果（数组，含 matched/unmatched 两类）
let currentMatchResults = [];

// 自动兜底开关状态（持久化到 chrome.storage.local.autoFallback，默认关闭）。
// 打开时，分析请求带 autoFallback:true，content 侧对常规匹配失败的模型按
// 名称包含关系自动选取首个兜底候选（source:'fallback-auto'）
let autoFallbackEnabled = false;

const statusDiv = document.getElementById('status');
const resultsSection = document.getElementById('resultsSection');
const resultsStats = document.getElementById('resultsStats');
const resultsTableBody = document.getElementById('resultsTableBody');
const infoBanner = document.getElementById('infoBanner');
const infoBannerText = document.getElementById('infoBannerText');
const closeBannerBtn = document.getElementById('closeBannerBtn');

// 右上角功能按钮
const refreshBtn = document.querySelector('.header-actions button[title="刷新"]');
const settingsBtn = document.querySelector('.header-actions button[title="设置"]');

// 模态对话框元素
const confirmModal = document.getElementById('confirmModal');
const modalTitle = document.getElementById('modalTitle');
const modalMessage = document.getElementById('modalMessage');
const modalInfoBox = document.getElementById('modalInfoBox');
const modalCancelBtn = document.getElementById('modalCancelBtn');
const modalConfirmBtn = document.getElementById('modalConfirmBtn');

// ========================================
// 自定义确认对话框
// ========================================

/**
 * 显示自定义确认对话框
 * @param {Object} options - 对话框配置选项
 * @param {string} [options.title='确认操作'] - 对话框标题
 * @param {string} [options.message='确认要执行此操作吗？'] - 提示消息
 * @param {Array<{label: string, value: string}>} [options.info] - 信息列表
 * @param {string} [options.confirmText='确认'] - 确认按钮文本
 * @param {string} [options.cancelText='取消'] - 取消按钮文本
 * @returns {Promise<boolean>} 用户是否确认（true=确认，false=取消）
 */
function showConfirmDialog(options) {
  return new Promise((resolve) => {
    // 获取当前的按钮元素（可能已经被替换过）
    const currentCancelBtn = document.getElementById('modalCancelBtn');
    const currentConfirmBtn = document.getElementById('modalConfirmBtn');

    // 设置标题和消息
    modalTitle.textContent = options.title || '确认操作';
    modalMessage.textContent = options.message || '确认要执行此操作吗？';

    // 设置信息框内容
    if (options.info && options.info.length > 0) {
      modalInfoBox.innerHTML = '';
      options.info.forEach(item => {
        const infoItem = document.createElement('div');
        infoItem.className = 'modal-info-item';
        infoItem.innerHTML = `
          <span class="modal-info-label">${item.label}</span>
          <span class="modal-info-value">${item.value}</span>
        `;
        modalInfoBox.appendChild(infoItem);
      });
      modalInfoBox.style.display = 'block';
    } else {
      modalInfoBox.style.display = 'none';
    }

    // 设置按钮文本
    currentCancelBtn.textContent = options.cancelText || '取消';
    currentConfirmBtn.textContent = options.confirmText || '确认';

    // 显示模态框
    confirmModal.classList.add('show');

    // 绑定事件（先移除旧事件）
    const newCancelBtn = currentCancelBtn.cloneNode(true);
    const newConfirmBtn = currentConfirmBtn.cloneNode(true);
    currentCancelBtn.parentNode.replaceChild(newCancelBtn, currentCancelBtn);
    currentConfirmBtn.parentNode.replaceChild(newConfirmBtn, currentConfirmBtn);

    // 取消按钮
    const handleCancel = () => {
      confirmModal.classList.remove('show');
      confirmModal.removeEventListener('click', handleOverlayClick);
      resolve(false);
    };

    newCancelBtn.addEventListener('click', handleCancel);

    // 确认按钮
    const handleConfirm = () => {
      confirmModal.classList.remove('show');
      confirmModal.removeEventListener('click', handleOverlayClick);
      resolve(true);
    };

    newConfirmBtn.addEventListener('click', handleConfirm);

    // 点击遮罩层关闭
    const handleOverlayClick = (e) => {
      if (e.target === confirmModal) {
        confirmModal.classList.remove('show');
        confirmModal.removeEventListener('click', handleOverlayClick);
        resolve(false);
      }
    };

    confirmModal.addEventListener('click', handleOverlayClick);
  });
}

/**
 * 检测用户登录状态
 * 通过检查 Cookie 判断用户是否已登录 New API 后台
 * @returns {Promise<void>}
 */
async function checkLoginStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab.url;

    // 显示 Banner（如果之前被隐藏）
    infoBanner.classList.remove('hidden');
    infoBanner.style.opacity = '1';

    // 检查是否在 New API 页面
    if (!url || (!url.includes('localhost') && !url.includes('127.0.0.1') && !url.match(/https?:\/\/[^\/]+/))) {
      infoBannerText.textContent = '⚠️ 请在 New API 后台页面打开此插件';
      infoBanner.style.background = 'rgba(255, 149, 0, 0.08)';
      infoBanner.style.color = '#FF9500';
      closeBannerBtn.style.display = 'flex';
      return;
    }

    // 尝试获取 Cookie
    chrome.runtime.sendMessage({
      action: 'getCookies',
      url: url
    }, (response) => {
      if (response && response.success && response.newApiUser) {
        // ✅ 已登录 - 显示成功状态
        infoBannerText.innerHTML = `✅ 已连接 | 用户: ${response.newApiUser.username || '未知'}`;
        infoBanner.style.background = 'rgba(52, 199, 89, 0.08)';
        infoBanner.style.color = '#34C759';

        // 3秒后自动淡出并隐藏
        setTimeout(() => {
          infoBanner.style.transition = 'opacity 0.4s ease';
          infoBanner.style.opacity = '0';
          setTimeout(() => {
            infoBanner.classList.add('hidden');
          }, 400);
        }, 3000);
      } else {
        // ❌ 未登录 - 显示明确的操作指引
        infoBannerText.innerHTML = '⚠️ 未检测到登录状态 | 请登录后点击右上角 ⟳ 刷新';
        infoBanner.style.background = 'rgba(255, 149, 0, 0.08)';
        infoBanner.style.color = '#FF9500';
        closeBannerBtn.style.display = 'flex';
      }
    });
  } catch (error) {
    console.error('检测登录状态失败:', error);
    infoBannerText.textContent = 'ℹ️ 请在 New API 后台页面使用此插件';
    infoBanner.style.background = 'rgba(0, 122, 255, 0.08)';
    infoBanner.style.color = '#007AFF';
    closeBannerBtn.style.display = 'flex';
  }
}

// Banner 关闭按钮事件
if (closeBannerBtn) {
  closeBannerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    infoBanner.style.transition = 'opacity 0.3s ease';
    infoBanner.style.opacity = '0';
    setTimeout(() => {
      infoBanner.classList.add('hidden');
    }, 300);
  });
}

// 表格搜索功能
if (tableSearchInput) {
  tableSearchInput.addEventListener('input', (e) => {
    const searchTerm = e.target.value.toLowerCase().trim();
    const rows = resultsTableBody.querySelectorAll('tr');

    let visibleCount = 0;

    rows.forEach(row => {
      const modelName = row.querySelector('.model-name')?.textContent.toLowerCase() || '';
      if (modelName.includes(searchTerm)) {
        row.style.display = '';
        visibleCount++;
      } else {
        row.style.display = 'none';
      }
    });

    // 更新统计信息
    if (searchTerm) {
      resultsStats.textContent = `找到 ${visibleCount} 个匹配项`;
    } else {
      updateResultsStats();
    }

    // 搜索改变了"可见勾选行"的集合，同步按钮的计数/提示需随之刷新
    updateSmartSyncButton();
  });
}

function updateResultsStats() {
  if (!currentMatchResults || currentMatchResults.length === 0) {
    resultsStats.textContent = '';
    return;
  }
  const matchedCount = currentMatchResults.filter(r => r.matched).length;
  const fallbackCount = currentMatchResults.filter(
    r => r.matched && (r.source === 'fallback-auto' || r.source === 'fallback-manual')
  ).length;
  const unmatchedCount = currentMatchResults.length - matchedCount;
  const fallbackPart = fallbackCount > 0 ? `, 兜底: ${fallbackCount}` : '';
  resultsStats.textContent = `共 ${currentMatchResults.length} 个模型 (已匹配: ${matchedCount}${fallbackPart}, 未匹配: ${unmatchedCount})`;
}

// 更新同步按钮状态
function updateSmartSyncButton() {
  const channelId = channelSelect.value.trim();
  // 只统计可见（未被搜索隐藏）的勾选行——与 getCheckedSelections 的实际同步范围保持一致，
  // 否则按钮上的 (N) 和提示会把被搜索隐藏的已勾选行也算进去，与真正会同步的数量不符。
  const checkedBoxes = resultsTableBody
    ? Array.from(resultsTableBody.querySelectorAll('input.row-checkbox:checked')).filter(isRowVisible)
    : [];
  const checkedCount = checkedBoxes.length;

  // global 模式没有"选中渠道"的概念，只要求勾选了至少一个模型即可同步；
  // channel 模式仍要求先选渠道（否则无从分析）。
  const gateOk = currentMode === 'global' ? checkedCount > 0 : (channelId && checkedCount > 0);
  if (!gateOk) {
    smartSyncBtn.disabled = true;
    syncModeHint.style.display = 'none';
    return;
  }

  smartSyncBtn.disabled = false;
  smartSyncBtnText.textContent = `同步选中价格 (${checkedCount})`;

  // 回查勾选行，区分按次/按秒计价 / 按 Token 计价（含长上下文分级）的模型数量，混合时提示分布
  let flatCallCount = 0;
  let flatSecondCount = 0;
  let ratioCount = 0;
  let tieredCount = 0;
  checkedBoxes.forEach(checkbox => {
    const index = parseInt(checkbox.dataset.index, 10);
    const result = currentMatchResults[index];
    if (!result || !result.matched) return;
    if (result.billingMode === 'flat') {
      if (result.flatUnit === 'second') flatSecondCount++;
      else flatCallCount++;
    }
    else if (result.billingMode === 'tiered') tieredCount++;
    else ratioCount++;
  });

  const parts = [];
  if (ratioCount > 0) parts.push(`${ratioCount} 个按 Token 计价`);
  if (tieredCount > 0) parts.push(`${tieredCount} 个长上下文分级计价`);
  if (flatCallCount > 0) parts.push(`${flatCallCount} 个按次计价`);
  if (flatSecondCount > 0) parts.push(`${flatSecondCount} 个按秒计价`);

  syncModeText.textContent = parts.length > 0
    ? `将同步 ${parts.join(' + ')} 的模型`
    : `将同步 ${checkedCount} 个模型的价格`;
  syncModeHint.style.display = 'block';
}

// 同步选中价格按钮点击事件
smartSyncBtn.addEventListener('click', async () => {
  if (smartSyncBtn.disabled) return;

  const selections = getCheckedSelections();
  if (selections.length === 0) {
    showStatus('⚠️ 请至少选择一个模型', 'error');
    return;
  }

  // 全局模式（覆盖 New API 内置/全量模型）或大批量选择时，同步会一次性改写大量模型的
  // 计费配置且不可逆，加一道确认对话框防止误触（尤其默认全勾选 + Ctrl+Enter 的场景）。
  const CONFIRM_THRESHOLD = 20;
  if (currentMode === 'global' || selections.length >= CONFIRM_THRESHOLD) {
    const confirmed = await showConfirmDialog({
      title: '⚠️ 确认同步价格',
      message: currentMode === 'global'
        ? '你正在同步 New API 内置/全量模型的价格，这会直接改写这些模型的计费配置，确定继续吗？'
        : '将改写选中模型的计费配置，确定继续吗？',
      info: [
        { label: '影响模型数', value: `${selections.length} 个` },
        { label: '模式', value: currentMode === 'global' ? 'New API 内置/全量' : '当前渠道' }
      ],
      confirmText: '确认同步',
      cancelText: '取消'
    });
    if (!confirmed) return;
  }

  smartSyncBtn.disabled = true;
  const originalHTML = smartSyncBtn.innerHTML;
  smartSyncBtn.innerHTML = '<span class="spinner"></span>同步中...';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const scriptReady = await ensureContentScript(tab.id);
    if (!scriptReady) {
      showStatus(
        '❌ 无法连接到页面脚本\n\n' +
        '💡 解决方法：\n' +
        '1. 刷新当前页面（F5）\n' +
        '2. 重新打开此插件',
        'error'
      );
      return;
    }

    const syncResult = await sendMessageWithRetry(tab.id, {
      action: 'syncSelectedPrices',
      apiUrl: currentApiUrl,
      selections
    });

    if (!syncResult.success) {
      showStatus(`❌ 同步失败：${syncResult.error}`, 'error');
      return;
    }

    const syncResponse = syncResult.response;

    if (syncResponse.success) {
      showStatus(`✅ 同步成功！已更新 ${syncResponse.stats.syncedCount} 个模型的价格`, 'success');
    } else {
      showStatus(`❌ 同步失败：${syncResponse.error}`, 'error');
    }
  } catch (error) {
    showStatus(`❌ 错误：${error.message}`, 'error');
  } finally {
    smartSyncBtn.disabled = false;
    smartSyncBtn.innerHTML = originalHTML;
    updateSmartSyncButton();
  }
});

// 根据匹配结果组装 syncSelectedPrices 需要的单条 selection——单渠道同步和批量更新
// 所有渠道两个入口共用这一份逻辑，避免其中一处漏改导致新字段静默丢失
function buildSelectionFromResult(result) {
  if (result.billingMode === 'flat') {
    return {
      modelName: result.modelName,
      billingMode: 'flat',
      modelPrice: result.modelPrice
    };
  }
  const sel = {
    modelName: result.modelName,
    billingMode: result.billingMode === 'tiered' ? 'tiered' : 'ratio',
    modelRatio: result.modelRatio,
    completionRatio: result.completionRatio
  };
  if (result.cacheRatio != null) sel.cacheRatio = result.cacheRatio;
  if (result.createCacheRatio != null) sel.createCacheRatio = result.createCacheRatio;
  if (result.billingMode === 'tiered' && result.billingExpr) {
    sel.billingExpr = result.billingExpr;
  }
  return sel;
}

// 判断某个勾选框所在行当前是否可见（未被搜索过滤隐藏）。
// 搜索框只设置 row.style.display，不改勾选状态；同步时必须只算可见行，
// 否则被搜索隐藏的已勾选行会被静默一起同步，用户以为搜索缩小了范围其实没有。
function isRowVisible(checkbox) {
  const row = checkbox.closest('tr');
  return row && row.style.display !== 'none';
}

// 收集当前勾选且可见的行，组装成 syncSelectedPrices 需要的 selections
function getCheckedSelections() {
  const selections = [];
  resultsTableBody.querySelectorAll('input.row-checkbox:checked').forEach(checkbox => {
    if (!isRowVisible(checkbox)) return;
    const index = parseInt(checkbox.dataset.index, 10);
    const result = currentMatchResults[index];
    if (result && result.matched) {
      selections.push(buildSelectionFromResult(result));
    }
  });
  return selections;
}

// ========================================
// 批量更新所有渠道按钮
// ========================================
if (batchUpdateBtn) {
  batchUpdateBtn.addEventListener('click', async () => {
    await performBatchUpdateAllChannels();
  });
}

// ========================================
// 同步 New API 内置价格按钮（全局模式入口）
// ========================================
if (syncBuiltinBtn) {
  syncBuiltinBtn.addEventListener('click', async () => {
    if (syncBuiltinBtn.disabled) return;
    syncBuiltinBtn.disabled = true;
    const originalHTML = syncBuiltinBtn.innerHTML;
    syncBuiltinBtn.innerHTML = '<span class="spinner"></span>枚举中...';
    try {
      await analyzeBuiltinPricing();
    } catch (error) {
      showStatus(`❌ 错误：${error.message}`, 'error');
    } finally {
      syncBuiltinBtn.disabled = false;
      syncBuiltinBtn.innerHTML = originalHTML;
      updateSmartSyncButton();
    }
  });
}

/**
 * 批量更新所有渠道的价格配置
 * 对每个渠道读取当前模型列表、匹配 OpenRouter 官方价格，自动同步所有已匹配的模型
 */
async function performBatchUpdateAllChannels() {
  const confirmed = await showConfirmDialog({
    title: '🔄 批量更新所有渠道',
    message: '将对每个渠道读取当前模型列表，匹配官方价格并自动同步所有已匹配的模型\n\n这可能需要一些时间，确定继续吗？',
    info: [
      { label: '渠道数量', value: `${channelsList.length} 个` },
      { label: '预计耗时', value: `约 ${Math.ceil(channelsList.length * 2)} 秒` }
    ],
    confirmText: '开始批量更新',
    cancelText: '取消'
  });

  if (!confirmed) return;

  batchUpdateBtn.disabled = true;
  const originalHTML = batchUpdateBtn.innerHTML;
  batchUpdateBtn.innerHTML = '<span class="spinner"></span>批量更新中...';

  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const successChannels = [];
  const failedChannels = [];

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const scriptReady = await ensureContentScript(tab.id);
    if (!scriptReady) {
      showStatus('❌ 无法连接到页面脚本，请刷新页面后重试', 'error');
      return;
    }

    showProgress(0, '准备中...');
    showBatchUpdateStatus(0, channelsList.length, successCount, failedCount, skippedCount);

    for (let i = 0; i < channelsList.length; i++) {
      const channel = channelsList[i];
      const progress = Math.round(((i + 1) / channelsList.length) * 100);

      showProgress(progress, `${i + 1}/${channelsList.length}: ${channel.name}`);

      try {
        const analyzeResult = await sendMessageWithRetry(tab.id, {
          action: 'analyzeChannelPricing',
          channelId: channel.id,
          autoFallback: autoFallbackEnabled
        });

        if (!analyzeResult.success || !analyzeResult.response.success) {
          const error = analyzeResult.error || analyzeResult.response?.error || '未知错误';
          failedCount++;
          failedChannels.push({
            name: channel.name,
            reason: error.substring(0, 100),
            type: 'error'
          });
          showBatchUpdateStatus(i + 1, channelsList.length, successCount, failedCount, skippedCount, channel.name, 'error');
          continue;
        }

        const { apiUrl, results } = analyzeResult.response;
        const selections = results
          .filter(r => r.matched)
          .map(buildSelectionFromResult);

        if (selections.length === 0) {
          skippedCount++;
          failedChannels.push({
            name: channel.name,
            reason: '没有匹配到任何官方价格的模型',
            type: 'skip'
          });
          showBatchUpdateStatus(i + 1, channelsList.length, successCount, failedCount, skippedCount, channel.name, 'skip');
          continue;
        }

        const syncResult = await sendMessageWithRetry(tab.id, {
          action: 'syncSelectedPrices',
          apiUrl,
          selections
        });

        if (!syncResult.success || !syncResult.response.success) {
          const error = syncResult.error || syncResult.response?.error || '未知错误';
          failedCount++;
          failedChannels.push({
            name: channel.name,
            reason: error.substring(0, 100),
            type: 'error'
          });
          showBatchUpdateStatus(i + 1, channelsList.length, successCount, failedCount, skippedCount, channel.name, 'error');
          continue;
        }

        successCount++;
        successChannels.push({
          name: channel.name,
          modelCount: selections.length
        });

        showBatchUpdateStatus(i + 1, channelsList.length, successCount, failedCount, skippedCount, channel.name, 'success');

        await new Promise(resolve => setTimeout(resolve, 300));

      } catch (error) {
        console.error(`处理渠道 ${channel.name} 时出错:`, error);
        failedCount++;
        failedChannels.push({
          name: channel.name,
          reason: error.message.substring(0, 100),
          type: 'error'
        });
        showBatchUpdateStatus(i + 1, channelsList.length, successCount, failedCount, skippedCount, channel.name, 'error');
      }
    }

    showProgress(100, '✅ 批量更新完成');
    showBatchUpdateFinalReport(channelsList.length, successCount, failedCount, skippedCount, successChannels, failedChannels);

    setTimeout(() => {
      hideProgress();
    }, 2000);

  } catch (error) {
    showStatus(`❌ 批量更新失败：${error.message}`, 'error');
    hideProgress();
  } finally {
    batchUpdateBtn.disabled = false;
    batchUpdateBtn.innerHTML = originalHTML;
  }
}

/**
 * 显示批量更新的实时状态
 */
function showBatchUpdateStatus(current, total, success, failed, skipped, currentChannel = '', status = '') {
  const statusIcon = {
    'success': '✅',
    'error': '❌',
    'skip': '⏭️',
    '': '🔄'
  };

  const icon = statusIcon[status] || '🔄';
  const channelInfo = currentChannel ? ` | 当前: ${icon} ${currentChannel}` : '';

  const message = `📊 批量更新进度: ${current}/${total}${channelInfo}\n\n` +
    `✅ 成功: ${success} 个\n` +
    `❌ 失败: ${failed} 个\n` +
    `⏭️ 跳过: ${skipped} 个`;

  showStatus(message, 'info');
}

/**
 * 显示批量更新的最终报告
 */
function showBatchUpdateFinalReport(total, success, failed, skipped, successChannels, failedChannels) {
  let message = `🎉 批量更新完成！\n\n`;
  message += `📊 总计: ${total} 个渠道\n`;
  message += `✅ 成功: ${success} 个\n`;
  message += `❌ 失败: ${failed} 个\n`;
  message += `⏭️ 跳过: ${skipped} 个\n`;

  // 成功渠道详情（仅显示前5个）
  if (successChannels.length > 0) {
    message += `\n━━━━━━━━━━━━━━━━━━━━\n`;
    message += `✅ 成功更新的渠道:\n`;
    const displayCount = Math.min(5, successChannels.length);
    for (let i = 0; i < displayCount; i++) {
      const ch = successChannels[i];
      message += `  • ${ch.name} (${ch.modelCount}个模型)\n`;
    }
    if (successChannels.length > 5) {
      message += `  ... 还有 ${successChannels.length - 5} 个渠道\n`;
    }
  }

  // 失败/跳过渠道详情
  if (failedChannels.length > 0) {
    message += `\n━━━━━━━━━━━━━━━━━━━━\n`;
    message += `❌ 失败/跳过的渠道:\n`;
    failedChannels.forEach(ch => {
      const icon = ch.type === 'skip' ? '⏭️' : '❌';
      const shortReason = ch.reason.length > 60
        ? ch.reason.substring(0, 60) + '...'
        : ch.reason;
      message += `  ${icon} ${ch.name}\n     └─ ${shortReason}\n`;
    });
  }

  const statusType = success > 0 ? 'success' : (failed > 0 ? 'error' : 'info');
  showStatus(message, statusType);
}

// 单渠道分析：读取渠道当前模型列表 + 匹配官方价格
async function analyzeSelectedChannel(channelId) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const scriptReady = await ensureContentScript(tab.id);
  if (!scriptReady) {
    showStatus(
      '❌ 无法连接到页面脚本\n\n' +
      '💡 解决方法：\n' +
      '1. 刷新当前页面（F5）\n' +
      '2. 重新打开此插件',
      'error'
    );
    return;
  }

  showStatus('🔍 正在读取渠道模型并匹配官方价格...', 'info');

  const result = await sendMessageWithRetry(tab.id, {
    action: 'analyzeChannelPricing',
    channelId,
    autoFallback: autoFallbackEnabled
  });

  if (!result.success || !result.response.success) {
    const error = result.error || result.response?.error || '未知错误';
    showStatus(`❌ 分析失败：${error}`, 'error');
    resultsSection.classList.remove('show');
    currentMatchResults = [];
    return;
  }

  currentApiUrl = result.response.apiUrl;
  currentMatchResults = result.response.results;

  renderMatchTable(currentMatchResults);

  const matchedCount = currentMatchResults.filter(r => r.matched).length;
  showStatus(`✅ 匹配完成：${matchedCount}/${currentMatchResults.length} 个模型命中官方价格`, 'success');
}

// 全局分析：枚举 New API 内置/已配置 + 所有启用渠道的模型，匹配官方价格。
// 不依赖选中渠道，产出的 results 形状与 analyzeSelectedChannel 完全一致，下游复用。
async function analyzeBuiltinPricing() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const scriptReady = await ensureContentScript(tab.id);
  if (!scriptReady) {
    showStatus(
      '❌ 无法连接到页面脚本\n\n' +
      '💡 解决方法：\n' +
      '1. 刷新当前页面（F5）\n' +
      '2. 重新打开此插件',
      'error'
    );
    return;
  }

  currentMode = 'global';
  // 切到全局模式时清空渠道下拉框的选中，避免 UI 上仍高亮着某个渠道产生误导
  channelSelect.value = '';
  showStatus('🔍 正在枚举 New API 内置/已启用模型并匹配官方价格...', 'info');

  const result = await sendMessageWithRetry(tab.id, {
    action: 'analyzeGlobalPricing',
    autoFallback: autoFallbackEnabled
  });

  if (!result.success || !result.response.success) {
    const error = result.error || result.response?.error || '未知错误';
    showStatus(`❌ 分析失败：${error}`, 'error');
    resultsSection.classList.remove('show');
    currentMatchResults = [];
    updateSmartSyncButton();
    return;
  }

  currentApiUrl = result.response.apiUrl;
  currentMatchResults = result.response.results;

  renderMatchTable(currentMatchResults);

  const matchedCount = currentMatchResults.filter(r => r.matched).length;
  let msg = `✅ 匹配完成：${matchedCount}/${currentMatchResults.length} 个 New API 模型命中官方价格`;
  if (result.response.warning) {
    msg += `\n⚠️ ${result.response.warning}（已降级为仅内置/已配置模型）`;
  }
  showStatus(msg, result.response.warning ? 'info' : 'success');
  updateSmartSyncButton();
}

// ========================================
// 渠道列表管理
// ========================================

async function loadChannelList() {
  try {
    channelSelect.disabled = true;
    channelSelect.innerHTML = '<option value="">-- 加载中... --</option>';
    channelHint.innerHTML = '⏳ 正在加载渠道列表...';
    channelHint.style.color = 'var(--color-text-secondary)';

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const scriptReady = await ensureContentScript(tab.id);
    if (!scriptReady) {
      channelSelect.innerHTML = '<option value="">-- 请刷新页面 --</option>';
      channelHint.innerHTML = '❌ 无法连接到页面，请刷新后重试';
      channelHint.style.color = 'var(--color-danger)';
      return;
    }

    const result = await sendMessageWithRetry(tab.id, {
      action: 'getChannelList'
    });

    if (!result.success) {
      channelSelect.innerHTML = '<option value="">-- 加载失败 --</option>';
      channelHint.innerHTML = '❌ 获取渠道列表失败，请检查登录状态';
      channelHint.style.color = 'var(--color-danger)';
      return;
    }

    const response = result.response;

    if (response.success && response.channels) {
      channelsList = response.channels;
      renderChannelSelect(response.channels);
      channelHint.innerHTML = `✅ 已加载 ${response.channels.length} 个渠道`;
      channelHint.style.color = 'var(--color-success)';

      setTimeout(() => {
        channelHint.innerHTML = '💡 选择渠道后自动读取该渠道已有模型并匹配官方价格';
        channelHint.style.color = 'var(--color-text-secondary)';
      }, 2000);
    } else {
      channelSelect.innerHTML = '<option value="">-- 无可用渠道 --</option>';
      channelHint.innerHTML = '⚠️ 未找到可用渠道';
      channelHint.style.color = 'var(--color-warning)';
    }
  } catch (error) {
    console.error('加载渠道列表失败:', error);
    channelSelect.innerHTML = '<option value="">-- 加载失败 --</option>';
    channelHint.innerHTML = '❌ 加载失败，请点击刷新按钮重试';
    channelHint.style.color = 'var(--color-danger)';
  } finally {
    channelSelect.disabled = false;
  }
}

/**
 * 渲染渠道下拉列表
 */
function renderChannelSelect(channels) {
  channelSelect.innerHTML = '<option value="">-- 请选择渠道 --</option>';

  channels.forEach(channel => {
    const option = document.createElement('option');
    option.value = channel.id;
    option.textContent = `${channel.name} (${channel.models}个)`;
    channelSelect.appendChild(option);
  });
}

// 刷新渠道列表按钮
if (refreshChannelsBtn) {
  refreshChannelsBtn.addEventListener('click', async () => {
    refreshChannelsBtn.style.transform = 'rotate(360deg)';
    refreshChannelsBtn.style.transition = 'transform 0.5s ease';

    await loadChannelList();

    setTimeout(() => {
      refreshChannelsBtn.style.transform = '';
    }, 500);
  });
}

// 渠道选择变化时读取该渠道模型并匹配官方价格
channelSelect.addEventListener('change', async () => {
  const channelId = channelSelect.value;
  if (channelId) {
    // 用户主动选了渠道 → 切回渠道模式（可能此前处于 global 模式）
    currentMode = 'channel';
    chrome.storage.local.set({ channelId: channelId });
    await analyzeSelectedChannel(channelId);
  } else {
    resultsSection.classList.remove('show');
    currentMatchResults = [];
  }

  updateSmartSyncButton();
});

// 自动兜底开关：持久化状态；若当前已有分析结果，按当前模式自动重新分析——
// 兜底是在 content 侧构建 results 时应用的，必须重新分析才能让开关变化生效
if (autoFallbackToggle) {
  autoFallbackToggle.addEventListener('change', async () => {
    autoFallbackEnabled = autoFallbackToggle.checked;
    chrome.storage.local.set({ autoFallback: autoFallbackEnabled });

    if (currentMatchResults.length === 0) return;

    if (currentMode === 'global') {
      await analyzeBuiltinPricing();
    } else if (channelSelect.value) {
      await analyzeSelectedChannel(channelSelect.value);
    }
    updateSmartSyncButton();
  });
}

// ========================================
// 右上角按钮功能
// ========================================

// 刷新按钮 - 重新检测登录状态和重置表单
if (refreshBtn) {
  refreshBtn.addEventListener('click', () => {
    checkLoginStatus();

    resultsSection.classList.remove('show');
    currentResults = null;
    currentApiUrl = '';
    currentMatchResults = [];
    currentMode = 'channel';
    updateSmartSyncButton();

    showStatus('🔄 已刷新页面状态', 'info');

    refreshBtn.style.transform = 'rotate(360deg)';
    refreshBtn.style.transition = 'transform 0.5s ease';
    setTimeout(() => {
      refreshBtn.style.transform = '';
    }, 500);
  });
}

// 设置按钮 - 显示关于对话框
if (settingsBtn) {
  settingsBtn.addEventListener('click', async () => {
    await showAboutDialog();
  });
}

// 显示关于对话框
async function showAboutDialog() {
  return new Promise((resolve) => {
    const currentCancelBtn = document.getElementById('modalCancelBtn');
    const currentConfirmBtn = document.getElementById('modalConfirmBtn');
    const modalBody = document.querySelector('#confirmModal .modal-body');

    modalTitle.textContent = 'PriceSyncPro';

    const originalContent = modalBody.innerHTML;

    const aboutHTML = `
      <div class="about-content">
        <div class="about-logo">🚀</div>
        <div class="about-version">版本 ${chrome.runtime.getManifest().version}</div>
        <div class="about-description">
          New API 定价同步助手<br>
          从 OpenRouter / LiteLLM / Vercel AI Gateway 官方价格匹配同步
        </div>
        <div class="about-links">
          <a href="https://github.com/sycg767/PriceSyncPro" target="_blank" class="about-link-btn" id="githubLink">
            <span class="about-link-icon">
              <svg class="github-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
                <path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
              </svg>
            </span>
            <span>GitHub 仓库</span>
          </a>

          <a href="https://github.com/sycg767/PriceSyncPro/issues" target="_blank" class="about-link-btn" id="issuesLink">
            <span class="about-link-icon">🐛</span>
            <span>问题反馈</span>
          </a>

          <a href="https://github.com/sycg767/PriceSyncPro/blob/main/README.md" target="_blank" class="about-link-btn" id="docsLink">
            <span class="about-link-icon">📖</span>
            <span>完整文档</span>
          </a>
        </div>
      </div>
    `;

    modalBody.innerHTML = aboutHTML;

    currentCancelBtn.style.display = 'none';
    currentConfirmBtn.textContent = '关闭';

    confirmModal.classList.add('show');

    setTimeout(() => {
      const githubLink = document.getElementById('githubLink');
      const issuesLink = document.getElementById('issuesLink');
      const docsLink = document.getElementById('docsLink');

      if (githubLink) {
        githubLink.addEventListener('click', (e) => {
          e.preventDefault();
          chrome.tabs.create({ url: 'https://github.com/sycg767/PriceSyncPro' });
        });
      }

      if (issuesLink) {
        issuesLink.addEventListener('click', (e) => {
          e.preventDefault();
          chrome.tabs.create({ url: 'https://github.com/sycg767/PriceSyncPro/issues' });
        });
      }

      if (docsLink) {
        docsLink.addEventListener('click', (e) => {
          e.preventDefault();
          chrome.tabs.create({ url: 'https://github.com/sycg767/PriceSyncPro/blob/main/README.md' });
        });
      }
    }, 100);

    const newConfirmBtn = currentConfirmBtn.cloneNode(true);
    currentConfirmBtn.parentNode.replaceChild(newConfirmBtn, currentConfirmBtn);

    const handleClose = () => {
      confirmModal.classList.remove('show');
      confirmModal.removeEventListener('click', handleOverlayClick);

      modalBody.innerHTML = originalContent;
      currentCancelBtn.style.display = '';

      resolve(true);
    };

    newConfirmBtn.addEventListener('click', handleClose);

    const handleOverlayClick = (e) => {
      if (e.target === confirmModal) {
        handleClose();
      }
    };

    confirmModal.addEventListener('click', handleOverlayClick);
  });
}

// 显示状态消息
function showStatus(message, type = 'info') {
  statusDiv.className = `status-card show status-${type}`;
  // 将换行符转换为 <br> 标签以支持多行显示
  statusDiv.innerHTML = message.replace(/\n/g, '<br>');
}

// 进度条控制
const progressBar = document.getElementById('progressBar');
const progressBarFill = progressBar?.querySelector('.progress-bar-fill');
const progressBarText = progressBar?.querySelector('.progress-bar-text');

function showProgress(percent, text) {
  if (!progressBar) return;
  progressBar.style.display = 'block';
  if (progressBarFill) progressBarFill.style.width = `${percent}%`;
  if (progressBarText) progressBarText.textContent = text || `${percent}%`;
}

function hideProgress() {
  if (progressBar) progressBar.style.display = 'none';
}

// ========================================
// Content Script 通信增强
// ========================================

// 带重试的消息发送
async function sendMessageWithRetry(tabId, message, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      return { success: true, response };
    } catch (error) {
      if (i < maxRetries - 1) {
        // 等待后重试
        await new Promise(resolve => setTimeout(resolve, 500));

        // 尝试重新注入 content script
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['content.js']
          });
          await new Promise(resolve => setTimeout(resolve, 300));
        } catch (injectError) {
        }
      } else {
        // 最后一次失败
        return {
          success: false,
          error: '无法连接到页面脚本',
          needRefresh: true
        };
      }
    }
  }
}

/**
 * 确保 Content Script 已加载（按需注入）
 * @param {number} tabId - 标签页 ID
 * @returns {Promise<boolean>} 是否成功加载
 */
async function ensureContentScript(tabId) {
  try {
    // 先尝试发送一个测试消息
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    console.log('✓ Content Script 已存在');
    return true;
  } catch (error) {
    // 如果失败，尝试注入
    console.log('🔧 首次使用，正在注入 Content Script...');
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['content.js']
      });
      // 等待脚本初始化
      await new Promise(resolve => setTimeout(resolve, 500));

      // 验证注入成功
      try {
        await chrome.tabs.sendMessage(tabId, { action: 'ping' });
        console.log('✓ Content Script 注入成功');
        return true;
      } catch (verifyError) {
        console.error('❌ Content Script 注入后验证失败');
        return false;
      }
    } catch (injectError) {
      console.error('❌ Content Script 注入失败:', injectError);
      return false;
    }
  }
}

// 非对话模型的语义类型徽标文案（result.modelType -> 徽标文字）。
// 未登记的类型不显示徽标（对话语言模型不带 modelType，天然无徽标）
const TYPE_BADGE_LABELS = {
  embedding: '向量',
  rerank: '重排',
  tts: 'TTS',
  stt: 'STT',
  image: '图像',
  video: '视频',
  realtime: '实时'
};

// 渲染匹配结果表格（性能优化版：使用 DocumentFragment 批量插入）
// 已匹配行默认勾选并可勾选，未匹配行禁用勾选框、整行标灰；
// 带兜底候选的行（未匹配或已兜底）在"匹配到"列渲染候选下拉框，支持就地升级/降级
const formatPrice = (price) => {
  if (price == null) return '-';
  if (price === 0) return '$0';
  if (price >= 1) return `$${price.toFixed(2)}`;
  if (price >= 0.01) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(6)}`;
};

// 阈值 token 数展示为 "128k"/"1M" 这类简写
const formatTokens = (tokens) => {
  if (tokens == null) return '';
  if (tokens % 1000000 === 0) return `${tokens / 1000000}M`;
  if (tokens % 1000 === 0) return `${tokens / 1000}k`;
  return `${tokens}`;
};

// 价格单元格：主价格 + 次要信息行（缓存读写价格 / 长上下文分级价格），
// 次要信息默认可见（不再只靠 title 悬浮才能看到），title 同时保留完整信息作为补充
const buildPriceCell = (mainPrice, secondaryParts) => {
  const cell = document.createElement('td');
  cell.className = 'price-cell';

  const mainDiv = document.createElement('div');
  mainDiv.className = 'price-main';
  mainDiv.textContent = formatPrice(mainPrice);
  cell.appendChild(mainDiv);

  const validParts = (secondaryParts || []).filter(Boolean);
  if (validParts.length > 0) {
    const secondaryDiv = document.createElement('div');
    secondaryDiv.className = 'price-secondary';
    secondaryDiv.textContent = validParts.join(' · ');
    cell.title = validParts.join(' · ');
    cell.appendChild(secondaryDiv);
  }

  return cell;
};

// 兜底候选在下拉框里的单行文案：官方名 + 紧凑价格
function formatFallbackOptionLabel(candidate) {
  if (candidate.billingMode === 'flat') {
    return `${candidate.matchedName} · ${formatPrice(candidate.flatPrice)}${candidate.flatUnit === 'second' ? '/秒' : '/次'}`;
  }
  return `${candidate.matchedName} · ${formatPrice(candidate.promptPrice)}/${formatPrice(candidate.completionPrice)}`;
}

// 构建兜底候选下拉框。未匹配行：占位项选中、checkbox 禁用；已兜底行：当前候选选中，
// 首项提供"取消兜底"降级回未匹配。change 时经 applyFallbackSelection 就地更新行
function buildFallbackSelect(result, index) {
  const select = document.createElement('select');
  select.className = 'fallback-select';
  select.title = '兜底候选按名称包含关系推断（规则1：渠道名是官方名的一部分，短者优先；规则2：官方名是渠道名的一部分，长者优先），价格可能不精确，请人工核对';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = result.matched
    ? '取消兜底（恢复未匹配）'
    : `-- 手动选择候选 (${result.fallbackCandidates.length}) --`;
  select.appendChild(placeholder);

  result.fallbackCandidates.forEach((candidate, candidateIdx) => {
    const option = document.createElement('option');
    option.value = String(candidateIdx);
    option.textContent = formatFallbackOptionLabel(candidate);
    if (result.matched && candidate.matchedName === result.matchedName) {
      option.selected = true;
    }
    select.appendChild(option);
  });

  select.addEventListener('change', () => {
    const value = select.value;
    applyFallbackSelection(index, value === '' ? null : parseInt(value, 10));
  });

  // 阻止点击下拉框冒泡触发行级别的其他交互
  select.addEventListener('click', (e) => e.stopPropagation());

  return select;
}

// 把一条 result 渲染进一个（空的）tr：勾选框 / 模型名 / 匹配到 / 输入价 / 输出价。
// 初次全表渲染与兜底选择后的行级就地重渲染共用，保证两条路径产出的行完全一致
function fillMatchRow(row, result, index) {
  row.className = result.matched ? '' : 'row-unmatched';

  // 勾选框
  const checkboxCell = document.createElement('td');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'row-checkbox';
  checkbox.dataset.index = index;
  if (result.matched) {
    checkbox.checked = true;
    checkbox.addEventListener('change', () => {
      updateSelectAllState();
      updateSmartSyncButton();
    });
  } else {
    checkbox.disabled = true;
  }
  checkboxCell.appendChild(checkbox);
  row.appendChild(checkboxCell);

  // 模型名称（原样显示，绝不改写）
  const nameCell = document.createElement('td');
  nameCell.className = 'model-name';
  nameCell.textContent = result.modelName;
  nameCell.title = result.modelName;
  row.appendChild(nameCell);

  // 匹配到（官方）
  const matchedCell = document.createElement('td');
  const isFallback = result.source === 'fallback-auto' || result.source === 'fallback-manual';
  if (result.matched) {
    const nameSpan = document.createElement('span');
    nameSpan.textContent = result.matchedName;
    matchedCell.appendChild(nameSpan);
    matchedCell.title = result.source
      ? `${result.matchedName} · 来源: ${result.source}`
      : result.matchedName;
    if (result.modelType && TYPE_BADGE_LABELS[result.modelType]) {
      const typeBadge = document.createElement('span');
      typeBadge.className = 'mode-badge mode-type';
      typeBadge.textContent = TYPE_BADGE_LABELS[result.modelType];
      typeBadge.title = `模型类型：${TYPE_BADGE_LABELS[result.modelType]}（来自价格源的语义分类，仅供核对）`;
      matchedCell.appendChild(typeBadge);
    }
    if (result.billingMode === 'tiered') {
      const badge = document.createElement('span');
      badge.className = 'mode-badge mode-tiered';
      badge.textContent = '分级';
      badge.title = `长上下文分级计价，超过 ${formatTokens(result.longContextThreshold)} tokens 后价格变化`;
      matchedCell.appendChild(badge);
    }
    if (isFallback) {
      const badge = document.createElement('span');
      badge.className = 'mode-badge mode-fallback';
      badge.textContent = '兜底';
      badge.title = result.source === 'fallback-auto'
        ? '自动兜底：按名称包含关系自动选取的官方候选，价格可能不精确，请人工核对'
        : '手动兜底：用户从候选中手动选择的官方价格';
      matchedCell.appendChild(badge);
    }
  } else {
    const badge = document.createElement('span');
    badge.className = 'mode-badge mode-unmatched';
    badge.textContent = '未匹配';
    matchedCell.appendChild(badge);
  }
  // 有候选的行（未匹配待选，或已兜底可改选/取消）渲染下拉框
  if (Array.isArray(result.fallbackCandidates) && result.fallbackCandidates.length > 0 &&
      (!result.matched || isFallback)) {
    matchedCell.appendChild(buildFallbackSelect(result, index));
  }
  row.appendChild(matchedCell);

  let inputPriceCell;
  let outputPriceCell;

  if (result.matched && result.billingMode === 'flat') {
    // flatUnit: 'second' 是每秒基准价（视频任务，New API 按 价格×秒数×分辨率系数 计费），
    // 缺省 'call' 是每次整价（图像生成/按查询计价的重排等）
    const isPerSecond = result.flatUnit === 'second';
    inputPriceCell = buildPriceCell(result.flatPrice, [isPerSecond ? '/秒' : '/次']);
    inputPriceCell.title = isPerSecond
      ? '按秒计价（ModelPrice 填每秒基准价，New API 视频任务按 价格×秒数×分辨率系数 计费）'
      : '按次计价（ModelPrice），不使用 ModelRatio/CompletionRatio';
    outputPriceCell = document.createElement('td');
    outputPriceCell.className = 'price-cell';
    const badge = document.createElement('span');
    badge.className = 'mode-badge mode-flat';
    badge.textContent = isPerSecond ? '按秒' : '按次';
    outputPriceCell.appendChild(badge);
  } else if (result.matched) {
    const cacheParts = [];
    if (result.cacheReadPrice != null) cacheParts.push(`缓存读${formatPrice(result.cacheReadPrice)}`);
    if (result.cacheWritePrice != null) cacheParts.push(`缓存写${formatPrice(result.cacheWritePrice)}`);

    const inputSecondary = [...cacheParts];
    const outputSecondary = [];
    if (result.billingMode === 'tiered') {
      const thresholdLabel = formatTokens(result.longContextThreshold);
      inputSecondary.push(`>${thresholdLabel}: ${formatPrice(result.longContextPromptPrice)}`);
      outputSecondary.push(`>${thresholdLabel}: ${formatPrice(result.longContextCompletionPrice)}`);
      // 长上下文档的缓存价格（如有）：空间有限不单独占次要行，附加到超阈值价格项里
      if (result.longContextCacheReadPrice != null) {
        inputSecondary.push(`>${thresholdLabel}缓存读${formatPrice(result.longContextCacheReadPrice)}`);
      }
      if (result.longContextCacheWritePrice != null) {
        inputSecondary.push(`>${thresholdLabel}缓存写${formatPrice(result.longContextCacheWritePrice)}`);
      }
    }

    inputPriceCell = buildPriceCell(result.promptPrice, inputSecondary);
    outputPriceCell = buildPriceCell(result.completionPrice, outputSecondary);
  } else {
    inputPriceCell = buildPriceCell(null, []);
    outputPriceCell = buildPriceCell(null, []);
  }

  row.appendChild(inputPriceCell);
  row.appendChild(outputPriceCell);
}

// 应用/取消一条兜底选择：整体替换 currentMatchResults[index]（避免 flat/ratio 字段残留
// 混杂），并只重渲染该行（不整表重建，保护其他行的勾选状态与搜索过滤显隐）。
// candidateIdx 为 null 表示降级回未匹配（保留候选列表供再次选择）
function applyFallbackSelection(index, candidateIdx) {
  const current = currentMatchResults[index];
  if (!current || !Array.isArray(current.fallbackCandidates)) return;

  const fallbackCandidates = current.fallbackCandidates;
  if (candidateIdx == null) {
    currentMatchResults[index] = {
      modelName: current.modelName,
      matched: false,
      fallbackCandidates
    };
  } else {
    const candidate = fallbackCandidates[candidateIdx];
    if (!candidate) return;
    // 候选本身是完整的 result 形状（content.js buildResultFromMatch 产出），
    // 整体拷贝后仅替换 source 标记并保留候选列表供改选
    currentMatchResults[index] = {
      ...candidate,
      source: 'fallback-manual',
      fallbackCandidates
    };
  }

  // 就地重渲染该行（按 dataset.index 定位，搜索过滤的 display 状态保留在 tr 上不受影响）
  const checkbox = resultsTableBody.querySelector(`input.row-checkbox[data-index="${index}"]`);
  const row = checkbox && checkbox.closest('tr');
  if (row) {
    row.innerHTML = '';
    fillMatchRow(row, currentMatchResults[index], index);
  }

  updateResultsStats();
  updateSmartSyncButton();
  updateSelectAllState();
}

function renderMatchTable(results) {
  resultsTableBody.innerHTML = '';

  updateResultsStats();

  const fragment = document.createDocumentFragment();

  results.forEach((result, index) => {
    const row = document.createElement('tr');
    fillMatchRow(row, result, index);
    fragment.appendChild(row);
  });


  resultsTableBody.appendChild(fragment);

  updateSelectAllState();
  resultsSection.classList.add('show');
}

// 全选/全不选（只影响已匹配、可勾选的行）
if (selectAllCheckbox) {
  selectAllCheckbox.addEventListener('change', () => {
    const checked = selectAllCheckbox.checked;
    resultsTableBody.querySelectorAll('input.row-checkbox:not(:disabled)').forEach(checkbox => {
      checkbox.checked = checked;
    });
    updateSmartSyncButton();
  });
}

// 根据当前各行勾选状态同步"全选"表头勾选框的状态
function updateSelectAllState() {
  if (!selectAllCheckbox) return;
  const enabledCheckboxes = resultsTableBody.querySelectorAll('input.row-checkbox:not(:disabled)');
  if (enabledCheckboxes.length === 0) {
    selectAllCheckbox.checked = false;
    selectAllCheckbox.disabled = true;
    return;
  }
  selectAllCheckbox.disabled = false;
  const allChecked = Array.from(enabledCheckboxes).every(cb => cb.checked);
  selectAllCheckbox.checked = allChecked;
}

// ========================================
// 初始化：恢复保存的渠道选择，检测登录状态，加载渠道列表
// ========================================
chrome.storage.local.get(['channelId', 'autoFallback'], (result) => {
  // 恢复自动兜底开关状态（必须在触发任何分析之前，分析请求要带上这个标志）
  autoFallbackEnabled = result.autoFallback === true;
  if (autoFallbackToggle) autoFallbackToggle.checked = autoFallbackEnabled;

  updateSmartSyncButton();

  checkLoginStatus();

  loadChannelList().then(() => {
    if (result.channelId) {
      channelSelect.value = result.channelId;
      if (channelSelect.value === result.channelId) {
        analyzeSelectedChannel(result.channelId).then(() => updateSmartSyncButton());
      }
    }
  });
});
