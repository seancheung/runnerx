#!/usr/bin/env bash
set -euo pipefail

# 检查 ffmpeg 是否可用
if ! command -v ffmpeg &> /dev/null; then
    echo '@@runnerx log {"level":"error","message":"ffmpeg 未安装。请先运行 brew install ffmpeg 安装。"}' >&2
    exit 1
fi

INPUT_FILE="${RUNNERX_INPUT_FILE}"
CODEC="${RUNNERX_CODEC:-h264}"
QUALITY="${RUNNERX_QUALITY:-medium}"
OUTPUT_FILE="${RUNNERX_OUTPUT_FILE}"

# 验证输入文件是否存在
if [ ! -f "$INPUT_FILE" ]; then
    echo '@@runnerx log {"level":"error","message":"输入文件不存在"}' >&2
    exit 1
fi

# 质量 → CRF 映射
case "$QUALITY" in
    low)
        if [ "$CODEC" = "h265" ]; then CRF=28; else CRF=28; fi
        ;;
    medium)
        if [ "$CODEC" = "h265" ]; then CRF=24; else CRF=23; fi
        ;;
    high)
        if [ "$CODEC" = "h265" ]; then CRF=20; else CRF=18; fi
        ;;
    *)
        echo '@@runnerx log {"level":"error","message":"未知质量: '"$QUALITY"'"}' >&2
        exit 1
        ;;
esac

# 编码器映射
case "$CODEC" in
    h264) VCODEC="libx264" ;;
    h265) VCODEC="libx265" ;;
    *)
        echo '@@runnerx log {"level":"error","message":"未知编码器: '"$CODEC"'"}' >&2
        exit 1
        ;;
esac

echo '@@runnerx log {"level":"info","message":"开始转换: 编码器='$VCODEC', 质量='$QUALITY' (CRF='$CRF')"}'

# 执行 ffmpeg，失败时捕获退出码
if ffmpeg -i "$INPUT_FILE" -c:v "$VCODEC" -crf "$CRF" -c:a aac -b:a 128k -preset medium -movflags +faststart "$OUTPUT_FILE"; then
    echo '@@runnerx log {"level":"info","message":"转换完成: '"$OUTPUT_FILE"'"}'
    echo '@@runnerx result {"type":"file","path":"'"$OUTPUT_FILE"'","label":"转换后的视频"}'
else
    echo '@@runnerx log {"level":"error","message":"转换失败"}' >&2
    exit 1
fi