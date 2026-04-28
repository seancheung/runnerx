#!/usr/bin/env bash
set -euo pipefail

echo "创建 .venv ..."
python3 -m venv .venv
echo "升级 pip ..."
.venv/bin/python -m pip install --upgrade pip --quiet
echo "（无外部依赖，跳过 pip install）"
echo "安装完成。"
