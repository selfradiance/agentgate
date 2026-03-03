import { randomUUID } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { AgentAdapter } from "../agent-adapter.js";
import { createMcpServer } from "./server.js";

const transports = new Map<string, StreamableHTTPServerTransport>();

export function startMcpHttpServer(port: number) {
  const app = express();
  app.use(express.json());

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
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
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
    transports.delete(sessionId);
    res.status(200).send("Session terminated");
  });

  const httpServer = app.listen(port, () => {
    process.stderr.write(
      `MCP HTTP server listening on port ${port}, endpoint: /mcp\n`
    );
  });

  return httpServer;
}
