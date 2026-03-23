import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AgentAdapter } from "../agent-adapter";
import { createLogger, generateRequestId } from "../logger";

// ---- Tool input schemas ----
const lockBondSchema = z.object({
  amount_cents: z.number().int().positive(),
  ttl_seconds: z.number().int().positive().default(3600),
  reason: z.string().default("mcp_lock_bond")
});

const executeBondedActionSchema = z.object({
  bondId: z.string(),
  actionType: z.string(),
  payload: z.preprocess((val) => {
    if (typeof val !== "string") return val;
    try { return JSON.parse(val); }
    catch { throw new Error("Invalid payload: must be valid JSON"); }
  }, z.record(z.string(), z.unknown())),
  exposure_cents: z.number().int().positive()
});

const resolveActionSchema = z.object({
  actionId: z.string(),
  outcome: z.enum(["success", "failed", "malicious"]),
  resolverId: z.string()
});

const getReputationSchema = z.object({
  identityId: z.string()
});

const createMarketMcpSchema = z.object({
  question: z.string(),
  resolution_deadline: z.string()
});

const resolveMarketMcpSchema = z.object({
  marketId: z.string(),
  outcome: z.enum(["yes", "no"])
});

function summarizeToolResult(result: unknown) {
  if (result === null || result === undefined) {
    return { resultType: String(result) };
  }

  if (Array.isArray(result)) {
    return { resultType: "array", itemCount: result.length };
  }

  if (typeof result === "object") {
    return {
      resultType: "object",
      keys: Object.keys(result as Record<string, unknown>).slice(0, 8)
    };
  }

  return { resultType: typeof result };
}

// ---- Server factory ----
export function createMcpServer(adapter: AgentAdapter): Server {
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
        },
        {
          name: "create_market",
          description: "Create a prediction market with a yes/no question and a resolution deadline (ISO timestamp).",
          inputSchema: createMarketMcpSchema
        },
        {
          name: "resolve_market",
          description: "Resolve an open prediction market as 'yes' or 'no'. Settles all positions automatically.",
          inputSchema: resolveMarketMcpSchema
        }
      ]
    };
  });

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolName = req.params?.name;
    const args = req.params?.arguments ?? {};
    const requestId = generateRequestId();
    const logger = createLogger(requestId);

    logger.info("MCP tool called", { tool: toolName });

    try {
      if (toolName === "lock_bond") {
        const input = lockBondSchema.parse(args);
        const result = await adapter.lockBond(input.amount_cents, input.ttl_seconds, input.reason);
        logger.info("MCP tool completed", { tool: toolName, ...summarizeToolResult(result) });
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
        logger.info("MCP tool completed", { tool: toolName, ...summarizeToolResult(result) });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      if (toolName === "resolve_action") {
        const input = resolveActionSchema.parse(args);
        const result = await adapter.resolveAction(input.actionId, input.outcome, input.resolverId);
        logger.info("MCP tool completed", { tool: toolName, ...summarizeToolResult(result) });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      if (toolName === "get_reputation") {
        const input = getReputationSchema.parse(args);
        const result = await adapter.getReputation(input.identityId);
        logger.info("MCP tool completed", { tool: toolName, ...summarizeToolResult(result) });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      if (toolName === "create_identity") {
        const result = await adapter.createIdentity();
        logger.info("MCP tool completed", { tool: toolName, ...summarizeToolResult(result) });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      if (toolName === "create_market") {
        const input = createMarketMcpSchema.parse(args);
        const result = await adapter.createMarket(input.question, input.resolution_deadline);
        logger.info("MCP tool completed", { tool: toolName, ...summarizeToolResult(result) });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      if (toolName === "resolve_market") {
        const input = resolveMarketMcpSchema.parse(args);
        const result = await adapter.resolveMarket(input.marketId, input.outcome);
        logger.info("MCP tool completed", { tool: toolName, ...summarizeToolResult(result) });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      throw new Error(`Unknown tool: ${toolName}`);
    } catch (err) {
      logger.error("MCP tool error", {
        tool: toolName,
        errorName: err instanceof Error ? err.name : typeof err,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });

  return server;
}

// Connect over stdio when run directly (for Claude Desktop / MCP clients)
const isMain = process.argv[1] !== undefined &&
  path.resolve(__filename) === path.resolve(process.argv[1]);

if (isMain) {
  const adapter = new AgentAdapter(
    process.env.AGENTGATE_BASE_URL ?? "http://127.0.0.1:3000",
    undefined,
    process.env.AGENTGATE_AGENT_NAME
  );
  const server = createMcpServer(adapter);

  async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  main().catch((err) => {
    createLogger().error(`MCP server fatal error: ${String(err)}`);
    process.exit(1);
  });
}
