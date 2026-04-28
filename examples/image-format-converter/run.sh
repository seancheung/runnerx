#!/usr/bin/env bash
set -euo pipefail

INPUT_FILE="${RUNNERX_INPUT_FILE:-}"
OUTPUT_FORMAT="${RUNNERX_OUTPUT_FORMAT:-}"
QUALITY="${RUNNERX_QUALITY:-90}"
OUTPUT_FILE="${RUNNERX_OUT_OUTPUT_FILE:-}"

echo "Input: ${INPUT_FILE}"
echo "Output Format: ${OUTPUT_FORMAT}"
echo "Quality: ${QUALITY}"
echo "Output File: ${OUTPUT_FILE}"

if [[ -z "${INPUT_FILE}" ]]; then
  echo "@@runnerx log {\"level\": \"error\", \"message\": \"Missing input file.\"}"
  exit 1
fi

if [[ ! -f "${INPUT_FILE}" ]]; then
  echo "@@runnerx log {\"level\": \"error\", \"message\": \"Input file not found: ${INPUT_FILE}\"}"
  exit 1
fi

if [[ -z "${OUTPUT_FORMAT}" ]]; then
  echo "@@runnerx log {\"level\": \"error\", \"message\": \"Missing output format.\"}"
  exit 1
fi

# Generate default output filename if none provided via save dialog
if [[ -z "${OUTPUT_FILE}" ]]; then
  BASENAME=$(basename "${INPUT_FILE}")
  NAME_WITHOUT_EXT="${BASENAME%.*}"
  case "${OUTPUT_FORMAT}" in
    jpg) EXT="jpg" ;;
    png) EXT="png" ;;
    gif) EXT="gif" ;;
    webp) EXT="webp" ;;
    bmp) EXT="bmp" ;;
    tiff) EXT="tiff" ;;
    *) EXT="${OUTPUT_FORMAT}" ;;
  esac
  OUTPUT_FILE="${NAME_WITHOUT_EXT}.${EXT}"
fi

# Detect ImageMagick command
if command -v magick &> /dev/null; then
  IM_CMD="magick"
elif command -v convert &> /dev/null; then
  IM_CMD="convert"
else
  echo "@@runnerx log {\"level\": \"error\", \"message\": \"ImageMagick (magick or convert) not found in PATH.\"}"
  exit 1
fi

echo "@@runnerx progress {\"value\": 0.2, \"message\": \"Converting image...\"}"

QUALITY_ARG=()
if [[ "${OUTPUT_FORMAT}" == "jpg" || "${OUTPUT_FORMAT}" == "webp" ]]; then
  QUALITY_ARG=("-quality" "${QUALITY}")
fi

if "${IM_CMD}" "${INPUT_FILE}" ${QUALITY_ARG[@]+"${QUALITY_ARG[@]}"} "${OUTPUT_FILE}"; then
  echo "@@runnerx progress {\"value\": 0.9, \"message\": \"Conversion done.\"}"
  echo "@@runnerx result {\"type\": \"image\", \"path\": \"${OUTPUT_FILE}\", \"label\": \"Converted Image\"}"
  echo "@@runnerx result {\"type\": \"file\", \"path\": \"${OUTPUT_FILE}\", \"label\": \"Download Converted Image\"}"
  echo "@@runnerx log {\"level\": \"info\", \"message\": \"Image saved to ${OUTPUT_FILE}\"}"
  echo "@@runnerx progress {\"value\": 1.0, \"message\": \"Complete.\"}"
else
  echo "@@runnerx log {\"level\": \"error\", \"message\": \"Conversion failed. Check ImageMagick installation and input file.\"}"
  exit 1
fi