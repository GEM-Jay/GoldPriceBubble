import './bubble.css';
import configScriptUrl from './config.js?url';
import dataSourceScriptUrl from './datasource.js?url';
import bubbleScriptUrl from './bubble.js?url';

const legacyScripts = [
  configScriptUrl,
  dataSourceScriptUrl,
  bubbleScriptUrl,
];

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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    loadLegacyScripts().catch((error) => console.error(error));
  }, { once: true });
} else {
  loadLegacyScripts().catch((error) => console.error(error));
}
