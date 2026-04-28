#!/usr/bin/env bash
set -euo pipefail

if [ -d ".venv" ]; then
  echo "删除 .venv ..."
  rm -rf .venv
else
  echo "（.venv 不存在，跳过）"
fi

echo "卸载完成。"
