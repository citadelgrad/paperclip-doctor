# paperclip-doctor

External OSS healthcheck CLI for Paperclip.

Repo: https://github.com/citadelgrad/paperclip-doctor

This project is intentionally a wrapper instead of a Paperclip core patch. It lets the community iterate quickly on runtime diagnostics and synthetic probes before deciding what should move upstream into `paperclipai doctor`.

What it checks today:
- optional handoff to the built-in `paperclipai doctor --yes`
- API health and bootstrap/auth readiness
- local-trusted vs API-key auth behavior
- company and agent discovery
- agent heartbeat invocation
- heartbeat run and event polling
- runtime env injection via `adapter.invoke`
- synthetic end-to-end issue -> wakeup -> progress probe
- human-readable terminal output
- JSON reports
- styled HTML reports

## Status model

The wrapper is built around three health layers:
- `runtime`: broad environment health and auto-discovery
- `agent`: targeted wakeup/event/env-contract probe for a specific agent
- `synthetic`: disposable issue creation plus real end-to-end reaction checks

## Local development

```bash
pnpm install
pnpm build
pnpm start -- runtime --api-base http://127.0.0.1:3847
```

For local iteration:

```bash
pnpm dev -- runtime --api-base http://127.0.0.1:3847
pnpm dev -- agent --api-base http://127.0.0.1:3847 --company-id <company-id> --agent-id <agent-id>
pnpm dev -- synthetic --api-base http://127.0.0.1:3847 --company-id <company-id> --agent-id <agent-id>
```

## CLI usage

```bash
paperclip-doctor runtime
paperclip-doctor agent --company-id <company-id> --agent-id <agent-id>
paperclip-doctor synthetic --company-id <company-id> --agent-id <agent-id>
```

Flags:
- `--json` emit JSON to stdout
- `--skip-setup` skip `paperclipai doctor --yes`
- `--api-base <url>` Paperclip API base URL
- `--api-key <key>` API key when not running in `local_trusted`
- `--company-id <id>` target company override
- `--agent-id <id>` target agent override
- `--timeout-ms <n>` timeout for polling-based checks
- `--output <path>` write JSON report to disk
- `--html-output <path>` write styled HTML report to disk
- `--no-cleanup` keep the synthetic issue visible after the probe

## Environment resolution

Flags win over env vars.

Supported env vars:
- `PAPERCLIP_API_URL`
- `PAPERCLIP_API_KEY`
- `PAPERCLIP_AGENT_ID`
- `PAPERCLIP_COMPANY_ID`
- `PAPERCLIP_DOCTOR_TIMEOUT_MS`
- `PAPERCLIP_DOCTOR_SKIP_SETUP=1`
- `PAPERCLIP_DOCTOR_CLEANUP=0`
- `PAPERCLIP_DOCTOR_HTML_OUTPUT=/path/to/report.html`

Auth behavior:
- in normal deployments, pass `--api-key` or `PAPERCLIP_API_KEY`
- in `local_trusted` dev mode, the doctor can still exercise loopback board routes without an API key

## Report examples

Runtime report with JSON and HTML artifacts:

```bash
paperclip-doctor runtime \
  --api-base "$PAPERCLIP_API_URL" \
  --json \
  --output .paperclip/health/runtime-latest.json \
  --html-output .paperclip/health/runtime-latest.html
```

Target one known agent:

```bash
paperclip-doctor agent \
  --api-base "$PAPERCLIP_API_URL" \
  --company-id "$PAPERCLIP_COMPANY_ID" \
  --agent-id "$PAPERCLIP_AGENT_ID" \
  --json \
  --output .paperclip/health/agent-latest.json \
  --html-output .paperclip/health/agent-latest.html
```

Weekly synthetic heartbeat probe:

```bash
paperclip-doctor synthetic \
  --api-base "$PAPERCLIP_API_URL" \
  --company-id "$PAPERCLIP_COMPANY_ID" \
  --agent-id "$PAPERCLIP_AGENT_ID" \
  --timeout-ms 45000 \
  --json \
  --output .paperclip/health/synthetic-latest.json \
  --html-output .paperclip/health/synthetic-latest.html
```

## Cron scheduler scripts

This repo includes local scheduler helpers in `scripts/`:
- `scripts/doctor-runtime.sh`
- `scripts/doctor-agent.sh`
- `scripts/doctor-synthetic.sh`
- `scripts/generate-report-index.sh`
- `scripts/install-cron.sh`

Each check script:
- runs the appropriate doctor command
- writes timestamped JSON + HTML artifacts under `health-reports/<kind>/history/`
- updates `latest.json` and `latest.html`
- regenerates `health-reports/index.html` so reports stay browsable from a single landing page
- regenerates `health-reports/index.json` so external dashboards/automation can consume the same report catalog programmatically

Examples:

```bash
./scripts/doctor-runtime.sh
./scripts/doctor-agent.sh
./scripts/doctor-synthetic.sh
```

Generate a crontab file:

```bash
./scripts/install-cron.sh
```

Install it directly:

```bash
./scripts/install-cron.sh --write
```

Cron-related env vars:
- `PAPERCLIP_DOCTOR_REPORT_DIR`
- `PAPERCLIP_DOCTOR_RUNTIME_CRON`
- `PAPERCLIP_DOCTOR_AGENT_CRON`
- `PAPERCLIP_DOCTOR_SYNTHETIC_CRON`
- `PAPERCLIP_DOCTOR_CRON_FILE`

Default schedules:
- runtime: daily at `13:17`
- agent: daily at `13:47`
- synthetic: Mondays at `14:23`

You can also regenerate the index manually:

```bash
./scripts/generate-report-index.sh
```

That writes both:
- `health-reports/index.html`
- `health-reports/index.json`

The JSON manifest includes:
- overall index status
- generation timestamp
- per-report-set latest artifact links
- recent history entries with status/summary metadata

## Exit codes

- `0` healthy
- `1` warning or degraded
- `2` at least one failure

## Why this exists

A green setup doctor is not enough. Many "wasted turn" failures come from runtime mismatches:
- wrong auth mode
- broken API base URLs
- wakeup or scheduler failures
- adapter startup problems
- missing injected env vars
- issue assignment or approval flow mismatches

`paperclip-doctor` is meant to make those failures visible before they burn agent turns.
