// ========================================
// 配置文件示例
// 使用说明：
// 1. 复制此文件为 config.js
// 2. 修改 DEFAULT_API_URL 为你的实际 API 地址
// ========================================

const DEFAULT_API_URL = 'http://your-api-server.com:8081/api/latest/all';

// 导出配置
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEFAULT_API_URL };
}

