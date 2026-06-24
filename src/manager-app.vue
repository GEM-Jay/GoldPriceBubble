<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import contentMarkup from './manager-content-fragment.html?raw';
import overlaysMarkup from './manager-overlays-fragment.html?raw';
import { bootManagerApp } from './manager.js';

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

function syncBodyTheme() {
  document.body.dataset.theme = appTheme.value;
  document.body.dataset.themeColor = themeColor.value;
}

function applyClassList(elements, classes) {
  elements.forEach((el) => el.classList.add(...classes));
}

function isDangerButton(el) {
  return el.classList.contains('btn-danger')
    || el.classList.contains('gp-btn-danger')
    || el.classList.contains('settings-danger-btn')
    || el.classList.contains('eula-btn-reject')
    || el.id === 'reset-data-btn'
    || el.id === 'clear-and-quit-btn'
    || el.dataset.action === 'delete-warehouse'
    || el.dataset.action === 'sell-warehouse';
}

function isPrimaryButton(el) {
  return el.classList.contains('btn-primary')
    || el.classList.contains('gp-btn-primary')
    || el.classList.contains('eula-btn-accept')
    || el.classList.contains('warehouse-new-btn')
    || el.dataset.action === 'show-new-warehouse'
    || el.dataset.action === 'buy-warehouse'
    || el.dataset.action === 'adjust-position'
    || el.dataset.action === 'create-warehouse';
}

function isSmallButton(el) {
  return el.classList.contains('btn-small')
    || el.classList.contains('gp-btn-small')
    || el.classList.contains('rows-step-btn')
    || el.classList.contains('chart-type-btn')
    || el.classList.contains('chart-refresh-btn')
    || el.classList.contains('ticket-image-remove')
    || el.classList.contains('ticket-modal-close');
}

function isIconButton(el) {
  return el.classList.contains('gp-icon-btn')
    || el.classList.contains('rows-step-btn')
    || el.classList.contains('chart-type-btn')
    || el.classList.contains('chart-refresh-btn')
    || el.classList.contains('ticket-image-add')
    || el.classList.contains('ticket-image-remove')
    || el.classList.contains('ticket-modal-close');
}

function isSegmentButton(el) {
  return el.classList.contains('gp-segment-btn')
    || el.classList.contains('chart-range-btn')
    || el.classList.contains('chart-type-btn')
    || el.classList.contains('chart-currency-btn')
    || el.classList.contains('font-color-btn');
}

function decorateButtonElement(el) {
  if (!el || el.classList.contains('wc-btn')) return;

  const shouldBeDanger = isDangerButton(el);
  const shouldBePrimary = isPrimaryButton(el);
  const shouldBeSmall = isSmallButton(el);
  const shouldBeIcon = isIconButton(el);
  const shouldBeSegment = isSegmentButton(el);
  const shouldBeLocked = el.classList.contains('eula-btn-locked');

  el.classList.remove(
    't-button--theme-primary',
    't-button--theme-default',
    't-button--theme-danger',
    't-button--variant-base',
    't-button--variant-outline',
    't-is-disabled',
    'gp-btn-primary',
    'gp-btn-secondary',
    'gp-btn-danger',
    'gp-btn-small',
    'gp-icon-btn',
    'gp-segment-btn',
  );

  const baseClasses = [
    't-button',
    't-button--shape-rectangle',
    'gp-td-button',
  ];
  const stateClasses = [];

  if (shouldBeDanger) {
    stateClasses.push('t-button--theme-danger', 't-button--variant-base', 'gp-btn-danger');
  } else if (shouldBePrimary) {
    stateClasses.push('t-button--theme-primary', 't-button--variant-base', 'gp-btn-primary');
  } else {
    stateClasses.push('t-button--theme-default', 't-button--variant-outline', 'gp-btn-secondary');
  }

  if (shouldBeSmall) stateClasses.push('t-size-s', 'gp-btn-small');
  if (shouldBeIcon) stateClasses.push('gp-icon-btn');
  if (shouldBeSegment) stateClasses.push('gp-segment-btn');
  if (shouldBeLocked) stateClasses.push('t-is-disabled');

  el.classList.add(...baseClasses, ...stateClasses);
  el.dataset.tdesignified = 'button';
}

function decorateLegacyButtons() {
  const selectors = [
    '.content .btn',
    '.modal-overlay .btn',
    '.eula-btn',
    '.rows-step-btn',
    '.chart-range-btn',
    '.chart-type-btn',
    '.chart-refresh-btn',
    '.chart-currency-btn',
    '.font-color-btn',
    '.ticket-image-add',
    '.ticket-image-remove',
    '.ticket-modal-close',
    '.warehouse-new-btn',
  ];
  document.querySelectorAll(selectors.join(', ')).forEach(decorateButtonElement);
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

function decorateLegacySwitches() {
  document.querySelectorAll('.content .switch').forEach((switchEl) => {
    const input = switchEl.querySelector('input[type="checkbox"]');
    const slider = switchEl.querySelector('.slider');
    if (!input || !slider) return;

    switchEl.classList.remove('t-switch');
    slider.classList.remove('t-switch__handle');
    input.classList.remove('t-switch__input');
    switchEl.classList.add('gp-td-switch');
    switchEl.classList.toggle('gp-td-switch-checked', input.checked);
    if (input.dataset.boundTdesignSwitch !== '1') {
      input.dataset.boundTdesignSwitch = '1';
      input.addEventListener('change', () => {
        switchEl.classList.toggle('gp-td-switch-checked', input.checked);
      });
    }
    switchEl.dataset.tdesignified = 'switch';
  });
}

function enhanceLegacyDom() {
  decorateLegacyCards();
  decorateLegacyButtons();
  decorateLegacyFields();
  decorateLegacySwitches();
}

onMounted(async () => {
  syncBodyTheme();
  await nextTick();
  enhanceLegacyDom();
  bootManagerApp();
  compatibilityObserver = new MutationObserver(() => {
    enhanceLegacyDom();
  });
  compatibilityObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
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
            <span
              v-if="item.key === 'settings'"
              id="app-update-dot-sidebar"
              class="update-dot nav-update-dot"
              style="display:none;"
              aria-hidden="true"
            ></span>
          </t-button>
        </nav>

        <div class="sidebar-footer">
          <t-card class="bubble-preview" id="bubble-preview" :bordered="false">
            <div class="bp-header">
              <span class="bp-title">气泡预览</span>
              <span class="bp-mode" id="bp-mode">正常</span>
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
