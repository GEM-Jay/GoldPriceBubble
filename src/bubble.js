// =========================
// bubble.js - 气泡窗口渲染（Tauri版）
// =========================

const _cleanupFns = [];
const _managedIntervals = new Map();
const _managedTimeouts = new Map();
const _singletonFlags = new Set();
let _isBubbleUnloading = false;
let _bubbleInitStarted = false;
let _resizeObserver = null;
const STREAM_RING_LIMIT = 50;
let _recentSnapshots = [];
let _lastVisualSignature = '';
const _bubbleLogFlags = Object.create(null);
let _lastResizeAppliedSignature = '';

function normalizeServerUrl(url) {
  const fallback = String(typeof SERVER_URL !== 'undefined' ? SERVER_URL : '').replace(/\/+$/, '');
  const raw = String(url || '').trim();
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return fallback;
    return raw.replace(/\/+$/, '');
  } catch (_) {
    return fallback;
  }
}

function registerCleanup(fn) {
  if (typeof fn === 'function') _cleanupFns.push(fn);
  return fn;
}

function setManagedInterval(key, fn, ms) {
  if (_managedIntervals.has(key)) clearInterval(_managedIntervals.get(key));
  const id = setInterval(fn, ms);
  _managedIntervals.set(key, id);
  return id;
}

function setManagedTimeout(key, fn, ms) {
  if (_managedTimeouts.has(key)) clearTimeout(_managedTimeouts.get(key));
  const id = setTimeout(() => {
    _managedTimeouts.delete(key);
    fn();
  }, ms);
  _managedTimeouts.set(key, id);
  return id;
}

function ensureSingletonInit(flagName, initFn) {
  if (_singletonFlags.has(flagName)) return false;
  _singletonFlags.add(flagName);
  initFn();
  return true;
}

function cleanupManagedResources() {
  _managedIntervals.forEach((id) => clearInterval(id));
  _managedIntervals.clear();
  _managedTimeouts.forEach((id) => clearTimeout(id));
  _managedTimeouts.clear();
  try { DataSource?.dispose?.(); } catch (_) {}
  while (_cleanupFns.length) {
    const fn = _cleanupFns.pop();
    try { fn(); } catch (_) {}
  }
}

window.addEventListener('beforeunload', () => {
  _isBubbleUnloading = true;
  cleanupManagedResources();
}, { once: true });

// 禁用 WebView2 状态栏和链接预览
document.addEventListener('DOMContentLoaded', () => {
  // 阻止所有元素的拖拽开始事件
  document.addEventListener('dragstart', (e) => e.preventDefault(), true);
  // 阻止鼠标悬停时的默认行为
  document.addEventListener('mouseover', (e) => {
    if (e.target.hasAttribute('data-tauri-drag-region')) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
});

// 等待 Tauri API 加载
function waitForTauri(callback) {
  if (window.__TAURI__) {
    callback();
  } else {
    setTimeout(() => waitForTauri(callback), 50);
  }
}

let invoke, listen, appWindow, LogicalSize;
waitForTauri(() => {
  invoke = window.__TAURI__.tauri.invoke;
  listen = window.__TAURI__.event.listen;
  appWindow = window.__TAURI__.window.appWindow;
  LogicalSize = window.__TAURI__.window.LogicalSize;
  
  // 在 Tauri API 加载后初始化应用
  if (document.readyState === 'loading') {
    ensureSingletonInit('bubble-dom-ready', () => document.addEventListener('DOMContentLoaded', init, { once: true }));
  } else {
    init();
  }
});

// ---------- 配置 ----------
// SERVER_URL 从 config.js 中导入

// ========= 状态管理 =========
const state = {
  prices: [],
  oldPrices: {},
  selectedCodes: [], // 首次由价格数据前两项填充，之后从 localStorage 读取
  bubbleRows: 2,
  bubbleStealth: false,
  bubbleMinimal: false, // 0存在感模式
  bubbleTheme: 'light',
  bubbleThemeColor: 'blue',
  bubbleFontSize: 12,
  bubbleFontColor: 'black',
  bubbleOpacity: 100,
  showPnl: false,
  selectedPnlWarehouses: [],
  serverUrl: (typeof SERVER_URL !== 'undefined' ? SERVER_URL : ''),
};

async function appLog(level, moduleName, event, message, context = null) {
  try {
    await invoke('append_client_log', {
      level,
      module: moduleName,
      event,
      message,
      context
    });
  } catch (_) {}
}

function _markBubbleLogFlag(key) {
  if (_bubbleLogFlags[key]) return false;
  _bubbleLogFlags[key] = true;
  return true;
}

function _getRecentSnapshotSummary() {
  const latest = _recentSnapshots.length ? _recentSnapshots[_recentSnapshots.length - 1] : null;
  return {
    recentSnapshotCount: _recentSnapshots.length,
    latestSnapshotTs: latest?.ts || null,
    latestSnapshotPricesCount: latest?.count || 0,
  };
}

function _getBubbleDiagnostics(extra = {}) {
  const { selectedPrices, selectedPnls } = _buildBubbleLines();
  return {
    selectedCodes: Array.isArray(state.selectedCodes) ? state.selectedCodes.slice() : [],
    pricesCount: Array.isArray(state.prices) ? state.prices.length : 0,
    selectedPricesCount: selectedPrices.length,
    pnlLinesCount: selectedPnls.length,
    hasRealContent: !!_hasRealContent,
    bubbleShown: !!_bubbleShown,
    devicePixelRatio: window.devicePixelRatio || 1,
    bubbleFontSize: state.bubbleFontSize,
    bubbleOpacity: state.bubbleOpacity,
    bubbleTheme: state.bubbleTheme,
    bubbleThemeColor: state.bubbleThemeColor,
    bubbleStealth: !!state.bubbleStealth,
    bubbleMinimal: !!state.bubbleMinimal,
    webviewDetected: !!window.chrome?.webview,
    ..._getRecentSnapshotSummary(),
    ...extra,
  };
}

function _shouldLogResizeRequested(reason) {
  if (reason !== 'resize_observer') return true;
  return _markBubbleLogFlag('resize_requested_observer_first');
}

// ========== 工具函数 ==========
function getCurrency(code) {
  return DataSource.getCurrency(code);
}

function getDisplayName(code, apiName) {
  return DataSource.getDisplayName(code, apiName);
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
    state.bubbleFontColor = localStorage.getItem('bubbleFontColor') || 'black';
    state.bubbleOpacity = parseInt(localStorage.getItem('bubbleOpacity') || '100');
    state.showPnl = localStorage.getItem('showPnl') === 'true';
    state.selectedPnlWarehouses = JSON.parse(localStorage.getItem('pnl_selected_warehouses') || '[]');
    state.serverUrl = normalizeServerUrl(localStorage.getItem('serverUrl') || (typeof SERVER_URL !== 'undefined' ? SERVER_URL : ''));
    try { localStorage.setItem('serverUrl', state.serverUrl); } catch (_) {}
  } catch (_) {
  }
  appLog('info', 'bubble', 'config_loaded', 'bubble config loaded', _getBubbleDiagnostics());
}

// ========== 价格数据处理（只读内存快照，不持久化）==========
function _pushRecentSnapshot(snapshot) {
  _recentSnapshots.push({
    ts: snapshot.ts || Date.now(),
    count: Array.isArray(snapshot.prices) ? snapshot.prices.length : 0,
  });
  if (_recentSnapshots.length > STREAM_RING_LIMIT) {
    _recentSnapshots.splice(0, _recentSnapshots.length - STREAM_RING_LIMIT);
  }
}

function applyPricesSnapshot(snapshot) {
  const prices = Array.isArray(snapshot?.prices) ? snapshot.prices : [];
  if (prices.length === 0) return false;
  // 保留旧价格用于涨跌色
  state.oldPrices = {};
  state.prices.forEach(p => { state.oldPrices[p.code] = p.value; });

  state.prices = prices;
  _pushRecentSnapshot(snapshot);
  if (_markBubbleLogFlag('snapshot_received_first')) {
    appLog('info', 'bubble', 'snapshot_received', 'bubble received first price snapshot', _getBubbleDiagnostics({
      snapshotTs: snapshot?.ts || null,
    }));
  }

  const savedCodes = localStorage.getItem('selectedCodes');
  if (savedCodes !== null) {
    state.selectedCodes = JSON.parse(savedCodes);
  } else {
    state.selectedCodes = DataSource.getFirstKeys(2);
    try { localStorage.setItem('selectedCodes', JSON.stringify(state.selectedCodes)); } catch (_) {}
  }
  _normalizeBubbleSelectedCodes();

  updateStatusIndicator(true);
  return true;
}

function _normalizeBubbleSelectedCodes() {
  const original = Array.isArray(state.selectedCodes) ? state.selectedCodes.slice() : [];
  const available = new Set((state.prices || []).map(item => item.code).filter(Boolean));
  const normalized = [];
  const seen = new Set();

  original.forEach((code) => {
    if (!code || seen.has(code) || !available.has(code)) return;
    seen.add(code);
    normalized.push(code);
  });

  if (normalized.length === 0 && state.prices.length > 0) {
    state.prices.slice(0, Math.max(1, state.bubbleRows || 1)).forEach((price) => {
      if (!price?.code || seen.has(price.code)) return;
      seen.add(price.code);
      normalized.push(price.code);
    });
  }

  const limited = normalized.slice(0, Math.max(1, state.bubbleRows || 1));
  const changed =
    limited.length !== original.length ||
    limited.some((code, index) => code !== original[index]);

  if (!changed) return false;
  state.selectedCodes = limited;
  try { localStorage.setItem('selectedCodes', JSON.stringify(limited)); } catch (_) {}
  appLog('warn', 'bubble', 'selected_codes_normalized', 'bubble selected codes normalized against current prices', _getBubbleDiagnostics({
    originalSelectedCodes: original,
    normalizedSelectedCodes: limited,
  }));
  return true;
}

function updateStatusIndicator(online) {
  const statusDot = document.getElementById('bubble-status-dot');
  if (statusDot) {
    statusDot.className = `status-dot ${online ? 'online' : 'offline'}`;
  }
}

// ========== 仓库数据处理 ==========
function loadWarehouses() {
  try {
    const raw = localStorage.getItem('warehouses');
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

// ========== 气泡渲染 ==========
function renderLoading() {
  const container = document.getElementById('bubble-lines');
  if (!container) return;
  container.innerHTML = `<div class="loading-hint" data-tauri-drag-region>数据抓取中，请稍候…</div>`;
  updateStatusIndicator(false);
}

function _applyBubbleVisualState() {
  document.body.setAttribute('data-theme', state.bubbleTheme);
  document.body.setAttribute('data-theme-color', state.bubbleThemeColor || 'blue');
  document.body.style.opacity = state.bubbleOpacity / 100;
  const _fcMap = { white: '#ffffff', black: '#000000', default: '' };
  document.body.style.setProperty('--bubble-font-color', _fcMap[state.bubbleFontColor] || '');

  const bubbleRoot = document.getElementById('bubble-root');
  if (!bubbleRoot) return;

  const visualMode = state.bubbleMinimal ? 'minimal' : (state.bubbleStealth ? 'moyu' : 'normal');
  const signature = [
    state.bubbleTheme,
    state.bubbleThemeColor || 'blue',
    state.bubbleOpacity,
    state.bubbleFontColor,
    state.bubbleFontSize,
    visualMode,
  ].join('|');

  bubbleRoot.classList.toggle('minimal', state.bubbleMinimal);
  bubbleRoot.classList.toggle('moyu', !state.bubbleMinimal && state.bubbleStealth);

  _lastVisualSignature = signature;
}

// 计算当前应展示的价格行和盈亏行数据
function _buildBubbleLines() {
  const selectedPrices = state.prices.filter(p => state.selectedCodes.includes(p.code));
  const warehouses = loadWarehouses();
  const selectedPnls = [];

  if (state.showPnl && state.selectedPnlWarehouses.length > 0) {
    if (state.selectedPnlWarehouses.includes('__total__')) {
      let totalPnl = 0;
      warehouses.forEach(w => {
        const priceObj = state.prices.find(p => p.code === w.refPrice);
        const currentPrice = priceObj?.value || 0;
        const currentValue = w.totalGrams * currentPrice;
        const pnl = currentValue - (w.totalCost || 0);
        if (getCurrency(w.refPrice) === '￥' || getCurrency(w.refPrice) === '¥') totalPnl += pnl;
      });
      selectedPnls.push({ name: '总仓营收', pnl: totalPnl });
    }
    state.selectedPnlWarehouses.forEach(id => {
      if (id === '__total__') return;
      const warehouse = warehouses.find(w => w.id === id);
      if (!warehouse) return;
      const priceObj = state.prices.find(p => p.code === warehouse.refPrice);
      const currentPrice = priceObj?.value || 0;
      const pnl = warehouse.totalGrams * currentPrice - (warehouse.totalCost || 0);
      selectedPnls.push({ name: warehouse.name, pnl });
    });
  }

  return { selectedPrices, selectedPnls };
}

function renderBubble() {
  const container = document.getElementById('bubble-lines');
  if (!container) return;

  const { selectedPrices, selectedPnls } = _buildBubbleLines();
  const visualSignatureBefore = _lastVisualSignature;

  // ── 判断结构是否与当前 DOM 一致（行数 + code 顺序 + pnl 行数）──
  const existingPriceRows = container.querySelectorAll('.line[data-code]');
  const existingPnlRows   = container.querySelectorAll('.pnl-line[data-pnl]');
  const structureMatch =
    existingPriceRows.length === selectedPrices.length &&
    existingPnlRows.length   === selectedPnls.length &&
    selectedPrices.every((p, i) => existingPriceRows[i]?.dataset.code === p.code) &&
    selectedPnls.every((p, i)   => existingPnlRows[i]?.dataset.pnl   === p.name);

  if (!structureMatch) {
    // 结构变了（选中项目/数量改变）→ 重建
    let html = '';
    selectedPrices.forEach(price => {
      const oldValue = state.oldPrices[price.code];
      let changeClass = '';
      if (oldValue !== undefined && oldValue !== price.value) {
        changeClass = price.value > oldValue ? 'price-up' : 'price-down';
      }
      html += `<div class="line ${changeClass}" data-code="${price.code}" data-tauri-drag-region>
        <span class="line-name" data-tauri-drag-region style="font-size:${state.bubbleFontSize - 1}px">${getDisplayName(price.code, price.name)}</span>
        <span class="line-price" data-tauri-drag-region style="font-size:${state.bubbleFontSize}px">${fmt(price.value, 2)} ${getCurrency(price.code)}</span>
      </div>`;
    });
    if (selectedPnls.length > 0) {
      html += '<div class="pnl-separator" data-tauri-drag-region></div>';
      selectedPnls.forEach(item => {
        const pnlClass = item.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
        html += `<div class="pnl-line ${pnlClass}" data-pnl="${item.name}" data-tauri-drag-region>
          <span class="line-name" data-tauri-drag-region style="font-size:${state.bubbleFontSize - 1}px">${item.name}</span>
          <span class="line-price" data-tauri-drag-region style="font-size:${state.bubbleFontSize}px">${item.pnl >= 0 ? '+' : ''}${fmt(item.pnl, 2)} ￥</span>
        </div>`;
      });
    }
    container.innerHTML = html;
  } else {
    // 结构不变 → 只更新数值和涨跌色，不碰 DOM 结构
    selectedPrices.forEach((price, i) => {
      const row = existingPriceRows[i];
      const priceSpan = row.querySelector('.line-price');
      const newText = `${fmt(price.value, 2)} ${getCurrency(price.code)}`;
      if (priceSpan && priceSpan.textContent !== newText) {
        priceSpan.textContent = newText;
      }

      const oldValue = state.oldPrices[price.code];
      if (oldValue !== undefined && oldValue !== price.value) {
        row.className = `line ${price.value > oldValue ? 'price-up' : 'price-down'}`;
      } else if (oldValue === price.value) {
        row.className = 'line';
      }
    });
    selectedPnls.forEach((item, i) => {
      const row = existingPnlRows[i];
      const priceSpan = row.querySelector('.line-price');
      const newText = `${item.pnl >= 0 ? '+' : ''}${fmt(item.pnl, 2)} ￥`;
      if (priceSpan && priceSpan.textContent !== newText) {
        priceSpan.textContent = newText;
      }
      row.className = `pnl-line ${item.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`;
    });
  }

  // 记录旧价格供下次比较涨跌
  selectedPrices.forEach(p => { state.oldPrices[p.code] = p.value; });
  if (state.prices.length > 0 && selectedPrices.length === 0 && _markBubbleLogFlag('render_no_selected_prices')) {
    appLog('warn', 'bubble', 'render_no_selected_prices', 'bubble has prices but no selected rows to render', _getBubbleDiagnostics());
  }
  if (selectedPrices.length > 0 && !_hasRealContent) {
    _hasRealContent = true;
    appLog('info', 'bubble', 'real_content_ready', 'bubble has real content ready to show', _getBubbleDiagnostics());
  }

  _applyBubbleVisualState();

  if (!structureMatch || visualSignatureBefore !== _lastVisualSignature) {
    _allowResizeObserverUntil = Date.now() + 800;
    scheduleResize('render');
  }
}

let _lastResizeW = 0, _lastResizeH = 0;
let _resizePending = false;
let _resizing = false;
let _resizeQueued = false;
let _bubbleShown = false;
let _hasRealContent = false;
let _allowResizeObserverUntil = 0;

function _measureNaturalSize(bubbleRoot) {
  const html = document.documentElement;
  const body = document.body;
  const prev = {
    htmlO: html.style.overflow, bodyO: body.style.overflow,
    bodyW: body.style.width,    rootW: bubbleRoot.style.width,
    rootH: bubbleRoot.style.height,
    rootT: bubbleRoot.style.transform,
    rootA: bubbleRoot.style.animation,
  };

  html.style.overflow     = 'visible';
  body.style.overflow     = 'visible';
  body.style.width        = 'max-content';
  bubbleRoot.style.width  = 'max-content';
  bubbleRoot.style.height = 'max-content';
  bubbleRoot.style.animation = 'none';
  bubbleRoot.style.transform = 'none';

  bubbleRoot.offsetHeight;

  const rect = bubbleRoot.getBoundingClientRect();
  const style = getComputedStyle(bubbleRoot);
  const marginX = parseFloat(style.marginLeft || '0') + parseFloat(style.marginRight || '0');
  const marginY = parseFloat(style.marginTop || '0') + parseFloat(style.marginBottom || '0');
  const dpr  = window.devicePixelRatio || 1;
  const w = Math.ceil((rect.width + marginX) * dpr);
  const h = Math.ceil((rect.height + marginY) * dpr);

  html.style.overflow     = prev.htmlO;
  body.style.overflow     = prev.bodyO;
  body.style.width        = prev.bodyW;
  bubbleRoot.style.width  = prev.rootW;
  bubbleRoot.style.height = prev.rootH;
  bubbleRoot.style.transform = prev.rootT;
  bubbleRoot.style.animation = prev.rootA;

  return { w, h };
}

async function resizeBubble() {
  if (_resizing) { _resizeQueued = true; return; }
  _resizing = true;

  try {
    if (_isBubbleUnloading) return;
    const bubbleRoot = document.getElementById('bubble-root');
    if (!bubbleRoot || !appWindow || !LogicalSize) return;

    const { w: domWidth, h: domHeight } = _measureNaturalSize(bubbleRoot);

    if (domWidth <= 0 || domHeight <= 0) {
      appLog('warn', 'bubble', 'resize_invalid_dimensions', 'bubble measured invalid dimensions', _getBubbleDiagnostics({
        domWidth,
        domHeight,
      }));
      return;
    }
    if (domWidth === _lastResizeW && domHeight === _lastResizeH) return;
    _lastResizeW = domWidth;
    _lastResizeH = domHeight;

    let finalW = domWidth;
    let finalH = domHeight;

    // Minimal mode is extra sensitive to glyph overhang and DPI rounding.
    // Keep a small width buffer so trailing currency symbols do not get clipped.
    if (state.bubbleMinimal) {
      finalW += 10;
    }

    const monitor = await window.__TAURI__.window.currentMonitor()
      || await window.__TAURI__.window.primaryMonitor();
    if (_isBubbleUnloading) return;
    if (monitor) {
      const maxH = monitor.size.height * 0.85;
      finalH = Math.min(finalH, maxH);
    }

    try {
      await invoke('set_bubble_size', { width: finalW, height: finalH });
    } catch (_) {
      if (_isBubbleUnloading) return;
      const { PhysicalSize } = window.__TAURI__.window;
      await appWindow.setSize(new PhysicalSize(finalW, finalH));
    }
    const resizeSignature = [finalW, finalH, domWidth, domHeight, !!_bubbleShown, !!_hasRealContent].join('|');
    if (resizeSignature !== _lastResizeAppliedSignature) {
      _lastResizeAppliedSignature = resizeSignature;
      appLog('info', 'bubble', 'resize_applied', 'bubble resize applied', _getBubbleDiagnostics({
        finalWidth: finalW,
        finalHeight: finalH,
        domWidth,
        domHeight,
      }));
    }

    if (!_bubbleShown && _hasRealContent) {
      if (_isBubbleUnloading) return;
      appLog('info', 'bubble', 'show_requested', 'bubble show requested', _getBubbleDiagnostics());
      try {
        await invoke('show_bubble');
        _bubbleShown = true;
        appLog('info', 'bubble', 'show_succeeded', 'bubble show succeeded', _getBubbleDiagnostics());
      } catch (error) {
        appLog('error', 'bubble', 'show_failed', 'bubble show failed', _getBubbleDiagnostics({
          message: String(error?.message || error || ''),
        }));
      }
    }

    if (_isBubbleUnloading) return;
    const winSize = await appWindow.innerSize();
    const rect = document.getElementById('bubble-root').getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    console.log(
      `[resize] div=${rect.width.toFixed(1)}x${rect.height.toFixed(1)}css  ` +
      `div_phys=${Math.ceil(rect.width*dpr)}x${Math.ceil(rect.height*dpr)}px  ` +
      `win_phys=${winSize.width}x${winSize.height}px  ` +
      `dpr=${dpr}  measured=${finalW}x${finalH}`
    );
  } finally {
    _resizing = false;
    if (_resizeQueued) {
      _resizeQueued = false;
      scheduleResize();
    }
  }
}

function scheduleResize(reason = 'unknown') {
  if (_resizePending) return;
  _resizePending = true;
  if (_shouldLogResizeRequested(reason)) {
    appLog('info', 'bubble', 'resize_requested', 'bubble resize requested', _getBubbleDiagnostics({ reason }));
  }
  // 用 setTimeout 替代 rAF，避免隐藏窗口中 rAF 不触发的问题
  setTimeout(() => {
    _resizePending = false;
    resizeBubble();
  }, 0);
}

function initResizeObserver() {
  const bubbleRoot = document.getElementById('bubble-root');
  if (!bubbleRoot) return;
  if (_resizeObserver) return;
  _resizeObserver = new ResizeObserver(() => {
    if (!_bubbleShown || Date.now() < _allowResizeObserverUntil) scheduleResize('resize_observer');
  });
  _resizeObserver.observe(bubbleRoot);
  registerCleanup(() => {
    _resizeObserver?.disconnect();
    _resizeObserver = null;
  });
}

// ========== 渲染触发（读快照 + 渲染）==========
function refreshFromSnapshot(snapshot) {
  if (applyPricesSnapshot(snapshot)) {
    renderBubble();
  } else {
    scheduleResize();
  }
}

// ========== 初始化 ==========
async function init() {
  if (_bubbleInitStarted) return;
  _bubbleInitStarted = true;
  await appLog('info', 'bubble', 'init_started', 'bubble init started', {
    platform: 'windows',
    appVersion: localStorage.getItem('appVersion') || '',
  });
  loadConfig();

  // 初始化 DataSource（气泡只需读缓存，不需要 httpFetch）
  DataSource.init(null, state.serverUrl);

  document.body.setAttribute('data-theme', state.bubbleTheme);
  document.body.setAttribute('data-theme-color', state.bubbleThemeColor || 'blue');
  document.body.style.opacity = state.bubbleOpacity / 100;
  _applyBubbleVisualState();

  renderLoading();

  // 未同意协议前不渲染，每 500ms 轮询一次 localStorage
  appLog('info', 'bubble', 'wait_eula', 'bubble waiting for eula acceptance', _getBubbleDiagnostics());
  await new Promise(resolve => {
    if (localStorage.getItem('eulaAccepted') === '1') { resolve(); return; }
    const t = setInterval(() => {
      if (localStorage.getItem('eulaAccepted') === '1') { clearInterval(t); resolve(); }
    }, 500);
  });

  initResizeObserver();

  // 监听管理窗口价格快照（管理窗口是唯一的抓取方）
  const unlistenPrices = await listen('prices-snapshot', (event) => {
    refreshFromSnapshot(event.payload);
  });
  registerCleanup(() => { try { unlistenPrices(); } catch (_) {} });

  const unlistenConnectionStatus = await listen('connection-status', (event) => {
    updateStatusIndicator(!!event?.payload?.online);
  });
  registerCleanup(() => { try { unlistenConnectionStatus(); } catch (_) {} });

  // 监听配置更新（选项、主题等变化，可能影响行数/字号 → 需要 resize）
  const unlistenConfig = await listen('config-update', () => {
    loadConfig();
    const container = document.getElementById('bubble-lines');
    if (container) container.innerHTML = '';
    renderBubble();
  });
  registerCleanup(() => { try { unlistenConfig(); } catch (_) {} });

  // 监听数据源更新（管理窗口更新了数据源列表）
  const unlistenSources = await listen('sources-updated', () => {
    DataSource.reloadFromStorage();
    renderBubble();
  });
  registerCleanup(() => { try { unlistenSources(); } catch (_) {} });

  // 监听强制刷新（从右键菜单或其他地方触发）
  const unlistenRefresh = await listen('bubble-refresh-now', () => {
    renderBubble();
  });
  registerCleanup(() => { try { unlistenRefresh(); } catch (_) {} });

  try {
    window.__TAURI__?.event?.emit?.('prices-snapshot-request');
  } catch (_) {}
  setManagedTimeout('bubble-first-snapshot-watchdog', () => {
    if (_recentSnapshots.length > 0 || _isBubbleUnloading) return;
    updateStatusIndicator(false);
    appLog('warn', 'bubble', 'snapshot_timeout', 'bubble did not receive price snapshot in time', _getBubbleDiagnostics());
  }, 8000);

  // 双击打开管理界面 (Tauri)
  document.addEventListener('dblclick', async () => {
    invoke('open_manager').catch(function () {});
  });

  const bubbleRoot = document.getElementById('bubble-root');
  const clearPressed = () => bubbleRoot?.classList.remove('dragging');
  bubbleRoot?.addEventListener('mousedown', () => bubbleRoot.classList.add('dragging'));
  document.addEventListener('mouseup', clearPressed);
  document.addEventListener('mouseleave', clearPressed);

  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'F12') {
      invoke('open_devtools', { label: 'bubble' }).catch(() => {});
      return;
    }
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C'))) {
      e.preventDefault();
    }
  });

  // 拖动结束后保存位置
  let _dragSaveTimer = null;
  document.addEventListener('mouseup', () => {
    clearTimeout(_dragSaveTimer);
    _dragSaveTimer = setTimeout(() => {
      invoke('save_bubble_position').catch(function () {});
    }, 300);
  });

  // 置顶兜底由 Rust 侧 SetWindowPos 负责，避免 WebView 侧 setAlwaysOnTop 触发窗口抖动。
}
