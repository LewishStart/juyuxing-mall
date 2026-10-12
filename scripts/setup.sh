#!/bin/bash
set -u

# 林元元商城 — 部署前本地依赖检查
# 默认会为缺少依赖的云函数安装生产依赖；传入 --check 只检查、不下载。

MODE="install"
if [ "${1:-}" = "--check" ]; then MODE="check"; fi

echo "林元元商城 · 部署前检查"

APPID=$(node -p "require('./project.config.json').appid || ''")
CLOUD_ENV=$(node -p "require('./cloudbaserc.json').envId || ''")
APP_ENV=$(node -e "const s=require('fs').readFileSync('miniprogram/app.js','utf8'); const m=s.match(/envId:\\s*['\"]([^'\"]+)/); process.stdout.write(m ? m[1] : '')")

CONFIG_OK=true
if [ -z "$APPID" ] || [ "$APPID" = "your-app-id" ]; then
  echo "✗ project.config.json 尚未配置真实 AppID"
  CONFIG_OK=false
else
  echo "✓ AppID: $APPID"
fi

if [ -z "$CLOUD_ENV" ] || [ "$CLOUD_ENV" = "your-env-id" ]; then
  echo "✗ cloudbaserc.json 尚未配置真实环境 ID"
  CONFIG_OK=false
elif [ "$APP_ENV" != "$CLOUD_ENV" ]; then
  echo "✗ app.js 与 cloudbaserc.json 的环境 ID 不一致"
  CONFIG_OK=false
else
  echo "✓ CloudBase 环境一致: $CLOUD_ENV"
fi

MISSING=()
INSTALL_FAILED=false
FUNCTION_NAMES=$(node -p "require('./cloudbaserc.json').functions.map(item => item.name).join(' ')")
for name in $FUNCTION_NAMES; do
  dir="cloudfunctions/${name}/"
  if [ -d "${dir}node_modules/wx-server-sdk" ]; then
    echo "✓ $name 依赖已就绪"
    continue
  fi

  MISSING+=("$name")
  if [ "$MODE" = "check" ]; then
    echo "! $name 缺少 wx-server-sdk"
    continue
  fi

  if [ -f "${dir}package-lock.json" ]; then
    command="npm ci --omit=dev"
  else
    command="npm install --omit=dev"
  fi
  echo "→ $name: $command"
  if ! (cd "$dir" && $command); then INSTALL_FAILED=true; fi
done

if [ "$MODE" = "check" ] && [ ${#MISSING[@]} -gt 0 ]; then
  echo "缺少依赖: ${MISSING[*]}"
  echo "确认允许下载后运行: npm run setup"
fi

if [ "$CONFIG_OK" != true ] || [ "$INSTALL_FAILED" = true ]; then exit 1; fi

echo "本地配置检查完成。数据库、索引、迁移和部署步骤见 docs/ABC-DEPLOYMENT.md。"
