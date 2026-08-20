import { SERVER_URL, TICKET_SERVER_URL } from './config.js';
import { checkUpdate as tauriCheckUpdate, installUpdate as tauriInstallUpdate, onUpdaterEvent } from '@tauri-apps/api/updater';

const _runtimeLogFlags = Object.create(null);

function once(key) {
  if (_runtimeLogFlags[key]) return false;
  _runtimeLogFlags[key] = true;
  return true;
}

function normalizeServerUrl(url, fallback = SERVER_URL) {
  const base = String(fallback || '').replace(/\/+$/, '');
  const raw = String(url || '').trim();
  if (!raw) return base;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return base;
    return raw.replace(/\/+$/, '');
  } catch (_) {
    return base;
  }
}

function getTauri() {
  return window.__TAURI__ || null;
}

function waitForTauri(callback) {
  if (getTauri()) {
    setTimeout(callback, 0);
  } else {
    setTimeout(() => waitForTauri(callback), 50);
  }
}

function getTauriApis() {
  const tauri = getTauri();
  return {
    tauri,
    invoke: tauri?.tauri?.invoke || null,
    emit: tauri?.event?.emit || null,
    listen: tauri?.event?.listen || null,
    httpFetch: tauri?.http?.fetch || null,
    appWindow: tauri?.window?.appWindow || null,
    currentWindow: tauri?.window?.getCurrent?.() || null,
    LogicalSize: tauri?.window?.LogicalSize || null,
    PhysicalSize: tauri?.window?.PhysicalSize || null,
    updater: tauri?.updater || null,
    checkUpdater: tauriCheckUpdate,
    installUpdater: tauriInstallUpdate,
    onUpdaterEvent,
  };
}

function getClientRuntimeSummary() {
  return {
    platform: navigator.platform || 'unknown',
    language: navigator.language || '',
    webviewDetected: !!window.chrome?.webview,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

async function appendClientLog(invoke, level, moduleName, event, message, context = null) {
  if (!invoke) return;
  try {
    await invoke('append_client_log', {
      level,
      module: moduleName,
      event,
      message,
      context,
    });
  } catch (_) {}
}

function createLogger(moduleName, getInvoke, contextFactory) {
  return async function log(level, event, message, context = null) {
    const invoke = typeof getInvoke === 'function' ? getInvoke() : getInvoke;
    const baseContext = typeof contextFactory === 'function' ? contextFactory() : null;
    const finalContext = baseContext || context ? { ...(baseContext || {}), ...(context || {}) } : null;
    await appendClientLog(invoke, level, moduleName, event, message, finalContext);
  };
}

function getTicketApiBase() {
  return String(TICKET_SERVER_URL || '').trim().replace(/\/+$/, '');
}

async function setPriceDisplayMode(mode) {
  const invoke = getTauriApis().invoke;
  if (!invoke) throw new Error('Tauri invoke is unavailable');
  return invoke('set_price_display_mode', { mode });
}

async function updateTaskbarDisplay(payload) {
  const invoke = getTauriApis().invoke;
  if (!invoke) return;
  return invoke('update_taskbar_display', { payload });
}

async function getTaskbarDisplayStatus() {
  const invoke = getTauriApis().invoke;
  if (!invoke) {
    return {
      supported: false,
      requestedMode: 'bubble',
      actualDisplay: 'bubble',
      attached: false,
      fallbackReason: 'unsupported_os',
      userVisible: false,
    };
  }
  return invoke('get_taskbar_display_status');
}

export {
  SERVER_URL,
  TICKET_SERVER_URL,
  appendClientLog,
  createLogger,
  getClientRuntimeSummary,
  getTauri,
  getTauriApis,
  getTaskbarDisplayStatus,
  getTicketApiBase,
  normalizeServerUrl,
  once,
  setPriceDisplayMode,
  updateTaskbarDisplay,
  waitForTauri,
};
