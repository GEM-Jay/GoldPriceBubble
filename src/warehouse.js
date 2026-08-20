import dataSource from './datasource.js';
import { createApp, h } from 'vue';
import { Button as TButton } from 'tdesign-vue-next';

// =========================
// warehouse.js - 仓库管理模块（重写 - 简洁版）
// =========================

let PRICES = [];
let currentWarehouseId = null;
let _newWarehousePriceTimer = null;
const _historyVisibleCounts = new Map();

function _clearNewWarehousePriceTimer() {
  if (_newWarehousePriceTimer !== null) {
    clearInterval(_newWarehousePriceTimer);
    _newWarehousePriceTimer = null;
  }
}
const HISTORY_VERSION = 4;
const COST_MODEL_VERSION = 4;
const MAX_HISTORY_ITEMS = 300;
let _notifySummary = null;

function _deriveLegacyRealizedPnl(warehouse) {
  if (warehouse.historyTrimmedAt || !Array.isArray(warehouse.history)) return 0;
  let grams = 0;
  let cost = 0;
  let realizedPnl = 0;
  for (const entry of warehouse.history) {
    const tradeGrams = Number(entry.grams) || 0;
    const tradePrice = Number(entry.price) || 0;
    if (entry.type === 'adjust') {
      // Older adjustment records stored grams in oldCost/newCost, so their cost basis
      // cannot be reconstructed reliably. Preserve current holdings and start realized
      // PnL tracking from zero rather than inventing a value.
      return 0;
    }
    if ((entry.type === 'buy' || entry.type === 'open') && tradeGrams > 0 && tradePrice > 0) {
      grams += tradeGrams;
      cost += tradeGrams * tradePrice;
    } else if (entry.type === 'sell' && tradeGrams > 0 && grams > 0) {
      const soldGrams = Math.min(tradeGrams, grams);
      const costBasis = cost * (soldGrams / grams);
      realizedPnl += soldGrams * tradePrice - costBasis;
      grams -= soldGrams;
      cost -= costBasis;
    }
  }
  return Number.isFinite(realizedPnl) ? realizedPnl : 0;
}

function _deriveLegacyCostState(warehouse, realizedPnl) {
  const storedCost = Number(warehouse?.totalCost) || 0;
  const history = Array.isArray(warehouse?.history) ? warehouse.history : [];
  if (!history.length || warehouse.historyTrimmedAt) {
    return {
      investedCost: storedCost - realizedPnl,
      inventoryCost: Math.max(0, storedCost),
    };
  }

  let grams = 0;
  let investedCost = 0;
  let inventoryCost = 0;
  for (const entry of history) {
    const tradeGrams = Math.max(0, Number(entry.grams) || 0);
    const tradePrice = Math.max(0, Number(entry.price) || 0);
    if (entry.type === 'buy' || entry.type === 'open') {
      const amount = tradeGrams * tradePrice;
      grams += tradeGrams;
      investedCost += amount;
      inventoryCost += amount;
    } else if (entry.type === 'sell' && grams > 0) {
      const soldGrams = Math.min(tradeGrams, grams);
      const proceeds = Number.isFinite(Number(entry.proceeds))
        ? Number(entry.proceeds)
        : soldGrams * tradePrice;
      const costBasis = Number.isFinite(Number(entry.costBasis))
        ? Number(entry.costBasis)
        : inventoryCost * (soldGrams / grams);
      grams -= soldGrams;
      investedCost -= proceeds;
      inventoryCost = grams > 0 ? Math.max(0, inventoryCost - costBasis) : 0;
    } else if (entry.type === 'adjust') {
      const newGrams = Math.max(0, Number(entry.newGrams ?? entry.newCost) || 0);
      const explicitCost = Number(entry.costAfter ?? entry.newCost);
      const newCostPrice = Number(entry.newCostPrice);
      const adjustedCost = Number.isFinite(explicitCost)
        ? explicitCost
        : newGrams * (Number.isFinite(newCostPrice) ? Math.max(0, newCostPrice) : 0);
      grams = newGrams;
      investedCost = adjustedCost;
      inventoryCost = Math.max(0, adjustedCost);
    }
  }
  return { investedCost, inventoryCost };
}

function _normalizeWarehouse(warehouse) {
  const totalGrams = Math.max(0, Number(warehouse?.totalGrams) || 0);
  const realizedPnl = warehouse?.costModelVersion >= 2
    ? (Number(warehouse.realizedPnl) || 0)
    : _deriveLegacyRealizedPnl(warehouse || {});
  const legacyCostState = warehouse?.costModelVersion >= 3
    ? null
    : _deriveLegacyCostState(warehouse || {}, realizedPnl);
  const totalCost = legacyCostState
    ? legacyCostState.investedCost
    : (Number(warehouse?.totalCost) || 0);
  const { inventoryCost: _oldInventoryCost, realizedPnl: _oldRealizedPnl, ...rest } = warehouse || {};
  return {
    ...rest,
    totalGrams,
    totalCost: Math.round((totalCost + Number.EPSILON) * 100) / 100,
    costModelVersion: COST_MODEL_VERSION,
    history: Array.isArray(warehouse?.history) ? warehouse.history : [],
  };
}

function _getCostMetrics(warehouse, currentPrice = 0) {
  const grams = Math.max(0, Number(warehouse?.totalGrams) || 0);
  const holdingCost = Number(warehouse?.totalCost) || 0;
  const currentValue = _roundMoney(grams * (Number(currentPrice) || 0));
  const totalPnl = _roundMoney(currentValue - holdingCost);
  // 工行口径：成本价是累计净投入除以当前持有份额。
  const avgCost = grams > 0 ? holdingCost / grams : 0;
  return { grams, holdingCost, currentValue, totalPnl, avgCost };
}

function _trimWarehouseHistory(warehouse) {
  const history = Array.isArray(warehouse.history) ? warehouse.history : [];
  if (history.length <= MAX_HISTORY_ITEMS) {
    return {
      ...warehouse,
      historyVersion: HISTORY_VERSION,
      history,
    };
  }

  const trimmed = history.slice(-MAX_HISTORY_ITEMS);
  const removed = history.slice(0, history.length - trimmed.length);
  const archiveSummary = {
    trimmedCount: removed.length,
    firstTimestamp: removed[0]?.timestamp || null,
    lastTimestamp: removed[removed.length - 1]?.timestamp || null,
    trimmedAt: Date.now(),
  };

  return {
    ...warehouse,
    historyVersion: HISTORY_VERSION,
    historyTrimmedAt: archiveSummary.trimmedAt,
    historyArchiveSummary: archiveSummary,
    history: trimmed,
  };
}

// ============================================
// 数据存储
// ============================================
function loadWarehouses() {
  try {
    const raw = localStorage.getItem('warehouses');
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const needsMigration = parsed.some(warehouse => warehouse?.costModelVersion !== COST_MODEL_VERSION);
    const normalized = parsed.map(_normalizeWarehouse);
    if (needsMigration) {
      localStorage.setItem('warehouses', JSON.stringify(normalized.map(_trimWarehouseHistory)));
    }
    return normalized;
  } catch (_) {
    return [];
  }
}

function saveWarehouses(list) {
  try {
    const normalized = Array.isArray(list)
      ? list.map(_normalizeWarehouse).map(_trimWarehouseHistory)
      : [];
    localStorage.setItem('warehouses', JSON.stringify(normalized));
    return true;
  } catch (_) {
    return false;
  }
}

// ============================================
// 工具函数
// ============================================
function getCurrency(code) {
  if (dataSource) return dataSource.getCurrency(code);
  if (code === 'CALC_NY_LON_DIFF_PCT') return '%';
  return '$';
}

function fmt(v, decimals = 2) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  const num = Number(v);
  return num.toFixed(decimals).replace(/\.?0+$/, '');
}

function fmtMoney(v) {
  const num = Number(v);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function _numberLoadingDotsMarkup() {
  return `<span class="number-loading-dots" role="status" aria-label="行情加载中">
    <span class="number-loading-dot"></span>
    <span class="number-loading-dot"></span>
    <span class="number-loading-dot"></span>
  </span>`;
}

function _getHistoryDisplayType(entry, historyIndex, warehouseId) {
  if (entry?.type === 'open') return 'open';
  const createdAt = Number(warehouseId);
  const timestamp = Number(entry?.timestamp);
  const isLegacyOpeningEntry = entry?.type === 'buy'
    && historyIndex === 0
    && Number.isFinite(createdAt)
    && Number.isFinite(timestamp)
    && Math.abs(timestamp - createdAt) <= 10000;
  return isLegacyOpeningEntry ? 'open' : entry?.type;
}

function _roundMoney(value) {
  return Math.round(((Number(value) || 0) + Number.EPSILON) * 100) / 100;
}

function formatDateTime(timestamp) {
  if (!timestamp) return '—';
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function _showWarehouseDialog({ title = '提示', message = '', details = [], type = 'info', confirmText = '确定', cancelText = '' }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'warehouse-dialog-overlay';
    overlay.innerHTML = `
      <div class="warehouse-dialog" role="dialog" aria-modal="true" aria-labelledby="warehouse-dialog-title">
        <div class="warehouse-dialog-main">
          <div class="warehouse-dialog-icon" aria-hidden="true"></div>
          <div class="warehouse-dialog-content">
            <h3 id="warehouse-dialog-title" class="warehouse-dialog-title"></h3>
          </div>
        </div>
        <p class="warehouse-dialog-message"></p>
        <dl class="warehouse-dialog-details"></dl>
        <div class="warehouse-dialog-actions"></div>
      </div>
    `;
    overlay.dataset.type = type;
    overlay.querySelector('.warehouse-dialog-title').textContent = title;
    const messageEl = overlay.querySelector('.warehouse-dialog-message');
    messageEl.textContent = message;
    messageEl.hidden = !message;
    const detailsEl = overlay.querySelector('.warehouse-dialog-details');
    const normalizedDetails = Array.isArray(details) ? details : [];
    normalizedDetails.forEach((detail) => {
      const row = document.createElement('div');
      row.className = 'warehouse-dialog-detail-row';
      const label = document.createElement('dt');
      label.textContent = detail?.label || '';
      const value = document.createElement('dd');
      value.textContent = detail?.value || '';
      row.append(label, value);
      detailsEl.appendChild(row);
    });
    detailsEl.hidden = normalizedDetails.length === 0;

    let buttonApp = null;
    let closed = false;
    const close = (result) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeydown);
      buttonApp?.unmount();
      overlay.classList.remove('is-visible');
      setTimeout(() => overlay.remove(), 140);
      resolve(result);
    };
    const onKeydown = (event) => {
      if (event.key === 'Escape') close(false);
      if (event.key === 'Enter') close(true);
    };
    const actionsEl = overlay.querySelector('.warehouse-dialog-actions');
    buttonApp = createApp({
      render() {
        const buttons = [];
        if (cancelText) {
          buttons.push(h(TButton, {
            class: 'warehouse-dialog-cancel',
            theme: 'default',
            variant: 'outline',
            size: 'small',
            onClick: () => close(false),
          }, () => cancelText));
        }
        buttons.push(h(TButton, {
          class: 'warehouse-dialog-confirm',
          theme: type === 'danger' ? 'danger' : 'primary',
          size: 'small',
          onClick: () => close(true),
        }, () => confirmText));
        return h('div', { class: 'warehouse-dialog-button-group' }, buttons);
      },
    });
    buttonApp.mount(actionsEl);

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay && cancelText) close(false);
    });
    document.addEventListener('keydown', onKeydown);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.add('is-visible');
      overlay.querySelector('.warehouse-dialog-confirm')?.focus();
    });
  });
}

function _showWarehouseNotice(message, type = 'success') {
  const titles = { success: '操作成功', error: '操作未完成', info: '提示' };
  let region = document.querySelector('.warehouse-toast-region');
  if (!region) {
    region = document.createElement('div');
    region.className = 'warehouse-toast-region';
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
  }
  const toast = document.createElement('div');
  toast.className = 'warehouse-toast';
  toast.dataset.type = type;
  toast.innerHTML = `
    <span class="warehouse-toast-icon" aria-hidden="true"></span>
    <span class="warehouse-toast-copy">
      <strong class="warehouse-toast-title"></strong>
      <span class="warehouse-toast-message"></span>
    </span>
  `;
  toast.querySelector('.warehouse-toast-title').textContent = titles[type] || titles.info;
  toast.querySelector('.warehouse-toast-message').textContent = message;
  region.appendChild(toast);
  while (region.children.length > 3) region.firstElementChild?.remove();
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  setTimeout(() => {
    toast.classList.remove('is-visible');
    setTimeout(() => {
      toast.remove();
      if (!region.children.length) region.remove();
    }, 180);
  }, type === 'error' ? 3600 : 2600);
}

function _confirmWarehouseAction(message, options = {}) {
  return _showWarehouseDialog({
    title: options.title || '请确认操作',
    message,
    details: options.details || [],
    type: options.danger ? 'danger' : 'info',
    confirmText: options.confirmText || '确认',
    cancelText: '取消',
  });
}

// 获取显示名称
function getDisplayName(code) {
  const mapped = dataSource.getDisplayName(code, '');
  if (mapped && mapped !== code) return mapped;
  const p = PRICES.find(p => p.code === code);
  if (p && p.name) return p.name;
  return code;
}

function getRefPriceItems() {
  const items = [];
  const seen = new Set();

  dataSource.getAllItems()
    .filter(item => getCurrency(item.code) === '¥')
    .forEach((item) => {
      if (seen.has(item.code)) return;
      seen.add(item.code);
      items.push({
        code: item.code,
        name: getDisplayName(item.code),
      });
    });

  PRICES
    .filter(p => getCurrency(p.code) === '¥')
    .forEach((p) => {
      if (seen.has(p.code)) return;
      seen.add(p.code);
      items.push({
        code: p.code,
        name: getDisplayName(p.code),
      });
    });

  return items;
}

function getRefPriceLabel(code) {
  const item = getRefPriceItems().find((entry) => entry.code === code);
  if (item && item.name) return item.name;
  return getDisplayName(code);
}

// ============================================
// 获取仓库总体统计
// ============================================
function getWarehouseSummary() {
  const warehouses = loadWarehouses();
  let totalGrams = 0;
  let totalCost = 0;
  let totalValue = 0;
  
  warehouses.forEach(w => {
    totalGrams += w.totalGrams || 0;
    totalCost += w.totalCost || 0;
    
    // 计算当前市值
    const priceObj = PRICES.find(p => p.code === w.refPrice);
    const currentPrice = priceObj?.value || 0;
    totalValue += (w.totalGrams || 0) * currentPrice;
  });
  
  totalCost = _roundMoney(totalCost);
  totalValue = _roundMoney(totalValue);
  const totalPnl = _roundMoney(totalValue - totalCost);
  
  return { totalGrams, totalCost, totalValue, totalPnl };
}

// ============================================
// 渲染仓库列表
// ============================================
function renderWarehouseList() {
  _clearNewWarehousePriceTimer();
  const warehouses = loadWarehouses();
  const container = document.getElementById('warehouse-list');
  if (!container) return;

  // 新建仓库按钮（放在顶部）
  const newWarehouseBtn = `
    <button class="warehouse-new-btn gp-btn-primary" data-action="show-new-warehouse">
      <span class="new-btn-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false"><path d="M12 6v12M6 12h12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
      </span>
      <span class="new-btn-copy">
        <span class="new-btn-text">新建仓库</span>
      </span>
    </button>
  `;

  if (warehouses.length === 0) {
    container.innerHTML = newWarehouseBtn + `
      <div class="empty-state">
        <p>暂无仓库</p>
      </div>
    `;
    document.getElementById('warehouse-detail').innerHTML = `
      <div class="empty-state">
        <p>请选择或创建一个仓库</p>
      </div>
    `;
    return;
  }

  const warehouseItemsHTML = warehouses.map(w => {
    const priceObj = PRICES.find(p => p.code === w.refPrice);
    const currentPrice = Number(priceObj?.value);
    const hasLivePrice = Number.isFinite(currentPrice) && currentPrice > 0;
    const metrics = _getCostMetrics(w, currentPrice);
    const pnl = metrics.totalPnl;
    const cost = w.totalCost || 0;
    
    return `
      <div class="warehouse-item ${currentWarehouseId === w.id ? 'active' : ''}" 
           data-id="${w.id}"
           data-action="select-warehouse">
        <div class="warehouse-item-top">
          <div class="warehouse-name">${w.name}</div>
          <div class="warehouse-item-badge">${getRefPriceLabel(w.refPrice)}</div>
        </div>
        <div class="warehouse-item-bottom">
          <span class="warehouse-stats-mini">总成本 ${fmt(cost, 2)}¥</span>
          <div class="warehouse-item-metrics">
            <span>${fmt(w.totalGrams, 2)}g</span>
            ${hasLivePrice
              ? `<span class="${pnl >= 0 ? 'metric-profit' : 'metric-loss'}">${pnl >= 0 ? '+' : ''}${fmt(pnl, 2)}¥</span>`
              : _numberLoadingDotsMarkup()}
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = newWarehouseBtn + warehouseItemsHTML;

  // 如果没有选中的仓库，选中第一个
  if (!currentWarehouseId && warehouses.length > 0) {
    currentWarehouseId = warehouses[0].id;
  }

  // 渲染详情
  if (currentWarehouseId) {
    renderWarehouseDetail(currentWarehouseId);
  }

  // 通知manager更新统计信息
  _notifySummary?.();
}

// ============================================
// 渲染仓库详情
// ============================================
function renderWarehouseDetail(id) {
  _clearNewWarehousePriceTimer();
  const warehouses = loadWarehouses();
  const warehouse = warehouses.find(w => w.id === id);
  if (!warehouse) {
    document.getElementById('warehouse-detail').innerHTML = '<div class="empty-state"><p>仓库不存在</p></div>';
    return;
  }

  currentWarehouseId = id;

  // 更新价格
  const priceObj = PRICES.find(p => p.code === warehouse.refPrice);
  const currentPrice = Number(priceObj?.value);
  const hasLivePrice = Number.isFinite(currentPrice) && currentPrice > 0;
  const currency = getCurrency(warehouse.refPrice);

  // 计算盈亏
  const metrics = _getCostMetrics(warehouse, currentPrice);
  const totalCost = metrics.holdingCost;
  const currentValue = metrics.currentValue;
  const pnl = metrics.totalPnl;
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0;
  const avgCost = metrics.avgCost;

  const detail = document.getElementById('warehouse-detail');
  detail.innerHTML = `
    <div class="warehouse-detail-container">
      <div class="warehouse-hero">
        <div class="warehouse-hero-main">
          <span class="warehouse-hero-eyebrow">仓库详情</span>
          <h2 class="warehouse-title">${warehouse.name}</h2>
          <div class="warehouse-hero-meta">
            <span>参考金价：${getRefPriceLabel(warehouse.refPrice)}</span>
            <span>当前总成本：${fmt(totalCost, 2)} ¥</span>
            <span>总克数：${fmt(warehouse.totalGrams, 4)}g</span>
          </div>
        </div>
        <div class="warehouse-hero-actions">
          <button class="btn btn-danger btn-small gp-btn-danger" data-action="delete-warehouse" data-warehouse-id="${id}">删除仓库</button>
        </div>
      </div>

      <div class="warehouse-block block-status">
        <div class="block-header-with-action">
          <h3 class="block-title">仓位概览</h3>
          <span class="warehouse-block-caption">实时跟踪当前仓位与盈亏表现</span>
        </div>

        <div class="status-grid">
          <div class="status-item">
            <span class="status-label">当前价格</span>
            <span class="status-value" id="warehouse-current-price-${id}">${hasLivePrice ? `${fmtMoney(currentPrice)} ${currency}/g` : _numberLoadingDotsMarkup()}</span>
          </div>
          <div class="status-item">
            <span class="status-label">持有份额</span>
            <span class="status-value">${fmt(warehouse.totalGrams, 4)}g</span>
          </div>
          <div class="status-item">
            <span class="status-label">市值</span>
            <span class="status-value" id="warehouse-value-${id}">${hasLivePrice ? `${fmt(currentValue, 2)} ¥` : _numberLoadingDotsMarkup()}</span>
          </div>
          <div class="status-item">
            <span class="status-label">成本（克价）</span>
            <span class="status-value">${fmtMoney(avgCost)} ¥/g</span>
          </div>
          <div class="status-item ${hasLivePrice ? (pnl >= 0 ? 'positive' : 'negative') : ''}">
            <span class="status-label">当前盈亏</span>
            <span class="status-value" id="warehouse-pnl-${id}">${hasLivePrice ? `${pnl >= 0 ? '+' : ''}${fmt(pnl, 2)} ¥` : _numberLoadingDotsMarkup()}</span>
          </div>
          <div class="status-item ${hasLivePrice ? (pnl >= 0 ? 'positive' : 'negative') : ''}">
            <span class="status-label">盈亏比</span>
            <span class="status-value" id="warehouse-pnl-pct-${id}">${hasLivePrice ? `${pnl >= 0 ? '+' : ''}${fmt(pnlPct, 2)}%` : _numberLoadingDotsMarkup()}</span>
          </div>
        </div>

        <div class="warehouse-info-form">
          <div class="form-row">
            <label>仓库名称</label>
            <input type="text" id="rename-input-${id}" placeholder="当前" value="${warehouse.name}">
            <button class="btn btn-secondary btn-small gp-btn-secondary" data-action="rename-warehouse" data-warehouse-id="${id}">重命名</button>
          </div>
            <div class="form-row">
              <label>参考金价</label>
              <select id="refprice-select-${id}" data-action="change-refprice" data-warehouse-id="${id}">
                ${getRefPriceItems().map(item => `
                  <option value="${item.code}" ${item.code === warehouse.refPrice ? 'selected' : ''}>
                    ${item.name}
                  </option>
              `).join('')}
            </select>
          </div>
        </div>
      </div>

      <div class="warehouse-ops-grid">
        <div class="warehouse-block block-trade">
          <h3 class="block-title">交易操作</h3>
          <div class="trade-form-stacked">
            <div class="form-row">
              <label>数量（g）</label>
              <input type="number" id="buy-grams-${id}" placeholder="0.000" step="0.0001" min="0">
            </div>
            <div class="form-row">
              <label>价格（¥/g）</label>
              <input type="number" id="buy-price-${id}" placeholder="请输入实际成交价格" step="0.01" min="0">
            </div>
            <div class="form-row form-row-buttons">
              <button class="btn btn-danger gp-btn-danger warehouse-action-btn" data-action="sell-warehouse" data-warehouse-id="${id}">卖出</button>
              <button class="btn btn-primary gp-btn-primary warehouse-btn-primary warehouse-action-btn" data-action="buy-warehouse" data-warehouse-id="${id}">买入</button>
            </div>
          </div>
        </div>

        <div class="warehouse-block block-adjust">
          <h3 class="block-title">调整当前仓位</h3>
          <div class="adjust-form-stacked">
            <div class="form-row">
              <label>持仓数量（g）</label>
              <input type="number" id="adjust-grams-${id}" placeholder="${fmt(warehouse.totalGrams, 4)}" step="0.0001" min="0">
            </div>
            <div class="form-row">
              <label>成本价（¥/g）</label>
              <input type="number" id="adjust-cost-price-${id}" placeholder="${fmt(avgCost, 2)}" step="0.01" min="0">
            </div>
            <div class="form-row form-row-buttons">
              <button class="btn btn-primary gp-btn-primary warehouse-btn-primary" data-action="adjust-position" data-warehouse-id="${id}">应用调整</button>
            </div>
          </div>
        </div>
      </div>

      <div class="warehouse-block block-history">
        <div class="block-header-with-action">
          <h3 class="block-title">交易记录</h3>
          <span class="warehouse-block-caption">默认展示最近 3 条操作</span>
        </div>
        <div class="history-list">
          ${warehouse.history && warehouse.history.length > 0 ? (() => {
            const historyItems = warehouse.history
              .map((entry, historyIndex) => ({ entry, historyIndex }))
              .reverse();
            const visibleCount = _historyVisibleCounts.get(id) || 3;
            const visibleItems = historyItems.slice(0, visibleCount);
            const rows = visibleItems.map(({ entry: h, historyIndex }) => {
              const displayType = _getHistoryDisplayType(h, historyIndex, warehouse.id);
              const oldGrams = h.oldGrams ?? h.oldCost;
              const newGrams = h.newGrams ?? h.newCost;
              const detailText = h.type !== 'adjust'
                ? `${fmt(h.grams, 4)}g × ${fmtMoney(h.price)} ¥/g = ¥${fmtMoney(h.amount ?? (h.grams * h.price))}`
                : `持仓 ${fmt(oldGrams, 4)}g → ${fmt(newGrams, 4)}g${Number.isFinite(Number(h.newCostPrice)) ? ` · 成本价 ${fmtMoney(h.newCostPrice)} ¥/g` : ''}`;
              
              return `
                <div class="history-item-detailed history-${displayType}">
                  <div class="history-row-compact">
                    <span class="history-badge">${displayType === 'open' ? '建仓' : displayType === 'buy' ? '买入' : displayType === 'sell' ? '卖出' : '调整'}</span>
                    <span class="history-detail">${detailText}</span>
                    <span class="history-time">${formatDateTime(h.timestamp)}</span>
                  </div>
                </div>
              `;
            }).join('');
            const more = historyItems.length > visibleCount
              ? `<button type="button" class="history-more-btn" data-action="show-more-history" data-warehouse-id="${id}">More →</button>`
              : '';
            return rows + more;
          })() :
            '<div class="empty-state">暂无交易记录</div>'
          }
        </div>
      </div>
    </div>
  `;
}

// ============================================
// 显示新建仓库表单
// ============================================
function _buildRefPriceSelect(selectedCode) {
  const rmbPrices = getRefPriceItems();
  if (rmbPrices.length === 0) {
    return `<span class="text-secondary" style="font-size:12px;">数据抓取中，请稍候…</span>`;
  }
  return `<select id="new-warehouse-ref">
    ${rmbPrices.map(item => `
      <option value="${item.code}" ${item.code === selectedCode ? 'selected' : ''}>${item.name}</option>
    `).join('')}
  </select>`;
}

function showNewWarehouseForm() {
  _clearNewWarehousePriceTimer();
  const detail = document.getElementById('warehouse-detail');
  detail.innerHTML = `
    <div class="warehouse-detail-container">
      <div class="warehouse-hero warehouse-hero-create">
        <div class="warehouse-hero-main">
          <span class="warehouse-hero-eyebrow">创建仓库</span>
          <h2 class="warehouse-title">新建仓库</h2>
          <div class="warehouse-hero-meta">
            <span>支持先录入初始持仓，也可以创建后再逐笔交易</span>
          </div>
        </div>
      </div>

      <div class="warehouse-block">
        <h3 class="block-title">基本信息</h3>
        <div class="form-row">
          <label>仓库名称</label>
          <input type="text" id="new-warehouse-name" placeholder="例如：我的黄金仓库">
        </div>
        <div class="form-row" id="new-warehouse-ref-row">
          <label>价格参考对象</label>
          ${_buildRefPriceSelect('')}
        </div>
        <div class="form-row">
          <label>总克重（g）</label>
          <input type="number" id="new-warehouse-grams" placeholder="0.0000" step="0.0001" min="0">
        </div>
        <div class="form-row">
          <label>总成本（¥）</label>
          <input type="number" id="new-warehouse-total-cost" placeholder="0.00" step="0.01" min="0">
        </div>
        <div class="form-row form-row-buttons">
          <button class="btn btn-primary gp-btn-primary" data-action="create-warehouse">创建仓库</button>
          <button class="btn btn-secondary gp-btn-secondary" data-action="cancel-new-warehouse">取消</button>
        </div>
      </div>
    </div>
  `;

  // 数据未到时轮询，到了就自动填充 select
  if (getRefPriceItems().length === 0) {
    _newWarehousePriceTimer = setInterval(() => {
      const refRow = document.getElementById('new-warehouse-ref-row');
      if (!refRow) { _clearNewWarehousePriceTimer(); return; } // 表单已关闭
      const rmbPrices = getRefPriceItems();
      if (rmbPrices.length > 0) {
        const label = refRow.querySelector('label');
        refRow.innerHTML = '';
        if (label) refRow.appendChild(label);
        const tmp = document.createElement('div');
        tmp.innerHTML = _buildRefPriceSelect('');
        refRow.appendChild(tmp.firstElementChild);
        _clearNewWarehousePriceTimer();
      }
    }, 800);
  }

  setTimeout(() => {
    document.getElementById('new-warehouse-name')?.focus();
  }, 100);
}

function cancelNewWarehouse() {
  _clearNewWarehousePriceTimer();
  if (currentWarehouseId) {
    renderWarehouseDetail(currentWarehouseId);
  } else {
    renderWarehouseList();
  }
}

// ============================================
// 创建仓库
// ============================================
function createWarehouse() {
  _clearNewWarehousePriceTimer();
  const name = document.getElementById('new-warehouse-name')?.value.trim();
  const refPrice = document.getElementById('new-warehouse-ref')?.value;
  const gramsInput = document.getElementById('new-warehouse-grams')?.value;
  const totalCostInput = document.getElementById('new-warehouse-total-cost')?.value;

  if (!name) {
    _showWarehouseNotice('请输入仓库名称', 'error');
    return;
  }

  const warehouses = loadWarehouses();
  const grams = gramsInput ? parseFloat(gramsInput) : 0;
  const totalCost = totalCostInput ? parseFloat(totalCostInput) : 0;

  const newWarehouse = {
    id: Date.now().toString(),
    name,
    refPrice,
    totalGrams: grams,
    totalCost: totalCost,
    costModelVersion: COST_MODEL_VERSION,
    history: grams > 0 && totalCost > 0 ? [{
      type: 'open',
      grams: grams,
      price: totalCost / grams,
      timestamp: Date.now()
    }] : []
  };

  warehouses.push(newWarehouse);
  if (!saveWarehouses(warehouses)) {
    _showWarehouseNotice('保存失败，请稍后重试', 'error');
    return;
  }

  currentWarehouseId = newWarehouse.id;
  renderWarehouseList();
  _showWarehouseNotice('仓库已创建');

  // 触发仓库变化事件
  window.dispatchEvent(new CustomEvent('warehousesChanged'));
}

// ============================================
// 选择仓库
// ============================================
function selectWarehouse(id) {
  if (currentWarehouseId && currentWarehouseId !== id) {
    _historyVisibleCounts.delete(currentWarehouseId);
  }
  currentWarehouseId = id;
  renderWarehouseList();
}

function resetHistoryPagination() {
  _historyVisibleCounts.clear();
}

// ============================================
// 删除仓库
// ============================================
// 重命名仓库
function renameWarehouse(id) {
  const warehouses = loadWarehouses();
  const warehouse = warehouses.find(w => w.id === id);
  
  if (!warehouse) {
    _showWarehouseNotice('仓库不存在', 'error');
    return;
  }
  
  // 从输入框获取新名称
  const renameInput = document.getElementById(`rename-input-${id}`);
  if (!renameInput) {
    _showWarehouseNotice('仓库名称输入框不可用，请重新打开页面', 'error');
    return;
  }
  
  const newName = renameInput.value.trim();
  
  if (!newName) {
    _showWarehouseNotice('仓库名称不能为空', 'error');
    return;
  }
  
  // 检查名称是否重复
  if (warehouses.some(w => w.id !== id && w.name === newName)) {
    _showWarehouseNotice('仓库名称已存在', 'error');
    return;
  }
  
  // 更新名称
  warehouse.name = newName;
  if (!saveWarehouses(warehouses)) {
    _showWarehouseNotice('保存失败，请稍后重试', 'error');
    return;
  }
  
  // 刷新显示
  renderWarehouseList();
  
  // 触发仓库变化事件
  window.dispatchEvent(new CustomEvent('warehousesChanged'));
}

// 修改价格参考对象
function changeRefPrice(id) {
  const warehouses = loadWarehouses();
  const warehouse = warehouses.find(w => w.id === id);
  
  if (!warehouse) {
    _showWarehouseNotice('仓库不存在', 'error');
    return;
  }
  
  // 从下拉菜单获取新的价格参考
  const refPriceSelect = document.getElementById(`refprice-select-${id}`);
  if (!refPriceSelect) {
    _showWarehouseNotice('参考金价选择器不可用，请重新打开页面', 'error');
    return;
  }
  
  const newRefPrice = refPriceSelect.value;
  
  // 更新价格参考
  warehouse.refPrice = newRefPrice;
  if (!saveWarehouses(warehouses)) {
    _showWarehouseNotice('保存失败，请稍后重试', 'error');
    return;
  }
  
  // 刷新显示
  renderWarehouseList();
  
  // 触发仓库变化事件
  window.dispatchEvent(new CustomEvent('warehousesChanged'));
}

async function deleteWarehouse(id) {
  if (!await _confirmWarehouseAction('删除后，该仓库及其全部交易记录将无法恢复。', {
    title: '删除仓库',
    confirmText: '删除',
    danger: true,
  })) {
    return;
  }

  let warehouses = loadWarehouses();
  warehouses = warehouses.filter(w => w.id !== id);
  if (!saveWarehouses(warehouses)) {
    _showWarehouseNotice('保存失败，请稍后重试', 'error');
    return;
  }

  if (currentWarehouseId === id) {
    currentWarehouseId = null;
  }

  renderWarehouseList();

  // 触发仓库变化事件
  window.dispatchEvent(new CustomEvent('warehousesChanged'));
  _showWarehouseNotice('仓库已删除');
}

// ============================================
// 买入
// ============================================
async function buy(id) {
  const gramsInput = document.getElementById(`buy-grams-${id}`);
  const priceInput = document.getElementById(`buy-price-${id}`);

  const grams = parseFloat(gramsInput?.value);
  const price = parseFloat(priceInput?.value);

  if (!grams || grams <= 0) {
    _showWarehouseNotice('请输入有效的交易克数', 'error');
    return;
  }

  if (!price || price <= 0) {
    _showWarehouseNotice('请输入实际成交价格', 'error');
    return;
  }

  const warehouses = loadWarehouses();
  const warehouse = warehouses.find(w => w.id === id);
  if (!warehouse) {
    _showWarehouseNotice('仓库不存在', 'error');
    return;
  }

  const amount = _roundMoney(grams * price);
  if (!await _confirmWarehouseAction('', {
    title: '确认买入',
    confirmText: '确认',
    details: [
      { label: '买入数量', value: `${fmt(grams, 4)}g` },
      { label: '成交价', value: `${fmtMoney(price)} ¥/g` },
      { label: '成交金额', value: `¥${fmtMoney(amount)}` },
    ],
  })) {
    return;
  }

  // 更新仓库数据
  warehouse.totalGrams = (warehouse.totalGrams || 0) + grams;
  warehouse.totalCost = _roundMoney((warehouse.totalCost || 0) + amount);
  warehouse.history = warehouse.history || [];
  warehouse.history.push({
    type: 'buy',
    grams,
    price,
    amount,
    timestamp: Date.now(),
    gramsAfter: warehouse.totalGrams,
    costAfter: warehouse.totalCost,
  });

  if (!saveWarehouses(warehouses)) {
    _showWarehouseNotice('保存失败，请稍后重试', 'error');
    return;
  }
  _historyVisibleCounts.set(id, 3);

  // 清空输入框
  if (gramsInput) gramsInput.value = '';
  if (priceInput) priceInput.value = '';

  // 重新渲染详情
  renderWarehouseList();
  window.dispatchEvent(new CustomEvent('warehousesChanged'));

  _showWarehouseNotice(`已买入 ${fmt(grams, 4)}g，成交金额 ¥${fmt(amount, 2)}`);
}

// ============================================
// 卖出
// ============================================
async function sell(id) {
  // 买入和卖出共用同一组输入框
  const gramsInput = document.getElementById(`buy-grams-${id}`);
  const priceInput = document.getElementById(`buy-price-${id}`);

  const grams = parseFloat(gramsInput?.value);
  const price = parseFloat(priceInput?.value);

  if (!grams || grams <= 0) {
    _showWarehouseNotice('请输入有效的交易克数', 'error');
    return;
  }

  if (!price || price <= 0) {
    _showWarehouseNotice('请输入实际成交价格', 'error');
    return;
  }

  const warehouses = loadWarehouses();
  const warehouse = warehouses.find(w => w.id === id);
  if (!warehouse) {
    _showWarehouseNotice('仓库不存在', 'error');
    return;
  }

  if (grams > warehouse.totalGrams) {
    _showWarehouseNotice('卖出克数不能超过当前持有总量', 'error');
    return;
  }

  // 工行口径：卖出回款直接冲减当前总成本。
  const proceeds = _roundMoney(grams * price);
  const sellingAll = Math.abs(grams - warehouse.totalGrams) < 1e-9;
  if (!await _confirmWarehouseAction('', {
    title: '确认卖出',
    confirmText: '确认',
    danger: true,
    details: [
      { label: '卖出数量', value: `${fmt(grams, 4)}g` },
      { label: '成交价', value: `${fmtMoney(price)} ¥/g` },
      { label: '成交金额', value: `¥${fmtMoney(proceeds)}` },
    ],
  })) {
    return;
  }

  // 更新仓库数据
  warehouse.totalGrams -= grams;
  warehouse.totalCost = _roundMoney((warehouse.totalCost || 0) - proceeds);
  if (sellingAll || Math.abs(warehouse.totalGrams) < 1e-9) {
    warehouse.totalGrams = 0;
    warehouse.totalCost = 0;
  }
  warehouse.history = warehouse.history || [];
  warehouse.history.push({
    type: 'sell',
    grams,
    price,
    timestamp: Date.now(),
    proceeds,
    gramsAfter: warehouse.totalGrams,
    costAfter: warehouse.totalCost,
  });

  if (!saveWarehouses(warehouses)) {
    _showWarehouseNotice('保存失败，请稍后重试', 'error');
    return;
  }
  _historyVisibleCounts.set(id, 3);

  // 清空输入框
  if (gramsInput) gramsInput.value = '';
  if (priceInput) priceInput.value = '';

  // 重新渲染详情
  renderWarehouseList();
  window.dispatchEvent(new CustomEvent('warehousesChanged'));

  _showWarehouseNotice(`已卖出 ${fmt(grams, 4)}g，成交金额 ¥${fmt(proceeds, 2)}`);
}

// ============================================
// 调整成本
// ============================================
async function adjustCost(id) {
  const costInput = document.getElementById(`adjust-cost-${id}`);
  const newCost = parseFloat(costInput?.value);

  if (isNaN(newCost) || newCost < 0) {
    _showWarehouseNotice('请输入有效的成本金额', 'error');
    return;
  }

  const warehouses = loadWarehouses();
  const warehouse = warehouses.find(w => w.id === id);
  if (!warehouse) {
    _showWarehouseNotice('仓库不存在', 'error');
    return;
  }

  const oldCost = warehouse.totalCost || 0;

  if (!await _confirmWarehouseAction('', {
    title: '调整总成本',
    confirmText: '应用调整',
    details: [
      { label: '调整前', value: `¥${fmtMoney(oldCost)}` },
      { label: '调整后', value: `¥${fmtMoney(newCost)}` },
    ],
  })) {
    return;
  }

  // 更新仓库数据
  warehouse.totalCost = newCost;
  warehouse.history = warehouse.history || [];
  warehouse.history.push({
    type: 'adjust',
    oldCost,
    newCost,
    oldGrams: warehouse.totalGrams,
    newGrams: warehouse.totalGrams,
    gramsAfter: warehouse.totalGrams,
    costAfter: warehouse.totalCost,
    timestamp: Date.now()
  });

  if (!saveWarehouses(warehouses)) {
    _showWarehouseNotice('保存失败，请稍后重试', 'error');
    return;
  }
  _historyVisibleCounts.set(id, 3);

  // 清空输入框
  if (costInput) costInput.value = '';

  // 重新渲染详情
  renderWarehouseDetail(id);
  renderWarehouseList();

  _showWarehouseNotice('总成本已更新');
  
  // 触发仓库变化事件
  window.dispatchEvent(new CustomEvent('warehousesChanged'));
}

// ============================================
// 直接调整仓位（数量+成本价）
// ============================================
async function adjustPosition(id) {
  const warehouses = loadWarehouses();
  const warehouse = warehouses.find(w => w.id === id);
  if (!warehouse) return;

  const newGramsInput = document.getElementById(`adjust-grams-${id}`);
  const newCostPriceInput = document.getElementById(`adjust-cost-price-${id}`);
  
  const newGrams = parseFloat(newGramsInput.value);
  const newCostPrice = parseFloat(newCostPriceInput.value);

  if (isNaN(newGrams) || newGrams < 0) {
    _showWarehouseNotice('请输入有效的持仓数量', 'error');
    return;
  }

  if (isNaN(newCostPrice) || newCostPrice < 0) {
    _showWarehouseNotice('请输入有效的成本价', 'error');
    return;
  }

  const oldGrams = warehouse.totalGrams;
  const oldCost = warehouse.totalCost || 0;
  const newTotalCost = _roundMoney(newGrams * newCostPrice);
  if (!await _confirmWarehouseAction('', {
    title: '确认调整仓位',
    confirmText: '确认',
    details: [
      { label: '持仓数量', value: `${fmt(newGrams, 4)}g` },
      { label: '成本价', value: `${fmtMoney(newCostPrice)} ¥/g` },
      { label: '总成本', value: `¥${fmtMoney(newTotalCost)}` },
    ],
  })) {
    return;
  }
  
  warehouse.totalGrams = newGrams;
  warehouse.totalCost = newTotalCost;
  
  warehouse.history = warehouse.history || [];
  warehouse.history.push({
    type: 'adjust',
    timestamp: Date.now(),
    oldGrams,
    newGrams,
    oldCost,
    newCost: warehouse.totalCost,
    oldCostPrice: oldGrams > 0 ? oldCost / oldGrams : 0,
    newCostPrice,
    gramsAfter: warehouse.totalGrams,
    costAfter: warehouse.totalCost,
  });

  if (!saveWarehouses(warehouses)) {
    _showWarehouseNotice('保存失败，请稍后重试', 'error');
    return;
  }
  _historyVisibleCounts.set(id, 3);
  renderWarehouseDetail(id);
  renderWarehouseList();
  
  _showWarehouseNotice('仓位与成本价已更新');
  
  // 触发仓库变化事件
  window.dispatchEvent(new CustomEvent('warehousesChanged'));
}

// ============================================
// 实时更新仓库详情中的动态数据（价格、盈亏、市值）
// ============================================
function updateWarehouseRealTimeData() {
  if (!currentWarehouseId) return;
  
  const warehouses = loadWarehouses();
  const warehouse = warehouses.find(w => w.id === currentWarehouseId);
  if (!warehouse) return;

  // 获取最新价格
  const priceObj = PRICES.find(p => p.code === warehouse.refPrice);
  const currentPrice = Number(priceObj?.value);
  const hasLivePrice = Number.isFinite(currentPrice) && currentPrice > 0;
  const currency = getCurrency(warehouse.refPrice);

  // 计算盈亏
  const metrics = _getCostMetrics(warehouse, currentPrice);
  const { currentValue, totalPnl: pnl } = metrics;
  const pnlPct = metrics.holdingCost > 0 ? (pnl / metrics.holdingCost) * 100 : 0;

  // 更新DOM中的动态数据
  const priceEl = document.getElementById(`warehouse-current-price-${currentWarehouseId}`);
  const pnlEl = document.getElementById(`warehouse-pnl-${currentWarehouseId}`);
  const valueEl = document.getElementById(`warehouse-value-${currentWarehouseId}`);
  const pnlPctEl = document.getElementById(`warehouse-pnl-pct-${currentWarehouseId}`);

  if (!hasLivePrice) {
    [priceEl, pnlEl, valueEl, pnlPctEl].forEach((element) => {
      if (!element) return;
      element.innerHTML = _numberLoadingDotsMarkup();
      element.closest('.status-item')?.classList.remove('positive', 'negative');
    });
    return;
  }

  if (priceEl) {
    priceEl.textContent = `${fmtMoney(currentPrice)} ${currency}/g`;
  }

  if (pnlEl) {
    pnlEl.innerHTML = `${pnl >= 0 ? '+' : ''}${fmt(pnl, 2)} ¥`;
    const statusItem = pnlEl.closest('.status-item');
    if (statusItem) {
      statusItem.classList.remove('positive', 'negative');
      statusItem.classList.add(pnl >= 0 ? 'positive' : 'negative');
    }
  }

  if (valueEl) {
    valueEl.textContent = `${fmt(currentValue, 2)} ¥`;
  }

  if (pnlPctEl) {
    pnlPctEl.textContent = `${pnl >= 0 ? '+' : ''}${fmt(pnlPct, 2)}%`;
    const statusItem = pnlPctEl.closest('.status-item');
    if (statusItem) {
      statusItem.classList.remove('positive', 'negative');
      statusItem.classList.add(pnl >= 0 ? 'positive' : 'negative');
    }
  }
}

function updateWarehouseListRealTimeData() {
  const warehouses = loadWarehouses();
  if (!warehouses.length) return;

  warehouses.forEach((warehouse) => {
    const itemEl = document.querySelector(`.warehouse-item[data-id="${warehouse.id}"]`);
    if (!itemEl) return;

    const priceObj = PRICES.find((p) => p.code === warehouse.refPrice);
    const currentPrice = Number(priceObj?.value);
    const hasLivePrice = Number.isFinite(currentPrice) && currentPrice > 0;
    const pnl = _getCostMetrics(warehouse, currentPrice).totalPnl;

    const metricsEl = itemEl.querySelector('.warehouse-item-metrics');
    if (metricsEl) {
      metricsEl.innerHTML = `
        <span>${fmt(warehouse.totalGrams, 2)}g</span>
        ${hasLivePrice
          ? `<span class="${pnl >= 0 ? 'metric-profit' : 'metric-loss'}">${pnl >= 0 ? '+' : ''}${fmt(pnl, 2)}¥</span>`
          : _numberLoadingDotsMarkup()}
      `;
    }
  });
}

// ============================================
// 价格更新（从 manager.js 调用）
// ============================================
function updatePrices(prices) {
  const hadPrices = PRICES.length > 0;
  PRICES = prices;

  updateWarehouseListRealTimeData();

  // 首次拿到价格后，左侧列表需要整体验证一次，避免首屏停留在 0 价格计算结果
  if (!hadPrices && PRICES.length > 0) {
    renderWarehouseList();
    return;
  }

  // 如果当前有选中的仓库，更新显示
  if (currentWarehouseId) {
    // 只更新价格和盈亏显示，不重新渲染整个表单
    updateWarehouseRealTimeData();
  }
}

function refreshWarehouseView(prices = null) {
  if (Array.isArray(prices)) {
    PRICES = prices;
  }
  renderWarehouseList();
  updateWarehouseListRealTimeData();
  updateWarehouseRealTimeData();
  _notifySummary?.();
}

function updatePriceDisplay(id) {
  if (id) currentWarehouseId = id;
  updateWarehouseRealTimeData();
}

function bindWarehouseInteractions() {
  const list = document.getElementById('warehouse-list');
  if (list && list.dataset.boundWarehouseList !== '1') {
    list.dataset.boundWarehouseList = '1';
    list.addEventListener('click', (event) => {
      const showNew = event.target.closest('[data-action="show-new-warehouse"]');
      if (showNew) {
        showNewWarehouseForm();
        return;
      }
      const item = event.target.closest('.warehouse-item[data-action="select-warehouse"]');
      if (item?.dataset.id) selectWarehouse(item.dataset.id);
    });
  }

  const detail = document.getElementById('warehouse-detail');
  if (detail && detail.dataset.boundWarehouseDetail !== '1') {
    detail.dataset.boundWarehouseDetail = '1';
    detail.addEventListener('click', (event) => {
      const actionEl = event.target.closest('[data-action]');
      if (!actionEl) return;
      const id = actionEl.dataset.warehouseId;
      switch (actionEl.dataset.action) {
        case 'delete-warehouse':
          deleteWarehouse(id);
          break;
        case 'rename-warehouse':
          renameWarehouse(id);
          break;
        case 'buy-warehouse':
          buy(id);
          break;
        case 'sell-warehouse':
          sell(id);
          break;
        case 'adjust-position':
          adjustPosition(id);
          break;
        case 'show-more-history':
          _historyVisibleCounts.set(id, (_historyVisibleCounts.get(id) || 3) + 5);
          renderWarehouseDetail(id);
          break;
        case 'create-warehouse':
          createWarehouse();
          break;
        case 'cancel-new-warehouse':
          cancelNewWarehouse();
          break;
        default:
          break;
      }
    });

    detail.addEventListener('change', (event) => {
      const target = event.target.closest('[data-action="change-refprice"]');
      if (target?.dataset.warehouseId) {
        changeRefPrice(target.dataset.warehouseId);
      }
    });
  }
}

function setWarehouseCallbacks(callbacks = {}) {
  _notifySummary = typeof callbacks.notifySummary === 'function' ? callbacks.notifySummary : null;
}

const warehouseModule = {
  getWarehouseSummary,
  renderWarehouseList,
  renderWarehouseDetail,
  showNewWarehouseForm,
  cancelNewWarehouse,
  createWarehouse,
  selectWarehouse,
  renameWarehouse,
  changeRefPrice,
  deleteWarehouse,
  buy,
  sell,
  adjustCost,
  adjustPosition,
  updateWarehouseRealTimeData,
  updateWarehouseListRealTimeData,
  updatePrices,
  refreshWarehouseView,
  bindWarehouseInteractions,
  setWarehouseCallbacks,
  resetHistoryPagination,
};

export {
  bindWarehouseInteractions,
  loadWarehouses,
  warehouseModule,
};

export default warehouseModule;
