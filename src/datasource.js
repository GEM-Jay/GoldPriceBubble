import { SERVER_URL, normalizeServerUrl, once } from './runtime.js';

const MAX_PRICE_ITEMS = 64;
const FIELD_MAP_TTL_MS = 10 * 60 * 1000;
const FIELD_MAP_TIMEOUT_MS = 4000;

let _heartbeatTimer = null;
let _latestPrices = [];
const _pendingControllers = new Set();

let _serverUrl = '';
let _codeToName = {};
let _codeToCurrency = {};
let _baseItems = [];
let _fieldMapBySourceKey = {};
let _fieldMapFetchPromise = null;
let _fieldMapFetchedAt = 0;
let _httpFetch = null;
let _log = async () => {};

function setLogger(logger) {
  _log = typeof logger === 'function' ? logger : async () => {};
}

function _normalizeApiBaseUrl(url) {
  return normalizeServerUrl(url, SERVER_URL);
}

function _normalizeFieldMapResponse(json) {
  if (!json || typeof json !== 'object') return null;
  const map = {};
  for (const [key, val] of Object.entries(json)) {
    if (Array.isArray(val) && val.length >= 3) {
      map[key] = { code: val[0], name: val[1], currency: val[2] };
    } else if (val && typeof val === 'object') {
      const code = val.code || key;
      const name = val.name || key;
      const currency = val.currency || '¥';
      map[key] = { code, name, currency };
    }
  }
  return Object.keys(map).length > 0 ? map : null;
}

function _appendCacheBust(url) {
  try {
    const finalUrl = new URL(url);
    finalUrl.searchParams.set('_ts', String(Date.now()));
    return finalUrl.toString();
  } catch (_) {
    const sep = String(url).includes('?') ? '&' : '?';
    return `${url}${sep}_ts=${Date.now()}`;
  }
}

function _getFieldMapSnapshot() {
  return Object.keys(_fieldMapBySourceKey).length
    ? Object.fromEntries(
      Object.entries(_fieldMapBySourceKey).map(([key, def]) => [key, { ...def }]),
    )
    : null;
}

function _getApiBaseUrl() {
  return _normalizeApiBaseUrl(_serverUrl || SERVER_URL);
}

function _getFieldsUrl() {
  const base = _getApiBaseUrl();
  return base ? `${base}/fields` : '';
}

function _applyFieldMap(map) {
  _codeToName = {};
  _codeToCurrency = {};
  _baseItems = [];
  _fieldMapBySourceKey = {};
  for (const [key, def] of Object.entries(map)) {
    const code = def.code || key;
    const name = def.name || key;
    const currency = def.currency || '¥';
    _codeToName[code] = name;
    _codeToCurrency[code] = currency;
    _fieldMapBySourceKey[key] = { code, name, currency };
    _baseItems.push({ code, name, currency });
  }
}

async function ensureFieldMap(options = {}) {
  const force = options.force === true;
  const now = Date.now();
  if (!force && _baseItems.length && (now - _fieldMapFetchedAt) < FIELD_MAP_TTL_MS) {
    return _getFieldMapSnapshot();
  }
  if (!force && _fieldMapFetchPromise) return _fieldMapFetchPromise;
  const fieldsUrl = _getFieldsUrl();
  if (!fieldsUrl) return null;

  if (once('datasource_fieldmap_fetch_started')) {
    _log('info', 'datasource_fieldmap_fetch_started', 'datasource field map fetch started', {
      fieldsUrl,
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    try { controller.abort(); } catch (_) {}
  }, FIELD_MAP_TIMEOUT_MS);
  _pendingControllers.add(controller);
  _fieldMapFetchPromise = (async () => {
    try {
      const resp = await fetch(_appendCacheBust(fieldsUrl), {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!resp.ok) return _getFieldMapSnapshot();
      const map = _normalizeFieldMapResponse(await resp.json());
      if (map) {
        _applyFieldMap(map);
        _fieldMapFetchedAt = Date.now();
        return map;
      }
      return _getFieldMapSnapshot();
    } catch (error) {
      await _log('error', 'datasource_fieldmap_fetch_failed', 'datasource field map fetch failed', {
        message: String(error?.message || error || ''),
        fieldsUrl,
      });
      return _getFieldMapSnapshot();
    } finally {
      clearTimeout(timeoutId);
      _pendingControllers.delete(controller);
      _fieldMapFetchPromise = null;
    }
  })();
  return _fieldMapFetchPromise;
}

async function init(httpFetch, serverUrl) {
  _httpFetch = httpFetch || null;
  _serverUrl = serverUrl;
  _latestPrices = [];
  try { localStorage.removeItem('cachedPrices'); } catch (_) {}
  await _log('info', 'datasource_module_initialized', 'datasource module initialized', {
    serverUrl: _normalizeApiBaseUrl(serverUrl),
    cachedPricesCount: 0,
  });
  try {
    await ensureFieldMap();
  } catch (_) {}
  if (_heartbeatTimer) clearTimeout(_heartbeatTimer);
  _heartbeatTimer = null;
  if (serverUrl) {
    _heartbeatTimer = setTimeout(() => {
      _heartbeatTimer = null;
      sendHeartbeat();
    }, 8000);
  }
}

function dispose() {
  if (_heartbeatTimer) clearTimeout(_heartbeatTimer);
  _heartbeatTimer = null;
  _pendingControllers.forEach((controller) => {
    try { controller.abort(); } catch (_) {}
  });
  _pendingControllers.clear();
}

function updateFromFieldMap(map) {
  _applyFieldMap(map);
}

function getCurrency(code) {
  if (code === 'CALC_NY_LON_DIFF_PCT') return '%';
  if (code === 'CALC_NY_LON_DIFF') return '$';
  return _codeToCurrency[code] || '¥';
}

function getDisplayName(code, fallback) {
  if (code === 'CALC_NY_LON_DIFF') return '纽伦差';
  if (code === 'CALC_NY_LON_DIFF_PCT') return '纽伦比';
  return _codeToName[code] || fallback || code;
}

function getAllItems() {
  return [
    ..._baseItems,
    { code: 'CALC_NY_LON_DIFF', name: '纽伦差', currency: '$' },
    { code: 'CALC_NY_LON_DIFF_PCT', name: '纽伦比', currency: '%' },
  ];
}

function getFirstKeys(n) {
  return _baseItems.slice(0, n).map((it) => it.code);
}

function _normalizePrice(price) {
  if (!price || !price.code) return null;
  const value = Number(price.value);
  return {
    code: String(price.code),
    name: price.name ? String(price.name) : '',
    value: Number.isFinite(value) ? value : 0,
    currency: price.currency ? String(price.currency) : getCurrency(price.code),
  };
}

function _compactPrices(prices) {
  const map = new Map();
  (prices || []).forEach((price) => {
    const normalized = _normalizePrice(price);
    if (normalized) map.set(normalized.code, normalized);
  });
  return Array.from(map.values()).slice(0, MAX_PRICE_ITEMS);
}

function savePrices(prices) {
  _latestPrices = _compactPrices(prices);
}

function loadPrices() {
  return _latestPrices.slice();
}

function _getOrCreateClientId() {
  try {
    let id = localStorage.getItem('clientId');
    if (!id) {
      id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
      });
      localStorage.setItem('clientId', id);
    }
    return id;
  } catch (_) {
    return null;
  }
}

async function _requestJson(path, options = {}) {
  const apiBaseUrl = _getApiBaseUrl();
  if (!apiBaseUrl) return null;
  const controller = new AbortController();
  _pendingControllers.add(controller);
  try {
    const requestInit = {
      method: options.method || 'GET',
      headers: options.headers || {},
      cache: 'no-store',
      signal: controller.signal,
    };
    if (options.payload !== undefined) {
      requestInit.headers = {
        'Content-Type': 'application/json',
        ...requestInit.headers,
      };
      requestInit.body = JSON.stringify(options.payload);
    }
    const resp = await fetch(_appendCacheBust(apiBaseUrl + path), requestInit);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    _pendingControllers.delete(controller);
  }
}

async function sendHeartbeat() {
  if (!_serverUrl) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem('lastHeartbeat') === today) return;
    const id = _getOrCreateClientId();
    if (!id) return;
    const data = await _requestJson('/ping', {
      method: 'POST',
      payload: { id, v: localStorage.getItem('appVersion') || '' },
    });
    try {
      if (data?.latest) {
        localStorage.setItem('latestVersion', data.latest);
        localStorage.setItem('latestVersionFetchedAt', String(Date.now()));
      }
    } catch (_) {}
    localStorage.setItem('lastHeartbeat', today);
  } catch (_) {}
}

async function crawlAll() { return []; }
function isTradingTime() { return true; }
function hasSources() { return _baseItems.length > 0; }
function getLastUpdate() { return null; }
function reloadFromStorage() {}

const dataSource = {
  init,
  dispose,
  sendHeartbeat,
  crawlAll,
  getAllItems,
  getCurrency,
  getDisplayName,
  updateFromFieldMap,
  hasSources,
  getLastUpdate,
  reloadFromStorage,
  savePrices,
  loadPrices,
  getFirstKeys,
  isTradingTime,
  ensureFieldMap,
  setLogger,
};

export { dataSource };
export default dataSource;
