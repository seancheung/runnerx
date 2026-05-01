#!/usr/bin/env bash
set -euo pipefail

input="${RUNNERX_INPUT_FILE:?missing INPUT_FILE}"
format="${RUNNERX_FORMAT:-mp3}"
bitrate="${RUNNERX_BITRATE:-192}"
output="${RUNNERX_OUTPUT_FILE:?missing output path}"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo '@@runnerx log {"level":"error","message":"ffmpeg 未安装。请先安装 ffmpeg。"}'
  exit 1
fi

case "$format" in
  mp3) codec=libmp3lame; rate_arg=(-b:a "${bitrate}k") ;;
  aac) codec=aac;        rate_arg=(-b:a "${bitrate}k") ;;
  wav) codec=pcm_s16le;  rate_arg=() ;;
  *) echo "未知格式: $format"; exit 1 ;;
esac

echo '@@runnerx progress {"value":0.05,"message":"探测时长"}'
duration=$(ffprobe -v error -show_entries format=duration \
  -of default=noprint_wrappers=1:nokey=1 "$input" 2>/dev/null || echo "")

echo '@@runnerx log {"level":"info","message":"开始转码"}'

ffmpeg -y -i "$input" -vn -acodec "$codec" "${rate_arg[@]}" \
  -progress pipe:1 -nostats -loglevel error "$output" \
  | while IFS='=' read -r key value; do
      if [[ "$key" == "out_time_ms" && -n "$duration" ]]; then
        secs=$(awk "BEGIN { printf \"%.3f\", $value / 1000000 / $duration }")
        printf '@@runnerx progress {"value":%s,"message":"转码中"}\n' "$secs"
      fi
    done

echo '@@runnerx progress {"value":1.0,"message":"完成"}'
printf '@@runnerx result {"type":"file","path":"%s","label":"音频"}\n' "$output"
echo "已生成: $output"
