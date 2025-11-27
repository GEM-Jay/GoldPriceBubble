// ========================================================
// manager.js  —— GoldPrice 管理界面主控制器（Tauri版）
// ========================================================

// 等待 Tauri API 加载
function waitForTauri(callback) {
  if (window.__TAURI__) {
    callback();
  } else {
    setTimeout(() => waitForTauri(callback), 50);
  }
}

let invoke, emit, httpFetch;
waitForTauri(() => {
  invoke = window.__TAURI__.tauri.invoke;
  emit = window.__TAURI__.event.emit;
  httpFetch = window.__TAURI__.http.fetch;
  
  // 在 Tauri API 加载后初始化应用
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
});

// ---------- 配置 ----------
const DEFAULT_API_URL = 'http://123.207.22.15:8081/api/latest/all';

// 金价固定顺序
const FIXED_ORDER = [
  'hf_GC',
  'hf_XAU',
  'gds_AUTD',
  'WG-XAUUSD',
  'SGE-Au(T+D)',
  '21001001000001',
  'CZB-JCJ',
  'CALC_NY_LON_DIFF',
  'CALC_NY_LON_DIFF_PCT',
];

// 货币单位
const CURRENCY_MAP = {
  gds_AUTD: '￥',
  'SGE-Au(T+D)': '￥',
  '21001001000001': '￥',
  'CZB-JCJ': '￥',
};

// 显示名称映射
const DISPLAY_NAME_MAP = {
  // 国际金价
  'hf_GC': '纽约金',
  'hf_XAU': '伦敦金',
  'WG-XAUUSD': '伦敦金_JD',
  'hf_XAG': '纽约银',
  'hf_SI': '纽约银',
  'hf_XPT': '纽约铂',
  'hf_XPD': '纽约钯',
  
  // 国内金价
  'gds_AUTD': '民生积存',
  'SGE-Au(T+D)': '上海黄金交易所金价',
  '21001001000001': '民生积存',
  'CZB-JCJ': '浙商积存',
  'ads_AGTD': '建设积存',
  
  // 计算值
  'CALC_NY_LON_DIFF': '纽轮差',
  'CALC_NY_LON_DIFF_PCT': '纽伦比',
};

// ========= 状态管理 =========
const state = {
  prices: [],
  selectedCodes: [],
  bubbleRows: 2,
  bubbleStealth: false,
  bubbleMinimal: false, // 0存在感模式
  bubbleTheme: 'light',
  bubbleThemeColor: 'blue',
  bubbleFontSize: 12,
  bubbleOpacity: 100,
  showPnl: false,
  selectedPnlWarehouses: [],
  refreshInterval: 2000,
  apiUrl: DEFAULT_API_URL,
  autoStart: false,
  showOnStart: false,
};

// ========== 工具函数 ==========
function getCurrency(code) {
  if (code === 'CALC_NY_LON_DIFF_PCT') return '%';
  return CURRENCY_MAP[code] || '$';
}

function getDisplayName(code, apiName) {
  // 优先使用预定义的中文名称，其次使用API返回的name，最后才用code
  return DISPLAY_NAME_MAP[code] || apiName || code;
}

function fmt(v, decimals = 2) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  const num = Number(v);
  return num.toFixed(decimals).replace(/\.?0+$/, '');
}

// ========= 仓库统计信息显示 =========
function updateWarehouseSummaryDisplay() {
  if (!window.warehouseModule || !window.warehouseModule.getWarehouseSummary) return;
  
  const summary = window.warehouseModule.getWarehouseSummary();
  const pnlSummaryEl = document.getElementById('pnl-summary');
  
  if (pnlSummaryEl) {
    const pnlClass = summary.totalPnl >= 0 ? 'positive' : 'negative';
    pnlSummaryEl.innerHTML = `
      <span class="summary-inline-item">总仓营收: <span class="summary-inline-value ${pnlClass}">${summary.totalPnl >= 0 ? '+' : ''}${fmt(summary.totalPnl, 2)}¥</span></span>
      <span class="summary-inline-divider">|</span>
      <span class="summary-inline-item">总仓克重: <span class="summary-inline-value">${fmt(summary.totalGrams, 2)}g</span></span>
      <span class="summary-inline-divider">|</span>
      <span class="summary-inline-item">总仓市值: <span class="summary-inline-value">${fmt(summary.totalValue, 2)}¥</span></span>
      <span class="summary-inline-divider">|</span>
      <span class="summary-inline-item">总仓成本: <span class="summary-inline-value">${fmt(summary.totalCost, 2)}¥</span></span>
    `;
    pnlSummaryEl.className = 'pnl-summary pnl-summary-inline';
  }
}

// 使函数全局可用
window.updateWarehouseSummaryDisplay = updateWarehouseSummaryDisplay;

// ========== 数据持久化 ==========
function loadState() {
  try {
    state.selectedCodes = JSON.parse(localStorage.getItem('selectedCodes') || '[]');
    state.bubbleRows = parseInt(localStorage.getItem('bubbleRows') || '2');
    state.bubbleStealth = localStorage.getItem('bubbleStealth') === 'true';
    state.bubbleMinimal = localStorage.getItem('bubbleMinimal') === 'true';
    state.bubbleTheme = localStorage.getItem('bubbleTheme') || 'light';
    state.bubbleThemeColor = localStorage.getItem('bubbleThemeColor') || 'blue';
    state.bubbleFontSize = parseInt(localStorage.getItem('bubbleFontSize') || '12');
    state.bubbleOpacity = parseInt(localStorage.getItem('bubbleOpacity') || '100');
    state.showPnl = localStorage.getItem('showPnl') === 'true';
    state.selectedPnlWarehouses = JSON.parse(localStorage.getItem('pnl_selected_warehouses') || '[]');
    state.refreshInterval = parseInt(localStorage.getItem('refreshInterval') || '2000');
    state.apiUrl = localStorage.getItem('apiUrl') || DEFAULT_API_URL;
    state.autoStart = localStorage.getItem('autoStart') === 'true';
    state.showOnStart = localStorage.getItem('showOnStart') === 'true';
  } catch (err) {
    console.error('加载配置失败:', err);
  }
}

async function saveState() {
  try {
    localStorage.setItem('selectedCodes', JSON.stringify(state.selectedCodes));
    localStorage.setItem('bubbleRows', state.bubbleRows.toString());
    localStorage.setItem('bubbleStealth', state.bubbleStealth.toString());
    localStorage.setItem('bubbleMinimal', state.bubbleMinimal.toString());
    localStorage.setItem('bubbleTheme', state.bubbleTheme);
    localStorage.setItem('bubbleThemeColor', state.bubbleThemeColor);
    localStorage.setItem('bubbleFontSize', state.bubbleFontSize.toString());
    localStorage.setItem('bubbleOpacity', state.bubbleOpacity.toString());
    localStorage.setItem('showPnl', state.showPnl.toString());
    localStorage.setItem('pnl_selected_warehouses', JSON.stringify(state.selectedPnlWarehouses));
    localStorage.setItem('refreshInterval', state.refreshInterval.toString());
    localStorage.setItem('apiUrl', state.apiUrl);
    localStorage.setItem('autoStart', state.autoStart.toString());
    localStorage.setItem('showOnStart', state.showOnStart.toString());

    // 通知气泡窗口更新 (Tauri)
    try {
      await invoke('notify_bubble', { message: 'config-update' });
    } catch (err) {
      console.error('Failed to notify bubble:', err);
    }
  } catch (err) {
    console.error('保存配置失败:', err);
  }
}

// ========== 价格数据处理 ==========
function calcNY_LON_DIFF(prices) {
  const ny = prices.find(p => p.code === 'hf_GC');
  const lon = prices.find(p => p.code === 'hf_XAU');
  if (ny && lon) {
    return { code: 'CALC_NY_LON_DIFF', value: ny.value - lon.value, name: '纽约伦敦金价差额' };
  }
  return null;
}

function calcNY_LON_DIFF_PCT(prices) {
  const ny = prices.find(p => p.code === 'hf_GC');
  const lon = prices.find(p => p.code === 'hf_XAU');
  if (ny && lon && lon.value !== 0) {
    const pct = ((ny.value - lon.value) / lon.value) * 100;
    return { code: 'CALC_NY_LON_DIFF_PCT', value: pct, name: '纽约伦敦金价差额(%)' };
  }
  return null;
}

async function fetchPrices() {
  try {
    console.log('开始获取价格数据...');
    // 使用 Tauri 的 HTTP 客户端避免 CORS 问题
    const response = await httpFetch(state.apiUrl, {
      method: 'GET',
      timeout: 30,
    });
    
    console.log('API响应状态:', response.status);
    if (response.status !== 200) throw new Error('API 请求失败');
    const data = response.data;
    console.log('获取到的数据:', data);
    
    // 转换数据格式 - API返回的是数组 [{code, name, price, ...}]
    let prices = Array.isArray(data) 
      ? data.map(item => ({
          code: item.code,
          value: item.price,
          name: item.name
        }))
      : Object.keys(data).map(code => ({
          code,
          value: data[code],
          name: code
        }));

    // 计算衍生价格
    const diff = calcNY_LON_DIFF(prices);
    const diffPct = calcNY_LON_DIFF_PCT(prices);
    if (diff) prices.push(diff);
    if (diffPct) prices.push(diffPct);

    // 过滤掉黄金延期
    prices = prices.filter(p => p.code !== 'SGE-Au(T+D)_delta');

    // 排序
    prices.sort((a, b) => {
      const idxA = FIXED_ORDER.indexOf(a.code);
      const idxB = FIXED_ORDER.indexOf(b.code);
      if (idxA === -1 && idxB === -1) return 0;
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });

    console.log('处理后的价格数组长度:', prices.length);
    state.prices = prices;
    console.log('state.prices已更新，长度:', state.prices.length);
    renderPriceList();
    console.log('renderPriceList已调用');
    
    // 静默更新状态点，不显示文字避免抖动
    const statusDot = document.getElementById('status-dot');
    if (statusDot) {
      statusDot.className = 'status-dot online';
    }
    
    // 通知仓库模块更新价格
    if (window.warehouseModule) {
      window.warehouseModule.updatePrices(prices);
      // 实时更新仓库详情中的动态数据（价格、盈亏、市值）
      if (window.warehouseModule.updateWarehouseRealTimeData) {
        window.warehouseModule.updateWarehouseRealTimeData();
      }
    }
    
    return prices;
  } catch (err) {
    console.error('获取价格失败:', err);
    console.error('错误详情:', err.message, err.stack);
    
    // 显示错误提示
    alert(`价格数据获取失败: ${err.message}\n\n请检查:\n1. 网络连接是否正常\n2. API地址是否正确: ${state.apiUrl}`);
    
    // 静默更新状态点，不显示文字避免抖动
    const statusDot = document.getElementById('status-dot');
    if (statusDot) {
      statusDot.className = 'status-dot offline';
    }
    
    return [];
  }
}

// updateStatus函数已废弃，直接在fetchPrices中静默更新status-dot，避免文字抖动

// ========== 页面导航 ==========
function switchView(viewId) {
  // 添加 view- 前缀（如果没有的话）
  const fullViewId = viewId.startsWith('view-') ? viewId : `view-${viewId}`;
  
  // 隐藏所有视图
  document.querySelectorAll('.view').forEach(view => {
    view.classList.remove('active');
  });
  
  // 取消所有导航项的激活状态
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
  });
  
  // 激活目标视图
  const targetView = document.getElementById(fullViewId);
  if (targetView) {
    targetView.classList.add('active');
  }
  
  // 激活对应的导航项
  const navItem = document.querySelector(`[data-view="${viewId}"]`);
  if (navItem) {
    navItem.classList.add('active');
  }

  // 更新页面标题
  const titles = {
    'view-prices': '价格选择',
    'prices': '价格选择',
    'view-store': '仓库管理',
    'store': '仓库管理',
    'view-bubble-style': '气泡设置',
    'bubble-style': '气泡设置',
    'view-settings': '应用设置',
    'settings': '应用设置'
  };
  const pageTitle = document.getElementById('page-title');
  if (pageTitle) {
    pageTitle.textContent = titles[fullViewId] || titles[viewId] || 'GoldPrice';
  }

  // 如果切换到仓库管理页面，更新统计信息
  if (fullViewId === 'view-store' || viewId === 'store') {
    updateWarehouseSummaryDisplay();
  }
}

// ========== 价格选择页面 ==========
function renderPriceList() {
  console.log('renderPriceList被调用, state.prices长度:', state.prices.length);
  const container = document.getElementById('price-select-list');
  if (!container) {
    console.error('找不到price-select-list容器');
    return;
  }

  // 如果是首次渲染或价格数量变化，完全重新渲染
  const existingCards = container.querySelectorAll('.price-card');
  if (existingCards.length !== state.prices.length) {
    container.innerHTML = state.prices.map(price => {
      const isSelected = state.selectedCodes.includes(price.code);
      const displayName = getDisplayName(price.code, price.name);
      const currency = getCurrency(price.code);
      const value = fmt(price.value, 2);
      
      return `
        <div class="price-card ${isSelected ? 'selected' : ''}" data-code="${price.code}">
          <input type="checkbox" 
                 class="price-checkbox" 
                 id="price-${price.code}" 
                 ${isSelected ? 'checked' : ''}
                 onchange="togglePriceSelection('${price.code}')">
          <label for="price-${price.code}" class="price-card-label">
            <div class="price-card-left">
              <div class="price-card-name">${displayName}</div>
              
            </div>
            <div class="price-card-right">
              <div class="price-card-value" data-code="${price.code}">${value}</div>
              <div class="price-card-currency">${currency}</div>
            </div>
          </label>
        </div>
      `;
    }).join('');
  } else {
    // 只更新价格数值和选中状态
    state.prices.forEach(price => {
      const card = container.querySelector(`.price-card[data-code="${price.code}"]`);
      if (card) {
        const valueElement = card.querySelector('.price-card-value');
        const checkbox = card.querySelector('.price-checkbox');
        const isSelected = state.selectedCodes.includes(price.code);
        
        if (valueElement) {
          const newValue = fmt(price.value, 2);
          if (valueElement.textContent !== newValue) {
            valueElement.textContent = newValue;
            // 不添加价格变化动画
          }
        }
        
        if (checkbox) {
          checkbox.checked = isSelected;
        }
        
        if (isSelected) {
          card.classList.add('selected');
        } else {
          card.classList.remove('selected');
        }
      }
    });
  }

  updatePriceSelectionUI();
}

function togglePriceSelection(code) {
  const index = state.selectedCodes.indexOf(code);
  
  if (index > -1) {
    // 取消选择
    state.selectedCodes.splice(index, 1);
  } else {
    // 添加选择（检查行数限制）
    if (state.selectedCodes.length >= state.bubbleRows) {
      alert(`最多只能选择 ${state.bubbleRows} 个价格`);
      // 恢复checkbox状态
      const checkbox = document.getElementById(`price-${code}`);
      if (checkbox) checkbox.checked = false;
      return;
    }
    state.selectedCodes.push(code);
  }

  saveState();
  renderPriceList();
  renderPreview();
}

function updatePriceSelectionUI() {
  const selectedCount = document.getElementById('selected-count');
  const rowsLimit = document.getElementById('rows-limit');
  
  if (selectedCount) {
    selectedCount.textContent = state.selectedCodes.length;
  }
  if (rowsLimit) {
    rowsLimit.textContent = state.bubbleRows;
  }
}

function deselectAll() {
  state.selectedCodes = [];
  saveState();
  renderPriceList();
  renderPreview();
}

// ========== 仓库管理页面 ==========
function renderWarehousePnlList() {
  const container = document.getElementById('pnl-warehouse-select');
  if (!container) return;

  const warehouses = loadWarehouses();
  
  container.innerHTML = `
    <div class="pnl-item">
      <input type="checkbox" 
             id="pnl-__total__" 
             ${state.selectedPnlWarehouses.includes('__total__') ? 'checked' : ''}
             onchange="togglePnlWarehouse('__total__')">
      <label for="pnl-__total__">总仓营收</label>
    </div>
    ${warehouses.map(w => `
      <div class="pnl-item">
        <input type="checkbox" 
               id="pnl-${w.id}" 
               ${state.selectedPnlWarehouses.includes(w.id) ? 'checked' : ''}
               onchange="togglePnlWarehouse('${w.id}')">
        <label for="pnl-${w.id}">${w.name}</label>
      </div>
    `).join('')}
  `;
}

function togglePnlWarehouse(id) {
  const index = state.selectedPnlWarehouses.indexOf(id);
  
  if (index > -1) {
    // 取消选中
    state.selectedPnlWarehouses.splice(index, 1);
  } else {
    // 添加选中（最多3个）
    if (state.selectedPnlWarehouses.length >= 3) {
      alert('最多只能选择3个仓库盈亏');
      // 恢复checkbox状态
      const checkbox = document.getElementById(`pnl-${id}`);
      if (checkbox) checkbox.checked = false;
      return;
    }
    state.selectedPnlWarehouses.push(id);
  }

  saveState();
  renderWarehousePnlList();
  renderPreview();
}

function loadWarehouses() {
  try {
    const raw = localStorage.getItem('warehouses');
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error('加载仓库失败:', err);
    return [];
  }
}

function updatePnlSummary() {
  // 此函数已被 updateWarehouseSummaryDisplay 替代
  // 调用新的统计显示函数
  updateWarehouseSummaryDisplay();
}

// 更新滑动条进度填充
function updateRangeProgress(input) {
  const value = input.value;
  const min = input.min || 0;
  const max = input.max || 100;
  const percentage = ((value - min) / (max - min)) * 100;
  input.style.setProperty('--range-progress', `${percentage}%`);
}

// ========== 气泡设置页面 ==========
function setupBubbleSettings() {
  // 字体大小
  const fontSizeInput = document.getElementById('font-size-bubble');
  const fontSizeValue = document.getElementById('font-size-value');
  if (fontSizeInput && fontSizeValue) {
    fontSizeInput.value = state.bubbleFontSize;
    fontSizeValue.textContent = state.bubbleFontSize;
    updateRangeProgress(fontSizeInput);
    fontSizeInput.addEventListener('input', (e) => {
      state.bubbleFontSize = parseInt(e.target.value);
      fontSizeValue.textContent = state.bubbleFontSize;
      updateRangeProgress(e.target);
      saveState();
      renderPreview();
    });
  }

  // 透明度
  const opacityInput = document.getElementById('bubble-opacity');
  const opacityValue = document.getElementById('opacity-value');
  if (opacityInput && opacityValue) {
    opacityInput.value = state.bubbleOpacity;
    opacityValue.textContent = state.bubbleOpacity + '%';
    updateRangeProgress(opacityInput);
    opacityInput.addEventListener('input', (e) => {
      state.bubbleOpacity = parseInt(e.target.value);
      opacityValue.textContent = state.bubbleOpacity + '%';
      updateRangeProgress(e.target);
      saveState();
      renderPreview();
    });
  }

  // 行数
  const rowsInput = document.getElementById('bubble-rows');
  const rowsLabel = document.getElementById('bubble-rows-label');
  if (rowsInput && rowsLabel) {
    rowsInput.value = state.bubbleRows;
    rowsLabel.textContent = state.bubbleRows;
    updateRangeProgress(rowsInput);
    rowsInput.addEventListener('input', (e) => {
      const newRows = parseInt(e.target.value);
      const oldRows = state.bubbleRows;
      state.bubbleRows = newRows;
      rowsLabel.textContent = state.bubbleRows;
      updateRangeProgress(e.target);
      
      // 如果减少行数，自动取消最后选中的价格
      if (newRows < oldRows && state.selectedCodes.length > newRows) {
        // 保留最早选中的，移除最后选中的
        state.selectedCodes = state.selectedCodes.slice(0, newRows);
        renderPriceList();
      }
      
      saveState();
      updatePriceSelectionUI();
      renderPreview();
    });
  }

  // 主题配色
  const themeColorSelect = document.getElementById('theme-color-select');
  if (themeColorSelect) {
    themeColorSelect.value = state.bubbleThemeColor;
    themeColorSelect.addEventListener('change', (e) => {
      state.bubbleThemeColor = e.target.value;
      document.body.setAttribute('data-theme-color', state.bubbleThemeColor);
      saveState();
      renderPreview();
    });
  }

  // 隐身模式（摸鱼模式）
  const stealthCheckbox = document.getElementById('bubble-stealth');
  if (stealthCheckbox) {
    stealthCheckbox.checked = state.bubbleStealth;
    stealthCheckbox.addEventListener('change', (e) => {
      state.bubbleStealth = e.target.checked;
      // 摸鱼模式和0存在感模式互斥
      if (e.target.checked) {
        state.bubbleMinimal = false;
        const minimalCheckbox = document.getElementById('bubble-minimal');
        if (minimalCheckbox) minimalCheckbox.checked = false;
      }
      saveState();
      renderPreview();
    });
  }

  // 0存在感模式
  const minimalCheckbox = document.getElementById('bubble-minimal');
  
  if (minimalCheckbox) {
    minimalCheckbox.checked = state.bubbleMinimal;
    
    minimalCheckbox.addEventListener('change', (e) => {
      state.bubbleMinimal = e.target.checked;
      // 0存在感模式和摸鱼模式互斥
      if (e.target.checked) {
        state.bubbleStealth = false;
        const stealthCheckbox = document.getElementById('bubble-stealth');
        if (stealthCheckbox) stealthCheckbox.checked = false;
      }
      
      saveState();
      renderPreview();
    });
  }

  // 显示盈亏
  const pnlCheckbox = document.getElementById('show-pnl');
  if (pnlCheckbox) {
    pnlCheckbox.checked = state.showPnl;
    pnlCheckbox.addEventListener('change', (e) => {
      state.showPnl = e.target.checked;
      const pnlSelectDiv = document.getElementById('pnl-warehouse-select');
      if (pnlSelectDiv) {
        pnlSelectDiv.style.display = e.target.checked ? 'block' : 'none';
      }
      saveState();
      renderPreview();
    });
    
    // 初始化时根据状态显示/隐藏仓库选择
    const pnlSelectDiv = document.getElementById('pnl-warehouse-select');
    if (pnlSelectDiv) {
      pnlSelectDiv.style.display = state.showPnl ? 'block' : 'none';
    }
  }
}

// ========== 应用设置页面 ==========
function setupAppSettings() {
  // 开机自启
  const autoStartCheckbox = document.getElementById('auto-start');
  if (autoStartCheckbox) {
    autoStartCheckbox.checked = state.autoStart;
    autoStartCheckbox.addEventListener('change', async (e) => {
      state.autoStart = e.target.checked;
      await saveState();
      try {
        await invoke('set_auto_start', { enabled: state.autoStart });
      } catch (err) {
        console.error('Failed to set auto start:', err);
      }
    });
  }

  // 启动时显示气泡
  const showOnStartCheckbox = document.getElementById('show-on-start');
  if (showOnStartCheckbox) {
    showOnStartCheckbox.checked = state.showOnStart;
    showOnStartCheckbox.addEventListener('change', (e) => {
      state.showOnStart = e.target.checked;
      saveState();
    });
  }

  // 刷新间隔
  const refreshInput = document.getElementById('refresh-interval');
  if (refreshInput) {
    // 显示为秒，但内部存储为毫秒
    refreshInput.value = Math.floor(state.refreshInterval / 1000);
    refreshInput.addEventListener('change', (e) => {
      // 将秒转换为毫秒存储
      state.refreshInterval = parseInt(e.target.value) * 1000;
      saveState();
      // 重新启动定时器
      if (window.priceUpdateInterval) {
        clearInterval(window.priceUpdateInterval);
      }
      window.priceUpdateInterval = setInterval(async () => {
        await fetchPrices();
        renderPriceList();
        updateWarehouseSummaryDisplay();
        updatePnlSummary();
        renderPreview();
      }, state.refreshInterval);
    });
  }

  // 数据管理按钮
  const exportBtn = document.getElementById('export-data-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportData);
  }

  const importBtn = document.getElementById('import-data-btn');
  if (importBtn) {
    importBtn.addEventListener('click', importData);
  }

  const resetBtn = document.getElementById('reset-data-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', resetData);
  }
}

function exportData() {
  try {
    const data = {
      version: '1.0',
      timestamp: Date.now(),
      config: { ...state },
      warehouses: loadWarehouses()
    };
    
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `goldprice-backup-${Date.now()}.json`;
    a.click();
    
    URL.revokeObjectURL(url);
    alert('数据导出成功！');
  } catch (err) {
    console.error('导出失败:', err);
    alert('数据导出失败！');
  }
}

function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target.result);
        
        // 恢复配置
        Object.assign(state, data.config);
        saveState();
        
        // 恢复仓库
        if (data.warehouses) {
          localStorage.setItem('warehouses', JSON.stringify(data.warehouses));
        }
        
        alert('数据导入成功！页面即将刷新。');
        location.reload();
      } catch (err) {
        console.error('导入失败:', err);
        alert('数据导入失败！文件格式错误。');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

async function resetData() {
  if (!confirm('确定要清除所有数据并退出吗？此操作不可恢复！')) {
    return;
  }
  
  localStorage.clear();
  try {
    await invoke('quit_app');
  } catch (err) {
    console.error('Failed to quit app:', err);
  }
}

// ========== 主题切换 ==========
function setupTheme() {
  // 应用主题
  document.body.setAttribute('data-theme', state.bubbleTheme);
  
  // 日夜切换按钮
  const themeToggle = document.getElementById('theme-toggle');
  if (!themeToggle) return;
  
  const mainButton = themeToggle.querySelector('.theme-main-button');
  const daytimeBackground = themeToggle.querySelectorAll('.theme-daytime-background');
  const cloud = themeToggle.querySelector('.theme-cloud');
  const cloudLight = themeToggle.querySelector('.theme-cloud-light');
  const moon = themeToggle.querySelectorAll('.theme-moon');
  const stars = themeToggle.querySelector('.theme-stars');
  const cloudSons = themeToggle.querySelectorAll('.theme-cloud-son');
  
  let isMoved = false;
  let isClicked = false;
  
  // 云朵随机移动动画
  const getRandomDirection = () => {
    const directions = ['1.5px', '-1.5px'];
    return directions[Math.floor(Math.random() * directions.length)];
  };
  
  const moveElementRandomly = (element) => {
    const randomDirectionX = getRandomDirection();
    const randomDirectionY = getRandomDirection();
    element.style.transform = `translate(${randomDirectionX}, ${randomDirectionY})`;
  };
  
  setInterval(() => {
    cloudSons.forEach(moveElementRandomly);
  }, 1000);
  
  // 切换到dark/light
  const switchToDark = () => {
    mainButton.style.transform = 'translateX(33px)';
    mainButton.style.backgroundColor = 'rgba(195, 200, 210, 1)';
    mainButton.style.boxShadow = '1px 1px 2px rgba(0, 0, 0, 0.5), inset -1px -2px 1px -1px rgba(0, 0, 0, 0.5), inset 2px 2px 1px -1px rgba(255, 255, 210, 1)';
    daytimeBackground[0].style.transform = 'translateX(33px)';
    daytimeBackground[1].style.transform = 'translateX(24px)';
    daytimeBackground[2].style.transform = 'translateX(15px)';
    cloud.style.transform = 'translateY(24px)';
    cloudLight.style.transform = 'translateY(24px)';
    themeToggle.style.backgroundColor = 'rgba(25, 30, 50, 1)';
    moon[0].style.opacity = '1';
    moon[1].style.opacity = '1';
    moon[2].style.opacity = '1';
    stars.style.transform = 'translateY(-18px)';
    stars.style.opacity = '1';
    isMoved = true;
  };
  
  const switchToLight = () => {
    mainButton.style.transform = 'translateX(0)';
    mainButton.style.backgroundColor = 'rgba(255, 195, 35, 1)';
    mainButton.style.boxShadow = '1px 1px 2px rgba(0, 0, 0, 0.5), inset -1px -2px 1px -1px rgba(0, 0, 0, 0.5), inset 2px 2px 1px -1px rgba(255, 230, 80, 1)';
    daytimeBackground[0].style.transform = 'translateX(0)';
    daytimeBackground[1].style.transform = 'translateX(0)';
    daytimeBackground[2].style.transform = 'translateX(0)';
    cloud.style.transform = 'translateY(4px)';
    cloudLight.style.transform = 'translateY(4px)';
    themeToggle.style.backgroundColor = 'rgba(70, 133, 192, 1)';
    moon[0].style.opacity = '0';
    moon[1].style.opacity = '0';
    moon[2].style.opacity = '0';
    stars.style.transform = 'translateY(-50px)';
    stars.style.opacity = '0';
    isMoved = false;
  };
  
  // 初始化状态
  if (state.bubbleTheme === 'dark') {
    switchToDark();
  }
  
  // 点击切换
  themeToggle.addEventListener('click', () => {
    if (isMoved) {
      switchToLight();
      state.bubbleTheme = 'light';
    } else {
      switchToDark();
      state.bubbleTheme = 'dark';
    }
    
    isClicked = true;
    setTimeout(() => {
      isClicked = false;
    }, 500);
    
    saveState();
    document.body.setAttribute('data-theme', state.bubbleTheme);
    renderPreview();
  });
  
  // Hover效果
  mainButton.addEventListener('mouseenter', () => {
    if (isClicked) return;
    if (isMoved) {
      mainButton.style.transform = 'translateX(30px)';
      daytimeBackground[0].style.transform = 'translateX(30px)';
      daytimeBackground[1].style.transform = 'translateX(22px)';
      daytimeBackground[2].style.transform = 'translateX(14px)';
    } else {
      mainButton.style.transform = 'translateX(3px)';
      daytimeBackground[0].style.transform = 'translateX(3px)';
      daytimeBackground[1].style.transform = 'translateX(2px)';
      daytimeBackground[2].style.transform = 'translateX(1px)';
    }
  });
  
  mainButton.addEventListener('mouseleave', () => {
    if (isClicked) return;
    if (isMoved) {
      mainButton.style.transform = 'translateX(33px)';
      daytimeBackground[0].style.transform = 'translateX(33px)';
      daytimeBackground[1].style.transform = 'translateX(24px)';
      daytimeBackground[2].style.transform = 'translateX(15px)';
    } else {
      mainButton.style.transform = 'translateX(0)';
      daytimeBackground[0].style.transform = 'translateX(0)';
      daytimeBackground[1].style.transform = 'translateX(0)';
      daytimeBackground[2].style.transform = 'translateX(0)';
    }
  });
}

// ========== 气泡预览 ==========
function renderPreview() {
  const preview = document.getElementById('bubble-preview');
  if (!preview) return;

  // 获取选中的价格
  const selectedPrices = state.prices.filter(p => state.selectedCodes.includes(p.code));
  
  // 获取选中的仓库盈亏
  const warehouses = loadWarehouses();
  const selectedPnls = [];
  
  if (state.showPnl && state.selectedPnlWarehouses.length > 0) {
    // 计算总仓营收
    if (state.selectedPnlWarehouses.includes('__total__')) {
      let totalPnl = 0;
      warehouses.forEach(w => {
        const priceObj = state.prices.find(p => p.code === w.refPrice);
        const currentPrice = priceObj?.value || 0;
        const currentValue = w.totalGrams * currentPrice;
        const pnl = currentValue - (w.totalCost || 0);
        
        if (getCurrency(w.refPrice) === '￥') {
          totalPnl += pnl;
        }
      });
      selectedPnls.push({ name: '总仓营收', pnl: totalPnl, currency: '￥' });
    }
    
    // 各个仓库的盈亏
    state.selectedPnlWarehouses.forEach(id => {
      if (id === '__total__') return;
      
      const warehouse = warehouses.find(w => w.id === id);
      if (!warehouse) return;
      
      const priceObj = state.prices.find(p => p.code === warehouse.refPrice);
      const currentPrice = priceObj?.value || 0;
      const currentValue = warehouse.totalGrams * currentPrice;
      const pnl = currentValue - (warehouse.totalCost || 0);
      
      selectedPnls.push({ name: warehouse.name, pnl, currency: '￥' });
    });
  }

  // 构建预览内容，模拟真实气泡样式
  let previewClass = '';
  if (state.bubbleStealth) previewClass = 'stealth';
  if (state.bubbleMinimal) previewClass = 'minimal';
  const themeColor = state.bubbleThemeColor || 'blue';
  
  preview.className = 'bubble-preview-content ' + previewClass;
  preview.setAttribute('data-theme', state.bubbleTheme);
  preview.setAttribute('data-theme-color', themeColor);
  preview.style.fontSize = state.bubbleFontSize + 'px';
  preview.style.opacity = state.bubbleOpacity / 100;
  
  preview.innerHTML = `
    <div class="preview-header">
      <span class="preview-title">预览效果</span>
      <span class="status-dot online"></span>
    </div>
    ${selectedPrices.map(price => {
      const displayName = getDisplayName(price.code, price.name);
      const shortName = displayName.length > 4 ? displayName.substring(0, 4) : displayName;
      return `
        <div class="preview-line">
          <span class="preview-name">${shortName}</span>
          <span class="preview-value">${fmt(price.value, 2)} ${getCurrency(price.code)}</span>
        </div>
      `;
    }).join('')}
    ${selectedPnls.length > 0 ? `
      <div class="preview-separator"></div>
      ${selectedPnls.map(item => {
        const shortName = item.name.length > 4 ? item.name.substring(0, 4) : item.name;
        return `
          <div class="preview-line pnl ${item.pnl >= 0 ? 'profit' : 'loss'}">
            <span class="preview-name">${shortName}</span>
            <span class="preview-value">${item.pnl >= 0 ? '+' : ''}${fmt(item.pnl, 2)} ${item.currency || '￥'}</span>
          </div>
        `;
      }).join('')}
    ` : ''}
  `;
}

// ========== 初始化 ==========
async function init() {
  // 加载配置
  loadState();
  
  // 设置主题和主题配色
  document.body.setAttribute('data-theme', state.bubbleTheme);
  document.body.setAttribute('data-theme-color', state.bubbleThemeColor || 'blue');
  setupTheme();
  
  // 获取价格数据
  await fetchPrices();
  
  // 渲染各个页面
  renderPriceList();
  renderWarehousePnlList();
  updatePnlSummary();
  setupBubbleSettings();
  setupAppSettings();
  renderPreview();
  
  // 渲染仓库列表
  if (window.warehouseModule) {
    window.warehouseModule.renderWarehouseList();
  }
  
  // 初始化统计信息显示
  setTimeout(() => {
    updateWarehouseSummaryDisplay();
  }, 500);
  
  // 设置导航
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const viewId = item.dataset.view;
      if (viewId) {
        switchView(viewId);
      }
    });
  });
  
  // 刷新按钮
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      await fetchPrices();
      renderPriceList();
      updatePnlSummary();
      renderPreview();
    });
  }
  
  // 取消全选按钮
  const deselectAllBtn = document.getElementById('deselect-all-btn');
  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', deselectAll);
  }
  
  // 新建仓库按钮
  const newWarehouseBtn = document.getElementById('new-warehouse-btn');
  if (newWarehouseBtn) {
    newWarehouseBtn.addEventListener('click', () => {
      if (window.warehouseModule) {
        window.warehouseModule.showNewWarehouseForm();
      }
    });
  }
  
  // 监听仓库变化
  window.addEventListener('warehousesChanged', () => {
    renderWarehousePnlList();
    updatePnlSummary();
    renderPreview();
  });
  
  // 清除全部数据并退出按钮
  const clearAndQuitBtn = document.getElementById('clear-and-quit-btn');
  if (clearAndQuitBtn) {
    clearAndQuitBtn.addEventListener('click', async () => {
      const confirmed = confirm('⚠️ 警告：清除全部数据并退出\n\n确定要清除所有数据并退出应用吗？\n\n此操作不可撤销，将删除：\n✓ 所有仓库数据\n✓ 所有交易记录\n✓ 所有配置设置\n\n应用将恢复到默认初始状态。');
      
      if (confirmed) {
        try {
          // 清除所有 localStorage 数据
          localStorage.clear();
          
          // 调用后端清除文件数据并退出
          await invoke('clear_all_data_and_quit');
        } catch (err) {
          console.error('清除数据失败:', err);
          alert('清除数据失败: ' + err.message);
        }
      }
    });
  }
  
  // 定时刷新价格
  setInterval(async () => {
    await fetchPrices();
    renderPriceList();
    updatePnlSummary();
    renderPreview();
  }, state.refreshInterval);
}

// ========== 全局函数（供 HTML onclick 调用）==========
window.togglePriceSelection = togglePriceSelection;
window.togglePnlWarehouse = togglePnlWarehouse;
