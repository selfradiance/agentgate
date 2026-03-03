import type { AppInstance } from "./app";
import { scoreIdentity } from "./reputation";
import type { IdentityRecord, BondRecord, ActionRecord } from "./types";

const ID_COLS = new Set(["id", "identity_id", "bond_id", "action_id"]);

const STATUS_COLORS: Record<string, string> = {
  active:    "background:#2d6a4f",
  success:   "background:#2d6a4f",
  released:  "background:#2d6a4f",
  slashed:   "background:#6a2d2d",
  malicious: "background:#6a2d2d",
  burned:    "background:#6a2d2d",
  open:      "background:#6a5f2d",
  occupied:  "background:#6a5f2d",
};

function truncateId(val: string): string {
  // Keep the prefix (e.g. "bond_", "id_", "action_") + first 8 chars of the UUID
  const underscore = val.indexOf("_");
  if (underscore === -1) return val.slice(0, 13) + "…";
  const prefix = val.slice(0, underscore + 1);
  const rest = val.slice(underscore + 1);
  return `${prefix}${rest.slice(0, 8)}…`;
}

function renderCell(col: string, val: unknown): string {
  const raw = val === null || val === undefined ? "" : String(val);

  if (ID_COLS.has(col) && raw.length > 0) {
    const display = truncateId(raw);
    return `<td title="${raw}">${display}</td>`;
  }

  if (col === "status" && raw.length > 0) {
    const style = STATUS_COLORS[raw] ?? "background:#3a3a3a";
    return `<td style="${style};color:#eee;font-weight:bold">${raw}</td>`;
  }

  if (col === "payload" && raw.length > 60) {
    const display = raw.slice(0, 60) + "…";
    const escaped = raw.replace(/"/g, "&quot;");
    return `<td title="${escaped}">${display}</td>`;
  }

  if (col === "agent_name") {
    return raw.length > 0
      ? `<td>${raw}</td>`
      : `<td style="color:#555;font-style:italic">default</td>`;
  }

  return `<td>${raw}</td>`;
}

function buildTable(rows: unknown[]): string {
  if (rows.length === 0) {
    return `<p style="color:#888;font-style:italic">No records.</p>`;
  }

  const cols = Object.keys(rows[0] as Record<string, unknown>);
  const header = cols.map((c) => `<th>${c}</th>`).join("");
  const body = rows
    .map((row) => {
      const cells = cols
        .map((c) => renderCell(c, (row as Record<string, unknown>)[c]))
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

function buildSummaryBar(data: { identities: unknown[]; bonds: unknown[]; actions: unknown[] }): string {
  const activeBonds = (data.bonds as Array<Record<string, unknown>>).filter(
    (b) => b["status"] === "active" || b["status"] === "occupied"
  ).length;

  const stats = [
    ["Identities", data.identities.length],
    ["Bonds", data.bonds.length],
    ["Active Bonds", activeBonds],
    ["Actions", data.actions.length],
  ];

  const items = stats
    .map(
      ([label, value]) =>
        `<span class="stat"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></span>`
    )
    .join("");

  return `<div class="summary">${items}</div>`;
}

function buildReputationTable(data: { identities: unknown[]; bonds: unknown[]; actions: unknown[] }): string {
  const identities = data.identities as IdentityRecord[];
  const bonds = data.bonds as BondRecord[];
  const actions = data.actions as ActionRecord[];

  if (identities.length === 0) {
    return `<p style="color:#888;font-style:italic">No records.</p>`;
  }

  const rows = identities.map((identity) => {
    const stats = {
      locks:     bonds.filter((b) => b.identity_id === identity.id).length,
      actions:   actions.filter((a) => a.identity_id === identity.id).length,
      successes: actions.filter((a) => a.identity_id === identity.id && a.status === "success").length,
      failures:  actions.filter((a) => a.identity_id === identity.id && a.status === "failed").length,
      malicious: actions.filter((a) => a.identity_id === identity.id && a.status === "malicious").length,
    };
    const score = scoreIdentity(stats);
    const scoreColor = score > 0 ? "background:#2d6a4f" : score < 0 ? "background:#6a2d2d" : "background:#3a3a3a";
    const idDisplay = truncateId(identity.id);
    const pkDisplay = identity.public_key.slice(0, 12) + "…";
    const agentCell = identity.agent_name
      ? `<td>${identity.agent_name}</td>`
      : `<td style="color:#555;font-style:italic">default</td>`;

    return `<tr>
      <td title="${identity.id}">${idDisplay}</td>
      ${agentCell}
      <td title="${identity.public_key}">${pkDisplay}</td>
      <td style="${scoreColor};color:#eee;font-weight:bold;text-align:center">${score}</td>
      <td>${identity.created_at}</td>
    </tr>`;
  });

  return `<table>
    <thead><tr><th>id</th><th>agent</th><th>public_key</th><th>score</th><th>created_at</th></tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table>`;
}

function buildHtml(data: { identities: unknown[]; bonds: unknown[]; actions: unknown[] }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="5" />
  <title>AgentGate Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #1a1a2e;
      color: #eee;
      font-family: monospace;
      padding: 2rem;
    }
    h1 {
      font-size: 1.6rem;
      margin-bottom: 1.25rem;
      letter-spacing: 0.05em;
      color: #a0c4ff;
    }
    h2 {
      font-size: 1.1rem;
      margin-bottom: 0.75rem;
      color: #90e0ef;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    section { margin-bottom: 2.5rem; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8rem;
    }
    th, td {
      border: 1px solid #333;
      padding: 0.4rem 0.7rem;
      text-align: left;
      white-space: nowrap;
    }
    thead tr { background: #16213e; color: #a0c4ff; }
    tbody tr:nth-child(even) { background: #0f0f23; }
    tbody tr:nth-child(odd)  { background: #1a1a2e; }
    .summary {
      display: flex;
      gap: 1.5rem;
      margin-bottom: 2rem;
      flex-wrap: wrap;
    }
    .stat {
      display: flex;
      flex-direction: column;
      align-items: center;
      background: #16213e;
      border: 1px solid #333;
      border-radius: 6px;
      padding: 0.6rem 1.2rem;
      min-width: 7rem;
    }
    .stat-value {
      font-size: 1.5rem;
      font-weight: bold;
      color: #a0c4ff;
    }
    .stat-label {
      font-size: 0.7rem;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-top: 0.15rem;
    }
    .footer {
      margin-top: 1.5rem;
      font-size: 0.7rem;
      color: #555;
    }
  </style>
</head>
<body>
  <h1>AgentGate Dashboard</h1>

  ${buildSummaryBar(data)}

  <section>
    <h2>Reputation Scores (${data.identities.length})</h2>
    ${buildReputationTable(data)}
  </section>

  <section>
    <h2>Bonds (${data.bonds.length})</h2>
    ${buildTable(data.bonds)}
  </section>

  <section>
    <h2>Actions (${data.actions.length})</h2>
    ${buildTable(data.actions)}
  </section>

  <section>
    <h2>Identities (${data.identities.length})</h2>
    ${buildTable(data.identities)}
  </section>

  <p class="footer">Auto-refreshes every 5 seconds.</p>
</body>
</html>`;
}

export function registerDashboard(app: AppInstance) {
  app.get("/dashboard", {
    preHandler: async (request, reply) => {
      const secret = process.env.AGENTGATE_REST_KEY;
      if (!secret) return;
      const auth = request.headers.authorization;
      if (!auth || !auth.startsWith("Basic ")) {
        reply.header("WWW-Authenticate", 'Basic realm="AgentGate"').status(401).send("Unauthorized");
        return;
      }
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const colonIndex = decoded.indexOf(":");
      const password = colonIndex >= 0 ? decoded.slice(colonIndex + 1) : "";
      if (password !== secret) {
        reply.header("WWW-Authenticate", 'Basic realm="AgentGate"').status(401).send("Unauthorized");
      }
    }
  }, async (_request, reply) => {
    const data = app.getDashboardData();
    reply.type("text/html").send(buildHtml(data));
  });
}
