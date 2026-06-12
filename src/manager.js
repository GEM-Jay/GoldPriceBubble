// ========================================================
// manager.js  —— GoldPrice 管理界面主控制器（Tauri版）
// ========================================================

const _cleanupFns = [];
const _managedIntervals = new Map();
const _managedTimeouts = new Map();
const _singletonFlags = new Set();
const ALLOWED_THEME_COLORS = new Set(['blue']);
let _isPageUnloading = false;
let _managerInitStarted = false;
let _managerAsyncStarted = false;
let _updateSourcesInFlight = false;
let _updateSourcesCooldownUntil = 0;
let _sseReconnectTimer = null;
let _sseReconnectPending = false;
let _sseAbortController = null;
let _sseReader = null;
let _sseProcessScheduled = false;
let _sseQueuedPayload = null;
let _ssePendingChunk = '';
let _sseMessageRing = [];
let _sseLatestSnapshot = null;
let _activeDownloadId = null;
let _downloadCancelled = false;
const SSE_RING_LIMIT = 50;
const SSE_MAX_PENDING_CHARS = 64 * 1024;
const SSE_MAX_MESSAGE_CHARS = 8 * 1024;
const SSE_MAX_MESSAGES_PER_SECOND = 20;
const SSE_FIRST_PAYLOAD_TIMEOUT_MS = 8000;
const SSE_RECONNECT_DELAY_MS = 3000;
const UPDATE_SOURCES_COOLDOWN_MS = 1200;
const _streamMetrics = {
  recentMessages: 0,
  pendingQueueLength: 0,
  lastMessageSize: 0,
  hasActiveReader: false,
  processedInWindow: 0,
  windowStartedAt: 0,
};

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

function clearManagedTimeout(key) {
  const id = _managedTimeouts.get(key);
  if (id) {
    clearTimeout(id);
    _managedTimeouts.delete(key);
  }
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
  _disconnectSSE();
  try { DataSource?.dispose?.(); } catch (_) {}
  while (_cleanupFns.length) {
    const fn = _cleanupFns.pop();
    try { fn(); } catch (_) {}
  }
}

window.addEventListener('beforeunload', () => {
  _isPageUnloading = true;
  cleanupManagedResources();
}, { once: true });

// 等待 Tauri API 加载
function waitForTauri(callback) {
  if (window.__TAURI__) {
    setTimeout(callback, 0);
  } else {
    setTimeout(() => waitForTauri(callback), 50);
  }
}

let invoke, emit, httpFetch;
waitForTauri(() => {
  invoke = window.__TAURI__.tauri.invoke;
  emit = window.__TAURI__.event.emit;
  httpFetch = window.__TAURI__.http.fetch;

  const run = () => {
    if (_managerInitStarted) return;
    if (localStorage.getItem('eulaAccepted') === '1') {
      init();
    } else {
      // 首次启动：确保管理窗口可见，再弹协议
      invoke('open_manager').catch(() => {});
      showEula(() => {
        // 标记本次会话是刚接受协议，_initAsync 强制拉取数据源
        sessionStorage.setItem('eulaJustAccepted', '1');
        init();
      });
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
});

// ---------- 配置 ----------
// SERVER_URL 从 config.js 中导入

// ========= 状态管理 =========
const state = {
  prices: [],
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
  refreshInterval: 5000,
  serverUrl: (typeof SERVER_URL !== 'undefined' ? SERVER_URL : ''),
  autoStart: false,
};

let _clientIdentity = null;
let _ticketImages = [];
let _ticketItems = [];
let _ticketHistoryOpen = false;
let _ticketTargetId = null;
let _ticketUnreadCount = 0;
let _ticketUnreadPollInitialized = false;
let _lastTicketRefreshAt = 0;
const _managerLogFlags = Object.create(null);
let _lastManagerConfigNotifySignature = '';
let _connectionOnline = false;

function _ticketApiBase() {
  const base = String(typeof TICKET_SERVER_URL !== 'undefined' ? TICKET_SERVER_URL : '').trim();
  return base.replace(/\/+$/, '');
}

function _getLegacyClientId() {
  try { return localStorage.getItem('clientId') || ''; } catch (_) { return ''; }
}

async function _syncClientIdentity() {
  if (_clientIdentity) return _clientIdentity;
  if (!invoke) return null;
  try {
    const identity = await invoke('get_or_create_client_identity', {
      legacyClientId: _getLegacyClientId() || null
    });
    _clientIdentity = identity || null;
    const aboutEl = document.getElementById('app-install-id');
    if (aboutEl) aboutEl.textContent = _clientIdentity?.install_id || '—';
    return _clientIdentity;
  } catch (_) {
    return null;
  }
}

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

function _getClientRuntimeSummary() {
  return {
    platform: navigator.platform || 'unknown',
    language: navigator.language || '',
    webviewDetected: !!window.chrome?.webview,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

function _markManagerLogFlag(key) {
  if (_managerLogFlags[key]) return false;
  _managerLogFlags[key] = true;
  return true;
}

function _maskEmail(email) {
  const raw = String(email || '').trim();
  const at = raw.indexOf('@');
  if (at <= 1) return raw ? '***' : '';
  return `${raw.slice(0, 1)}***${raw.slice(at)}`;
}

function _getLatestSnapshotSummary() {
  return {
    hasSnapshot: !!_sseLatestSnapshot,
    snapshotTs: _sseLatestSnapshot?.ts || null,
    snapshotAgeMs: _sseLatestSnapshot ? Math.max(0, Date.now() - _sseLatestSnapshot.ts) : null,
    snapshotPricesCount: Array.isArray(_sseLatestSnapshot?.prices) ? _sseLatestSnapshot.prices.length : 0,
    recentMessages: _streamMetrics.recentMessages,
  };
}

function _getBubbleConfigSummary() {
  return {
    selectedCodes: Array.isArray(state.selectedCodes) ? state.selectedCodes.slice() : [],
    bubbleRows: state.bubbleRows,
    showPnl: !!state.showPnl,
    bubbleStealth: !!state.bubbleStealth,
    bubbleMinimal: !!state.bubbleMinimal,
    bubbleTheme: state.bubbleTheme,
    bubbleOpacity: state.bubbleOpacity,
  };
}

function _setConnectionOnline(online, reason = '') {
  _connectionOnline = !!online;
  const statusClass = `status-dot ${_connectionOnline ? 'online' : 'offline'}`;
  const statusDot = document.getElementById('status-dot');
  if (statusDot) statusDot.className = statusClass;
  const previewDot = document.querySelector('#bubble-preview .status-dot');
  if (previewDot) previewDot.className = statusClass;
  try {
    emit?.('connection-status', {
      online: _connectionOnline,
      reason,
      ts: Date.now(),
    });
  } catch (_) {}
}

function _getManagerDataSummary() {
  return {
    pricesCount: Array.isArray(state.prices) ? state.prices.length : 0,
    sseSchemaCount: Array.isArray(_sseSchema) ? _sseSchema.length : 0,
    hasActiveReader: !!_streamMetrics.hasActiveReader,
    lastMessageSize: _streamMetrics.lastMessageSize,
    ..._getLatestSnapshotSummary(),
  };
}

async function _appendTicketSeedLogs({ identity, includeLogs, title, email }) {
  const sharedContext = {
    includeLogs,
    titleLength: String(title || '').trim().length,
    hasEmail: !!String(email || '').trim(),
    maskedEmail: _maskEmail(email),
    platform: 'windows',
    appVersion: localStorage.getItem('appVersion') || '',
    installId: identity?.install_id || null,
    hasLegacyClientId: !!identity?.legacy_client_id,
  };
  await appLog('info', 'ticket', 'submit_started', 'ticket submit started', {
    ...sharedContext,
    ..._getClientRuntimeSummary(),
    ..._getBubbleConfigSummary(),
    ..._getManagerDataSummary(),
  });
  if (includeLogs) {
    await appLog('info', 'ticket', 'include_logs_enabled', 'ticket include logs enabled', {
      ...sharedContext,
      ..._getClientRuntimeSummary(),
      ..._getBubbleConfigSummary(),
      ..._getManagerDataSummary(),
    });
  }
}

function _buildFallbackTicketLog({ identity, includeLogs, title, email }) {
  const entry = {
    ts: new Date().toISOString(),
    level: 'info',
    module: 'ticket',
    event: 'placeholder_log_generated',
    message: 'generated fallback ticket diagnostics',
    context: {
      includeLogs,
      titleLength: String(title || '').trim().length,
      hasEmail: !!String(email || '').trim(),
      maskedEmail: _maskEmail(email),
      platform: 'windows',
      appVersion: localStorage.getItem('appVersion') || '',
      installId: identity?.install_id || null,
      hasLegacyClientId: !!identity?.legacy_client_id,
      bubble: _getBubbleConfigSummary(),
      manager: _getManagerDataSummary(),
      clientRuntime: _getClientRuntimeSummary(),
    },
    app_version: localStorage.getItem('appVersion') || '',
  };
  return `${JSON.stringify(entry)}\n`;
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

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch] || ch));
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
    // 如果是首次使用（没有 selectedCodes），保留默认值
    const savedCodes = localStorage.getItem('selectedCodes');
    if (savedCodes !== null) {
      state.selectedCodes = JSON.parse(savedCodes);
    }
    const savedAutoStart = localStorage.getItem('autoStart');
    if (savedAutoStart !== null) {
      state.autoStart = savedAutoStart === 'true';
    }
    
    state.bubbleRows = parseInt(localStorage.getItem('bubbleRows') || '2');
    state.bubbleStealth = false;
    state.bubbleMinimal = localStorage.getItem('bubbleMinimal') === 'true';
    state.bubbleTheme = localStorage.getItem('bubbleTheme') || 'light';
    const savedThemeColor = localStorage.getItem('bubbleThemeColor') || 'blue';
    state.bubbleThemeColor = ALLOWED_THEME_COLORS.has(savedThemeColor) ? savedThemeColor : 'blue';
    state.bubbleFontSize = parseInt(localStorage.getItem('bubbleFontSize') || '12');
    state.bubbleFontColor = localStorage.getItem('bubbleFontColor') || 'black';
    state.bubbleOpacity = parseInt(localStorage.getItem('bubbleOpacity') || '100');
    state.showPnl = localStorage.getItem('showPnl') === 'true';
    state.selectedPnlWarehouses = JSON.parse(localStorage.getItem('pnl_selected_warehouses') || '[]');
    state.serverUrl = normalizeServerUrl(localStorage.getItem('serverUrl') || (typeof SERVER_URL !== 'undefined' ? SERVER_URL : ''));
    localStorage.setItem('serverUrl', state.serverUrl);
    localStorage.setItem('bubbleThemeColor', state.bubbleThemeColor);
    localStorage.removeItem('bubbleStealth');
    _normalizeSelectedCodes();
  } catch (_) {
  }
}

async function saveState() {
  try {
    localStorage.setItem('selectedCodes', JSON.stringify(state.selectedCodes));
    localStorage.setItem('bubbleRows', state.bubbleRows.toString());
    localStorage.removeItem('bubbleStealth');
    localStorage.setItem('bubbleMinimal', state.bubbleMinimal.toString());
    localStorage.setItem('bubbleTheme', state.bubbleTheme);
    localStorage.setItem('bubbleThemeColor', state.bubbleThemeColor);
    localStorage.setItem('bubbleFontSize', state.bubbleFontSize.toString());
    localStorage.setItem('bubbleFontColor', state.bubbleFontColor);
    localStorage.setItem('bubbleOpacity', state.bubbleOpacity.toString());
    localStorage.setItem('showPnl', state.showPnl.toString());
    localStorage.setItem('pnl_selected_warehouses', JSON.stringify(state.selectedPnlWarehouses));
    localStorage.setItem('serverUrl', state.serverUrl);
    localStorage.setItem('autoStart', state.autoStart.toString());

    // 通知气泡窗口更新 (Tauri)
    try {
      const signature = JSON.stringify({
        ..._getBubbleConfigSummary(),
        bubbleThemeColor: state.bubbleThemeColor,
        bubbleFontSize: state.bubbleFontSize,
        bubbleFontColor: state.bubbleFontColor,
      });
      if (_lastManagerConfigNotifySignature !== signature) {
        _lastManagerConfigNotifySignature = signature;
        appLog('info', 'manager', 'notify_bubble_config', 'bubble config update emitted', {
          ...JSON.parse(signature),
        });
      }
      await invoke('notify_bubble', { message: 'config-update' });
    } catch (_) {
    }
  } catch (_) {
  }
}

// ========== SSE 长连接 ==========
function _getApiBaseUrl() {
  return normalizeServerUrl(typeof SERVER_URL !== 'undefined' ? SERVER_URL : '');
}

function _getSseBaseUrl() {
  const base = _getApiBaseUrl();
  return base ? `${base}/stream` : '';
}

function _getFieldsUrl() {
  const base = _getApiBaseUrl();
  return base ? `${base}/fields` : '';
}

function _getSelectableCodes() {
  if (typeof DataSource === 'undefined' || typeof DataSource.getAllItems !== 'function') {
    return [];
  }
  if (typeof DataSource.hasSources === 'function' && !DataSource.hasSources()) {
    return [];
  }
  return DataSource.getAllItems().map(item => item.code).filter(Boolean);
}

function _normalizeSelectedCodes() {
  const original = Array.isArray(state.selectedCodes) ? state.selectedCodes.slice() : [];
  const selectable = new Set(_getSelectableCodes());
  const normalized = [];
  const seen = new Set();

  original.forEach((code) => {
    if (!code || seen.has(code)) return;
    if (selectable.size > 0 && !selectable.has(code)) return;
    seen.add(code);
    normalized.push(code);
  });

  const limited = normalized.slice(0, Math.max(1, state.bubbleRows || 1));
  const changed =
    limited.length !== original.length ||
    limited.some((code, idx) => code !== original[idx]);

  if (changed) state.selectedCodes = limited;
  return changed;
}

// 本地兜底 field map，启动时会被服务端数据覆盖
let SSE_FIELD_MAP = {
  'comex':   { code: 'hf_GC',              name: '纽约金',    currency: '$' },
  'lbma':    { code: 'hf_XAU',             name: '伦敦金',    currency: '$' },
  'autd':    { code: 'gds_AUTD',           name: '黄金延期',  currency: '¥' },
  'lbma_jd': { code: 'WG-XAUUSD',         name: '伦敦金JD',  currency: '$' },
  'sge':     { code: 'SGE-Au',             name: '上海金',    currency: '¥' },
  'cnh':     { code: 'FX-USDCNH',          name: '离岸人民币', currency: '¥' },
  'xag':     { code: 'hf_XAG',             name: '伦敦银',    currency: '$' },
};

let _sseSchema = [];

function _pushStreamMessage(message) {
  _sseMessageRing.push(message);
  if (_sseMessageRing.length > SSE_RING_LIMIT) {
    _sseMessageRing.splice(0, _sseMessageRing.length - SSE_RING_LIMIT);
  }
  _streamMetrics.recentMessages = _sseMessageRing.length;
}

function _compactPricesForSnapshot(prices) {
  return (prices || []).map((price) => ({
    code: price.code,
    name: price.name,
    value: Number(price.value),
    currency: price.currency,
  }));
}

function _broadcastPricesSnapshot(prices, rawMessage) {
  if (_isPageUnloading) return;
  const snapshot = {
    ts: Date.now(),
    prices: _compactPricesForSnapshot(prices),
  };
  _sseLatestSnapshot = snapshot;
  _pushStreamMessage({
    ts: snapshot.ts,
    size: rawMessage ? rawMessage.length : 0,
    count: snapshot.prices.length,
  });
  try {
    emit('prices-snapshot', snapshot);
    if (_markManagerLogFlag('snapshot_broadcast_first')) {
      appLog('info', 'manager', 'snapshot_broadcast', 'price snapshot broadcast to bubble', {
        pricesCount: snapshot.prices.length,
        rawMessageSize: rawMessage ? rawMessage.length : 0,
      });
    }
  } catch (_) {}
}

function _isExpectedAbortError(error) {
  if (!error) return false;
  return error.name === 'AbortError' || /aborted/i.test(String(error.message || error));
}

function _processPriceSnapshot(prices, rawMessage) {
  if (!prices || prices.length === 0) return;
  clearManagedTimeout('manager-sse-first-payload-watchdog');
  state.prices = prices;
  DataSource.savePrices(prices);
  if (localStorage.getItem('selectedCodes') === null && state.selectedCodes.length === 0) {
    state.selectedCodes = prices.slice(0, 2).map(p => p.code);
    saveState();
  }
  updatePriceValues(prices);
  _updateTodayCandle(prices);
  if (window.warehouseModule) {
    window.warehouseModule.updatePrices(prices);
    if (window.warehouseModule.updateWarehouseRealTimeData) {
      window.warehouseModule.updateWarehouseRealTimeData();
    }
  }
  _broadcastPricesSnapshot(prices, rawMessage);
  _setConnectionOnline(true, 'snapshot_received');
  updatePnlSummary();
  renderPreview();
}

function _processQueuedSsePayload() {
  _sseProcessScheduled = false;
  const payload = _sseQueuedPayload;
  _sseQueuedPayload = null;
  _streamMetrics.pendingQueueLength = 0;
  if (!payload || _sseSchema.length === 0) return;

  const now = Date.now();
  if (! _streamMetrics.windowStartedAt || now - _streamMetrics.windowStartedAt >= 1000) {
    _streamMetrics.windowStartedAt = now;
    _streamMetrics.processedInWindow = 0;
  }
  _streamMetrics.processedInWindow += 1;
  const prices = _buildPricesFromSSE(payload);
  if (!prices.length) return;
  _processPriceSnapshot(prices, payload);
}

function _enqueueSsePayload(payload) {
  if (!payload || payload.length > SSE_MAX_MESSAGE_CHARS) return;
  _streamMetrics.lastMessageSize = payload.length;
  const now = Date.now();
  if (!_streamMetrics.windowStartedAt || now - _streamMetrics.windowStartedAt >= 1000) {
    _streamMetrics.windowStartedAt = now;
    _streamMetrics.processedInWindow = 0;
  }
  _sseQueuedPayload = payload;
  _streamMetrics.pendingQueueLength = 1;
  if (_streamMetrics.processedInWindow >= SSE_MAX_MESSAGES_PER_SECOND && _sseProcessScheduled) {
    return;
  }
  if (_sseProcessScheduled) return;
  _sseProcessScheduled = true;
  setManagedTimeout('manager-sse-process', _processQueuedSsePayload, 0);
}

async function _consumeSseResponse(response) {
  if (!response.ok || !response.body) {
    throw new Error(`SSE HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  _sseReader = reader;
  _streamMetrics.hasActiveReader = true;
  const decoder = new TextDecoder('utf-8');
  _ssePendingChunk = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      _ssePendingChunk += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      if (_ssePendingChunk.length > SSE_MAX_PENDING_CHARS) {
        throw new Error('SSE pending chunk overflow');
      }

      let boundary = _ssePendingChunk.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = _ssePendingChunk.slice(0, boundary);
        _ssePendingChunk = _ssePendingChunk.slice(boundary + 2);
        const lines = frame.split(/\r?\n/);
        let eventName = 'message';
        const dataLines = [];
        lines.forEach((line) => {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        });
        const payload = dataLines.join('\n');
        if (payload) {
          if (eventName === 'schema') {
            _sseSchema = payload.split(',');
            updateSseConnectedLabel();
            appLog('info', 'manager', 'sse_schema_received', 'sse schema received', {
              schemaCount: _sseSchema.length,
              schemaSample: _sseSchema.slice(0, 4),
            });
          } else {
            _enqueueSsePayload(payload);
          }
        }
        boundary = _ssePendingChunk.indexOf('\n\n');
      }
    }
  } finally {
    if (_sseReader === reader) _sseReader = null;
    _streamMetrics.hasActiveReader = false;
    try { reader.releaseLock(); } catch (_) {}
  }
}

async function _fetchFieldMap(options = {}) {
  try {
    const map = await DataSource.ensureFieldMap(options);
    if (!map || typeof map !== 'object') return;
    if (Object.keys(map).length > 0) {
      SSE_FIELD_MAP = map;
      if (typeof DataSource !== 'undefined') DataSource.updateFromFieldMap(map);
    }
  } catch (_) {}
}


function _buildPricesFromSSE(dataStr) {
  const vals = dataStr.split(',').map(Number);
  const prices = [];
  _sseSchema.forEach((fieldName, i) => {
    const def = SSE_FIELD_MAP[fieldName];
    if (!def || isNaN(vals[i]) || vals[i] <= 0) return;
    prices.push({ code: def.code, name: def.name, value: vals[i], currency: def.currency });
  });
  const ny = prices.find(p => p.code === 'hf_GC');
  const lon = prices.find(p => p.code === 'hf_XAU');
  if (ny && lon) {
    prices.push({ code: 'CALC_NY_LON_DIFF', name: '纽伦差', value: ny.value - lon.value, currency: '$' });
    if (lon.value !== 0) {
      prices.push({ code: 'CALC_NY_LON_DIFF_PCT', name: '纽伦比', value: ((ny.value - lon.value) / lon.value) * 100, currency: '%' });
    }
  }
  return prices;
}

function _connectSSE() {
  if (_sseAbortController || _sseReconnectPending) return;
  const sseBaseUrl = _getSseBaseUrl();
  if (!sseBaseUrl) return;
  _sseAbortController = new AbortController();
  const controller = _sseAbortController;
  _streamMetrics.hasActiveReader = false;
  setManagedTimeout('manager-sse-first-payload-watchdog', () => {
    if (_isPageUnloading || controller.signal.aborted) return;
    if (_sseLatestSnapshot && Date.now() - _sseLatestSnapshot.ts < SSE_FIRST_PAYLOAD_TIMEOUT_MS) return;
    appLog('warn', 'manager', 'sse_first_payload_timeout', 'sse first payload timed out', {
      timeoutMs: SSE_FIRST_PAYLOAD_TIMEOUT_MS,
      ..._getManagerDataSummary(),
    });
    _setConnectionOnline(false, 'sse_first_payload_timeout');
    _disconnectSSE();
    _sseReconnectPending = true;
    _sseReconnectTimer = setManagedTimeout('manager-sse-reconnect', () => {
      _sseReconnectPending = false;
      _sseReconnectTimer = null;
      _connectSSE();
    }, 0);
  }, SSE_FIRST_PAYLOAD_TIMEOUT_MS);

  fetch(sseBaseUrl, {
    method: 'GET',
    cache: 'no-store',
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  })
    .then((response) => {
      appLog('info', 'manager', 'sse_connected', 'sse connection established', {
        status: response.status,
        sseBaseUrl,
      });
      return _consumeSseResponse(response);
    })
    .then(() => {
      if (controller.signal.aborted) return;
      if (_isPageUnloading) return;
      _setConnectionOnline(false, 'sse_stream_closed');
      _disconnectSSE();
      if (_sseReconnectPending) return;
      _sseReconnectPending = true;
      _sseReconnectTimer = setManagedTimeout('manager-sse-reconnect', () => {
        _sseReconnectPending = false;
        _sseReconnectTimer = null;
        _connectSSE();
      }, SSE_RECONNECT_DELAY_MS);
    })
    .catch((error) => {
      if (controller.signal.aborted || _isExpectedAbortError(error) || _isPageUnloading) return;
      console.error('[SSE] stream error:', error);
      appLog('error', 'manager', 'sse_stream_error', 'sse stream error', {
        message: String(error?.message || error || ''),
        ..._getManagerDataSummary(),
      });
      _setConnectionOnline(false, 'sse_stream_error');
      _disconnectSSE();
      if (_sseReconnectPending) return;
      _sseReconnectPending = true;
      _sseReconnectTimer = setManagedTimeout('manager-sse-reconnect', () => {
        _sseReconnectPending = false;
        _sseReconnectTimer = null;
        _connectSSE();
      }, SSE_RECONNECT_DELAY_MS);
    });
}

function _disconnectSSE() {
  const reader = _sseReader;
  _sseReader = null;
  if (reader) {
    try {
      const pendingCancel = reader.cancel();
      if (pendingCancel && typeof pendingCancel.catch === 'function') {
        pendingCancel.catch(() => {});
      }
    } catch (_) {}
  }
  if (_sseAbortController) {
    try { _sseAbortController.abort(); } catch (_) {}
    _sseAbortController = null;
  }
  if (_sseReconnectTimer) {
    clearManagedTimeout('manager-sse-reconnect');
    _sseReconnectTimer = null;
  }
  clearManagedTimeout('manager-sse-first-payload-watchdog');
  _sseReconnectPending = false;
  _sseSchema = [];
  _ssePendingChunk = '';
  _sseQueuedPayload = null;
  _sseProcessScheduled = false;
  _streamMetrics.hasActiveReader = false;
  _streamMetrics.pendingQueueLength = 0;
  const el = document.getElementById('sources-last-update');
  if (el) el.textContent = '';
}

function _manageSseConnection() {
  _connectSSE();
}

// ========== 交易时间提示 ==========
function updateTradingHoursTip() {}

// ========== 价格数据处理 ==========
async function fetchPrices() {
  updateTradingHoursTip();
  if (!DataSource.isTradingTime()) {
    if (state.prices.length > 0) {
      updatePriceValues(state.prices);
    }
    return state.prices;
  }
  try {
    // 每个数据源响应后立即热更新 manager UI，不通知气泡（避免气泡频繁重建）
    const prices = await DataSource.crawlAll((partial) => {
      if (!partial || partial.length === 0) return;
      state.prices = partial;
      updatePriceValues(partial);
      _setConnectionOnline(true, 'manual_partial_prices');
    });

    if (prices.length === 0) {
      _setConnectionOnline(false, 'manual_prices_empty');
      return [];
    }

    state.prices = prices;

    // 仅当用户从未保存过选择时（真正首次使用）才自动勾选前两个
    if (localStorage.getItem('selectedCodes') === null) {
      state.selectedCodes = DataSource.getFirstKeys(2);
      saveState();
      // 卡片可能已由 partial 回调渲染（彼时 selectedCodes 为空），补设选中状态
      const container = document.getElementById('price-select-list');
      if (container) {
        state.selectedCodes.forEach(code => {
          const card = container.querySelector(`.price-card[data-code="${code}"]`);
          if (card) {
            card.classList.add('selected');
            const cb = card.querySelector('.price-checkbox');
            if (cb) cb.checked = true;
          }
        });
      }
    }

    DataSource.savePrices(prices);
    _broadcastPricesSnapshot(prices);

    // 最终热更新数值，然后按数据源顺序重排卡片（仅移动节点，不重建）
    updatePriceValues(prices);
    _sortPriceCards();

    _setConnectionOnline(true, 'manual_prices_ready');

    if (window.warehouseModule) {
      window.warehouseModule.updatePrices(prices);
      if (window.warehouseModule.updateWarehouseRealTimeData) {
        window.warehouseModule.updateWarehouseRealTimeData();
      }
    }

    return prices;
  } catch (_) {
    _setConnectionOnline(false, 'manual_fetch_failed');
    return [];
  }
}

// ========== 页面导航 ==========
function switchView(viewId) {
  // 添加 view- 前缀（如果没有的话）
  const fullViewId = viewId.startsWith('view-') ? viewId : `view-${viewId}`;
  const wasChartActive = !!document.getElementById('view-chart')?.classList.contains('active');
  
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
    'view-chart': '行情走势',
    'chart': '行情走势',
    'view-bubble-style': '气泡设置',
    'bubble-style': '气泡设置',
    'view-settings': '应用设置',
    'settings': '应用设置'
  };
  const pageTitle = document.getElementById('page-title');
  if (pageTitle) {
    pageTitle.textContent = titles[fullViewId] || titles[viewId] || 'GoldPrice';
  }

  if (fullViewId === 'view-store' || viewId === 'store') {
    updateWarehouseSummaryDisplay();
  }

  if (fullViewId === 'view-settings' || viewId === 'settings') {
    _refreshTicketList();
  }

  if ((fullViewId === 'view-chart' || viewId === 'chart') && window.chartModule) {
    window.chartModule.onViewActivated();
  } else if (wasChartActive && window.chartModule?.onViewDeactivated) {
    window.chartModule.onViewDeactivated();
  }
}

// ========== 价格选择页面 ==========
function renderPriceListLoading() {
  const container = document.getElementById('price-select-list');
  if (!container) return;
  container.innerHTML = `
    <div class="price-list-loading">
      <span class="price-list-loading-dot"></span>
      <span class="price-list-loading-dot"></span>
      <span class="price-list-loading-dot"></span>
      <span style="margin-left:10px;font-size:13px;color:var(--text-secondary);">数据抓取中，过程可能需要几秒钟…</span>
    </div>`;
}

function renderPriceListPlaceholders() {
  const container = document.getElementById('price-select-list');
  if (!container || state.prices.length > 0 || !DataSource.hasSources()) return;
  const items = DataSource.getAllItems();
  if (!items.length) return;
  if (localStorage.getItem('selectedCodes') === null && state.selectedCodes.length === 0) {
    state.selectedCodes = DataSource.getFirstKeys(2);
    saveState();
  }
  container.innerHTML = '';
  items.forEach(item => {
    container.appendChild(_createPriceCardEl({
      code: item.code,
      name: item.name,
      value: NaN,
      currency: item.currency,
      pending: true,
    }));
  });
  updatePriceSelectionUI();
}

// 创建单张价格卡片 DOM 元素
function _createPriceCardEl(price) {
  const isSelected = state.selectedCodes.includes(price.code);
  const displayName = getDisplayName(price.code, price.name);
  const currency = getCurrency(price.code);
  const value = fmt(price.value, 5);
  const div = document.createElement('div');
  div.className = `price-card${isSelected ? ' selected' : ''}${price.pending ? ' price-card-pending' : ''}`;
  div.dataset.code = price.code;
  div.setAttribute('role', 'button');
  div.setAttribute('tabindex', '0');
  div.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
  div.innerHTML = `
    <input type="checkbox" class="price-checkbox" id="price-${price.code}"
           ${isSelected ? 'checked' : ''} tabindex="-1" aria-hidden="true">
    <label for="price-${price.code}" class="price-card-label">
      <div class="price-card-left"><div class="price-card-name">${displayName}</div></div>
      <div class="price-card-right">
        <div class="price-card-value${price.pending ? ' price-card-value-pending' : ''}" data-code="${price.code}">${price.pending ? '等待行情' : value}</div>
        <div class="price-card-currency">${currency}</div>
      </div>
    </label>`;
  return div;
}

// 完整重建所有卡片 —— 仅在数据源结构变化时调用（首次渲染、手动更新数据源后）
function renderPriceList() {
  const container = document.getElementById('price-select-list');
  if (!container) return;
  container.innerHTML = '';
  state.prices.forEach(price => container.appendChild(_createPriceCardEl(price)));
  updatePriceSelectionUI();
}

// 按数据源顺序重排已有卡片（仅移动 DOM 节点，不销毁）
function _sortPriceCards() {
  const container = document.getElementById('price-select-list');
  if (!container) return;

  // 建立 code → card 映射，避免重复查询 DOM
  const cardMap = new Map();
  container.querySelectorAll('.price-card').forEach(card => {
    cardMap.set(card.dataset.code, card);
  });

  // 按数据源定义顺序依次 appendChild（移动到末尾），最终顺序与数据源一致
  const orderedCodes = DataSource.getAllItems().map(item => item.code);
  for (const code of orderedCodes) {
    const card = cardMap.get(code);
    if (card) container.appendChild(card);
  }
}

// ── 今日 K 线合成 ──────────────────────────────────────
const TODAY_CODE = { usd: 'hf_XAU', cny: 'SGE-Au' };

function _todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// SSE 只做价格显示，不参与绘图
function _updateTodayCandle(prices) {
  if (!window.chartModule) return;
  ['usd', 'cny'].forEach(market => {
    const entry = prices.find(p => p.code === TODAY_CODE[market]);
    if (!entry) return;
    const price = parseFloat(entry.price ?? entry.value);
    if (!isNaN(price) && price > 0) {
      window.chartModule.updateLivePrice(price, market);
    }
  });
}

// 热更新：只更新已有卡片的数值，新卡片直接追加（顺序由 _sortPriceCards 统一整理）
function updatePriceValues(prices) {
  const container = document.getElementById('price-select-list');
  if (!container) return;

  const loadingEl = container.querySelector('.price-list-loading');
  if (loadingEl) loadingEl.remove();

  // 建立 code → card 的快速映射
  const cardMap = new Map();
  container.querySelectorAll('.price-card').forEach(card => {
    cardMap.set(card.dataset.code, card);
  });

  const incomingCodes = new Set(prices.map(p => p.code));

  // 移除已不在数据源里的卡片
  cardMap.forEach((card, code) => {
    if (!incomingCodes.has(code)) card.remove();
  });

  prices.forEach(price => {
    const card = cardMap.get(price.code);
    if (card) {
      card.classList.remove('price-card-pending');
      const valueEl = card.querySelector('.price-card-value');
      if (valueEl) {
        valueEl.classList.remove('price-card-value-pending');
        const nv = fmt(price.value, 5);
        if (valueEl.textContent !== nv) valueEl.textContent = nv;
      }
    } else {
      container.appendChild(_createPriceCardEl(price));
    }
  });

  if (_normalizeSelectedCodes()) saveState();
  updatePriceSelectionUI();
}

function togglePriceSelection(code) {
  const index = state.selectedCodes.indexOf(code);
  const prevEmpty = state.selectedCodes.length === 0;
  if (index > -1) {
    state.selectedCodes.splice(index, 1);
  } else {
    if (state.selectedCodes.length >= state.bubbleRows) {
      showToast(`已达到上限（${state.bubbleRows} 个）。\n如需选更多，请在"价格选择"中增加行数上限（最高 8）。`);
      syncCardsUI();
      return;
    }
    state.selectedCodes.push(code);
  }

  syncCardsUI();
  saveState();
  renderPreview();

  const nowEmpty = state.selectedCodes.length === 0;
  if (nowEmpty && !prevEmpty) {
    appLog('info', 'manager', 'hide_bubble_requested', 'bubble hide requested from price selection', {
      reason: 'selection_became_empty',
      selectedCodes: state.selectedCodes.slice(),
    });
    invoke('hide_bubble').catch(() => {});
  } else if (!nowEmpty && prevEmpty) {
    appLog('info', 'manager', 'show_bubble_requested', 'bubble show requested from price selection', {
      reason: 'selection_became_non_empty',
      selectedCodes: state.selectedCodes.slice(),
    });
    invoke('show_bubble').catch(() => {});
  }
}

function syncCardsUI() {
  _normalizeSelectedCodes();
  const container = document.getElementById('price-select-list');
  if (container) {
    container.querySelectorAll('.price-card').forEach(card => {
      const code = card.dataset.code;
      const selected = state.selectedCodes.includes(code);
      card.classList.toggle('selected', selected);
      card.setAttribute('aria-pressed', selected ? 'true' : 'false');
      const cb = card.querySelector('.price-checkbox');
      if (cb) cb.checked = selected;
    });
  }
  const selectedCount = document.getElementById('selected-count');
  if (selectedCount) selectedCount.textContent = state.selectedCodes.length;
  const rowsLimit = document.getElementById('rows-limit');
  if (rowsLimit) rowsLimit.textContent = state.bubbleRows;
}

function updatePriceSelectionUI() {
  syncCardsUI();
}

function setupPriceSelectionInteractions() {
  const container = document.getElementById('price-select-list');
  if (!container || container.dataset.boundPriceSelection === '1') return;
  container.dataset.boundPriceSelection = '1';

  container.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const card = event.target.closest('.price-card');
    if (!card || !container.contains(card)) return;
    event.preventDefault();
    togglePriceSelection(card.dataset.code);
  });

  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.price-card');
    if (!card || !container.contains(card)) return;
    event.preventDefault();
    togglePriceSelection(card.dataset.code);
  });
}

function deselectAll() {
  if (state.selectedCodes.length === 0) return;
  state.selectedCodes = [];
  appLog('info', 'manager', 'hide_bubble_requested', 'bubble hide requested from deselect all', {
    reason: 'deselect_all',
    selectedCodes: [],
  });
  invoke('hide_bubble').catch(() => {});
  saveState();
  syncCardsUI();
  renderPreview();
}

// ========== 仓库管理页面 ==========
function renderWarehousePnlList() {
  const container = document.getElementById('pnl-warehouse-select');
  if (!container) return;

  const warehouses = loadWarehouses();
  const items = [{ id: '__total__', name: '总仓营收' }, ...warehouses.map(w => ({ id: w.id, name: w.name }))];
  const selectedCount = state.selectedPnlWarehouses.length;

  container.innerHTML = `
    <div class="pnl-warehouse-head">
      <p class="pnl-warehouse-hint">选择要在气泡中显示盈亏的仓库</p>
      <span class="pnl-warehouse-count">已选 ${selectedCount}</span>
    </div>
    <div class="pnl-warehouse-list" role="group" aria-label="气泡显示仓库盈亏">
      ${items.map(item => `
        <label class="pnl-warehouse-option ${state.selectedPnlWarehouses.includes(item.id) ? 'active' : ''}"
               style="-webkit-app-region:no-drag;pointer-events:auto;">
          <input
            class="pnl-warehouse-checkbox"
            type="checkbox"
            ${state.selectedPnlWarehouses.includes(item.id) ? 'checked' : ''}
            onchange="togglePnlWarehouse('${item.id}')"
          />
          <span class="pnl-warehouse-option-label">${item.name}</span>
        </label>
      `).join('')}
    </div>
  `;
}

function togglePnlWarehouse(id) {
  const index = state.selectedPnlWarehouses.indexOf(id);
  
  if (index > -1) {
    // 取消选中
    state.selectedPnlWarehouses.splice(index, 1);
  } else {
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
  } catch (_) {
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
  // 字体大小试管
  const fontTube = document.getElementById('font-tube');
  const fontSizeValue = document.getElementById('font-size-value');
  function _updateFontTube(val) {
    if (!fontTube) return;
    fontTube.querySelectorAll('.font-tube-cell').forEach(cell => {
      cell.classList.toggle('active', parseInt(cell.dataset.val) === val);
    });
    if (fontSizeValue) fontSizeValue.textContent = val;
  }
  if (fontTube) {
    _updateFontTube(state.bubbleFontSize);
    fontTube.querySelectorAll('.font-tube-cell').forEach(cell => {
      cell.addEventListener('click', () => {
        state.bubbleFontSize = parseInt(cell.dataset.val);
        _updateFontTube(state.bubbleFontSize);
        saveState();
        renderPreview();
      });
    });
  }

  const fontColorBtns = document.getElementById('font-color-btns');
  const fontColorRow = document.querySelector('.form-row-font-color');
  const updateFontColorVisibility = () => {
    if (fontColorRow) fontColorRow.style.display = state.bubbleMinimal ? '' : 'none';
  };
  if (fontColorBtns) {
    function _updateFontColorBtns(val) {
      fontColorBtns.querySelectorAll('.font-color-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.color === val);
      });
    }
    _updateFontColorBtns(state.bubbleFontColor);
    fontColorBtns.querySelectorAll('.font-color-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.bubbleFontColor = btn.dataset.color;
        _updateFontColorBtns(state.bubbleFontColor);
        saveState();
        renderPreview();
      });
    });
  }
  updateFontColorVisibility();

  // 气泡行数步进器（价格选择页）
  const stepVal = document.getElementById('rows-step-value');
  const stepDown = document.getElementById('rows-step-down');
  const stepUp   = document.getElementById('rows-step-up');
  function _applyBubbleRows(newRows) {
    const clamped = Math.max(1, Math.min(8, newRows));
    const oldRows = state.bubbleRows;
    state.bubbleRows = clamped;
    if (stepVal) stepVal.textContent = clamped;
    if (stepDown) stepDown.disabled = clamped <= 1;
    if (stepUp)   stepUp.disabled   = clamped >= 8;
    if (clamped < oldRows && state.selectedCodes.length > clamped) {
      state.selectedCodes.splice(clamped);
    }
    saveState();
    syncCardsUI();
    renderPreview();
  }
  if (stepVal) {
    stepVal.textContent = state.bubbleRows;
    if (stepDown) stepDown.disabled = state.bubbleRows <= 1;
    if (stepUp)   stepUp.disabled   = state.bubbleRows >= 8;
  }
  stepDown?.addEventListener('click', () => _applyBubbleRows(state.bubbleRows - 1));
  stepUp?.addEventListener('click',   () => _applyBubbleRows(state.bubbleRows + 1));

  // 主题配色
  const themeColorSelect = document.getElementById('theme-color-select');
  if (themeColorSelect) {
    themeColorSelect.value = state.bubbleTheme === 'dark' ? 'dark' : 'classic';
    themeColorSelect.addEventListener('change', (e) => {
      const selectedTheme = e.target.value === 'dark' ? 'dark' : 'light';
      state.bubbleTheme = selectedTheme;
      state.bubbleThemeColor = 'blue';
      document.body.setAttribute('data-theme', state.bubbleTheme);
      document.body.setAttribute('data-theme-color', state.bubbleThemeColor);
      saveState();
      setupTheme();
      renderPreview();
      if (window.chartModule) window.chartModule.onThemeChange();
    });
  }

  // 摸鱼模式（仅数字+边框）
  const minimalCheckbox = document.getElementById('bubble-minimal');
  
  if (minimalCheckbox) {
    minimalCheckbox.checked = state.bubbleMinimal;
    
    minimalCheckbox.addEventListener('change', (e) => {
      state.bubbleMinimal = e.target.checked;
      updateFontColorVisibility();
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

function _ticketStatusLabel(status) {
  switch (status) {
    case 'pending': return '未处理';
    case 'processing': return '处理中';
    case 'resolved': return '已处理';
    case 'closed': return '已关闭';
    default: return status || '未知';
  }
}

function _setTicketReplyDot(visible) {
  const dot = document.getElementById('ticket-reply-dot');
  if (dot) dot.style.display = visible ? '' : 'none';
}

function _setTicketHistoryBadge(visible) {
  const badge = document.getElementById('ticket-open-history-badge');
  if (badge) badge.style.display = visible ? '' : 'none';
}

function _loadTicketSeenReplyMap() {
  try {
    const raw = localStorage.getItem('ticketSeenReplyAtMap') || '{}';
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function _saveTicketSeenReplyMap(map) {
  try {
    localStorage.setItem('ticketSeenReplyAtMap', JSON.stringify(map || {}));
  } catch (_) {}
}

function _getTicketLatestAdminReplyAt(item) {
  const fromMessages = (item?.messages || [])
    .filter(msg => msg?.author_type === 'admin' && msg?.created_at)
    .map(msg => msg.created_at)
    .sort()
    .pop() || '';
  const fromLatestReply = item?.latest_reply?.created_at || '';
  return [fromMessages, fromLatestReply].filter(Boolean).sort().pop() || '';
}

function _ticketHasUnreadReply(item, seenMap = null) {
  const map = seenMap || _loadTicketSeenReplyMap();
  const latestReplyAt = _getTicketLatestAdminReplyAt(item);
  if (!latestReplyAt) return false;
  const seenAt = map[String(item?.id || '')] || '';
  return !seenAt || latestReplyAt > seenAt;
}

function _getLatestUnreadTicketId() {
  const seenMap = _loadTicketSeenReplyMap();
  const unreadItems = _ticketItems
    .filter(item => _ticketHasUnreadReply(item, seenMap))
    .sort((a, b) => {
      const aTs = _getTicketLatestAdminReplyAt(a);
      const bTs = _getTicketLatestAdminReplyAt(b);
      return bTs.localeCompare(aTs);
    });
  return unreadItems[0]?.id || null;
}

function _getUnreadTicketCount() {
  const seenMap = _loadTicketSeenReplyMap();
  return _ticketItems.filter(item => _ticketHasUnreadReply(item, seenMap)).length;
}

function _refreshTicketReplyDot() {
  try {
    const unreadCount = _getUnreadTicketCount();
    const hasUnread = unreadCount > 0;
    _ticketUnreadCount = unreadCount;
    _setTicketReplyDot(hasUnread);
    _setTicketHistoryBadge(hasUnread);
  } catch (_) {
    _setTicketReplyDot(false);
    _setTicketHistoryBadge(false);
    _ticketUnreadCount = 0;
  }
}

function _markTicketReplySeen(ticketId) {
  if (!ticketId) return;
  try {
    const item = _ticketItems.find(entry => String(entry.id) === String(ticketId));
    const latestReplyAt = _getTicketLatestAdminReplyAt(item);
    if (!latestReplyAt) return;
    const seenMap = _loadTicketSeenReplyMap();
    seenMap[String(ticketId)] = latestReplyAt;
    _saveTicketSeenReplyMap(seenMap);
  } catch (_) {}
  _refreshTicketReplyDot();
}

function _setTicketSubmitMessage(message, isError = false) {
  const el = document.getElementById('ticket-submit-msg');
  if (!el) return;
  el.textContent = message || '';
  el.style.color = isError ? '#e35d3f' : '';
}

function _renderTicketImages() {
  const list = document.getElementById('ticket-image-list');
  const addBtn = document.getElementById('ticket-pick-images-btn');
  if (!list) return;
  list.innerHTML = _ticketImages.map((file, index) => `
    <div class="ticket-image-chip">
      <img class="ticket-image-thumb" src="${escapeHtml(file.previewUrl || '')}" alt="${escapeHtml(file.name)}" />
      <button class="ticket-image-remove" type="button" data-ticket-image-remove="${index}" aria-label="移除图片">×</button>
    </div>
  `).join('');
  list.querySelectorAll('[data-ticket-image-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = _ticketImages[Number(btn.dataset.ticketImageRemove)];
      if (item?.previewUrl) {
        try { URL.revokeObjectURL(item.previewUrl); } catch (_) {}
      }
      _ticketImages.splice(Number(btn.dataset.ticketImageRemove), 1);
      _renderTicketImages();
    });
  });
  if (addBtn) addBtn.style.display = _ticketImages.length >= 3 ? 'none' : '';
}

function _renderTicketList() {
  const list = document.getElementById('ticket-list');
  if (!list) return;
  if (!_ticketItems.length) {
    list.innerHTML = '<div class="ticket-empty-state">当前无工单</div>';
    return;
  }
  const seenMap = _loadTicketSeenReplyMap();
  list.innerHTML = _ticketItems.map((item) => {
    const hasUnreadReply = _ticketHasUnreadReply(item, seenMap);
    const isTarget = _ticketTargetId && String(_ticketTargetId) === String(item.id);
    return `
    <div class="ticket-list-item ${hasUnreadReply ? 'has-unread-reply' : ''} ${isTarget ? 'active ticket-list-item-target' : ''}" data-ticket-id="${item.id}">
      <div class="ticket-list-title-row">
        <strong>${escapeHtml(item.ticket_no || ('#' + item.id))}</strong>
        <div style="display:flex;align-items:center;gap:8px;">
          ${hasUnreadReply ? '<span class="ticket-unread-chip">新消息</span>' : ''}
          <span class="ticket-status-badge ${item.status}">${_ticketStatusLabel(item.status)}</span>
        </div>
      </div>
      <div style="margin-top:8px;font-size:14px;">${escapeHtml(item.title || '')}</div>
      <div class="text-secondary" style="margin-top:8px;font-size:12px;">${new Date(item.updated_at || item.created_at || Date.now()).toLocaleString()}</div>
      <div class="ticket-message-list">
        ${(item.messages || []).map((msg) => `
          <div class="ticket-message-item ${msg.author_type === 'admin' ? 'admin' : ''}">
            <div class="ticket-message-head">
              <strong>${escapeHtml(msg.name)}</strong>
              <span class="text-secondary" style="font-size:12px;">${new Date(msg.created_at).toLocaleString()}</span>
            </div>
            <div style="margin-top:8px;white-space:pre-wrap;line-height:1.7;">${escapeHtml(msg.message)}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  }).join('');
  list.querySelectorAll('.ticket-list-item[data-ticket-id]').forEach((itemEl) => {
    itemEl.addEventListener('click', () => {
      const ticketId = itemEl.dataset.ticketId;
      _ticketTargetId = ticketId;
      _markTicketReplySeen(ticketId);
      _renderTicketList();
      const targetEl = document.querySelector(`.ticket-list-item[data-ticket-id="${ticketId}"]`);
      if (targetEl) targetEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  });
  if (_ticketTargetId) {
    const targetEl = list.querySelector(`.ticket-list-item[data-ticket-id="${_ticketTargetId}"]`);
    if (targetEl) {
      setManagedTimeout('ticket-target-scroll', () => {
        targetEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 0);
    }
  }
}

async function _ticketFetch(path, options = {}) {
  const base = _ticketApiBase();
  if (!base) throw new Error('未配置工单服务地址');
  const url = `${base}${path}`;
  const init = {
    method: options.method || 'GET',
    cache: 'no-store',
    headers: options.headers || {},
    body: options.body
  };
  const resp = await fetch(url, init);
  const json = await resp.json().catch(() => ({ s: 'error', m: '工单服务返回异常' }));
  if (!resp.ok || json.s !== 'ok') throw new Error(json.m || '工单请求失败');
  return json.d;
}

async function _refreshTicketList() {
  _lastTicketRefreshAt = Date.now();
  const identity = await _syncClientIdentity();
  if (!identity?.install_id) return;
  try {
    const tickets = await _ticketFetch(`/api/client/tickets?install_id=${encodeURIComponent(identity.install_id)}`);
    _ticketItems = await Promise.all((tickets || []).map(async (item) => {
      try {
        const messages = await _ticketFetch(`/api/client/tickets/${item.id}/messages?install_id=${encodeURIComponent(identity.install_id)}`);
        return { ...item, messages: messages || [] };
      } catch (_) {
        return { ...item, messages: [] };
      }
    }));
    if (!_ticketTargetId) _ticketTargetId = _getLatestUnreadTicketId();
    _renderTicketList();
    _refreshTicketReplyDot();
    _ticketUnreadPollInitialized = true;
  } catch (err) {
    _setTicketSubmitMessage(err.message || '工单列表刷新失败', true);
  }
}

function _toggleTicketHistory(open, targetTicketId = null) {
  const overlay = document.getElementById('ticket-history-overlay');
  if (!overlay) return;
  _ticketHistoryOpen = !!open;
  if (open && targetTicketId) _ticketTargetId = targetTicketId;
  overlay.style.display = open ? 'flex' : 'none';
  if (open) {
    _refreshTicketList();
  } else {
    _ticketTargetId = null;
  }
}

async function _submitTicket() {
  const titleEl = document.getElementById('ticket-title');
  const emailEl = document.getElementById('ticket-email');
  const contentEl = document.getElementById('ticket-content');
  const includeLogsEl = document.getElementById('ticket-include-logs');
  const submitBtn = document.getElementById('ticket-submit-btn');
  if (!titleEl || !emailEl || !contentEl || !submitBtn) return;

  const title = titleEl.value.trim();
  const email = emailEl.value.trim();
  const content = contentEl.value.trim();
  if (!title || !email || !content) {
    _setTicketSubmitMessage('请完整填写标题、联系方式和工单内容', true);
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    _setTicketSubmitMessage('联系方式格式不正确', true);
    return;
  }
  if (content.length > 400) {
    _setTicketSubmitMessage('工单内容不能超过 400 字', true);
    return;
  }
  if (_ticketImages.length > 3) {
    _setTicketSubmitMessage('图片最多只能上传 3 张', true);
    return;
  }

  const identity = await _syncClientIdentity();
  if (!identity?.install_id) {
    _setTicketSubmitMessage('客户端身份初始化失败，请重试', true);
    return;
  }

  submitBtn.disabled = true;
  _setTicketSubmitMessage('工单提交中…');
  try {
    const includeLogs = !!includeLogsEl?.checked;
    await _appendTicketSeedLogs({ identity, includeLogs, title, email });
    const body = new FormData();
    body.append('title', title);
    body.append('email', email);
    body.append('content', content);
    body.append('install_id', identity.install_id);
    body.append('legacy_client_id', identity.legacy_client_id || '');
    body.append('app_version', localStorage.getItem('appVersion') || '');
    body.append('platform', 'windows');
    body.append('created_at', new Date().toISOString());
    _ticketImages.forEach((file) => body.append('images', file.file));

    let attachedLogBytes = 0;
    let attachedLogs = false;
    if (includeLogs) {
      try {
        let logs = await invoke('get_recent_client_logs');
        if (!logs) {
          await appLog('warn', 'ticket', 'no_logs_available_after_seed', 'ticket logs empty after seed', {
            includeLogs,
            ..._getManagerDataSummary(),
          });
          logs = await invoke('get_recent_client_logs');
        }
        if (!logs) {
          logs = _buildFallbackTicketLog({ identity, includeLogs, title, email });
        }
        if (logs) {
          attachedLogBytes = new TextEncoder().encode(logs).length;
          body.append('log', new Blob([logs], { type: 'application/jsonl' }), 'client-log.jsonl');
          attachedLogs = true;
        }
      } catch (_) {}
    }

    const base = _ticketApiBase();
    const resp = await fetch(`${base}/api/tickets`, {
      method: 'POST',
      body,
      cache: 'no-store',
    });
    const json = await resp.json().catch(() => ({ s: 'error', m: '工单服务返回异常' }));
    if (!resp.ok || json.s !== 'ok') throw new Error(json.m || '提交失败');

    titleEl.value = '';
    emailEl.value = email;
    contentEl.value = '';
    _ticketImages.forEach((file) => {
      if (file?.previewUrl) {
        try { URL.revokeObjectURL(file.previewUrl); } catch (_) {}
      }
    });
    _ticketImages = [];
    _renderTicketImages();
    const countEl = document.getElementById('ticket-content-count');
    if (countEl) countEl.textContent = '0 / 400';
    _setTicketSubmitMessage(`提交成功，工单编号 ${json.d.ticket || json.d.id}`);
    await appLog('info', 'ticket', 'submit_success', 'ticket submitted', {
      ticketId: json.d.id || null,
      includeLogsRequested: includeLogs,
      attachedLogs,
      attachedLogBytes,
      imageCount: _ticketImages.length,
    });
    await _refreshTicketList();
  } catch (err) {
    _setTicketSubmitMessage(err.message || '工单提交失败', true);
    await appLog('error', 'ticket', 'submit_failed', 'ticket submit failed', {
      message: err.message || '',
      includeLogsRequested: !!includeLogsEl?.checked,
      imageCount: _ticketImages.length,
    });
  } finally {
    submitBtn.disabled = false;
  }
}

function setupTicketCenter() {
  const titleEl = document.getElementById('ticket-title');
  const emailEl = document.getElementById('ticket-email');
  const contentEl = document.getElementById('ticket-content');
  const countEl = document.getElementById('ticket-content-count');
  const pickBtn = document.getElementById('ticket-pick-images-btn');
  const inputEl = document.getElementById('ticket-images-input');
  const submitBtn = document.getElementById('ticket-submit-btn');
  const refreshBtn = document.getElementById('ticket-refresh-btn');
  const openHistoryBtn = document.getElementById('ticket-open-history-btn');
  const historyOverlay = document.getElementById('ticket-history-overlay');
  const historyCloseBtn = document.getElementById('ticket-history-close');

  if (titleEl && !titleEl.dataset.bound) {
    titleEl.dataset.bound = '1';
    try { if (emailEl) emailEl.value = localStorage.getItem('ticketContactEmail') || ''; } catch (_) {}
  }

  if (emailEl && !emailEl.dataset.bound) {
    emailEl.dataset.bound = '1';
    emailEl.addEventListener('change', () => {
      try { localStorage.setItem('ticketContactEmail', emailEl.value.trim()); } catch (_) {}
    });
  }

  if (contentEl && !contentEl.dataset.bound) {
    contentEl.dataset.bound = '1';
    contentEl.addEventListener('input', () => {
      if (countEl) countEl.textContent = `${contentEl.value.length} / 400`;
    });
  }

  if (pickBtn && inputEl && !pickBtn.dataset.bound) {
    pickBtn.dataset.bound = '1';
    pickBtn.addEventListener('click', () => inputEl.click());
    inputEl.addEventListener('change', () => {
      const picked = Array.from(inputEl.files || []);
      const merged = [..._ticketImages];
      for (const file of picked) {
        if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
          _setTicketSubmitMessage(`图片格式不支持：${file.name}`, true);
          continue;
        }
        if (file.size > 1.5 * 1024 * 1024) {
          _setTicketSubmitMessage(`图片超过 1.5MB：${file.name}`, true);
          continue;
        }
        if (merged.length >= 3) {
          _setTicketSubmitMessage('图片最多只能上传 3 张', true);
          break;
        }
        merged.push({
          file,
          name: file.name,
          previewUrl: URL.createObjectURL(file),
        });
      }
      _ticketImages = merged.slice(0, 3);
      inputEl.value = '';
      _renderTicketImages();
    });
  }

  if (submitBtn && !submitBtn.dataset.bound) {
    submitBtn.dataset.bound = '1';
    submitBtn.addEventListener('click', _submitTicket);
  }

  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = '1';
    refreshBtn.addEventListener('click', _refreshTicketList);
  }

  if (openHistoryBtn && !openHistoryBtn.dataset.bound) {
    openHistoryBtn.dataset.bound = '1';
    openHistoryBtn.addEventListener('click', () => _toggleTicketHistory(true, _getLatestUnreadTicketId()));
  }

  if (historyCloseBtn && !historyCloseBtn.dataset.bound) {
    historyCloseBtn.dataset.bound = '1';
    historyCloseBtn.addEventListener('click', () => _toggleTicketHistory(false));
  }

  if (historyOverlay && !historyOverlay.dataset.bound) {
    historyOverlay.dataset.bound = '1';
    historyOverlay.addEventListener('click', (event) => {
      if (event.target === historyOverlay) {
        _toggleTicketHistory(false);
      }
    });
  }

  _syncClientIdentity();
  _refreshTicketList();
}

// ========== 应用设置页面 ==========
async function setupAppSettings() {
  // 开机自启 - 使用已经同步的状态
  const autoStartCheckbox = document.getElementById('auto-start');
  if (autoStartCheckbox) {
    // 使用在 init() 中已经同步的状态
    autoStartCheckbox.checked = state.autoStart;
    
    autoStartCheckbox.addEventListener('change', async (e) => {
      state.autoStart = e.target.checked;
      await saveState();
      try {
        await invoke('set_auto_start', { enabled: state.autoStart });
      } catch (_) {
      }
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

  setupTicketCenter();
}

function exportData() {
  try {
    const data = {
      version: '1.0',
      timestamp: Date.now(),
      config: { ...state },
      identity: _clientIdentity ? {
        installId: _clientIdentity.install_id || '',
        legacyClientId: _clientIdentity.legacy_client_id || '',
        createdAt: _clientIdentity.created_at || '',
      } : null,
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
  } catch (_) {
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
      } catch (_) {
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
  } catch (_) {
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

  setManagedInterval('theme-cloud-animation', () => {
    cloudSons.forEach(moveElementRandomly);
  }, 1000);
  
  // 切换到dark/light
  const switchToDark = () => {
    mainButton.style.transform = 'translateX(23px)';
    mainButton.style.backgroundColor = 'rgba(195, 200, 210, 1)';
    mainButton.style.boxShadow = '1px 1px 2px rgba(0, 0, 0, 0.5), inset -1px -2px 1px -1px rgba(0, 0, 0, 0.5), inset 2px 2px 1px -1px rgba(255, 255, 210, 1)';
    daytimeBackground[0].style.transform = 'translateX(23px)';
    daytimeBackground[1].style.transform = 'translateX(16px)';
    daytimeBackground[2].style.transform = 'translateX(10px)';
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

  if (themeToggle.dataset.bound === '1') return;
  themeToggle.dataset.bound = '1';

  const onToggleClick = () => {
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
    if (window.chartModule) window.chartModule.onThemeChange();
  };

  const onMouseEnter = () => {
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
  };

  const onMouseLeave = () => {
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
  };

  themeToggle.addEventListener('click', onToggleClick);
  mainButton.addEventListener('mouseenter', onMouseEnter);
  mainButton.addEventListener('mouseleave', onMouseLeave);
  registerCleanup(() => {
    themeToggle.removeAttribute('data-bound');
    themeToggle.removeEventListener('click', onToggleClick);
    mainButton.removeEventListener('mouseenter', onMouseEnter);
    mainButton.removeEventListener('mouseleave', onMouseLeave);
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
        if (getCurrency(w.refPrice) === '￥' || getCurrency(w.refPrice) === '¥') totalPnl += pnl;
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
  if (state.bubbleMinimal) previewClass = 'minimal';
  const themeColor = state.bubbleThemeColor || 'blue';
  
  preview.className = 'bubble-preview-content ' + previewClass;
  preview.setAttribute('data-theme', state.bubbleTheme);
  preview.setAttribute('data-theme-color', themeColor);
  preview.style.fontSize = state.bubbleFontSize + 'px';
  preview.style.opacity = state.bubbleOpacity / 100;
  const _colorMap = { white: '#ffffff', black: '#000000', default: '' };
  preview.style.color = state.bubbleMinimal ? (_colorMap[state.bubbleFontColor] || '') : '';
  
  preview.innerHTML = `
    <div class="preview-header">
      <span class="preview-title">预览效果</span>
      <span class="status-dot ${_connectionOnline ? 'online' : 'offline'}"></span>
    </div>
    ${selectedPrices.map(price => {
      const displayName = getDisplayName(price.code, price.name);
      return `
        <div class="preview-line">
          <span class="preview-name">${displayName}</span>
          <span class="preview-value">${fmt(price.value, 2)} ${getCurrency(price.code)}</span>
        </div>
      `;
    }).join('')}
    ${selectedPnls.length > 0 ? `
      <div class="preview-separator"></div>
      ${selectedPnls.map(item => {
        return `
          <div class="preview-line pnl ${item.pnl >= 0 ? 'profit' : 'loss'}">
            <span class="preview-name">${item.name}</span>
            <span class="preview-value">${item.pnl >= 0 ? '+' : ''}${fmt(item.pnl, 2)} ${item.currency || '￥'}</span>
          </div>
        `;
      }).join('')}
    ` : ''}
  `;
}

// ========== 数据源更新红点 ==========

// ========== 更新数据源 ==========
async function handleUpdateSources() {
  const btn = document.getElementById('update-sources-btn');
  const now = Date.now();
  if (_updateSourcesInFlight || now < _updateSourcesCooldownUntil) return;
  _updateSourcesInFlight = true;
  _updateSourcesCooldownUntil = now + UPDATE_SOURCES_COOLDOWN_MS;
  if (btn) { btn.disabled = true; btn.textContent = '连接中...'; }
  try {
    const fieldMapTask = DataSource.ensureFieldMap({ force: true })
      .then((map) => {
        if (map && typeof map === 'object' && Object.keys(map).length > 0) {
          SSE_FIELD_MAP = map;
          DataSource.updateFromFieldMap(map);
          renderPriceListPlaceholders();
        }
      })
      .catch(() => {});
    _disconnectSSE();
    await fieldMapTask;
    _manageSseConnection();
  } finally {
    const remaining = Math.max(0, _updateSourcesCooldownUntil - Date.now());
    setManagedTimeout('manager-update-sources-unlock', () => {
      _updateSourcesInFlight = false;
      if (btn) { btn.disabled = false; btn.textContent = '重新连接'; }
    }, remaining);
  }
}

function updateSourcesLastUpdateLabel() {}

function updateSseConnectedLabel() {
  const el = document.getElementById('sources-last-update');
  if (!el) return;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  el.textContent = `连接已建立: ${hh}:${mm}:${ss}`;
}

// ========== 版本更新检测 ==========

// 语义版本比较：返回 true 表示 a < b（a 低于 b）
function semverLt(a, b) {
  const parse = v => String(v).replace(/^v/, '').split('.').map(n => parseInt(n) || 0);
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return a1 < b1;
  if (a2 !== b2) return a2 < b2;
  return a3 < b3;
}

function _setAppUpdateDot(visible) {
  const d1 = document.getElementById('app-update-dot');
  const d2 = document.getElementById('app-update-dot-settings');
  if (d1) d1.style.display = visible ? '' : 'none';
  if (d2) d2.style.display = visible ? '' : 'none';
}

function _clearPendingUpdate() {
  localStorage.removeItem('pendingUpdatePath');
  localStorage.removeItem('pendingUpdateVersion');
}

function _cleanupUpdateDownloads(keepPath = '') {
  try {
    return invoke('cleanup_update_downloads_cmd', { keepPath: keepPath || null });
  } catch (_) {
    return Promise.resolve();
  }
}

async function checkForUpdate() {
  try {
    let currentVersion = null;
    try { currentVersion = await invoke('get_app_version'); } catch (_) {}

    // 未能获取真实版本，跳过更新检测，防止误判
    if (!currentVersion || currentVersion === '0.0.0') return;

    localStorage.setItem('appVersion', currentVersion);
    const appVersionEl = document.getElementById('app-version');
    if (appVersionEl) appVersionEl.textContent = 'v' + currentVersion;

    const banner = document.getElementById('update-banner');

    // 每次都请求 /version，避免用心跳或本地待安装记录里的旧版本号拼下载链接。
    const updateInfo = await DataSource.checkUpdate();
    if (updateInfo && updateInfo.v && semverLt(currentVersion, updateInfo.v)) {
      const pendingVersion = localStorage.getItem('pendingUpdateVersion') || '';
      const pendingPath = localStorage.getItem('pendingUpdatePath') || '';
      if (pendingPath && pendingVersion === updateInfo.v) {
        _showInstallBanner(updateInfo.v);
        _setAppUpdateDot(true);
        return;
      }
      if (pendingPath) _clearPendingUpdate();

      const updateVersionEl = document.getElementById('update-version');
      if (banner && updateVersionEl) {
        updateVersionEl.textContent = 'v' + updateInfo.v;
        banner.style.display = 'block';
        banner._updateInfo = updateInfo;
        _setAppUpdateDot(true);
      }
    } else {
      if (banner) banner.style.display = 'none';
      _setAppUpdateDot(false);
      _clearPendingUpdate();
      _cleanupUpdateDownloads();
    }
  } catch (_) {}
}

function _showInstallBanner(version) {
  const banner = document.getElementById('update-banner');
  const updateVersionEl = document.getElementById('update-version');
  const downloadBtn = document.getElementById('download-update-btn');
  if (!banner) return;
  if (updateVersionEl && version) updateVersionEl.textContent = 'v' + version;
  if (downloadBtn) {
    downloadBtn.textContent = '安装更新';
    downloadBtn.dataset.mode = 'install';
    downloadBtn.style.display = '';
  }
  banner.style.display = 'block';
}

function _buildUpdateDownloadUrl(version) {
  const base = String(typeof COS_APK !== 'undefined' ? COS_APK : '').replace(/\/+$/, '');
  if (!base || !version) return '';
  return `${base}/GoldPrice_${version}_x64-setup.exe`;
}

function _appendDownloadCacheBust(url, version) {
  try {
    const finalUrl = new URL(url);
    finalUrl.searchParams.set('v', String(version || ''));
    finalUrl.searchParams.set('_ts', String(Date.now()));
    return finalUrl.toString();
  } catch (_) {
    const sep = String(url).includes('?') ? '&' : '?';
    return `${url}${sep}v=${encodeURIComponent(version || '')}&_ts=${Date.now()}`;
  }
}

function _newDownloadId() {
  return `dl-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function cancelActiveDownload() {
  const downloadId = _activeDownloadId;
  if (!downloadId) return;
  _downloadCancelled = true;
  _activeDownloadId = null;
  try { await invoke('cancel_download_update', { downloadId }); } catch (_) {}
  const progress = document.getElementById('download-progress');
  const btn = document.getElementById('download-update-btn');
  if (progress) progress.style.display = 'none';
  if (btn) {
    btn.style.display = '';
    btn.disabled = false;
    btn.dataset.mode = '';
    btn.textContent = '重新下载';
  }
  _showDownloadError('下载已取消，可重新下载');
}

async function handleDownloadUpdate() {
  const btn = document.getElementById('download-update-btn');

  if (btn && btn.dataset.mode === 'install') {
    const pending = localStorage.getItem('pendingUpdatePath');
    const pendingVersion = localStorage.getItem('pendingUpdateVersion') || '';
    if (!pending) {
      _clearPendingUpdate();
      _cleanupUpdateDownloads();
      btn.dataset.mode = '';
      btn.textContent = '下载更新';
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '检查中…'; }
    try {
      const latest = await DataSource.checkUpdate();
      const currentVersion = localStorage.getItem('appVersion') || '0.0.0';
      if (!latest?.v) {
        _clearPendingUpdate();
        _cleanupUpdateDownloads();
        btn.dataset.mode = '';
        btn.disabled = false;
        btn.textContent = '下载更新';
        const banner = document.getElementById('update-banner');
        if (banner) banner.style.display = 'none';
        _setAppUpdateDot(false);
        return;
      }
      if (latest?.v && semverLt(currentVersion, latest.v) && latest.v !== pendingVersion) {
        _clearPendingUpdate();
        _cleanupUpdateDownloads();
        btn.dataset.mode = '';
        btn.disabled = false;
        btn.textContent = '下载更新';
        const banner = document.getElementById('update-banner');
        const updateVersionEl = document.getElementById('update-version');
        if (banner && updateVersionEl) {
          updateVersionEl.textContent = 'v' + latest.v;
          banner.style.display = 'block';
          banner._updateInfo = latest;
          _setAppUpdateDot(true);
        }
        _showDownloadError('已有安装包不是最新版本，请重新下载');
        return;
      }
    } catch (_) {
      if (btn) { btn.disabled = false; btn.textContent = '安装更新'; }
      _showDownloadError('无法确认最新版本，请稍后重试');
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = '安装更新'; }
    try {
      await invoke('install_update', { path: pending });
    } catch (e) {
      _clearPendingUpdate();
      _cleanupUpdateDownloads();
      btn.dataset.mode = '';
      btn.textContent = '下载更新';
      alert('安装失败，请重新下载: ' + e.message);
    }
    return;
  }

  const banner = document.getElementById('update-banner');
  if (!banner || !banner._updateInfo) return;

  if (btn) { btn.disabled = true; btn.textContent = '检查中…'; }
  let info;
  try {
    const latest = await DataSource.checkUpdate();
    const currentVersion = localStorage.getItem('appVersion') || '0.0.0';
    if (latest && latest.v && semverLt(currentVersion, latest.v)) {
      info = latest;
      banner._updateInfo = latest;
      const updateVersionEl = document.getElementById('update-version');
      if (updateVersionEl) updateVersionEl.textContent = 'v' + latest.v;
    } else {
      banner.style.display = 'none';
      _setAppUpdateDot(false);
      if (btn) { btn.disabled = false; btn.textContent = '下载更新'; }
      return;
    }
  } catch (_) {
    _showDownloadError('无法确认最新版本，请稍后重试');
    if (btn) { btn.disabled = false; btn.textContent = '下载更新'; }
    return;
  }
  if (btn) { btn.disabled = false; btn.textContent = '下载更新'; }

  const progress = document.getElementById('download-progress');
  const progressBar = document.getElementById('download-progress-bar');
  const cancelBtn = document.getElementById('download-cancel-btn');

  if (btn) btn.style.display = 'none';
  if (progress) progress.style.display = 'block';
  if (cancelBtn) cancelBtn.style.display = '';

  const pctEl = document.getElementById('download-progress-pct');
  if (progressBar) progressBar.style.width = '0%';
  if (pctEl) pctEl.textContent = '连接中…';

  const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000; // 总兜底，真实连接/首包超时由 Rust 侧处理
  const TIMEOUT_ERR = '__DOWNLOAD_TIMEOUT__';
  const CANCEL_ERR = '__DOWNLOAD_CANCELLED__';

  let downloadSucceeded = false;
  let unlisten = null;
  const MAX_RETRIES = 3;
  const downloadId = _newDownloadId();
  _activeDownloadId = downloadId;
  _downloadCancelled = false;
  const downloadUrlBase = _buildUpdateDownloadUrl(info.v);
  if (!downloadUrlBase) {
    _activeDownloadId = null;
    if (progress) progress.style.display = 'none';
    if (btn) {
      btn.style.display = '';
      btn.disabled = false;
      btn.textContent = '下载更新';
    }
    _showDownloadError('下载地址生成失败，请检查 COS_APK 配置');
    return;
  }
  const downloadUrl = _appendDownloadCacheBust(downloadUrlBase, info.v);
  const filename = `GoldPrice_${info.v}_x64-setup.exe`;
  await _cleanupUpdateDownloads();
  if (cancelBtn) {
    cancelBtn.onclick = () => { cancelActiveDownload(); };
  }

  try {
    if (window.__TAURI__?.event?.listen) {
      unlisten = await window.__TAURI__.event.listen('download-progress', (event) => {
        if (event.payload) {
          if (event.payload.id && event.payload.id !== downloadId) return;
          if (_activeDownloadId !== downloadId) return;
          const pct = event.payload.percent || 0;
          if (progressBar) progressBar.style.width = pct + '%';
          if (pctEl) {
            pctEl.textContent = event.payload.phase === 'connecting' ? '连接中…' : pct + '%';
          }
        }
      });
    }

    let lastErr = null;
    let path = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (_downloadCancelled || _activeDownloadId !== downloadId) throw new Error(CANCEL_ERR);
      if (attempt > 1) {
        let remaining = 3;
        if (pctEl) pctEl.textContent = `连接中断，${remaining}秒后重试(${attempt}/${MAX_RETRIES})…`;
        let scanPct = 0, scanDir = 1;
        const scanTimer = setInterval(() => {
          scanPct += scanDir * 4;
          if (scanPct >= 55) scanDir = -1;
          if (scanPct <= 0) scanDir = 1;
          if (progressBar) progressBar.style.width = scanPct + '%';
        }, 80);
        const countTimer = setInterval(() => {
          remaining--;
          if (pctEl && remaining > 0) pctEl.textContent = `连接中断，${remaining}秒后重试(${attempt}/${MAX_RETRIES})…`;
        }, 1000);
        await new Promise(r => setTimeout(r, 3000));
        clearInterval(scanTimer);
        clearInterval(countTimer);
        if (progressBar) progressBar.style.width = '0%';
        if (pctEl) pctEl.textContent = '0%';
      }
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(TIMEOUT_ERR)), DOWNLOAD_TIMEOUT_MS)
        );
        path = await Promise.race([
          invoke('download_update', { url: downloadUrl, filename: filename, downloadId }),
          timeoutPromise,
        ]);
        if (_downloadCancelled || _activeDownloadId !== downloadId) throw new Error(CANCEL_ERR);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (e.message === TIMEOUT_ERR || e.message === CANCEL_ERR || String(e.message || e).includes('取消')) break;
      }
    }

    if (lastErr) throw lastErr;

    if (progressBar) progressBar.style.width = '100%';
    if (pctEl) pctEl.textContent = '100%';
    if (progress) progress.style.display = 'none';
    if (cancelBtn) cancelBtn.onclick = null;
    downloadSucceeded = true;
    _activeDownloadId = null;

    _showPostDownloadDialog(path, info.v);
  } catch (e) {
    if (_activeDownloadId === downloadId) {
      try { await invoke('cancel_download_update', { downloadId }); } catch (_) {}
      _activeDownloadId = null;
    }
    if (progress) progress.style.display = 'none';
    if (cancelBtn) cancelBtn.onclick = null;
    if (e.message === CANCEL_ERR || String(e.message || e).includes('取消')) {
      _showDownloadError('下载已取消，可重新下载');
    } else if (e.message === TIMEOUT_ERR) {
      _showDownloadError('当前下载新版本用户过多，请稍后重试');
    } else {
      _showDownloadError('下载失败：' + (e.message || e));
    }
  } finally {
    if (unlisten) unlisten();
    if (_activeDownloadId === downloadId) _activeDownloadId = null;
    if (!downloadSucceeded && btn) {
      btn.style.display = '';
      btn.dataset.mode = '';
      btn.disabled = false;
      btn.textContent = _downloadCancelled ? '重新下载' : '下载更新';
    }
  }
}

function _showDownloadError(msg) {
  const banner = document.getElementById('update-banner');
  if (!banner) return;
  let errEl = banner.querySelector('.download-error-msg');
  if (!errEl) {
    errEl = document.createElement('div');
    errEl.className = 'download-error-msg';
    banner.appendChild(errEl);
  }
  errEl.textContent = msg;
  errEl.style.display = 'block';
  // 6 秒后自动隐藏
  clearTimeout(errEl._hideTimer);
  errEl._hideTimer = setTimeout(() => { errEl.style.display = 'none'; }, 6000);
}

function _showPostDownloadDialog(path, version) {
  const overlay = document.getElementById('post-download-overlay');
  if (!overlay) {
    // 降级：直接安装
    invoke('install_update', { path }).catch(() => {});
    return;
  }
  overlay.style.display = 'flex';

  const nowBtn = document.getElementById('post-download-now');
  const laterBtn = document.getElementById('post-download-later');

  const cleanup = () => { overlay.style.display = 'none'; };

  nowBtn.onclick = async () => {
    cleanup();
    _clearPendingUpdate();
    _setAppUpdateDot(false);
    try {
      await invoke('install_update', { path: path });
    } catch (e) {
      alert('安装失败: ' + e.message);
      // 安装失败时恢复"安装更新"按钮
      _showInstallBanner(version || '');
    }
  };

  laterBtn.onclick = () => {
    cleanup();
    // 保留安装包路径，改变按钮状态
    localStorage.setItem('pendingUpdatePath', path);
    if (version) localStorage.setItem('pendingUpdateVersion', version);
    _cleanupUpdateDownloads(path);
    _showInstallBanner(version || '');
  };
}

function showToast(msg, { title = '提示', icon = 'ℹ️' } = {}) {
  const overlay = document.getElementById('toast-overlay');
  document.getElementById('toast-icon').textContent = icon;
  document.getElementById('toast-title').textContent = title;
  document.getElementById('toast-body').textContent = msg;
  overlay.style.display = 'flex';
  const ok = document.getElementById('toast-ok');
  if (ok._toastCloseHandler) ok.removeEventListener('click', ok._toastCloseHandler);
  const close = () => { overlay.style.display = 'none'; };
  ok._toastCloseHandler = close;
  ok.addEventListener('click', close);
}

// ========== 初始化 ==========
async function init() {
  if (_managerInitStarted) return;
  _managerInitStarted = true;
  appLog('info', 'manager', 'init_started', 'manager init started', {
    appVersion: localStorage.getItem('appVersion') || '',
    ..._getClientRuntimeSummary(),
  });
  loadState();

  // 若屏幕装不下默认窗口，按比例缩小窗口尺寸（与 HTML 早期 zoom 保持一致）
  const _appZoom = window.__appZoom || 1;
  if (_appZoom < 0.995) {
    try {
      const _win = window.__TAURI__?.window?.getCurrent?.();
      if (_win) {
        const _LogicalSize = window.__TAURI__.window.LogicalSize;
        await _win.setSize(new _LogicalSize(
          Math.round(1200 * _appZoom),
          Math.round(800 * _appZoom)
        ));
      }
    } catch (_) {}
  }
  invoke('fix_manager_dpi').catch(() => {});

  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'F12') {
      invoke('open_devtools', { label: 'manager' }).catch(() => {});
      return;
    }
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C'))) {
      e.preventDefault();
    }
  });

  // 自定义窗口控制按钮（无系统标题栏）
  const _appWin = window.__TAURI__?.window?.getCurrent?.();
  const _setWcMaxIcon = (maximized) => {
    const wcMaxBtn = document.getElementById('wc-max');
    if (!wcMaxBtn) return;
    wcMaxBtn.innerHTML = maximized
      ? '<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M6.2 4.2h7.6v7.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path><path d="M11.8 13.8H4.2V6.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path><path d="M13.8 4.2L8.4 9.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path></svg>'
      : '<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="4.2" y="4.2" width="9.6" height="9.6" rx="1.4" stroke="currentColor" stroke-width="1.6"></rect></svg>';
    wcMaxBtn.title = maximized ? '还原' : '最大化';
    wcMaxBtn.setAttribute('aria-label', maximized ? '还原' : '最大化');
  };
  document.getElementById('wc-min')?.addEventListener('click', () => _appWin?.minimize());
  document.getElementById('wc-close')?.addEventListener('click', () => _appWin?.hide());
  const wcMax = document.getElementById('wc-max');
  if (wcMax && _appWin) {
    _appWin.isMaximized().then(_setWcMaxIcon).catch(() => {});
    wcMax.addEventListener('click', async () => {
      const isMax = await _appWin.isMaximized().catch(() => false);
      if (isMax) {
        _appWin.unmaximize();
        _setWcMaxIcon(false);
      } else {
        _appWin.maximize();
        _setWcMaxIcon(true);
      }
    });
  }

  // 初始化 DataSource（同步，不阻塞）
  DataSource.init(httpFetch, state.serverUrl);
  DataSource.ensureFieldMap().then(() => {
    if (window.warehouseModule) {
      window.warehouseModule.renderWarehouseList();
    }
    renderWarehousePnlList();
  }).catch(() => {});
  _cleanupUpdateDownloads(localStorage.getItem('pendingUpdatePath') || '');

  // ── 第一步：立即完成所有同步 UI 初始化，保证交互可用 ──
  document.body.setAttribute('data-theme', state.bubbleTheme);
  document.body.setAttribute('data-theme-color', state.bubbleThemeColor || 'blue');
  setupTheme();
  setupBubbleSettings();
  renderWarehousePnlList();
  updateSourcesLastUpdateLabel();
  const fetchRateEl = document.getElementById('fetch-rate-sec');
  if (fetchRateEl) fetchRateEl.textContent = Math.round(state.refreshInterval / 1000);

  if (window.warehouseModule) {
    window.warehouseModule.renderWarehouseList();
  }

  // 价格列表先显示加载占位
  renderPriceListLoading();
  setupPriceSelectionInteractions();
  setManagedTimeout('manager-first-screen-server-message', () => {
    checkAndShowServerMessage();
  }, 0);

  // 设置导航
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const viewId = item.dataset.view;
      if (viewId) switchView(viewId);
    });
  });

  // 更新数据源按钮
  const updateSourcesBtn = document.getElementById('update-sources-btn');
  if (updateSourcesBtn) {
    updateSourcesBtn.addEventListener('click', handleUpdateSources);
  }

  // 刷新按钮

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

  // 下载更新按钮
  const downloadUpdateBtn = document.getElementById('download-update-btn');
  if (downloadUpdateBtn) {
    downloadUpdateBtn.addEventListener('click', handleDownloadUpdate);
  }

  // 检查更新按钮
  const checkUpdateBtn = document.getElementById('check-update-btn');
  if (checkUpdateBtn) {
    checkUpdateBtn.addEventListener('click', async () => {
      const resultEl = document.getElementById('check-update-result');
      checkUpdateBtn.disabled = true;
      if (resultEl) resultEl.textContent = '检查中…';
      try {
        const currentVersion = localStorage.getItem('appVersion');
        const updateInfo = await DataSource.checkUpdate();
        if (currentVersion && currentVersion !== '0.0.0' && updateInfo && updateInfo.v && semverLt(currentVersion, updateInfo.v)) {
          if (resultEl) resultEl.textContent = '发现新版本 v' + updateInfo.v + '，请前往侧边栏下载';
          // 同时触发侧边栏显示
          const banner = document.getElementById('update-banner');
          const updateVersionEl = document.getElementById('update-version');
          if (banner && updateVersionEl) {
            updateVersionEl.textContent = 'v' + updateInfo.v;
            banner.style.display = 'block';
            banner._updateInfo = updateInfo;
            _setAppUpdateDot(true);
          }
        } else {
          if (resultEl) resultEl.textContent = '当前已是最新版本';
          // 隐藏横幅，清除遗留的待安装记录
          const banner2 = document.getElementById('update-banner');
          if (banner2) banner2.style.display = 'none';
          _setAppUpdateDot(false);
          _clearPendingUpdate();
        }
      } catch (_) {
        if (resultEl) resultEl.textContent = '检查失败，请稍后重试';
      } finally {
        checkUpdateBtn.disabled = false;
      }
    });
  }

  // 清除全部数据并退出按钮
  const clearAndQuitBtn = document.getElementById('clear-and-quit-btn');
  if (clearAndQuitBtn) {
    clearAndQuitBtn.addEventListener('click', async () => {
      const confirmed = confirm('⚠️ 警告：清除全部数据并退出\n\n确定要清除所有数据并退出应用吗？\n\n此操作不可撤销，将删除：\n✓ 所有仓库数据\n✓ 所有交易记录\n✓ 所有配置设置\n\n应用将恢复到默认初始状态。');
      if (confirmed) {
        try {
          localStorage.clear();
          await invoke('clear_all_data_and_quit');
        } catch (err) {
          alert('清除数据失败: ' + err.message);
        }
      }
    });
  }

  // 监听来自托盘的开机自启状态变化
  if (window.__TAURI__?.event?.listen) {
    const listenFn = window.__TAURI__.event.listen;
    const unlisten = await listenFn('auto-start-changed', (event) => {
      const enabled = event.payload;
      state.autoStart = enabled;
      saveState();
      const autoStartCheckbox = document.getElementById('auto-start');
      if (autoStartCheckbox) autoStartCheckbox.checked = enabled;
    });
    registerCleanup(() => { try { unlisten(); } catch (_) {} });

    const unlistenSnapshotRequest = await listenFn('prices-snapshot-request', () => {
      if (_sseLatestSnapshot) {
        try { emit('prices-snapshot', _sseLatestSnapshot); } catch (_) {}
      }
    });
    registerCleanup(() => { try { unlistenSnapshotRequest(); } catch (_) {} });
  }

  // 监听窗口获得焦点时刷新开机自启状态
  const onWindowFocus = async () => {
    if (_isPageUnloading) return;
    const now = Date.now();
    if (now - _lastTicketRefreshAt > 4000) {
      _refreshTicketList().catch(() => {});
    }
    try {
      const enabled = await invoke('get_auto_start_status');
      if (_isPageUnloading) return;
      if (enabled !== state.autoStart) {
        state.autoStart = enabled;
        saveState();
        const autoStartCheckbox = document.getElementById('auto-start');
        if (autoStartCheckbox) autoStartCheckbox.checked = enabled;
      }
    } catch (_) {
    }
  };
  window.addEventListener('focus', onWindowFocus);
  registerCleanup(() => window.removeEventListener('focus', onWindowFocus));

  updateTradingHoursTip();

  // ── 第二步：后台异步完成耗时操作，不阻塞 UI ──
  _initAsync();
}

async function _initAsync() {
  if (_managerAsyncStarted) return;
  _managerAsyncStarted = true;
  // 同步开机自启状态
  let systemEnabled = false;
  try { systemEnabled = await invoke('get_auto_start_status'); } catch (_) {}
  if (_isPageUnloading) return;
  if (localStorage.getItem('autoStart') === null && !systemEnabled) {
    try { await invoke('set_auto_start', { enabled: true }); systemEnabled = true; } catch (_) {}
  }
  if (_isPageUnloading) return;
  state.autoStart = systemEnabled;
  localStorage.setItem('autoStart', state.autoStart.toString());

  setupAppSettings();
  renderPreview();

  sessionStorage.removeItem('eulaJustAccepted');
  await _fetchFieldMap({ force: true });
  if (_isPageUnloading) return;
  renderPriceListPlaceholders();
  _connectSSE();
  updatePnlSummary();
  renderPreview();

  setManagedTimeout('manager-warehouse-summary', () => updateWarehouseSummaryDisplay(), 300);
  setManagedTimeout('manager-check-update', () => checkForUpdate(), 3000);
  setManagedTimeout('manager-server-message-refresh', () => checkAndShowServerMessage(), 1500);
  setManagedTimeout('manager-heartbeat', async () => {
    await DataSource.sendHeartbeat();
  }, 8500);
}

// ========== 用户协议弹窗 ==========
function showEula(onAccept) {
  const overlay = document.getElementById('eula-overlay');
  const acceptBtn = document.getElementById('eula-accept-btn');
  const rejectBtn = document.getElementById('eula-reject-btn');
  const body = overlay.querySelector('.eula-body');

  overlay.style.display = 'flex';

  let eulaRead = false;
  const hintEl = document.getElementById('eula-hint-text');
  const scrollBarEl = document.getElementById('eula-scroll-bar');

  // 滚动进度条 + 解锁
  const onBodyScroll = () => {
    const scrollRatio = body.scrollTop / Math.max(1, body.scrollHeight - body.clientHeight);
    if (scrollBarEl) scrollBarEl.style.width = Math.min(100, scrollRatio * 100) + '%';

    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    if (nearBottom && !eulaRead) {
      eulaRead = true;
      acceptBtn.classList.remove('eula-btn-locked');
      if (hintEl) { hintEl.textContent = '已阅读完毕，可点击同意'; hintEl.style.opacity = '0.5'; }
    }
  };
  if (body._eulaScrollHandler) body.removeEventListener('scroll', body._eulaScrollHandler);
  body._eulaScrollHandler = onBodyScroll;
  body.addEventListener('scroll', onBodyScroll);

  if (acceptBtn._eulaClickHandler) acceptBtn.removeEventListener('click', acceptBtn._eulaClickHandler);
  acceptBtn._eulaClickHandler = () => {
    if (!eulaRead) {
      acceptBtn.classList.add('eula-btn-shake');
      setTimeout(() => acceptBtn.classList.remove('eula-btn-shake'), 500);
      if (hintEl) {
        hintEl.textContent = '请先阅读完整协议';
        hintEl.style.opacity = '1';
        hintEl.style.color = 'var(--accent-red, #e74c3c)';
      }
      return;
    }
    localStorage.setItem('eulaAccepted', '1');
    overlay.style.display = 'none';
    onAccept();
  };
  acceptBtn.addEventListener('click', acceptBtn._eulaClickHandler);

  if (rejectBtn._eulaClickHandler) rejectBtn.removeEventListener('click', rejectBtn._eulaClickHandler);
  rejectBtn._eulaClickHandler = async () => {
    try {
      await invoke('quit_app');
    } catch (_) {
      window.close();
    }
  };
  rejectBtn.addEventListener('click', rejectBtn._eulaClickHandler);
}

// ========== 服务器通知弹窗 ==========
async function checkAndShowServerMessage() {
  try {
    const msg = await DataSource.checkMessage();
    if (!msg) return;
    showServerMessage(msg);
  } catch (_) {
  }
}

function showServerMessage(msg) {
  const overlay = document.getElementById('server-message-overlay');
  const titleEl = document.getElementById('server-message-title');
  const bodyEl = document.getElementById('server-message-body');
  const urlEl = document.getElementById('server-message-url');
  const closeBtn = document.getElementById('server-message-close');

  if (!overlay) return;

  titleEl.textContent = msg.title || '通知';
  bodyEl.textContent = msg.body || '';

  if (msg.url) {
    urlEl.href = msg.url;
    urlEl.style.display = 'inline-flex';
  } else {
    urlEl.style.display = 'none';
  }

  overlay.style.display = 'flex';

  const dismiss = () => {
    overlay.style.display = 'none';
    DataSource.markMessageSeen(msg.id);
  };
  if (closeBtn._serverDismissHandler) closeBtn.removeEventListener('click', closeBtn._serverDismissHandler);
  closeBtn._serverDismissHandler = dismiss;
  closeBtn.addEventListener('click', dismiss);
}

// ========== 全局函数（供 HTML onclick 调用）==========
window.togglePriceSelection = togglePriceSelection;
window.togglePnlWarehouse = togglePnlWarehouse;
