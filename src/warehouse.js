// =========================
// warehouse.js - 仓库管理模块（重写 - 简洁版）
// =========================

let PRICES = [];
let currentWarehouseId = null;
const HISTORY_VERSION = 2;
const MAX_HISTORY_ITEMS = 300;

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
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

function saveWarehouses(list) {
  try {
    const normalized = Array.isArray(list) ? list.map(_trimWarehouseHistory) : [];
    localStorage.setItem('warehouses', JSON.stringify(normalized));
  } catch (_) {
  }
}

// ============================================
// 工具函数
// ============================================
function getCurrency(code) {
  if (typeof DataSource !== 'undefined') {
    return DataSource.getCurrency(code);
  }
  if (code === 'CALC_NY_LON_DIFF_PCT') return '%';
  return '$';
}

function fmt(v, decimals = 2) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  const num = Number(v);
  return num.toFixed(decimals).replace(/\.?0+$/, '');
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

// 获取显示名称
function getDisplayName(code) {
  if (typeof DataSource !== 'undefined') {
    const mapped = DataSource.getDisplayName(code, '');
    if (mapped && mapped !== code) return mapped;
  }
  const p = PRICES.find(p => p.code === code);
  if (p && p.name) return p.name;
  return code;
}

function getRefPriceItems() {
  const items = [];
  const seen = new Set();

  if (typeof DataSource !== 'undefined') {
    DataSource.getAllItems()
      .filter(item => getCurrency(item.code) === '¥')
      .forEach((item) => {
        if (seen.has(item.code)) return;
        seen.add(item.code);
        items.push({
          code: item.code,
          name: getDisplayName(item.code),
        });
      });
  }

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
  
  const totalPnl = totalValue - totalCost;
  
  return { totalGrams, totalCost, totalValue, totalPnl };
}

// ============================================
// 渲染仓库列表
// ============================================
function renderWarehouseList() {
  const warehouses = loadWarehouses();
  const container = document.getElementById('warehouse-list');
  if (!container) return;

  // 新建仓库按钮（放在顶部）
  const newWarehouseBtn = `
    <div class="warehouse-new-btn" onclick="warehouseModule.showNewWarehouseForm()">
      <span class="new-btn-icon">+</span>
      <span class="new-btn-text">新建仓库</span>
    </div>
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
    const currentPrice = priceObj?.value || 0;
    const currentValue = (w.totalGrams || 0) * currentPrice;
    const pnl = currentValue - (w.totalCost || 0);
    const cost = w.totalCost || 0;
    
    return `
      <div class="warehouse-item ${currentWarehouseId === w.id ? 'active' : ''}" 
           data-id="${w.id}"
           onclick="warehouseModule.selectWarehouse('${w.id}')">
        <div class="warehouse-name">${w.name}</div>
        <div class="warehouse-stats-mini">${fmt(w.totalGrams, 2)}g | 盈亏:${pnl >= 0 ? '+' : ''}${fmt(pnl, 2)}¥ | 成本:${fmt(cost, 2)}¥</div>
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
  if (window.updateWarehouseSummaryDisplay) {
    window.updateWarehouseSummaryDisplay();
  }
}

// ============================================
// 渲染仓库详情
// ============================================
function renderWarehouseDetail(id) {
  const warehouses = loadWarehouses();
  const warehouse = warehouses.find(w => w.id === id);
  if (!warehouse) {
    document.getElementById('warehouse-detail').innerHTML = '<div class="empty-state"><p>仓库不存在</p></div>';
    return;
  }

  currentWarehouseId = id;

  // 更新价格
  const priceObj = PRICES.find(p => p.code === warehouse.refPrice);
  const currentPrice = priceObj?.value || 0;
  const currency = getCurrency(warehouse.refPrice);

  // 计算盈亏
  const totalCost = warehouse.totalCost || 0;
  const currentValue = warehouse.totalGrams * currentPrice;
  const pnl = currentValue - totalCost;
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0;

  const detail = document.getElementById('warehouse-detail');
  detail.innerHTML = `
    <div class="warehouse-detail-container">

      <!-- 1. 当前库情况 -->
      <div class="warehouse-block block-status">
        <div class="block-header-with-action">
          <h3 class="block-title">当前库情况</h3>
          <button class="btn btn-danger btn-small" onclick="warehouseModule.deleteWarehouse('${id}')">删除仓库</button>
        </div>
        
        <!-- 状态数据块 -->
        <div class="status-grid">
          <div class="status-item">
            <span class="status-label">当前价格</span>
            <span class="status-value" id="warehouse-current-price-${id}">${fmt(currentPrice, 2)} ¥/g</span>
          </div>
          <div class="status-item">
            <span class="status-label">持仓数量</span>
            <span class="status-value">${fmt(warehouse.totalGrams, 4)} g</span>
          </div>
          <div class="status-item">
            <span class="status-label">市值</span>
            <span class="status-value" id="warehouse-value-${id}">${fmt(currentValue, 2)} ¥</span>
          </div>
          <div class="status-item ${pnl >= 0 ? 'positive' : 'negative'}">
            <span class="status-label">盈亏</span>
            <span class="status-value" id="warehouse-pnl-${id}">${pnl >= 0 ? '+' : ''}${fmt(pnl, 2)} ¥</span>
          </div>
          <div class="status-item">
            <span class="status-label">成本价</span>
            <span class="status-value">${warehouse.totalGrams > 0 ? fmt(totalCost / warehouse.totalGrams, 2) : '0'} ¥/g</span>
          </div>
          <div class="status-item">
            <span class="status-label">总成本</span>
            <span class="status-value">${fmt(totalCost, 2)} ¥</span>
          </div>
        </div>
        
        <!-- 仓库信息表单 -->
        <div class="warehouse-info-form">
          <div class="form-row">
            <label>仓库名称</label>
            <input type="text" id="rename-input-${id}" placeholder="当前" value="${warehouse.name}">
            <button class="btn btn-secondary btn-small" onclick="warehouseModule.renameWarehouse('${id}')">重命名</button>
          </div>
          <div class="form-row">
            <label>价格参考</label>
            <select id="refprice-select-${id}" onchange="warehouseModule.changeRefPrice('${id}')">
              ${getRefPriceItems().map(item => `
                <option value="${item.code}" ${item.code === warehouse.refPrice ? 'selected' : ''}>
                  ${item.name}
                </option>
              `).join('')}
            </select>
          </div>
        </div>
      </div>

      <!-- 2. 交易操作 -->
      <div class="warehouse-block block-trade">
        <h3 class="block-title">交易操作</h3>
        <div class="trade-form-stacked">
          <div class="form-row">
            <label>数量（克）</label>
            <input type="number" id="buy-grams-${id}" placeholder="0.000" step="0.0001" min="0">
          </div>
          <div class="form-row">
            <label>价格（¥/g）</label>
            <input type="number" id="buy-price-${id}" placeholder="${fmt(currentPrice, 2)}" step="0.01" min="0" value="${fmt(currentPrice, 2)}">
          </div>
          <div class="form-row form-row-buttons">
            <button class="btn btn-success" onclick="warehouseModule.buy('${id}')">买入</button>
            <button class="btn btn-danger" onclick="warehouseModule.sell('${id}')">卖出</button>
          </div>
        </div>
      </div>

      <!-- 3. 调整当前仓位 -->
      <div class="warehouse-block block-adjust">
        <h3 class="block-title">调整当前仓位</h3>
        <div class="adjust-form-stacked">
          <div class="form-row">
            <label>持仓数量（克）</label>
            <input type="number" id="adjust-grams-${id}" placeholder="${fmt(warehouse.totalGrams, 4)}" step="0.0001" min="0">
          </div>
          <div class="form-row">
            <label>成本价（¥/g）</label>
            <input type="number" id="adjust-cost-price-${id}" placeholder="${warehouse.totalGrams > 0 ? fmt(totalCost / warehouse.totalGrams, 2) : '0'}" step="0.01" min="0">
          </div>
          <div class="form-row form-row-buttons">
            <button class="btn btn-secondary" onclick="warehouseModule.adjustPosition('${id}')">应用调整</button>
          </div>
        </div>
      </div>

      <!-- 4. 交易记录 -->
      <div class="warehouse-block block-history">
        <h3 class="block-title">交易记录</h3>
        <div class="history-list">
          ${warehouse.history && warehouse.history.length > 0 ? 
            warehouse.history.slice().reverse().map((h, index) => {
              // 计算操作后的状态（从后往前遍历）
              let gramsAfter = warehouse.totalGrams;
              let costAfter = warehouse.totalCost;
              
              // 重新计算每一步的状态
              const historyAfterThis = warehouse.history.slice(warehouse.history.indexOf(h) + 1);
              historyAfterThis.forEach(laterH => {
                if (laterH.type === 'buy') {
                  gramsAfter -= laterH.grams;
                  costAfter -= laterH.grams * laterH.price;
                } else if (laterH.type === 'sell') {
                  gramsAfter += laterH.grams;
                  costAfter += laterH.grams * laterH.price;
                } else if (laterH.type === 'adjust') {
                  gramsAfter = laterH.oldCost;
                  costAfter = laterH.oldCost * (laterH.newCost / laterH.oldCost || 0);
                }
              });
              
              const pnlAtTime = h.type === 'adjust' ? 0 : (gramsAfter * currentPrice - costAfter);
              
              return `
                <div class="history-item-detailed history-${h.type}">
                  <div class="history-row-1">
                    <span class="history-badge">${h.type === 'buy' ? '买入' : h.type === 'sell' ? '卖出' : '调整'}</span>
                    <span class="history-time">${formatDateTime(h.timestamp)}</span>
                  </div>
                  <div class="history-row-2">
                    ${h.type !== 'adjust' ? 
                      `<span class="history-detail">操作：${fmt(h.grams, 4)}g @ ${fmt(h.price, 2)}¥/g = ${fmt(h.grams * h.price, 2)}¥</span>` :
                      `<span class="history-detail">操作：持仓 ${fmt(h.oldCost, 4)}g → ${fmt(h.newCost, 4)}g</span>`
                    }
                  </div>
                  <div class="history-row-3">
                    <span class="history-after">执行后：${fmt(gramsAfter, 4)}g | 成本:${fmt(costAfter, 2)}¥ | 市值:${fmt(gramsAfter * currentPrice, 2)}¥ | 营收:${pnlAtTime >= 0 ? '+' : ''}${fmt(pnlAtTime, 2)}¥</span>
                  </div>
                </div>
              `;
            }).join('') :
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
  const detail = document.getElementById('warehouse-detail');
  detail.innerHTML = `
    <div class="warehouse-detail-container">
      <div class="warehouse-detail-header">
        <div class="header-left">
          <h2 class="warehouse-title">创建新仓库</h2>
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
          <label>总克重（克）</label>
          <input type="number" id="new-warehouse-grams" placeholder="0.0000" step="0.0001" min="0">
        </div>
        <div class="form-row">
          <label>总成本（¥）</label>
          <input type="number" id="new-warehouse-total-cost" placeholder="0.00" step="0.01" min="0">
        </div>
        <div class="form-row form-row-buttons">
          <button class="btn btn-primary" onclick="warehouseModule.createWarehouse()">创建仓库</button>
          <button class="btn btn-secondary" onclick="warehouseModule.cancelNewWarehouse()">取消</button>
        </div>
      </div>
    </div>
  `;

  // 数据未到时轮询，到了就自动填充 select
  if (getRefPriceItems().length === 0) {
    const _timer = setInterval(() => {
      const refRow = document.getElementById('new-warehouse-ref-row');
      if (!refRow) { clearInterval(_timer); return; } // 表单已关闭
      const rmbPrices = getRefPriceItems();
      if (rmbPrices.length > 0) {
        const label = refRow.querySelector('label');
        refRow.innerHTML = '';
        if (label) refRow.appendChild(label);
        const tmp = document.createElement('div');
        tmp.innerHTML = _buildRefPriceSelect('');
        refRow.appendChild(tmp.firstElementChild);
        clearInterval(_timer);
      }
    }, 800);
  }

  setTimeout(() => {
    document.getElementById('new-warehouse-name')?.focus();
  }, 100);
}

function cancelNewWarehouse() {
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
  const name = document.getElementById('new-warehouse-name')?.value.trim();
  const refPrice = document.getElementById('new-warehouse-ref')?.value;
  const gramsInput = document.getElementById('new-warehouse-grams')?.value;
  const totalCostInput = document.getElementById('new-warehouse-total-cost')?.value;

  if (!name) {
    alert('请输入仓库名称');
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
    history: grams > 0 && totalCost > 0 ? [{
      type: 'buy',
      grams: grams,
      price: totalCost / grams,
      timestamp: Date.now()
    }] : []
  };

  warehouses.push(newWarehouse);
  saveWarehouses(warehouses);

  currentWarehouseId = newWarehouse.id;
  renderWarehouseList();

  // 触发仓库变化事件
  window.dispatchEvent(new CustomEvent('warehousesChanged'));
}

// ============================================
// 选择仓库
// ============================================
function selectWarehouse(id) {
  currentWarehouseId = id;
  renderWarehouseList();
}

// ============================================
// 删除仓库
// ============================================
// 重命名仓库
function renameWarehouse(id) {
  const warehouses = loadWarehouses();
  const warehouse = warehouses.find(w => w.id === id);
  
  if (!warehouse) {
    alert('仓库不存在！');
    return;
  }
  
  // 从输入框获取新名称
  const renameInput = document.getElementById(`rename-input-${id}`);
  if (!renameInput) {
    alert('输入框不存在！');
    return;
  }
  
  const newName = renameInput.value.trim();
  
  if (!newName) {
    alert('仓库名称不能为空！');
    return;
  }
  
  // 检查名称是否重复
  if (warehouses.some(w => w.id !== id && w.name === newName)) {
    alert('仓库名称已存在！');
    return;
  }
  
  // 更新名称
  warehouse.name = newName;
  saveWarehouses(warehouses);
  
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
    alert('仓库不存在！');
    return;
  }
  
  // 从下拉菜单获取新的价格参考
  const refPriceSelect = document.getElementById(`refprice-select-${id}`);
  if (!refPriceSelect) {
    alert('下拉菜单不存在！');
    return;
  }
  
  const newRefPrice = refPriceSelect.value;
  
  // 更新价格参考
  warehouse.refPrice = newRefPrice;
  saveWarehouses(warehouses);
  
  // 刷新显示
  renderWarehouseList();
  
  // 触发仓库变化事件
  window.dispatchEvent(new CustomEvent('warehousesChanged'));
}

function deleteWarehouse(id) {
  if (!confirm('确定要删除这个仓库吗？所有交易记录将被清除。')) {
    return;
  }

  let warehouses = loadWarehouses();
  warehouses = warehouses.filter(w => w.id !== id);
  saveWarehouses(warehouses);

  if (currentWarehouseId === id) {
    currentWarehouseId = null;
  }

  renderWarehouseList();

  // 触发仓库变化事件
  window.dispatchEvent(new CustomEvent('warehousesChanged'));
}

// ============================================
// 买入
// ============================================
function buy(id) {
  const gramsInput = document.getElementById(`buy-grams-${id}`);
  const priceInput = document.getElementById(`buy-price-${id}`);

  const grams = parseFloat(gramsInput?.value);
  const price = parseFloat(priceInput?.value);

  if (!grams || grams <= 0) {
    alert('请输入有效的克数');
    return;
  }

  if (!price || price <= 0) {
    alert('请输入有效的单价');
    return;
  }

  const warehouses = loadWarehouses();
  const warehouse = warehouses.find(w => w.id === id);
  if (!warehouse) {
    alert('仓库不存在');
    return;
  }

  // 更新仓库数据
  warehouse.totalGrams = (warehouse.totalGrams || 0) + grams;
  warehouse.totalCost = (warehouse.totalCost || 0) + (grams * price);
  warehouse.history = warehouse.history || [];
  warehouse.history.push({
    type: 'buy',
    grams,
    price,
    timestamp: Date.now()
  });

  saveWarehouses(warehouses);

  // 清空输入框
  if (gramsInput) gramsInput.value = '';
  if (priceInput) priceInput.value = '';

  // 重新渲染详情
  renderWarehouseDetail(id);

  alert('买入成功！');
}

// ============================================
// 卖出
// ============================================
function sell(id) {
  // 买入和卖出共用同一组输入框
  const gramsInput = document.getElementById(`buy-grams-${id}`);
  const priceInput = document.getElementById(`buy-price-${id}`);

  const grams = parseFloat(gramsInput?.value);
  const price = parseFloat(priceInput?.value);

  if (!grams || grams <= 0) {
    alert('请输入有效的克数');
    return;
  }

  if (!price || price <= 0) {
    alert('请输入有效的单价');
    return;
  }

  const warehouses = loadWarehouses();
  const warehouse = warehouses.find(w => w.id === id);
  if (!warehouse) {
    alert('仓库不存在');
    return;
  }

  if (grams > warehouse.totalGrams) {
    alert('卖出克数不能超过持有总量');
    return;
  }

  // 计算成本减少（按比例）
  const costReduction = (warehouse.totalCost || 0) * (grams / warehouse.totalGrams);

  // 更新仓库数据
  warehouse.totalGrams -= grams;
  warehouse.totalCost = (warehouse.totalCost || 0) - costReduction;
  warehouse.history = warehouse.history || [];
  warehouse.history.push({
    type: 'sell',
    grams,
    price,
    timestamp: Date.now()
  });

  saveWarehouses(warehouses);

  // 清空输入框
  if (gramsInput) gramsInput.value = '';
  if (priceInput) priceInput.value = '';

  // 重新渲染详情
  renderWarehouseDetail(id);

  alert('卖出成功！');
}

// ============================================
// 调整成本
// ============================================
function adjustCost(id) {
  const costInput = document.getElementById(`adjust-cost-${id}`);
  const newCost = parseFloat(costInput?.value);

  if (isNaN(newCost) || newCost < 0) {
    alert('请输入有效的成本金额');
    return;
  }

  const warehouses = loadWarehouses();
  const warehouse = warehouses.find(w => w.id === id);
  if (!warehouse) {
    alert('仓库不存在');
    return;
  }

  const oldCost = warehouse.totalCost || 0;

  if (!confirm(`确定要将总成本从 ${fmt(oldCost, 2)}￥ 调整为 ${fmt(newCost, 2)}￥ 吗？`)) {
    return;
  }

  // 更新仓库数据
  warehouse.totalCost = newCost;
  warehouse.history = warehouse.history || [];
  warehouse.history.push({
    type: 'adjust',
    oldCost,
    newCost,
    timestamp: Date.now()
  });

  saveWarehouses(warehouses);

  // 清空输入框
  if (costInput) costInput.value = '';

  // 重新渲染详情
  renderWarehouseDetail(id);
  renderWarehouseList();

  alert('成本调整成功！');
  
  // 触发仓库变化事件
  window.dispatchEvent(new CustomEvent('warehousesChanged'));
}

// ============================================
// 直接调整仓位（数量+成本价）
// ============================================
function adjustPosition(id) {
  const warehouses = loadWarehouses();
  const warehouse = warehouses.find(w => w.id === id);
  if (!warehouse) return;

  const newGramsInput = document.getElementById(`adjust-grams-${id}`);
  const newCostPriceInput = document.getElementById(`adjust-cost-price-${id}`);
  
  const newGrams = parseFloat(newGramsInput.value);
  const newCostPrice = parseFloat(newCostPriceInput.value);

  if (isNaN(newGrams) || newGrams < 0) {
    alert('请输入有效的持仓数量');
    return;
  }

  if (isNaN(newCostPrice) || newCostPrice < 0) {
    alert('请输入有效的成本价');
    return;
  }

  const oldGrams = warehouse.totalGrams;
  const oldCost = warehouse.totalCost || 0;
  
  warehouse.totalGrams = newGrams;
  warehouse.totalCost = newGrams * newCostPrice;
  
  warehouse.history = warehouse.history || [];
  warehouse.history.push({
    type: 'adjust',
    timestamp: Date.now(),
    oldCost: oldGrams,
    newCost: newGrams,
  });

  saveWarehouses(warehouses);
  renderWarehouseDetail(id);
  renderWarehouseList();
  
  alert('仓位调整成功');
  
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
  const currentPrice = priceObj?.value || 0;
  const currency = getCurrency(warehouse.refPrice);

  // 计算盈亏
  const totalCost = warehouse.totalCost || 0;
  const currentValue = warehouse.totalGrams * currentPrice;
  const pnl = currentValue - totalCost;
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0;

  // 更新DOM中的动态数据
  const priceEl = document.getElementById(`warehouse-current-price-${currentWarehouseId}`);
  const pnlEl = document.getElementById(`warehouse-pnl-${currentWarehouseId}`);
  const valueEl = document.getElementById(`warehouse-value-${currentWarehouseId}`);

  if (priceEl) {
    priceEl.textContent = `${fmt(currentPrice, 2)} ¥`;
  }

  if (pnlEl) {
    pnlEl.innerHTML = `${pnl >= 0 ? '+' : ''}${fmt(pnl, 2)} ¥`;
    const parentCell = pnlEl.closest('.info-cell');
    if (parentCell) {
      parentCell.classList.remove('positive', 'negative');
      parentCell.classList.add(pnl >= 0 ? 'positive' : 'negative');
    }
  }

  if (valueEl) {
    valueEl.textContent = `${fmt(currentValue, 2)} ¥`;
  }

  // 更新输入框中的参考价格提示
  const buyPriceInput = document.getElementById(`buy-price-${currentWarehouseId}`);
  const priceHint = document.querySelector('.price-hint');
  if (buyPriceInput && !buyPriceInput.value) {
    buyPriceInput.placeholder = `当前: ${fmt(currentPrice, 2)}`;
  }
  if (priceHint) {
    priceHint.textContent = `当前参考价格: ${fmt(currentPrice, 2)} ¥`;
  }
}

// ============================================
// 价格更新（从 manager.js 调用）
// ============================================
function updatePrices(prices) {
  PRICES = prices;
  // 如果当前有选中的仓库，更新显示
  if (currentWarehouseId) {
    // 只更新价格和盈亏显示，不重新渲染整个表单
    updatePriceDisplay(currentWarehouseId);
  }
}

function updatePriceDisplay(id) {
  const warehouses = loadWarehouses();
  const warehouse = warehouses.find(w => w.id === id);
  if (!warehouse) return;

  const priceObj = PRICES.find(p => p.code === warehouse.refPrice);
  const currentPrice = priceObj?.value || 0;
  const currency = getCurrency(warehouse.refPrice);

  const totalCost = warehouse.totalCost || 0;
  const currentValue = warehouse.totalGrams * currentPrice;
  const pnl = currentValue - totalCost;
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0;

  // 只更新价格和盈亏相关的显示元素
  const infoItems = document.querySelectorAll('.info-item');
  infoItems.forEach(item => {
    const label = item.querySelector('.label')?.textContent;
    const valueSpan = item.querySelector('.value');
    if (!valueSpan) return;

    if (label === '当前参考价：') {
      valueSpan.textContent = `${fmt(currentPrice, 2)} ${currency}/g`;
    } else if (label === '当前市值：') {
      valueSpan.textContent = `${fmt(currentValue, 2)} ￥`;
    } else if (label === '盈亏：') {
      valueSpan.textContent = `${pnl >= 0 ? '+' : ''}${fmt(pnl, 2)} ￥`;
      item.className = `info-item ${pnl >= 0 ? 'profit' : 'loss'}`;
    }
  });
}

// ============================================
// 导出模块
// ============================================
window.warehouseModule = {
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
  updatePrices
};
