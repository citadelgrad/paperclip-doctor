#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_ROOT="${PAPERCLIP_DOCTOR_REPORT_ROOT:-$ROOT/health-reports}"
OUTPUT_PATH="${1:-$REPORT_ROOT/index.html}"

mkdir -p "$REPORT_ROOT"

python3 - "$REPORT_ROOT" "$OUTPUT_PATH" <<'PY'
import glob
import html
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

report_root = Path(sys.argv[1])
output_path = Path(sys.argv[2])
json_output_path = output_path.with_suffix('.json')

def status_sort_key(value):
    return {"failed": 0, "degraded": 1, "warning": 2, "healthy": 3}.get(value, 99)

status_class = {"failed": "fail", "degraded": "warn", "warning": "warn-muted", "healthy": "pass"}


def read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def fmt_timestamp(value):
    if not value:
        return "unknown"
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    except Exception:
        return value


def rel(path: Path):
    return os.path.relpath(path, output_path.parent)

kinds = []
for child in sorted(report_root.iterdir() if report_root.exists() else [], key=lambda p: p.name):
    if not child.is_dir() or child.name.startswith('.'):
        continue
    latest_json = child / "latest.json"
    latest_html = child / "latest.html"
    latest = read_json(latest_json) if latest_json.exists() else None

    history_entries = []
    for json_path in sorted((child / "history").glob("*.json"), reverse=True):
        payload = read_json(json_path)
        if not payload:
            continue
        html_path = json_path.with_suffix(".html")
        history_entries.append({
            "json": json_path,
            "html": html_path if html_path.exists() else None,
            "generatedAt": payload.get("generatedAt"),
            "overallStatus": payload.get("overallStatus") or ("failed" if not payload.get("ok", True) else "healthy"),
            "command": payload.get("command", child.name),
            "summary": payload.get("summary", {}),
        })

    overall = latest.get("overallStatus") if latest else (history_entries[0]["overallStatus"] if history_entries else "healthy")
    kinds.append({
        "name": child.name,
        "latest": latest,
        "latest_json": latest_json if latest_json.exists() else None,
        "latest_html": latest_html if latest_html.exists() else None,
        "overallStatus": overall,
        "history": history_entries[:20],
    })

kinds.sort(key=lambda item: (status_sort_key(item["overallStatus"]), item["name"]))

overall_status = "healthy"
for candidate in [item["overallStatus"] for item in kinds]:
    if status_sort_key(candidate) < status_sort_key(overall_status):
        overall_status = candidate

cards = []
for item in kinds:
    latest = item["latest"] or {}
    summary = latest.get("summary", {}) if isinstance(latest, dict) else {}
    latest_generated = latest.get("generatedAt") if isinstance(latest, dict) else None
    latest_command = latest.get("command", item["name"]) if isinstance(latest, dict) else item["name"]
    latest_html_link = f'<a href="{html.escape(rel(item["latest_html"]))}">latest html</a>' if item["latest_html"] else '<span class="muted">latest html missing</span>'
    latest_json_link = f'<a href="{html.escape(rel(item["latest_json"]))}">latest json</a>' if item["latest_json"] else '<span class="muted">latest json missing</span>'

    rows = []
    for entry in item["history"]:
        entry_html_link = (
            f'<a href="{html.escape(rel(entry["html"]))}">html</a>' if entry["html"] else '<span class="muted">html missing</span>'
        )
        entry_json_link = f'<a href="{html.escape(rel(entry["json"]))}">json</a>'
        rows.append(
            "<tr>"
            f"<td>{html.escape(fmt_timestamp(entry['generatedAt']))}</td>"
            f"<td><span class=\"badge {html.escape(status_class.get(entry['overallStatus'], 'warn-muted'))}\">{html.escape(str(entry['overallStatus']).upper())}</span></td>"
            f"<td>{html.escape(str(entry['command']))}</td>"
            f"<td>{entry['summary'].get('passed', 0)} pass / {entry['summary'].get('warningOnly', max(entry['summary'].get('warned', 0) - entry['summary'].get('degraded', 0), 0))} warn / {entry['summary'].get('degraded', 0)} degr / {entry['summary'].get('failed', 0)} fail</td>"
            f"<td>{entry_html_link}</td>"
            f"<td>{entry_json_link}</td>"
            "</tr>"
        )
    history_table = (
        "<table><thead><tr><th>Generated</th><th>Status</th><th>Command</th><th>Summary</th><th>HTML</th><th>JSON</th></tr></thead><tbody>"
        + "".join(rows)
        + "</tbody></table>"
        if rows
        else "<p class=\"muted\">No historical reports yet.</p>"
    )

    cards.append(
        f"""
        <section class="card">
          <div class="card-header">
            <div>
              <div class="eyebrow">report set</div>
              <h2>{html.escape(item['name'])}</h2>
            </div>
            <span class="badge {html.escape(status_class.get(item['overallStatus'], 'warn-muted'))}">{html.escape(str(item['overallStatus']).upper())}</span>
          </div>
          <div class="meta-grid">
            <div><div class="meta-label">latest command</div><div class="meta-value">{html.escape(str(latest_command))}</div></div>
            <div><div class="meta-label">latest generated</div><div class="meta-value">{html.escape(fmt_timestamp(latest_generated))}</div></div>
            <div><div class="meta-label">summary</div><div class="meta-value">{summary.get('passed', 0)} healthy / {summary.get('warningOnly', max(summary.get('warned', 0) - summary.get('degraded', 0), 0))} warnings / {summary.get('degraded', 0)} degraded / {summary.get('failed', 0)} failures</div></div>
            <div><div class="meta-label">quick links</div><div class="meta-value links">{latest_html_link} {latest_json_link}</div></div>
          </div>
          <details>
            <summary>Recent history</summary>
            {history_table}
          </details>
        </section>
        """
    )

html_doc = f"""<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
  <title>paperclip-doctor reports</title>
  <style>
    :root {{ color-scheme: dark; --bg: #0b1020; --panel: #121937; --panel-2: #182042; --text: #eef2ff; --muted: #aab4d6; --pass: #22c55e; --warn: #f59e0b; --warn-muted: #fbbf24; --fail: #ef4444; --border: #2b3768; }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background: linear-gradient(180deg, #0b1020 0%, #111936 100%); color: var(--text); }}
    .wrap {{ max-width: 1200px; margin: 0 auto; padding: 32px 20px 60px; }}
    .hero, .card {{ background: rgba(18, 25, 55, 0.92); border: 1px solid var(--border); border-radius: 18px; box-shadow: 0 10px 30px rgba(0,0,0,0.25); }}
    .hero {{ padding: 24px; margin-bottom: 20px; border-color: color-mix(in srgb, var(--{status_class.get(overall_status, 'pass')}) 60%, var(--border)); }}
    .hero h1 {{ margin: 10px 0 8px; font-size: 30px; }}
    .hero p {{ margin: 0; color: var(--muted); line-height: 1.6; }}
    .cards {{ display: grid; gap: 18px; }}
    .card {{ padding: 20px; }}
    .card-header {{ display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }}
    .eyebrow, .meta-label {{ color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }}
    h2 {{ margin: 4px 0 0; font-size: 22px; }}
    .meta-grid {{ display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-bottom: 16px; }}
    .meta-value {{ margin-top: 6px; font-size: 15px; word-break: break-word; }}
    .links a {{ margin-right: 12px; }}
    .badge {{ display: inline-flex; align-items: center; padding: 6px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; letter-spacing: .08em; }}
    .badge.pass {{ background: rgba(34, 197, 94, .16); color: #86efac; }}
    .badge.warn {{ background: rgba(245, 158, 11, .16); color: #fcd34d; }}
    .badge.warn-muted {{ background: rgba(251, 191, 36, .16); color: #fde68a; }}
    .badge.fail {{ background: rgba(239, 68, 68, .16); color: #fca5a5; }}
    .muted {{ color: var(--muted); }}
    details {{ border-top: 1px solid var(--border); padding-top: 14px; }}
    summary {{ cursor: pointer; font-weight: 600; }}
    table {{ width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 14px; }}
    th, td {{ text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }}
    th {{ color: var(--muted); font-weight: 600; }}
    a {{ color: #93c5fd; text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
  </style>
</head>
<body>
  <div class=\"wrap\">
    <section class=\"hero\">
      <span class=\"badge {status_class.get(overall_status, 'pass')}\">{html.escape(overall_status.upper())}</span>
      <h1>paperclip-doctor report index</h1>
      <p>Browse the latest runtime, agent, and synthetic health checks plus recent history. This page is regenerated after each scheduled report run.</p>
    </section>
    <section class=\"cards\">{''.join(cards) if cards else '<section class="card"><p class="muted">No reports found yet.</p></section>'}</section>
  </div>
</body>
</html>
"""

manifest = {
    "generatedAt": datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
    "overallStatus": overall_status,
    "reportRoot": str(report_root),
    "htmlIndex": output_path.name,
    "reports": [
        {
            "name": item["name"],
            "overallStatus": item["overallStatus"],
            "latest": {
                "generatedAt": (item["latest"] or {}).get("generatedAt") if isinstance(item.get("latest"), dict) else None,
                "command": (item["latest"] or {}).get("command", item["name"]) if isinstance(item.get("latest"), dict) else item["name"],
                "summary": (item["latest"] or {}).get("summary", {}) if isinstance(item.get("latest"), dict) else {},
                "json": rel(item["latest_json"]) if item.get("latest_json") else None,
                "html": rel(item["latest_html"]) if item.get("latest_html") else None,
            },
            "history": [
                {
                    "generatedAt": entry.get("generatedAt"),
                    "overallStatus": entry.get("overallStatus"),
                    "command": entry.get("command"),
                    "summary": entry.get("summary", {}),
                    "json": rel(entry["json"]) if entry.get("json") else None,
                    "html": rel(entry["html"]) if entry.get("html") else None,
                }
                for entry in item.get("history", [])
            ],
        }
        for item in kinds
    ],
}

output_path.write_text(html_doc)
json_output_path.write_text(json.dumps(manifest, indent=2) + "\n")
print(str(output_path))
print(str(json_output_path))
PY
