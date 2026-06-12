<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import contentMarkup from './manager-content-fragment.html?raw';
import overlaysMarkup from './manager-overlays-fragment.html?raw';
import configScriptUrl from './config.js?url';
import dataSourceScriptUrl from './datasource.js?url';
import warehouseScriptUrl from './warehouse.js?url';
import klineDataScriptUrl from './kline_data.js?url';
import klineCacheScriptUrl from './kline_cache.js?url';
import echartsScriptUrl from './echarts.min.js?url';
import chartScriptUrl from './chart.js?url';
import managerScriptUrl from './manager.js?url';

const legacyScripts = [
  configScriptUrl,
  dataSourceScriptUrl,
  warehouseScriptUrl,
  klineDataScriptUrl,
  klineCacheScriptUrl,
  echartsScriptUrl,
  chartScriptUrl,
  managerScriptUrl,
];

const navItems = [
  {
    key: 'prices',
    label: '价格选择',
    icon: '<svg viewBox="0 0 20 20" fill="none"><rect x="3.5" y="4" width="13" height="12" rx="3" stroke="currentColor" stroke-width="1.6"></rect><path d="M6.7 9.9l2 2.1 4.6-4.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
  },
  {
    key: 'store',
    label: '仓库管理',
    attrs: { 'data-store-view': 'manage' },
    icon: '<svg viewBox="0 0 20 20" fill="none"><path d="M4.5 6.2h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path><path d="M5.2 6.2l1.1 9.3h7.4l1.1-9.3" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path><path d="M7.7 8.6v4.2M12.3 8.6v4.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path></svg>',
  },
  {
    key: 'chart',
    label: '行情走势',
    icon: '<svg viewBox="0 0 20 20" fill="none"><path d="M4.8 14.5h10.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path><path d="M6 12.1l2.3-2.3 2.2 1.7 3.5-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="6" cy="12.1" r="0.9" fill="currentColor"></circle><circle cx="8.3" cy="9.8" r="0.9" fill="currentColor"></circle><circle cx="10.5" cy="11.5" r="0.9" fill="currentColor"></circle><circle cx="14" cy="7.5" r="0.9" fill="currentColor"></circle></svg>',
  },
  {
    key: 'bubble-style',
    label: '气泡设置',
    icon: '<svg viewBox="0 0 20 20" fill="none"><rect x="4.1" y="4.3" width="11.8" height="9.4" rx="3" stroke="currentColor" stroke-width="1.6"></rect><path d="M8 15.1h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path><path d="M6.7 7.9h6.6M6.7 10.1h4.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>',
  },
  {
    key: 'settings',
    label: '应用设置',
    extraClass: 'nav-settings-item',
    icon: '<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="5.4" stroke="currentColor" stroke-width="1.6"></circle><path d="M10 7.2v2.9M10 12.7h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg>',
  },
];

const appTheme = ref('light');
const themeColor = ref('blue');
let compatibilityObserver = null;

const globalConfig = computed(() => ({
  classPrefix: 't',
}));

async function loadLegacyScripts() {
  for (const url of legacyScripts) {
    const existing = document.querySelector(`script[data-legacy-src="${url}"]`);
    if (existing) continue;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.async = false;
      script.dataset.legacySrc = url;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load legacy script: ${url}`));
      document.body.appendChild(script);
    });
  }
}

function syncBodyTheme() {
  document.body.dataset.theme = appTheme.value;
  document.body.dataset.themeColor = themeColor.value;
}

function applyClassList(elements, classes) {
  elements.forEach((el) => el.classList.add(...classes));
}

function decorateLegacyButtons() {
  document.querySelectorAll('.content .btn:not([data-tdesignified])').forEach((el) => {
    const classes = ['t-button', 't-button--shape-rectangle', 't-button--variant-outline', 't-size-s'];
    if (el.classList.contains('btn-primary')) {
      classes.push('t-button--theme-primary', 't-button--variant-base');
    } else if (el.classList.contains('btn-secondary')) {
      classes.push('t-button--theme-default', 't-button--variant-outline');
    } else {
      classes.push('t-button--theme-default', 't-button--variant-outline');
    }
    el.classList.add(...classes);
    el.dataset.tdesignified = 'button';
  });

  document.querySelectorAll('.rows-step-btn:not([data-tdesignified]), .chart-range-btn:not([data-tdesignified]), .chart-type-btn:not([data-tdesignified]), .chart-refresh-btn:not([data-tdesignified]), .chart-currency-btn:not([data-tdesignified]), .font-color-btn:not([data-tdesignified]), .ticket-image-add:not([data-tdesignified])').forEach((el) => {
    el.classList.add('t-button', 't-button--theme-default', 't-button--variant-outline', 't-size-s');
    el.dataset.tdesignified = 'button';
  });
}

function decorateLegacyCards() {
  applyClassList(document.querySelectorAll('.content .card'), ['t-card']);
  applyClassList(document.querySelectorAll('.content .style-panel'), ['t-card']);
  document.querySelectorAll('.content .badge:not([data-tdesignified])').forEach((el) => {
    el.classList.add('t-tag', 't-tag--theme-primary', 't-tag--variant-light');
    el.dataset.tdesignified = 'tag';
  });
}

function decorateLegacyFields() {
  document.querySelectorAll('.content select:not([data-tdesignified])').forEach((el) => {
    el.classList.add('t-select__input', 'td-compat-field');
    el.dataset.tdesignified = 'field';
  });
  document.querySelectorAll('.content input[type="text"]:not([data-tdesignified]), .content input[type="email"]:not([data-tdesignified])').forEach((el) => {
    el.classList.add('t-input__inner', 'td-compat-field');
    el.dataset.tdesignified = 'field';
  });
  document.querySelectorAll('.content textarea:not([data-tdesignified])').forEach((el) => {
    el.classList.add('t-textarea__inner', 'td-compat-field');
    el.dataset.tdesignified = 'field';
  });
}

function enhanceLegacyDom() {
  decorateLegacyCards();
  decorateLegacyButtons();
  decorateLegacyFields();
}

onMounted(async () => {
  syncBodyTheme();
  await nextTick();
  enhanceLegacyDom();
  compatibilityObserver = new MutationObserver(() => {
    enhanceLegacyDom();
  });
  compatibilityObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
  await loadLegacyScripts();
  enhanceLegacyDom();
});

onBeforeUnmount(() => {
  if (compatibilityObserver) {
    compatibilityObserver.disconnect();
    compatibilityObserver = null;
  }
});
</script>

<template>
  <t-config-provider :global-config="globalConfig">
    <t-layout class="app tdesign-manager-shell">
      <t-aside class="sidebar">
        <div class="sidebar-header" data-tauri-drag-region>
          <div class="sidebar-logo">GOLD-PRICE</div>
        </div>

        <nav class="sidebar-nav">
          <t-button
            v-for="item in navItems"
            :key="item.key"
            class="nav-item"
            :class="[{ active: item.key === 'prices' }, item.extraClass]"
            variant="text"
            size="large"
            block
            :data-view="item.key"
            v-bind="item.attrs || {}"
          >
            <template #icon>
              <span class="nav-item-icon" aria-hidden="true" v-html="item.icon"></span>
            </template>
            <span class="nav-item-label">{{ item.label }}</span>
            <span
              v-if="item.key === 'settings'"
              id="ticket-reply-dot"
              class="nav-dot"
              style="display:none;"
            >
              新消息
            </span>
          </t-button>
        </nav>

        <div class="sidebar-footer">
          <t-card class="bubble-preview" id="bubble-preview" :bordered="false">
            <div class="bp-header">
              <span class="bp-title">气泡预览</span>
              <span class="bp-mode" id="bp-mode">正常</span>
            </div>
          </t-card>

          <t-card id="update-banner" class="update-banner" style="display:none;" :bordered="false">
            <div class="update-info">
              <span class="update-text">新版本 <strong id="update-version"></strong></span>
            </div>
            <span class="btn-badge-wrap">
              <t-button id="download-update-btn" class="update-action-btn" size="small" theme="primary">
                下载更新
              </t-button>
              <span id="app-update-dot" class="update-dot"></span>
            </span>
            <div id="download-progress" class="download-progress" style="display:none;">
              <div class="download-progress-track">
                <div class="download-progress-bar" id="download-progress-bar"></div>
              </div>
              <span class="download-progress-pct" id="download-progress-pct">0%</span>
              <button id="download-cancel-btn" class="download-cancel-btn" type="button">取消</button>
            </div>
          </t-card>

          <div class="sidebar-copy">© 2025 Lucas Lee</div>
        </div>
        <div class="sidebar-ambient" aria-hidden="true"></div>
      </t-aside>

      <t-layout class="main">
        <t-header class="topbar" data-tauri-drag-region>
          <div class="topbar-left">
            <span class="top-title" id="page-title">价格选择</span>
          </div>
          <div class="topbar-right">
            <t-space size="12px" align="center">
              <div class="status-indicator">
                <span id="status-dot" class="status-dot"></span>
              </div>
            </t-space>
            <span id="sources-last-update" class="text-secondary topbar-last-update"></span>
            <t-button id="update-sources-btn" theme="primary" class="topbar-action-btn">
              重新连接
            </t-button>
            <div class="window-controls">
              <button class="wc-btn wc-min" id="wc-min" title="最小化" aria-label="最小化">
                <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path d="M4 9.5h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
                </svg>
              </button>
              <button class="wc-btn wc-max" id="wc-max" title="最大化" aria-label="最大化">
                <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <rect x="4.2" y="4.2" width="9.6" height="9.6" rx="1.4" stroke="currentColor" stroke-width="1.6"></rect>
                </svg>
              </button>
              <button class="wc-btn wc-close" id="wc-close" title="关闭" aria-label="关闭">
                <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path d="M5 5l8 8M13 5l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
                </svg>
              </button>
            </div>
          </div>
        </t-header>

        <t-content class="manager-main-content">
          <div v-html="contentMarkup"></div>
        </t-content>
      </t-layout>
    </t-layout>

    <div v-html="overlaysMarkup"></div>
  </t-config-provider>
</template>
