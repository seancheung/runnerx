#!/usr/bin/env bash
set -euo pipefail

title="${RUNNERX_TITLE:-untitled}"
count="${RUNNERX_COUNT:-5}"
verbose="${RUNNERX_VERBOSE:-0}"
format="${RUNNERX_FORMAT:-table}"
rows="${RUNNERX_ROWS:-5}"
tags="${RUNNERX_TAGS:-}"
file="${RUNNERX_INPUT_FILE:-}"

notes="${RUNNERX_NOTES:-}"

echo "标题: $title"
echo "步数: $count"
echo "标签: ${tags:-（无）}"
[[ -n "$file" ]] && echo "文件: $file"
if [[ -n "$notes" ]]; then
  echo "--- 备注 ---"
  echo "$notes"
  echo "--- /备注 ---"
fi

[[ "$verbose" == "1" ]] && echo '@@runnerx log {"level":"info","message":"verbose 模式已开启"}'

for i in $(seq 1 "$count"); do
  ratio=$(awk "BEGIN { printf \"%.3f\", $i / $count }")
  printf '@@runnerx progress {"value":%s,"message":"step %d/%d"}\n' "$ratio" "$i" "$count"
  echo "正在处理 step $i ..."
  sleep 0.4
done

case "$format" in
  table)
    cols='["id","name","status"]'
    rows_json="["
    for i in $(seq 1 "$rows"); do
      [[ $i -gt 1 ]] && rows_json+=","
      rows_json+="[$i,\"item-$i\",\"ok\"]"
    done
    rows_json+="]"
    printf '@@runnerx result {"type":"table","title":"演示数据","columns":%s,"rows":%s}\n' "$cols" "$rows_json"
    ;;
  json)
    echo '@@runnerx result {"type":"json","label":"摘要","data":{"title":"'$title'","count":'$count'}}'
    ;;
  text)
    echo '@@runnerx result {"type":"text","label":"摘要","data":"已生成 '"$count"' 步演示输出"}'
    ;;
esac

echo "完成！"
