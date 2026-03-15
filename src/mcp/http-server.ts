import { randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentAdapter } from "../agent-adapter.js";
import { createMcpServer } from "./server.js";
import { createLogger } from "../logger.js";

const MAX_SESSIONS = 100;
const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds

const transports = new Map<string, StreamableHTTPServerTransport>();
const lastActivity = new Map<string, number>();

function touchSession(sessionId: string) {
  lastActivity.set(sessionId, Date.now());
}

function removeSession(sessionId: string) {
  transports.delete(sessionId);
  lastActivity.delete(sessionId);
}

function mcpAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const secret = process.env.AGENTGATE_MCP_KEY;
  if (!secret) {
    if (process.env.AGENTGATE_DEV_MODE === "true") {
      next();
      return;
    }
    createLogger().error("AGENTGATE_MCP_KEY is not set — rejecting request (set AGENTGATE_DEV_MODE=true to skip auth)", {
      event: "auth_misconfigured",
      endpoint: req.path,
      missingKey: "AGENTGATE_MCP_KEY",
    });
    res.status(500).json({ error: "SERVER_MISCONFIGURED", message: "Server misconfigured: AGENTGATE_MCP_KEY not set" });
    return;
  }
  const provided = Array.isArray(req.headers["x-agentgate-key"])
    ? req.headers["x-agentgate-key"][0]
    : req.headers["x-agentgate-key"];
  const providedBuf = Buffer.from(provided ?? "");
  const secretBuf = Buffer.from(secret);
  if (!provided || providedBuf.length !== secretBuf.length || !timingSafeEqual(providedBuf, secretBuf)) {
    createLogger().warn("MCP auth failed", {
      event: "auth_failed",
      endpoint: req.path,
      reason: provided ? "wrong_key" : "missing_key",
    });
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid or missing x-agentgate-key header" });
    return;
  }
  next();
}

export function startMcpHttpServer(port: number) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  if (!process.env.AGENTGATE_MCP_KEY) {
    if (process.env.AGENTGATE_DEV_MODE === "true") {
      process.stderr.write("WARNING: AGENTGATE_MCP_KEY is not set — MCP auth is disabled (dev mode)\n");
    } else {
      process.stderr.write("WARNING: AGENTGATE_MCP_KEY is not set — MCP requests will be rejected until it is configured\n");
    }
  }

  app.use("/mcp", mcpAuthMiddleware);

  // POST /mcp — handles initialize (new session) and subsequent requests
  app.post("/mcp", async (req, res) => {
    const rawSessionId = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

    try {
      if (sessionId) {
        const transport = transports.get(sessionId);
        if (!transport) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Session not found" },
            id: null
          });
          return;
        }
        touchSession(sessionId);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (isInitializeRequest(req.body)) {
        if (transports.size >= MAX_SESSIONS) {
          res.status(503).json({ error: "TOO_MANY_SESSIONS" });
          return;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
            touchSession(sid);
          }
        });

        const adapter = new AgentAdapter(
          process.env.AGENTGATE_BASE_URL ?? "http://127.0.0.1:3000"
        );
        const server = createMcpServer(adapter);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null
      });
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });

  // GET /mcp — establishes SSE stream for server-to-client notifications
  app.get("/mcp", async (req, res) => {
    const rawSessionId = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

    if (!sessionId) {
      res.status(400).send("Missing session ID");
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(400).send("Session not found");
      return;
    }

    touchSession(sessionId);
    await transport.handleRequest(req, res);
  });

  // DELETE /mcp — terminates a session
  app.delete("/mcp", async (req, res) => {
    const rawSessionId = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

    if (!sessionId) {
      res.status(400).send("Missing session ID");
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(400).send("Session not found");
      return;
    }

    await transport.close();
    removeSession(sessionId);
    res.status(200).send("Session terminated");
  });

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, lastUsed] of lastActivity) {
      if (now - lastUsed > SESSION_IDLE_TIMEOUT_MS) {
        const transport = transports.get(sessionId);
        if (transport) {
          transport.close().catch(() => {});
        }
        removeSession(sessionId);
      }
    }
  }, SESSION_CLEANUP_INTERVAL_MS);

  const httpServer = app.listen(port, "127.0.0.1", () => {
    process.stderr.write(
      `MCP HTTP server listening on port ${port}, endpoint: /mcp\n`
    );
  });

  httpServer.on("close", () => {
    clearInterval(cleanupInterval);
  });

  return httpServer;
}
