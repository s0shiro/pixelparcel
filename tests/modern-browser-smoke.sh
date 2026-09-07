#!/usr/bin/env bash
set -euo pipefail

extension_dir=$(cd "$(dirname "$0")/.." && pwd)

for scenario in scan 720p 1080p retry unavailable long-upscale invalid-context selection selection-refresh; do
  query="count=7"
  case "$scenario" in
    scan) query="${query}&mode=scan" ;;
    720p|1080p) query="${query}&quality=${scenario}" ;;
    retry) query="${query}&mode=retry&quality=1080p&failIndex=2" ;;
    unavailable) query="count=1&quality=720p&lowResolution=1" ;;
    long-upscale) query="${query}&quality=1080p&longUpscale=1" ;;
    invalid-context) query="count=1&quality=1080p&invalidatedCancel=1" ;;
    selection) query="count=3&mode=selection" ;;
    selection-refresh) query="count=3&mode=selection-refresh&unstableIdentity=1" ;;
  esac
  result=$(google-chrome \
    --headless=new \
    --no-sandbox \
    --disable-gpu \
    --allow-file-access-from-files \
    --virtual-time-budget=120000 \
    --dump-dom \
    "file://${extension_dir}/tests/mock-modern-flow.html?${query}" 2>/dev/null)

  passed=true
  if [[ "$result" != *'data-legacy-requests="0"'* || "$result" != *'data-fetch-requests="0"'* || "$result" != *'data-wrong-quality="false"'* || "$result" != *'data-unrelated-clicks="0"'* ]]; then
    passed=false
  fi
  case "$scenario" in
    scan) [[ "$result" == *'data-found="7"'* && "$result" == *'data-failed="0"'* ]] || passed=false ;;
    720p|1080p|long-upscale) [[ "$result" == *'data-success="7"'* && "$result" == *'data-failed="0"'* ]] || passed=false ;;
    invalid-context) [[ "$result" == *'data-success="1"'* && "$result" == *'data-failed="0"'* && "$result" == *'data-unhandled-rejections="0"'* ]] || passed=false ;;
    retry) [[ "$result" == *'data-retry-correct="true"'* && "$result" == *'data-failed="0"'* ]] || passed=false ;;
    unavailable) [[ "$result" == *'data-success="0"'* && "$result" == *'data-failed="1"'* ]] || passed=false ;;
    selection|selection-refresh) [[ "$result" == *'data-selection-count="1"'* && "$result" == *'data-checked-count="1"'* && "$result" == *'data-playback-starts="0"'* && "$result" == *'data-control-outside-tile="true"'* ]] || passed=false ;;
  esac
  if [[ "$passed" != true ]]; then
    echo "New Flow browser test failed: ${scenario}"
    echo "$result" | sed -n '/<output/,/<\/output>/p'
    exit 1
  fi
  echo "New Flow browser test passed: ${scenario} (virtualized Angular grid, no legacy fetch)"
done
