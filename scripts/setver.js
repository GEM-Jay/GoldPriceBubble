#!/usr/bin/env node
// 用法: npm run setver -- 2.1.2
const fs = require('fs');
const path = require('path');

const ver = process.argv[2];
if (!ver || !/^\d+\.\d+\.\d+$/.test(ver)) {
  console.error('用法: npm run setver -- <版本号>  例如: npm run setver -- 2.1.2');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');

const files = [
  {
    file: 'package.json',
    replace: (s) => s.replace(/"version"\s*:\s*"[^"]+"/, `"version": "${ver}"`),
  },
  {
    file: 'src-tauri/tauri.conf.json',
    replace: (s) => s.replace(/"version"\s*:\s*"[^"]+"/, `"version": "${ver}"`),
  },
  {
    file: 'src-tauri/Cargo.toml',
    replace: (s) => s.replace(/^version = "[^"]+"/m, `version = "${ver}"`),
  },
];

files.forEach(({ file, replace }) => {
  const abs = path.join(root, file);
  const original = fs.readFileSync(abs, 'utf8');
  const updated = replace(original);
  if (updated === original) {
    console.warn(`  ⚠  ${file} 未发生变化，请检查格式`);
  } else {
    fs.writeFileSync(abs, updated, 'utf8');
    console.log(`  ✓  ${file}`);
  }
});

console.log(`\n版本已设置为 ${ver}`);
