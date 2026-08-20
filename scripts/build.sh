#!/bin/bash
# @dsh-external/dsh-prompt-enhancer — 纯 JS 插件构建(无 tsc/tsdown 依赖)。
# 本环境无源码 checkout、无 tsdown:host/client 均为手写 JS,构建即拷贝 + 特征校验。
# dev_build_plugin 会注入 DSH_CHECKOUT(装配式 profile 目录亦可),本脚本不使用它。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p lib

echo "=== 拷贝 host(src/index.js → lib/index.js) ==="
cp src/index.js lib/index.js

echo "=== 拷贝 client(src/client/index.js → lib/client.js) ==="
cp src/client/index.js lib/client.js

echo "=== 产物特征校验 ==="
node -e "
const fs = require('fs');
const host = fs.readFileSync('lib/index.js', 'utf8');
if (!host.includes('export function apply')) {
  console.error('lib/index.js 缺 apply 导出');
  process.exit(1);
}
const client = fs.readFileSync('lib/client.js', 'utf8');
if (!client.includes('__ModuleLoader__')) {
  console.error('lib/client.js 缺 __ModuleLoader__ 特征(注入器校验必挂)');
  process.exit(1);
}
console.log('host ✓ / client ✓');
"

echo "=== Build complete ==="
