#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type Status = "pass" | "warn" | "fail";
type CommandName = "runtime" | "agent" | "synthetic" | "help";

type CheckResult = {
  id: string;
  name: string;
  status: Status;
  message: string;
  details?: Record<string, unknown>;
};

type OverallStatus = "healthy" | "warning" | "degraded" | "failed";

type Report = {
  ok: boolean;
  overallStatus: OverallStatus;
  command: Exclude<CommandName, "help">;
  generatedAt: string;
  summary: { passed: number; warned: number; warningOnly: number; degraded: number; failed: number };
  checks: CheckResult[];
};

type CompanyRecord = {
  id: string;
  name: string;
  status?: string;
};

type AgentRecord = {
  id: string;
  name?: string;
  status?: string;
  companyId?: string;
  adapterType?: string;
  adapterConfig?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

type HeartbeatRun = {
  id: string;
  status: string;
  error?: string | null;
  companyId?: string;
  agentId?: string;
  createdAt?: string;
  finishedAt?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
};

type HeartbeatRunEvent = {
  seq?: number;
  runId?: string;
  eventType?: string;
  type?: string;
  message?: string;
  payload?: unknown;
};

type IssueRecord = {
  id: string;
  identifier?: string;
  companyId: string;
  title: string;
  status?: string;
  assigneeAgentId?: string | null;
  hiddenAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  executionRunId?: string | null;
};

type IssueComment = {
  id: string;
  body?: string;
  createdAt?: string;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
};

type ParsedArgs = {
  command: CommandName;
  json: boolean;
  skipSetup: boolean;
  apiBase?: string;
  apiKey?: string;
  agentId?: string;
  companyId?: string;
  timeoutMs: number;
  output?: string;
  htmlOutput?: string;
  cleanup: boolean;
};

type RuntimeContext = {
  apiBase: string;
  apiKey?: string;
  companyId?: string;
  agentId?: string;
  deploymentMode?: string;
  authReady?: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  if (args[0] === "--") args.shift();
  const command = (args.shift() as CommandName | undefined) ?? "help";
  const parsed: ParsedArgs = {
    command: command === "runtime" || command === "agent" || command === "synthetic" ? command : "help",
    json: false,
    skipSetup: process.env.PAPERCLIP_DOCTOR_SKIP_SETUP === "1",
    apiBase: process.env.PAPERCLIP_API_URL,
    apiKey: process.env.PAPERCLIP_API_KEY,
    agentId: process.env.PAPERCLIP_AGENT_ID,
    companyId: process.env.PAPERCLIP_COMPANY_ID,
    timeoutMs: Number.parseInt(process.env.PAPERCLIP_DOCTOR_TIMEOUT_MS ?? "30000", 10),
    output: undefined,
    htmlOutput: process.env.PAPERCLIP_DOCTOR_HTML_OUTPUT,
    cleanup: process.env.PAPERCLIP_DOCTOR_CLEANUP !== "0",
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === "--json") parsed.json = true;
    else if (arg === "--skip-setup") parsed.skipSetup = true;
    else if (arg === "--api-base") parsed.apiBase = args.shift();
    else if (arg === "--api-key") parsed.apiKey = args.shift();
    else if (arg === "--agent-id") parsed.agentId = args.shift();
    else if (arg === "--company-id") parsed.companyId = args.shift();
    else if (arg === "--timeout-ms") parsed.timeoutMs = Number.parseInt(args.shift() ?? "30000", 10);
    else if (arg === "--output") parsed.output = args.shift();
    else if (arg === "--html-output") parsed.htmlOutput = args.shift();
    else if (arg === "--no-cleanup") parsed.cleanup = false;
  }

  return parsed;
}

function usage(): string {
  return [
    "paperclip-doctor",
    "",
    "Commands:",
    "  runtime            Run setup + API/runtime checks and auto-discover company context.",
    "  agent              Run wakeup, heartbeat-run, and runtime env checks for an agent.",
    "  synthetic          Create a temporary issue, trigger a real wakeup path, and verify end-to-end flow.",
    "",
    "Flags:",
    "  --json             Emit JSON report",
    "  --skip-setup       Skip invoking paperclipai doctor --yes",
    "  --api-base <url>   Paperclip API base URL",
    "  --api-key <key>    Paperclip API key (optional in local_trusted mode)",
    "  --agent-id <id>    Agent id for agent/synthetic checks",
    "  --company-id <id>  Company id override",
    "  --timeout-ms <n>   Poll timeout for runtime and synthetic checks",
    "  --output <path>    Also write JSON report to file",
    "  --html-output <path> Write a styled HTML report to file",
    "  --no-cleanup       Keep synthetic issue instead of hiding it after the probe",
  ].join("\n");
}

function color(status: Status, text: string): string {
  const code = status === "pass" ? "32" : status === "warn" ? "33" : "31";
  return `\u001b[${code}m${text}\u001b[0m`;
}

function isDegradedCheck(check: CheckResult): boolean {
  return check.status === "warn" && check.message.toLowerCase().includes("degraded but functioning");
}

function summarize(checks: CheckResult[]) {
  const warned = checks.filter((c) => c.status === "warn").length;
  const degraded = checks.filter((c) => isDegradedCheck(c)).length;
  return {
    passed: checks.filter((c) => c.status === "pass").length,
    warned,
    warningOnly: warned - degraded,
    degraded,
    failed: checks.filter((c) => c.status === "fail").length,
  };
}

function deriveOverallStatus(checks: CheckResult[]): OverallStatus {
  if (checks.some((c) => c.status === "fail")) return "failed";
  if (checks.some((c) => isDegradedCheck(c))) return "degraded";
  if (checks.some((c) => c.status === "warn")) return "warning";
  return "healthy";
}

function exitCode(checks: CheckResult[]): number {
  if (checks.some((c) => c.status === "fail")) return 2;
  if (checks.some((c) => c.status === "warn")) return 1;
  return 0;
}

function printHuman(report: Report): void {
  console.log(`paperclip-doctor ${report.command}`);
  console.log(`generated: ${report.generatedAt}`);
  console.log(`overall: ${report.overallStatus}`);
  console.log("");
  for (const check of report.checks) {
    const icon = check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗";
    console.log(`${color(check.status, icon)} ${check.name}: ${check.message}`);
  }
  console.log("");
  console.log(
    [
      color("pass", `${report.summary.passed} passed`),
      report.summary.degraded ? color("warn", `${report.summary.degraded} degraded`) : null,
      report.summary.warningOnly ? color("warn", `${report.summary.warningOnly} warnings`) : null,
      report.summary.failed ? color("fail", `${report.summary.failed} failed`) : null,
    ]
      .filter(Boolean)
      .join(", "),
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHtmlReport(report: Report): string {
  const warningOnlyCount = report.summary.warningOnly;
  const heroToneClass =
    report.overallStatus === "failed"
      ? "fail"
      : report.overallStatus === "degraded"
        ? "warn"
        : report.overallStatus === "warning"
          ? "warn-muted"
          : "pass";
  const heroMessage =
    report.overallStatus === "failed"
      ? "Failed overall. One or more hard failures need attention."
      : report.overallStatus === "degraded"
        ? "Degraded but functioning. Core paths are working, but one or more checks show slowness, drift, or non-terminal behavior."
        : report.overallStatus === "warning"
          ? "Warning state. No hard failures or degraded runtime paths were detected, but one or more non-runtime warnings should be reviewed."
          : "Healthy overall. No degraded or failed checks were detected.";

  const summaryItems = [
    { label: "Healthy", value: report.summary.passed, className: "pass" },
    { label: "Degraded", value: report.summary.degraded, className: "warn" },
    { label: "Warnings", value: warningOnlyCount, className: "warn-muted" },
    { label: "Failures", value: report.summary.failed, className: "fail" },
  ].filter((item) => item.value > 0 || item.label !== "Warnings");

  const summaryHtml = summaryItems
    .map(
      (item) =>
        `<div class="summary-card ${item.className}"><div class="summary-value">${item.value}</div><div class="summary-label">${item.label}</div></div>`,
    )
    .join("\n");

  const checksHtml = report.checks
    .map((check) => {
      const classification = isDegradedCheck(check) ? "degraded" : check.status;
      const details = check.details ? `<pre>${escapeHtml(JSON.stringify(check.details, null, 2))}</pre>` : "";
      return `<section class="check ${classification}">
        <div class="check-header">
          <span class="badge ${classification}">${escapeHtml(classification.toUpperCase())}</span>
          <h3>${escapeHtml(check.name)}</h3>
        </div>
        <p>${escapeHtml(check.message)}</p>
        ${details}
      </section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>paperclip-doctor ${escapeHtml(report.command)} report</title>
  <style>
    :root { color-scheme: dark; --bg: #0b1020; --panel: #121937; --panel-2: #182042; --text: #eef2ff; --muted: #aab4d6; --pass: #22c55e; --warn: #f59e0b; --warn-muted: #fbbf24; --fail: #ef4444; --border: #2b3768; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background: linear-gradient(180deg, #0b1020 0%, #111936 100%); color: var(--text); }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 32px 20px 60px; }
    .hero, .check, .summary-card, .meta { background: rgba(18, 25, 55, 0.92); border: 1px solid var(--border); border-radius: 18px; box-shadow: 0 10px 30px rgba(0,0,0,0.25); }
    .hero { padding: 24px; margin-bottom: 20px; }
    .hero.pass { border-color: color-mix(in srgb, var(--pass) 60%, var(--border)); }
    .hero.warn { border-color: color-mix(in srgb, var(--warn) 60%, var(--border)); }
    .hero.warn-muted { border-color: color-mix(in srgb, var(--warn-muted) 50%, var(--border)); }
    .hero.fail { border-color: color-mix(in srgb, var(--fail) 60%, var(--border)); }
    .hero h1 { margin: 0 0 8px; font-size: 30px; }
    .hero p { margin: 0; color: var(--muted); }
    .hero-status { display: inline-flex; align-items: center; padding: 6px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; letter-spacing: .08em; margin-bottom: 12px; }
    .hero-status.pass { background: rgba(34, 197, 94, .16); color: #86efac; }
    .hero-status.warn { background: rgba(245, 158, 11, .16); color: #fcd34d; }
    .hero-status.warn-muted { background: rgba(251, 191, 36, .16); color: #fde68a; }
    .hero-status.fail { background: rgba(239, 68, 68, .16); color: #fca5a5; }
    .meta { padding: 16px 18px; margin-bottom: 20px; }
    .meta-grid, .summary-grid { display: grid; gap: 16px; }
    .meta-grid { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .summary-grid { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); margin: 20px 0 28px; }
    .meta-label, .summary-label { color: var(--muted); font-size: 13px; text-transform: uppercase; letter-spacing: .08em; }
    .meta-value { margin-top: 6px; font-size: 15px; word-break: break-word; }
    .summary-card { padding: 18px; text-align: center; }
    .summary-card.pass { border-color: color-mix(in srgb, var(--pass) 60%, var(--border)); }
    .summary-card.warn, .summary-card.degraded { border-color: color-mix(in srgb, var(--warn) 60%, var(--border)); }
    .summary-card.warn-muted { border-color: color-mix(in srgb, var(--warn-muted) 50%, var(--border)); }
    .summary-value { font-size: 42px; font-weight: 700; margin-bottom: 8px; }
    .checks { display: grid; gap: 16px; }
    .check { padding: 18px; }
    .check.pass { border-left: 6px solid var(--pass); }
    .check.warn, .check.degraded { border-left: 6px solid var(--warn); }
    .check.fail { border-left: 6px solid var(--fail); }
    .check-header { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .check-header h3 { margin: 0; font-size: 18px; }
    .badge { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; letter-spacing: .08em; }
    .badge.pass { background: rgba(34, 197, 94, .16); color: #86efac; }
    .badge.warn, .badge.degraded { background: rgba(245, 158, 11, .16); color: #fcd34d; }
    .badge.fail { background: rgba(239, 68, 68, .16); color: #fca5a5; }
    p { line-height: 1.6; }
    pre { margin: 14px 0 0; padding: 14px; overflow-x: auto; border-radius: 12px; background: var(--panel-2); border: 1px solid var(--border); color: #dbe6ff; }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero ${heroToneClass}">
      <div class="hero-status ${heroToneClass}">${escapeHtml(report.overallStatus.toUpperCase())}</div>
      <h1>paperclip-doctor ${escapeHtml(report.command)}</h1>
      <p>${escapeHtml(heroMessage)}</p>
    </section>

    <section class="meta">
      <div class="meta-grid">
        <div><div class="meta-label">Generated</div><div class="meta-value">${escapeHtml(report.generatedAt)}</div></div>
        <div><div class="meta-label">Command</div><div class="meta-value">${escapeHtml(report.command)}</div></div>
        <div><div class="meta-label">Overall status</div><div class="meta-value">${escapeHtml(report.overallStatus)}</div></div>
      </div>
    </section>

    <section class="summary-grid">${summaryHtml}</section>

    <section class="checks">${checksHtml}</section>
  </div>
</body>
</html>`;
}

async function maybeWriteReport(outputPath: string | undefined, report: Report): Promise<void> {
  if (!outputPath) return;
  const absolute = resolve(outputPath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function maybeWriteHtmlReport(outputPath: string | undefined, report: Report): Promise<void> {
  if (!outputPath) return;
  const absolute = resolve(outputPath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${renderHtmlReport(report)}\n`, "utf8");
}

async function runCommand(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      stderr += String(error);
      resolvePromise({ code: null, stdout, stderr });
    });
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function authHeaders(apiKey?: string, extra: Record<string, string> = {}): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}`, ...extra } : extra;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T | null; text: string }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: T | null = null;
  try {
    data = text ? (JSON.parse(text) as T) : null;
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data, text };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function isHeartbeatEnabled(agent: AgentRecord): boolean {
  const runtimeConfig = asRecord(agent.runtimeConfig);
  const heartbeat = asRecord(runtimeConfig?.heartbeat);
  return heartbeat?.enabled !== false;
}

function supportsWakeOnDemand(agent: AgentRecord): boolean {
  const runtimeConfig = asRecord(agent.runtimeConfig);
  const heartbeat = asRecord(runtimeConfig?.heartbeat);
  return heartbeat?.wakeOnDemand !== false;
}

async function runSetupCheck(checks: CheckResult[]): Promise<void> {
  const result = await runCommand("paperclipai", ["doctor", "--yes"]);
  if (result.code === null) {
    checks.push({
      id: "setup-doctor",
      name: "Built-in setup doctor",
      status: "warn",
      message: "paperclipai command not found in PATH; skipped built-in setup doctor",
    });
    return;
  }

  if (result.code === 0) {
    checks.push({
      id: "setup-doctor",
      name: "Built-in setup doctor",
      status: result.stdout.includes("Some checks failed") ? "warn" : "pass",
      message: "paperclipai doctor executed",
      details: { exitCode: result.code },
    });
    return;
  }

  checks.push({
    id: "setup-doctor",
    name: "Built-in setup doctor",
    status: "warn",
    message: "paperclipai doctor exited non-zero",
    details: { exitCode: result.code, stderr: result.stderr.slice(-500) },
  });
}

function scoreAgentForDiscovery(agent: AgentRecord): number {
  let score = 0;
  if (agent.status === "idle" || agent.status === "running") score += 4;
  else if (agent.status === "paused") score += 1;
  if (isHeartbeatEnabled(agent)) score += 2;
  if (supportsWakeOnDemand(agent)) score += 2;
  if (agent.adapterType) score += 1;
  return score;
}

async function discoverRuntimeContext(args: ParsedArgs, checks: CheckResult[]): Promise<RuntimeContext | null> {
  if (!args.apiBase) {
    checks.push({
      id: "api-base",
      name: "API base URL",
      status: "fail",
      message: "Missing API base URL. Set --api-base or PAPERCLIP_API_URL.",
    });
    return null;
  }

  let apiBase: string;
  try {
    apiBase = new URL(args.apiBase).toString().replace(/\/$/, "");
    checks.push({ id: "api-base", name: "API base URL", status: "pass", message: `Using ${apiBase}` });
  } catch {
    checks.push({ id: "api-base", name: "API base URL", status: "fail", message: `Invalid API base URL: ${args.apiBase}` });
    return null;
  }

  let healthData: Record<string, unknown> | null = null;
  try {
    const health = await fetchJson<Record<string, unknown>>(`${apiBase}/api/health`, {
      headers: authHeaders(args.apiKey),
    });
    if (!health.ok) {
      checks.push({
        id: "api-health",
        name: "API health",
        status: "fail",
        message: `Health endpoint returned ${health.status}`,
        details: health.data ? { response: health.data } : { raw: health.text.slice(0, 500) },
      });
      return null;
    }
    healthData = health.data;
    checks.push({
      id: "api-health",
      name: "API health",
      status: "pass",
      message: `Reachable (${health.status})`,
      details: health.data ? { response: health.data } : undefined,
    });
  } catch (error) {
    checks.push({
      id: "api-health",
      name: "API health",
      status: "fail",
      message: `Could not reach /api/health: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }

  const deploymentMode = typeof healthData?.deploymentMode === "string" ? healthData.deploymentMode : undefined;
  const authReady = typeof healthData?.authReady === "boolean" ? healthData.authReady : undefined;
  const bootstrapStatus = typeof healthData?.bootstrapStatus === "string" ? healthData.bootstrapStatus : undefined;
  const localTrusted = deploymentMode === "local_trusted";

  if (args.apiKey) {
    checks.push({ id: "api-key", name: "Authentication mode", status: "pass", message: "API key provided" });
  } else if (localTrusted) {
    checks.push({
      id: "api-key",
      name: "Authentication mode",
      status: "pass",
      message: "No API key provided, but deployment is local_trusted so board routes can still be exercised",
    });
  } else {
    checks.push({
      id: "api-key",
      name: "Authentication mode",
      status: "warn",
      message: "No API key provided. Read-only public checks may pass, but board/agent checks may fail outside local_trusted mode.",
    });
  }

  if (bootstrapStatus === "bootstrap_pending") {
    checks.push({
      id: "bootstrap-status",
      name: "Bootstrap status",
      status: "warn",
      message: "Instance bootstrap is still pending; authenticated flows may not be ready",
    });
  } else if (authReady === false) {
    checks.push({
      id: "bootstrap-status",
      name: "Bootstrap status",
      status: "warn",
      message: "Health endpoint reports auth is not ready",
    });
  } else {
    checks.push({
      id: "bootstrap-status",
      name: "Bootstrap status",
      status: "pass",
      message: `Auth bootstrap ready${deploymentMode ? ` (${deploymentMode})` : ""}`,
    });
  }

  const context: RuntimeContext = {
    apiBase,
    apiKey: args.apiKey,
    companyId: args.companyId,
    agentId: args.agentId,
    deploymentMode,
    authReady,
  };

  if (!context.companyId) {
    const companiesRes = await fetchJson<CompanyRecord[]>(`${apiBase}/api/companies`, {
      headers: authHeaders(args.apiKey),
    });

    if (!companiesRes.ok || !Array.isArray(companiesRes.data) || companiesRes.data.length === 0) {
      checks.push({
        id: "company-discovery",
        name: "Company discovery",
        status: "warn",
        message: !companiesRes.ok
          ? `Could not list companies (${companiesRes.status})`
          : "No companies returned by /api/companies",
        details: companiesRes.data ? { companies: companiesRes.data } : companiesRes.text ? { raw: companiesRes.text.slice(0, 500) } : undefined,
      });
    } else {
      const companies = companiesRes.data;
      const activeCompanies = companies.filter((company) => company.status !== "archived");
      const scoredCompanies = await Promise.all(
        (activeCompanies.length > 0 ? activeCompanies : companies).map(async (company) => {
          const agentsRes = await fetchJson<AgentRecord[]>(`${apiBase}/api/companies/${company.id}/agents`, {
            headers: authHeaders(args.apiKey),
          });
          const agents = asArray<AgentRecord>(agentsRes.data);
          const bestAgentScore = agents.reduce((best, agent) => Math.max(best, scoreAgentForDiscovery(agent)), 0);
          const runnableAgents = agents.filter((agent) => scoreAgentForDiscovery(agent) >= 8).length;
          return { company, bestAgentScore, runnableAgents, totalAgents: agents.length };
        }),
      );
      scoredCompanies.sort((a, b) => b.bestAgentScore - a.bestAgentScore || b.runnableAgents - a.runnableAgents || b.totalAgents - a.totalAgents);
      const chosen = scoredCompanies[0]?.company ?? activeCompanies[0] ?? companies[0];
      context.companyId = chosen.id;
      const chosenScore = scoredCompanies.find((entry) => entry.company.id === chosen.id);
      checks.push({
        id: "company-discovery",
        name: "Company discovery",
        status: companies.length === 1 ? "pass" : "warn",
        message:
          companies.length === 1
            ? `Resolved company ${chosen.name} (${chosen.id})`
            : `Resolved company ${chosen.name} (${chosen.id}) from ${companies.length} visible companies using agent-health scoring`,
        details: {
          companies: scoredCompanies.map((entry) => ({
            id: entry.company.id,
            name: entry.company.name,
            status: entry.company.status,
            bestAgentScore: entry.bestAgentScore,
            runnableAgents: entry.runnableAgents,
            totalAgents: entry.totalAgents,
          })),
          chosenScore,
        },
      });
    }
  } else {
    checks.push({
      id: "company-discovery",
      name: "Company discovery",
      status: "pass",
      message: `Using provided company id ${context.companyId}`,
    });
  }

  return context;
}

async function resolveAgent(context: RuntimeContext, checks: CheckResult[]): Promise<AgentRecord | null> {
  if (!context.apiBase) return null;

  if (context.agentId) {
    const provided = await fetchJson<AgentRecord>(`${context.apiBase}/api/agents/${context.agentId}`, {
      headers: authHeaders(context.apiKey),
    });
    if (!provided.ok || !provided.data) {
      checks.push({
        id: "agent-selection",
        name: "Agent selection",
        status: "fail",
        message: `Agent not found or inaccessible: ${context.agentId}`,
      });
      return null;
    }
    checks.push({
      id: "agent-selection",
      name: "Agent selection",
      status: "pass",
      message: `Using provided agent ${provided.data.name ?? provided.data.id}`,
      details: { agentId: provided.data.id, companyId: provided.data.companyId },
    });
    return provided.data;
  }

  if (!context.companyId) {
    checks.push({
      id: "agent-selection",
      name: "Agent selection",
      status: "fail",
      message: "No company id available to discover agents",
    });
    return null;
  }

  const agentsRes = await fetchJson<AgentRecord[]>(`${context.apiBase}/api/companies/${context.companyId}/agents`, {
    headers: authHeaders(context.apiKey),
  });

  const agents = asArray<AgentRecord>(agentsRes.data);
  if (!agentsRes.ok || agents.length === 0) {
    checks.push({
      id: "agent-selection",
      name: "Agent selection",
      status: "fail",
      message: !agentsRes.ok ? `Could not list agents (${agentsRes.status})` : "No agents returned for company",
    });
    return null;
  }

  const candidates = agents.filter((agent) => agent.status !== "terminated" && isHeartbeatEnabled(agent) && supportsWakeOnDemand(agent));
  const chosen = candidates[0] ?? agents[0];
  context.agentId = chosen.id;
  checks.push({
    id: "agent-selection",
    name: "Agent selection",
    status: candidates.length > 0 ? "pass" : "warn",
    message: `Discovered agent ${chosen.name ?? chosen.id}${candidates.length > 1 ? ` from ${candidates.length} wakeable agents` : ""}`,
    details: {
      candidates: candidates.map((agent) => ({ id: agent.id, name: agent.name, status: agent.status, adapterType: agent.adapterType })),
      totalAgents: agents.length,
    },
  });
  return chosen;
}

async function getAgentById(context: RuntimeContext, agentId: string): Promise<AgentRecord | null> {
  const res = await fetchJson<AgentRecord>(`${context.apiBase}/api/agents/${agentId}`, {
    headers: authHeaders(context.apiKey),
  });
  return res.ok ? res.data : null;
}

async function pollHeartbeatRun(
  context: RuntimeContext,
  runId: string,
  companyId: string,
  agentId: string,
  timeoutMs: number,
): Promise<{
  finalRun: HeartbeatRun | null;
  sawEvents: boolean;
  sawAdapterInvoke: boolean;
  sawExpectedEnv: boolean;
  latestEnvKeys: string[];
}> {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  let lastSeq = 0;
  let finalRun: HeartbeatRun | null = null;
  let sawAdapterInvoke = false;
  let sawExpectedEnv = false;
  let latestEnvKeys: string[] = [];
  let sawEvents = false;

  while (Date.now() < deadline) {
    const [eventsRes, runsRes] = await Promise.all([
      fetchJson<HeartbeatRunEvent[]>(`${context.apiBase}/api/heartbeat-runs/${runId}/events?afterSeq=${lastSeq}&limit=100`, {
        headers: authHeaders(context.apiKey),
      }),
      fetchJson<HeartbeatRun[]>(`${context.apiBase}/api/companies/${companyId}/heartbeat-runs?agentId=${agentId}&limit=100`, {
        headers: authHeaders(context.apiKey),
      }),
    ]);

    if (eventsRes.ok && Array.isArray(eventsRes.data) && eventsRes.data.length > 0) {
      sawEvents = true;
      for (const event of eventsRes.data) {
        lastSeq = Math.max(lastSeq, event.seq ?? lastSeq);
        const eventType = event.eventType ?? event.type ?? "";
        if (eventType === "adapter.invoke") {
          sawAdapterInvoke = true;
          const payload = asRecord(event.payload);
          const env = asRecord(payload?.env);
          latestEnvKeys = Object.keys(env ?? {}).sort();
          const expected = ["PAPERCLIP_AGENT_ID", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_API_URL", "PAPERCLIP_RUN_ID"];
          sawExpectedEnv = expected.every((key) => latestEnvKeys.includes(key));
        }
      }
    }

    if (runsRes.ok && Array.isArray(runsRes.data)) {
      finalRun = runsRes.data.find((run) => run.id === runId) ?? finalRun;
      if (finalRun && ["succeeded", "failed", "cancelled", "timed_out"].includes(finalRun.status)) {
        break;
      }
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }

  return { finalRun, sawEvents, sawAdapterInvoke, sawExpectedEnv, latestEnvKeys };
}

async function runRuntimeChecks(args: ParsedArgs): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  if (!args.skipSetup) {
    await runSetupCheck(checks);
  }

  const context = await discoverRuntimeContext(args, checks);
  if (!context) return checks;

  if (context.companyId) {
    const orgRes = await fetchJson<unknown>(`${context.apiBase}/api/companies/${context.companyId}/org`, {
      headers: authHeaders(context.apiKey),
    });
    checks.push({
      id: "org-read",
      name: "Org read",
      status: orgRes.ok ? "pass" : "warn",
      message: orgRes.ok ? `Org endpoint reachable for company ${context.companyId}` : `Org endpoint returned ${orgRes.status}`,
    });
  }

  if (context.companyId) {
    const agentChecks = await runAgentChecksFromContext(context, args.timeoutMs, true);
    checks.push(...agentChecks);
  } else {
    checks.push({
      id: "agent-runtime-checks",
      name: "Agent runtime checks",
      status: "warn",
      message: "No company could be resolved, so agent checks were skipped",
    });
  }

  return checks;
}

async function runAgentChecksFromContext(context: RuntimeContext, timeoutMs: number, allowDiscovery = false): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  if (!context.apiBase) {
    checks.push({ id: "agent-prereqs", name: "Agent prerequisites", status: "fail", message: "Missing API base URL." });
    return checks;
  }

  const agent = allowDiscovery ? await resolveAgent(context, checks) : context.agentId ? await getAgentById(context, context.agentId) : null;
  if (!agent) {
    if (!allowDiscovery) {
      checks.push({ id: "agent-prereqs", name: "Agent prerequisites", status: "fail", message: "Agent checks require --agent-id or discovery context." });
    }
    return checks;
  }

  const effectiveCompanyId = agent.companyId ?? context.companyId;
  if (!effectiveCompanyId) {
    checks.push({
      id: "agent-company",
      name: "Agent company context",
      status: "fail",
      message: "Could not determine company id for target agent",
    });
    return checks;
  }
  context.companyId = effectiveCompanyId;
  context.agentId = agent.id;

  checks.push({
    id: "agent-fetch",
    name: "Agent fetch",
    status: "pass",
    message: `Fetched ${agent.name ?? agent.id}`,
    details: { status: agent.status, adapterType: agent.adapterType, companyId: agent.companyId },
  });

  const gatingStatus = agent.status === "paused" || agent.status === "pending_approval";
  checks.push({
    id: "agent-status",
    name: "Agent status",
    status: gatingStatus ? "warn" : "pass",
    message: gatingStatus ? `Agent status may block heartbeats: ${agent.status}` : `Agent status is ${agent.status ?? "unknown"}`,
  });

  checks.push({
    id: "heartbeat-enabled",
    name: "Heartbeat enabled",
    status: isHeartbeatEnabled(agent) ? "pass" : "warn",
    message: isHeartbeatEnabled(agent) ? "Heartbeat is enabled" : "Heartbeat appears disabled in runtimeConfig",
  });

  checks.push({
    id: "wake-on-demand",
    name: "Wake on demand",
    status: supportsWakeOnDemand(agent) ? "pass" : "warn",
    message: supportsWakeOnDemand(agent) ? "Agent supports on-demand wakeups" : "wakeOnDemand appears disabled",
  });

  const adapterConfig = asRecord(agent.adapterConfig) ?? {};
  const cwd = typeof adapterConfig.cwd === "string" ? adapterConfig.cwd : null;
  checks.push({
    id: "agent-cwd",
    name: "Agent cwd config",
    status: cwd ? "pass" : "warn",
    message: cwd ? `Configured cwd: ${cwd}` : "No cwd in adapter config",
  });

  let wakeup: HeartbeatRun | { status: string } | null = null;
  try {
    const res = await fetchJson<HeartbeatRun | { status: string }>(`${context.apiBase}/api/agents/${agent.id}/heartbeat/invoke`, {
      method: "POST",
      headers: authHeaders(context.apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      checks.push({
        id: "heartbeat-invoke",
        name: "Heartbeat invoke",
        status: "fail",
        message: `Heartbeat invoke returned ${res.status}`,
        details: res.data ? { response: res.data as Record<string, unknown> } : { raw: res.text.slice(0, 500) },
      });
      return checks;
    }
    wakeup = res.data;
  } catch (error) {
    checks.push({
      id: "heartbeat-invoke",
      name: "Heartbeat invoke",
      status: "fail",
      message: `Heartbeat request failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return checks;
  }

  if (!wakeup || ("status" in wakeup && wakeup.status === "skipped")) {
    checks.push({
      id: "heartbeat-invoke",
      name: "Heartbeat invoke",
      status: "warn",
      message: "Heartbeat invocation was skipped (cooldown/concurrency or agent policy)",
    });
    return checks;
  }

  const runId = (wakeup as HeartbeatRun).id;
  checks.push({ id: "heartbeat-invoke", name: "Heartbeat invoke", status: "pass", message: `Invoked run ${runId}` });

  const polled = await pollHeartbeatRun(context, runId, effectiveCompanyId, agent.id, timeoutMs);

  checks.push({
    id: "heartbeat-events",
    name: "Heartbeat run events",
    status: polled.sawEvents ? "pass" : "warn",
    message: polled.sawEvents ? `Observed run events for ${runId}` : `No run events observed within ${timeoutMs}ms`,
  });

  checks.push({
    id: "adapter-invoke",
    name: "Adapter invoke event",
    status: polled.sawAdapterInvoke ? "pass" : "warn",
    message: polled.sawAdapterInvoke ? "Observed adapter.invoke event" : "Did not observe adapter.invoke event",
    details: polled.latestEnvKeys.length > 0 ? { envKeys: polled.latestEnvKeys } : undefined,
  });

  checks.push({
    id: "env-contract",
    name: "Runtime env contract",
    status: polled.sawAdapterInvoke ? (polled.sawExpectedEnv ? "pass" : "warn") : "warn",
    message: polled.sawAdapterInvoke
      ? polled.sawExpectedEnv
        ? "Observed expected PAPERCLIP_* runtime env keys"
        : "adapter.invoke env is missing one or more expected PAPERCLIP_* keys"
      : "Could not verify runtime env without adapter.invoke event",
    details: polled.latestEnvKeys.length > 0 ? { envKeys: polled.latestEnvKeys } : undefined,
  });

  if (!polled.finalRun) {
    checks.push({
      id: "heartbeat-final-status",
      name: "Heartbeat final status",
      status: "warn",
      message:
        polled.sawAdapterInvoke || polled.sawEvents
          ? `Degraded but functioning: heartbeat started and emitted runtime signals, but no terminal status was resolved within ${timeoutMs}ms`
          : `Could not resolve final run status within ${timeoutMs}ms`,
      details:
        polled.sawAdapterInvoke || polled.sawEvents
          ? {
              sawEvents: polled.sawEvents,
              sawAdapterInvoke: polled.sawAdapterInvoke,
              sawExpectedEnv: polled.sawExpectedEnv,
            }
          : undefined,
    });
    return checks;
  }

  const finalStatus = polled.finalRun.status;
  const nonTerminalButHealthy = ["queued", "starting", "running"].includes(finalStatus) && (polled.sawAdapterInvoke || polled.sawEvents);
  checks.push({
    id: "heartbeat-final-status",
    name: "Heartbeat final status",
    status: finalStatus === "succeeded" ? "pass" : finalStatus === "failed" ? "fail" : "warn",
    message: polled.finalRun.error
      ? `${finalStatus}: ${polled.finalRun.error}`
      : nonTerminalButHealthy
        ? `Degraded but functioning: run is still ${finalStatus} after ${timeoutMs}ms despite successful invoke/events/env checks`
        : finalStatus,
    details: nonTerminalButHealthy
      ? {
          runId,
          finalStatus,
          sawEvents: polled.sawEvents,
          sawAdapterInvoke: polled.sawAdapterInvoke,
          sawExpectedEnv: polled.sawExpectedEnv,
        }
      : undefined,
  });

  return checks;
}

async function runAgentChecks(args: ParsedArgs): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const context = await discoverRuntimeContext(args, checks);
  if (!context) return checks;
  checks.push(...(await runAgentChecksFromContext(context, args.timeoutMs, true)));
  return checks;
}

async function createSyntheticIssue(context: RuntimeContext, agent: AgentRecord): Promise<IssueRecord | null> {
  if (!context.companyId) return null;
  const timestamp = new Date().toISOString();
  const payload = {
    title: `[doctor] Synthetic heartbeat probe ${timestamp}`,
    description:
      "Synthetic Paperclip doctor probe. Safe to ignore. This issue exists only to verify assignment wakeups, heartbeat runs, and comment/status plumbing.",
    status: "todo",
    priority: "low",
    requestDepth: 0,
    assigneeAgentId: agent.id,
  };

  const res = await fetchJson<IssueRecord>(`${context.apiBase}/api/companies/${context.companyId}/issues`, {
    method: "POST",
    headers: authHeaders(context.apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  return res.ok ? res.data : null;
}

async function hideIssue(context: RuntimeContext, issueId: string): Promise<boolean> {
  const res = await fetchJson<IssueRecord>(`${context.apiBase}/api/issues/${issueId}`, {
    method: "PATCH",
    headers: authHeaders(context.apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify({ hiddenAt: new Date().toISOString() }),
  });
  return res.ok;
}

async function runSyntheticChecks(args: ParsedArgs): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const context = await discoverRuntimeContext(args, checks);
  if (!context) return checks;

  const agent = await resolveAgent(context, checks);
  if (!agent) return checks;
  if (!context.companyId) {
    checks.push({
      id: "synthetic-company",
      name: "Synthetic company context",
      status: "fail",
      message: "Could not determine company id",
    });
    return checks;
  }

  const createdAtMs = Date.now();
  const issue = await createSyntheticIssue(context, agent);
  if (!issue) {
    checks.push({
      id: "synthetic-issue-create",
      name: "Synthetic issue creation",
      status: "fail",
      message: "Failed to create synthetic probe issue",
    });
    return checks;
  }

  checks.push({
    id: "synthetic-issue-create",
    name: "Synthetic issue creation",
    status: "pass",
    message: `Created ${issue.identifier ?? issue.id} for ${agent.name ?? agent.id}`,
    details: { issueId: issue.id, identifier: issue.identifier, companyId: issue.companyId },
  });

  const deadline = Date.now() + Math.max(5000, args.timeoutMs);
  let latestIssue: IssueRecord | null = issue;
  let latestComments: IssueComment[] = [];
  let matchedRun: HeartbeatRun | null = null;
  let terminalRun: HeartbeatRun | null = null;

  while (Date.now() < deadline) {
    const [issueRes, commentsRes, runsRes] = await Promise.all([
      fetchJson<IssueRecord>(`${context.apiBase}/api/issues/${issue.id}`, { headers: authHeaders(context.apiKey) }),
      fetchJson<IssueComment[]>(`${context.apiBase}/api/issues/${issue.id}/comments`, { headers: authHeaders(context.apiKey) }),
      fetchJson<HeartbeatRun[]>(`${context.apiBase}/api/companies/${context.companyId}/heartbeat-runs?agentId=${agent.id}&limit=50`, {
        headers: authHeaders(context.apiKey),
      }),
    ]);

    if (issueRes.ok && issueRes.data) latestIssue = issueRes.data;
    if (commentsRes.ok && Array.isArray(commentsRes.data)) latestComments = commentsRes.data;

    if (runsRes.ok && Array.isArray(runsRes.data)) {
      const relevant = runsRes.data
        .filter((run) => {
          const runCreatedAt = run.createdAt ? Date.parse(run.createdAt) : 0;
          const snapshot = asRecord(run.contextSnapshot);
          return run.agentId === agent.id && (runCreatedAt >= createdAtMs - 2000 || snapshot?.issueId === issue.id);
        })
        .sort((a, b) => Date.parse(b.createdAt ?? "1970-01-01T00:00:00Z") - Date.parse(a.createdAt ?? "1970-01-01T00:00:00Z"));
      matchedRun = relevant[0] ?? matchedRun;
      if (matchedRun && ["succeeded", "failed", "cancelled", "timed_out"].includes(matchedRun.status)) {
        terminalRun = matchedRun;
      }
    }

    const issueAdvanced = latestIssue?.status && latestIssue.status !== issue.status;
    const issueCommented = latestComments.length > 0;
    if (terminalRun || issueAdvanced || issueCommented) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }

  checks.push({
    id: "synthetic-heartbeat-run",
    name: "Synthetic heartbeat run",
    status: matchedRun ? "pass" : "warn",
    message: matchedRun ? `Observed heartbeat run ${matchedRun.id} (${matchedRun.status})` : "No matching heartbeat run observed for synthetic issue",
    details: matchedRun ? { runId: matchedRun.id, status: matchedRun.status } : undefined,
  });

  checks.push({
    id: "synthetic-issue-progress",
    name: "Synthetic issue progress",
    status:
      latestComments.length > 0 || (latestIssue?.status && latestIssue.status !== issue.status)
        ? "pass"
        : matchedRun
          ? "warn"
          : "warn",
    message:
      latestComments.length > 0
        ? `Observed ${latestComments.length} issue comment(s)`
        : latestIssue?.status && latestIssue.status !== issue.status
          ? `Issue status changed from ${issue.status ?? "unknown"} to ${latestIssue.status}`
          : "Agent did not comment or change issue status within timeout",
    details: {
      latestStatus: latestIssue?.status,
      commentCount: latestComments.length,
    },
  });

  const syntheticShowedProgress = Boolean(matchedRun) && (latestComments.length > 0 || (latestIssue?.status && latestIssue.status !== issue.status));
  checks.push({
    id: "synthetic-terminal-status",
    name: "Synthetic terminal status",
    status: !terminalRun ? "warn" : terminalRun.status === "succeeded" ? "pass" : terminalRun.status === "failed" ? "fail" : "warn",
    message: terminalRun
      ? terminalRun.error
        ? `${terminalRun.status}: ${terminalRun.error}`
        : terminalRun.status
      : syntheticShowedProgress
        ? "Degraded but functioning: synthetic issue triggered a real run and issue progress, but the run did not reach a terminal state within timeout"
        : matchedRun
          ? "Synthetic heartbeat started but did not reach a terminal state within timeout"
          : "Synthetic heartbeat did not reach a terminal state within timeout",
    details: !terminalRun && syntheticShowedProgress
      ? {
          matchedRunId: matchedRun?.id,
          matchedRunStatus: matchedRun?.status,
          latestIssueStatus: latestIssue?.status,
          commentCount: latestComments.length,
        }
      : undefined,
  });

  if (args.cleanup) {
    const hidden = await hideIssue(context, issue.id);
    checks.push({
      id: "synthetic-cleanup",
      name: "Synthetic cleanup",
      status: hidden ? "pass" : "warn",
      message: hidden ? `Hidden synthetic issue ${issue.identifier ?? issue.id}` : `Could not hide synthetic issue ${issue.identifier ?? issue.id}`,
    });
  } else {
    checks.push({
      id: "synthetic-cleanup",
      name: "Synthetic cleanup",
      status: "warn",
      message: `Synthetic issue ${issue.identifier ?? issue.id} was kept because --no-cleanup was set`,
    });
  }

  return checks;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    console.log(usage());
    process.exit(0);
  }

  const checks =
    args.command === "runtime"
      ? await runRuntimeChecks(args)
      : args.command === "agent"
        ? await runAgentChecks(args)
        : await runSyntheticChecks(args);
  const summary = summarize(checks);
  const overallStatus = deriveOverallStatus(checks);
  const report: Report = {
    ok: summary.failed === 0,
    overallStatus,
    command: args.command,
    generatedAt: new Date().toISOString(),
    summary,
    checks,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }

  await maybeWriteReport(args.output, report);
  await maybeWriteHtmlReport(args.htmlOutput, report);
  process.exit(exitCode(checks));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(2);
});
