#!/usr/bin/env bash
set -euo pipefail

src="${RUNNERX_SOURCE_DIR:?missing source dir}"
dst="${RUNNERX_ARCHIVE:?missing output path}"
include_hidden="${RUNNERX_INCLUDE_HIDDEN:-0}"
compression="${RUNNERX_COMPRESSION:-optimal}"

if [ ! -d "$src" ]; then
  echo "@@runnerx log {\"level\":\"error\",\"message\":\"源目录不存在: $src\"}"
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo '@@runnerx log {"level":"error","message":"未找到 zip 命令"}'
  exit 1
fi

# 已存在则先删，避免 zip 把新文件追加进去
[ -f "$dst" ] && rm -f "$dst"

case "$compression" in
  fastest)        level=("-1") ;;
  nocompression)  level=("-0") ;;
  *)              level=("-6") ;;
esac

cd "$src"

# 计算文件总数（排除隐藏文件除非显式包含）
if [ "$include_hidden" = "1" ]; then
  total=$(find . -type f | wc -l | tr -d ' ')
else
  total=$(find . -type f -not -path '*/.*' | wc -l | tr -d ' ')
fi
echo "@@runnerx log {\"level\":\"info\",\"message\":\"共 $total 个文件待压缩\"}"
echo '@@runnerx progress {"value":0.05,"message":"开始压缩..."}'

zip_args=("-r" "${level[@]}" "$dst" ".")
if [ "$include_hidden" != "1" ]; then
  zip_args+=("-x" "*/.*" "-x" ".*")
fi

# 解析 zip 的 "adding: ..." 行做进度推进
count=0
zip "${zip_args[@]}" 2>&1 | while IFS= read -r line; do
  case "$line" in
    *"adding:"*|*"updating:"*)
      count=$((count + 1))
      if [ "$total" -gt 0 ]; then
        ratio=$(awk "BEGIN { printf \"%.3f\", $count / $total }")
        printf '@@runnerx progress {"value":%s,"message":"已处理 %d/%d 个文件"}\n' "$ratio" "$count" "$total"
      fi
      ;;
    *)
      # 其它 zip 输出原样落到控制台
      echo "$line"
      ;;
  esac
done

echo '@@runnerx progress {"value":1.0,"message":"完成"}'
size_human=$(du -h "$dst" 2>/dev/null | awk '{print $1}')
echo "@@runnerx log {\"level\":\"info\",\"message\":\"输出: $dst ($size_human)\"}"
printf '@@runnerx result {"type":"file","path":"%s","label":"压缩文件"}\n' "$dst"
