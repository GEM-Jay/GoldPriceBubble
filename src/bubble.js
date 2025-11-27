// =========================
// bubble.js - 气泡窗口渲染（Tauri版）
// =========================

// 等待 Tauri API 加载
function waitForTauri(callback) {
  if (window.__TAURI__) {
    callback();
  } else {
    setTimeout(() => waitForTauri(callback), 50);
  }
}

let invoke, listen, httpFetch;
waitForTauri(() => {
  invoke = window.__TAURI__.tauri.invoke;
  listen = window.__TAURI__.event.listen;
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
  'SGE-Au(T+D)': '上海金',
  '21001001000001': '民生积存',
  'CZB-JCJ': '浙商积存',
  'ads_AGTD': '建设积存',
  
  // 计算值
  'CALC_NY_LON_DIFF': '金价差额(纽约 - 伦敦)',
  'CALC_NY_LON_DIFF_PCT': '金价差异率(%)',
};

// ========= 状态管理 =========
const state = {
  prices: [],
  oldPrices: {},
  selectedCodes: ['hf_XAU', 'SGE-Au(T+D)'], // 默认勾选伦敦金和上海金
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

// ========== 数据持久化 ==========
function loadConfig() {
  try {
    // 如果是首次使用（没有 selectedCodes），保留默认值
    const savedCodes = localStorage.getItem('selectedCodes');
    if (savedCodes !== null) {
      state.selectedCodes = JSON.parse(savedCodes);
    }
    
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
    state.showOnStart = localStorage.getItem('showOnStart') === 'true';
  } catch (err) {
    console.error('加载配置失败:', err);
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
    // 更新状态点为在线（绿色）
    updateStatusIndicator(true);
    
    // 使用 Tauri 的 HTTP 客户端避免 CORS 问题
    const response = await httpFetch(state.apiUrl, {
      method: 'GET',
      timeout: 30,
    });
    
    if (response.status !== 200) throw new Error('API 请求失败');
    const data = response.data;
    
    // 保存旧价格用于比较
    state.oldPrices = {};
    state.prices.forEach(p => {
      state.oldPrices[p.code] = p.value;
    });
    
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

    state.prices = prices;
    updateStatusIndicator(true);
    return true;
  } catch (err) {
    console.error('获取价格失败:', err);
    updateStatusIndicator(false);
    return false;
  }
}

function updateStatusIndicator(online) {
  const statusDot = document.querySelector('.status-indicator .status-dot');
  if (statusDot) {
    statusDot.className = `status-dot ${online ? 'online' : 'offline'}`;
  }
}

// ========== 仓库数据处理 ==========
function loadWarehouses() {
  try {
    const raw = localStorage.getItem('warehouses');
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error('加载仓库失败:', err);
    return [];
  }
}

// ========== 气泡渲染 ==========
function renderBubble() {
  const container = document.getElementById('bubble-lines');
  if (!container) return;

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
      selectedPnls.push({ name: '总仓营收', pnl: totalPnl });
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
      
      selectedPnls.push({ name: warehouse.name, pnl });
    });
  }

  // 渲染价格行
  let html = '';
  
  selectedPrices.forEach(price => {
    const oldValue = state.oldPrices[price.code];
    let changeClass = '';
    if (oldValue !== undefined && oldValue !== price.value) {
      changeClass = price.value > oldValue ? 'price-up' : 'price-down';
    }
    
    html += `
      <div class="line ${changeClass}">
        <span class="line-name" style="font-size: ${state.bubbleFontSize - 1}px">${getDisplayName(price.code, price.name)}</span>
        <span class="line-price" style="font-size: ${state.bubbleFontSize}px">${fmt(price.value, 2)} ${getCurrency(price.code)}</span>
      </div>
    `;
  });

  // 添加分隔线和仓库盈亏
  if (selectedPnls.length > 0) {
    html += '<div class="pnl-separator"></div>';
    
    selectedPnls.forEach(item => {
      const pnlClass = item.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
      html += `
        <div class="pnl-line ${pnlClass}">
          <span class="line-name" style="font-size: ${state.bubbleFontSize - 1}px">${item.name}</span>
          <span class="line-price" style="font-size: ${state.bubbleFontSize}px">${item.pnl >= 0 ? '+' : ''}${fmt(item.pnl, 2)} ￥</span>
        </div>
      `;
    });
  }

  container.innerHTML = html;

  // 应用主题、主题配色和透明度
  document.body.setAttribute('data-theme', state.bubbleTheme);
  document.body.setAttribute('data-theme-color', state.bubbleThemeColor || 'blue');
  document.body.style.opacity = state.bubbleOpacity / 100;
  
  // 应用摸鱼模式和0存在感模式
  const bubbleRoot = document.getElementById('bubble-root');
  if (bubbleRoot) {
    bubbleRoot.classList.remove('moyu', 'minimal');
    if (state.bubbleMinimal) {
      bubbleRoot.classList.add('minimal');
    } else if (state.bubbleStealth) {
      bubbleRoot.classList.add('moyu');
    }
  }

  // 调整窗口大小
  resizeBubble();
}

async function resizeBubble() {
  // 计算需要的行数
  const priceCount = state.selectedCodes.length;
  const pnlCount = state.showPnl ? state.selectedPnlWarehouses.length : 0;
  const totalRows = priceCount + pnlCount;

  // 计算实际需要的宽度
  let maxWidth = 0; // 完全根据内容自适应
  
  // 0存在感模式下宽度计算更紧凑
  const isMinimal = state.bubbleMinimal;
  const basePadding = isMinimal ? 30 : 50; // 0存在感模式padding更小
  
  // 检查价格内容的宽度
  const selectedPrices = state.prices.filter(p => state.selectedCodes.includes(p.code));
  selectedPrices.forEach(price => {
    const name = getDisplayName(price.code);
    const value = price.value ? price.value.toFixed(2) : '0.00';
    const currency = getCurrency(price.code);
    // 估算文本宽度：汉字约14px，数字约8px，字母约7px
    const nameWidth = isMinimal ? 0 : name.split('').reduce((sum, char) => {
      return sum + (/[\u4e00-\u9fa5]/.test(char) ? 14 : 7);
    }, 0); // 0存在感模式不显示名称
    const valueWidth = value.length * 8;
    const currencyWidth = currency.length * 7;
    const estimatedWidth = nameWidth + valueWidth + currencyWidth + basePadding;
    maxWidth = Math.max(maxWidth, estimatedWidth);
  });

  // 检查仓库盈亏的宽度
  if (state.showPnl && state.selectedPnlWarehouses.length > 0) {
    const warehouses = loadWarehouses();
    const pnlPadding = isMinimal ? 100 : 120;
    state.selectedPnlWarehouses.forEach(wId => {
      if (wId === '__total__') {
        // 总仓营收
        const nameWidth = isMinimal ? 0 : 4 * 14; // 0存在感模式不显示名称
        const estimatedWidth = nameWidth + pnlPadding;
        maxWidth = Math.max(maxWidth, estimatedWidth);
      } else {
        const warehouse = warehouses.find(w => w.id === wId);
        if (warehouse) {
          const nameWidth = isMinimal ? 0 : warehouse.name.split('').reduce((sum, char) => {
            return sum + (/[\u4e00-\u9fa5]/.test(char) ? 14 : 7);
          }, 0);
          const estimatedWidth = nameWidth + pnlPadding;
          maxWidth = Math.max(maxWidth, estimatedWidth);
        }
      }
    });
  }

  // 根据字体大小调整
  const fontRatio = state.bubbleFontSize / 12;
  maxWidth = Math.ceil(maxWidth * fontRatio);

  // 获取设备像素比（DPI缩放）
  const dpiScale = window.devicePixelRatio || 1.0;

  // 通知主进程调整窗口大小 (Tauri)
  try {
    await invoke('resize_bubble', { 
      fontSize: state.bubbleFontSize, 
      rows: totalRows,
      contentWidth: maxWidth,  // 传递计算出的宽度
      dpiScale: dpiScale  // 传递DPI缩放因子
    });
  } catch (err) {
    console.error('Failed to resize bubble:', err);
  }
}

// ========== 主循环 ==========
async function mainLoop() {
  const success = await fetchPrices();
  if (success) {
    renderBubble();
  }
}

// ========== 初始化 ==========
async function init() {
  // 加载配置
  loadConfig();

  // 应用主题
  document.body.setAttribute('data-theme', state.bubbleTheme);
  document.body.style.opacity = state.bubbleOpacity / 100;

  // 首次获取数据并渲染
  await mainLoop();

  // 定时刷新
  setInterval(mainLoop, state.refreshInterval);

  // 监听配置更新 (Tauri)
  await listen('config-update', () => {
    loadConfig();
    renderBubble();
  });

  // 监听刷新事件 (Tauri)
  await listen('bubble-refresh-now', () => {
    mainLoop();
  });

  // 双击打开管理界面 (Tauri)
  document.addEventListener('dblclick', async () => {
    try {
      await invoke('open_manager');
    } catch (err) {
      console.error('Failed to open manager:', err);
    }
  });

  // 右键菜单 (Tauri)
  document.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    try {
      await invoke('show_bubble_context_menu');
    } catch (err) {
      console.error('Failed to show context menu:', err);
    }
  });

  // 气泡窗口始终显示，不自动隐藏
  console.log('气泡窗口初始化完成，保持显示状态');
}
