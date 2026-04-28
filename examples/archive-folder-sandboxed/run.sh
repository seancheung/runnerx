#!/bin/sh
# Alpine BusyBox 的 sh，不是 bash——避免 bash-only 语法（数组、[[ ]] 等）。
set -eu

src="${RUNNERX_SOURCE_DIR:?missing source dir}"
dst="${RUNNERX_OUT_ARCHIVE:?missing output path}"
include_hidden="${RUNNERX_INCLUDE_HIDDEN:-0}"
compression="${RUNNERX_COMPRESSION:-optimal}"

if [ ! -d "$src" ]; then
  echo "@@runnerx log {\"level\":\"error\",\"message\":\"源目录不存在: $src\"}"
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo '@@runnerx log {"level":"error","message":"容器内未安装 zip。请重新安装脚本。"}'
  exit 1
fi

# 已存在则先删，避免追加
[ -f "$dst" ] && rm -f "$dst"

case "$compression" in
  fastest)        level=-1 ;;
  nocompression)  level=-0 ;;
  *)              level=-6 ;;
esac

cd "$src"

if [ "$include_hidden" = "1" ]; then
  total=$(find . -type f | wc -l | tr -d ' ')
else
  total=$(find . -type f -not -path '*/.*' | wc -l | tr -d ' ')
fi
echo "@@runnerx log {\"level\":\"info\",\"message\":\"$total 个文件待压缩\"}"
echo '@@runnerx progress {"value":0.05,"message":"开始压缩..."}'

count=0
if [ "$include_hidden" = "1" ]; then
  zip -r $level "$dst" . 2>&1
else
  zip -r $level "$dst" . -x '*/.*' -x '.*' 2>&1
fi | while IFS= read -r line; do
  case "$line" in
    *"adding:"*|*"updating:"*)
      count=$((count + 1))
      if [ "$total" -gt 0 ]; then
        ratio=$(awk "BEGIN { printf \"%.3f\", $count / $total }")
        printf '@@runnerx progress {"value":%s,"message":"已处理 %d/%d 个文件"}\n' "$ratio" "$count" "$total"
      fi
      ;;
    *)
      echo "$line"
      ;;
  esac
done

echo '@@runnerx progress {"value":1.0,"message":"完成"}'
size=$(du -h "$dst" 2>/dev/null | awk '{print $1}')
printf '@@runnerx log {"level":"info","message":"输出: %s (%s)"}\n' "$dst" "$size"
printf '@@runnerx result {"type":"file","path":"%s","label":"压缩文件"}\n' "$dst"
