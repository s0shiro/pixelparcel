#!/usr/bin/env bash
set -euo pipefail

extension_dir=$(cd "$(dirname "$0")/.." && pwd)

for quality in 720p 1080p; do
  mock_url="file://${extension_dir}/tests/mock-flow.html?quality=${quality}"
  result=$(google-chrome \
    --headless=new \
    --no-sandbox \
    --disable-gpu \
    --allow-file-access-from-files \
    --virtual-time-budget=12000 \
    --dump-dom \
    "$mock_url" 2>/dev/null)

  if [[ "$result" != *'data-success="2"'* || "$result" != *'data-failed="0"'* || "$result" != *'data-found="2"'* ]]; then
    echo "Browser smoke test failed for ${quality}"
    echo "$result" | tail -30
    exit 1
  fi

  echo "Browser smoke test passed: two ${quality} exports completed"
done

click_submenu_url="file://${extension_dir}/tests/mock-flow.html?quality=1080p&submenu=click"
click_submenu_result=$(google-chrome \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --allow-file-access-from-files \
  --virtual-time-budget=20000 \
  --dump-dom \
  "$click_submenu_url" 2>/dev/null)

if [[ "$click_submenu_result" != *'data-success="2"'* || "$click_submenu_result" != *'data-failed="0"'* ]]; then
  echo "Browser click-only resolution submenu test failed"
  echo "$click_submenu_result" | tail -30
  exit 1
fi

echo "Browser click-only resolution submenu passed for 1080p"

project_id="99999999-9999-4999-8999-999999999999"
title_remap_url="file://${extension_dir}/tests/mock-flow.html?quality=1080p&count=2&titleRemap=1&projectId=${project_id}"
title_remap_result=$(google-chrome \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --allow-file-access-from-files \
  --virtual-time-budget=16000 \
  --dump-dom \
  "$title_remap_url" 2>/dev/null)

if [[ "$title_remap_result" != *'data-success="2"'* || "$title_remap_result" != *'data-failed="0"'* ]]; then
  echo "Browser stale-ID/title fallback test failed"
  echo "$title_remap_result" | tail -30
  exit 1
fi

echo "Browser stale-ID/title fallback passed: both renamed card IDs matched"

scan_url="file://${extension_dir}/tests/mock-flow.html?mode=scan&count=23&projectId=${project_id}"
scan_result=$(google-chrome \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --allow-file-access-from-files \
  --virtual-time-budget=12000 \
  --dump-dom \
  "$scan_url" 2>/dev/null)

if [[ "$scan_result" != *'data-found="23"'* || "$scan_result" != *'data-failed="0"'* ]]; then
  echo "Browser inventory scan test failed"
  echo "$scan_result" | tail -30
  exit 1
fi

echo "Browser inventory scan passed: all 23 videos counted while only two cards were mounted"

failure_url="file://${extension_dir}/tests/mock-flow.html?quality=720p&count=3&failDownload=2&projectId=${project_id}"
failure_result=$(google-chrome \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --allow-file-access-from-files \
  --virtual-time-budget=12000 \
  --dump-dom \
  "$failure_url" 2>/dev/null)

if [[ "$failure_result" != *'data-failed="1"'* || "$failure_result" != *'data-failure-count="1"'* || "$failure_result" != *'data-failure-index="2"'* ]]; then
  echo "Browser failed-video identification test failed"
  echo "$failure_result" | tail -30
  exit 1
fi

echo "Browser failed-video identification passed: video #2 was recorded"

retry_url="file://${extension_dir}/tests/mock-flow.html?mode=retry-test&quality=720p&count=3&failDownload=2&projectId=${project_id}"
retry_result=$(google-chrome \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --allow-file-access-from-files \
  --virtual-time-budget=16000 \
  --dump-dom \
  "$retry_url" 2>/dev/null)

if [[ "$retry_result" != *'data-retry-completed="true"'* || "$retry_result" != *'data-failure-count="0"'* ]]; then
  echo "Browser failed-only retry test failed"
  echo "$retry_result" | tail -30
  exit 1
fi

echo "Browser failed-only retry passed: only the failed video reran"

fallback_result=$(google-chrome \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --allow-file-access-from-files \
  --virtual-time-budget=16000 \
  --dump-dom \
  "file://${extension_dir}/tests/mock-flow.html?mode=scan&count=23&inventoryFailure=1&projectId=${project_id}" 2>/dev/null)

if [[ "$fallback_result" != *'data-found="2"'* || "$fallback_result" != *'data-failed="0"'* || "$fallback_result" != *'data-last-error=""'* ]]; then
  echo "Browser inventory-request recovery test failed"
  echo "$fallback_result" | sed -n '/<output/,/<\/output>/p'
  exit 1
fi

echo "Browser inventory-request recovery passed: successful grid fallback clears the stale fetch error"
