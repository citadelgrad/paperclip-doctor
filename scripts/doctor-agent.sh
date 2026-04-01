#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_BASE="${PAPERCLIP_API_URL:-http://127.0.0.1:3847}"
COMPANY_ID="${PAPERCLIP_COMPANY_ID:?set PAPERCLIP_COMPANY_ID}"
AGENT_ID="${PAPERCLIP_AGENT_ID:?set PAPERCLIP_AGENT_ID}"
REPORT_DIR="${PAPERCLIP_DOCTOR_REPORT_DIR:-$ROOT/health-reports/agent}"
TIMEOUT_MS="${PAPERCLIP_DOCTOR_TIMEOUT_MS:-30000}"

mkdir -p "$REPORT_DIR/history"
stamp="$(date +%F-%H%M%S)"
base="$REPORT_DIR/history/$stamp"

cd "$ROOT"
set +e
pnpm start -- agent \
  --api-base "$API_BASE" \
  --company-id "$COMPANY_ID" \
  --agent-id "$AGENT_ID" \
  --timeout-ms "$TIMEOUT_MS" \
  --json \
  --output "$base.json" \
  --html-output "$base.html"
status=$?
set -e

cp "$base.json" "$REPORT_DIR/latest.json"
cp "$base.html" "$REPORT_DIR/latest.html"
"$ROOT/scripts/generate-report-index.sh" >/dev/null

echo "agent report written to $base.json and $base.html"
echo "report index updated at $ROOT/health-reports/index.html"
exit "$status"
