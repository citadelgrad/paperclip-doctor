#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_SCHEDULE="${PAPERCLIP_DOCTOR_RUNTIME_CRON:-17 13 * * *}"
AGENT_SCHEDULE="${PAPERCLIP_DOCTOR_AGENT_CRON:-47 13 * * *}"
SYNTHETIC_SCHEDULE="${PAPERCLIP_DOCTOR_SYNTHETIC_CRON:-23 14 * * 1}"
CRON_FILE="${PAPERCLIP_DOCTOR_CRON_FILE:-$ROOT/.generated-crontab}"

cat > "$CRON_FILE" <<EOF
# paperclip-doctor runtime
$RUNTIME_SCHEDULE cd $ROOT && $ROOT/scripts/doctor-runtime.sh >> $ROOT/health-reports/runtime/cron.log 2>&1
# paperclip-doctor agent
$AGENT_SCHEDULE cd $ROOT && $ROOT/scripts/doctor-agent.sh >> $ROOT/health-reports/agent/cron.log 2>&1
# paperclip-doctor synthetic
$SYNTHETIC_SCHEDULE cd $ROOT && $ROOT/scripts/doctor-synthetic.sh >> $ROOT/health-reports/synthetic/cron.log 2>&1
EOF

if [[ "${1:-}" == "--write" ]]; then
  crontab "$CRON_FILE"
  echo "installed crontab from $CRON_FILE"
else
  echo "wrote $CRON_FILE"
  echo "review it, then run: crontab $CRON_FILE"
fi
