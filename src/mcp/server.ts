import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AgentAdapter } from "../agent-adapter";

// Adapter points at AgentGate HTTP API
const adapter = new AgentAdapter(process.env.AGENTGATE_BASE_URL ?? "http://127.0.0.1:3000");

// ---- Tool input schemas ----
const lockBondSchema = z.object({
  amount_cents: z.coerce.number().int().positive(),
  ttl_seconds: z.coerce.number().int().positive().default(3600),
  reason: z.string().default("mcp_lock_bond")
});

const executeBondedActionSchema = z.object({
  bondId: z.string(),
  actionType: z.string(),
  payload: z.preprocess((val) => typeof val === "string" ? JSON.parse(val) : val, z.record(z.string(), z.unknown())),
  exposure_cents: z.coerce.number().int().positive()
});

const resolveActionSchema = z.object({
  actionId: z.string(),
  outcome: z.enum(["success", "failed", "malicious"])
});

const getReputationSchema = z.object({
  identityId: z.string()
});

// ---- MCP server ----
const server = new Server(
  { name: "agentgate-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "lock_bond",
        description: "Lock a bond (stake) for an identity.",
        inputSchema: lockBondSchema
      },
      {
        name: "execute_bonded_action",
        description: "Execute a bonded action through AgentGate.",
        inputSchema: executeBondedActionSchema
      },
      {
        name: "resolve_action",
        description: "Resolve an action as success/failed/malicious.",
        inputSchema: resolveActionSchema
      },
      {
        name: "get_reputation",
        description: "Get identity reputation score.",
        inputSchema: getReputationSchema
      },
      {
        name: "create_identity",
        description: "Create or load the agent identity. Called automatically by other tools, but can be called explicitly.",
        inputSchema: z.object({})
      }
    ]
  };
});

// Call tool
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const toolName = req.params?.name;
  const args = req.params?.arguments ?? {};

  if (toolName === "lock_bond") {
    const input = lockBondSchema.parse(args);
    const result = await adapter.lockBond(input.amount_cents, input.ttl_seconds, input.reason);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (toolName === "execute_bonded_action") {
    const input = executeBondedActionSchema.parse(args);
    const result = await adapter.executeBondedAction(
      input.bondId,
      input.actionType,
      input.payload,
      input.exposure_cents
    );
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (toolName === "resolve_action") {
    const input = resolveActionSchema.parse(args);
    const result = await adapter.resolveAction(input.actionId, input.outcome);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (toolName === "get_reputation") {
    const input = getReputationSchema.parse(args);
    const result = await adapter.getReputation(input.identityId);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (toolName === "create_identity") {
    const result = await adapter.createIdentity();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  throw new Error(`Unknown tool: ${toolName}`);
});

// Connect over stdio (for Claude Desktop / MCP clients)
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
