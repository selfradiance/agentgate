// examples/marketgate/mock-exchange.ts
import http from "node:http";
import { URL } from "node:url";

type Json = Record<string, unknown>;

function readJson(req: http.IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function send(res: http.ServerResponse, status: number, body: Json) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const orders = new Map<string, Json>();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true });
    }

    if (method === "POST" && url.pathname === "/orders") {
      const body = await readJson(req);
      const id = `ord_${Math.random().toString(16).slice(2)}`;
      const order = { id, ...body, createdAt: new Date().toISOString() };
      orders.set(id, order);
      return send(res, 200, { ok: true, order });
    }

    if (
      method === "POST" &&
      url.pathname.startsWith("/orders/") &&
      url.pathname.endsWith("/cancel")
    ) {
      const id = url.pathname.split("/")[2];
      if (!orders.has(id)) return send(res, 404, { ok: false, error: "order_not_found" });
      const existing = orders.get(id)!;
      orders.delete(id);
      return send(res, 200, { ok: true, cancelled: existing });
    }
    // Agent action router (next step: this is where AgentGate enforcement will go)
    if (method === "POST" && url.pathname === "/agent-action") {
      const body = await readJson(req);

      const actionType = body?.actionType;
      const payload = body?.payload;

      if (actionType === "place_order") {
        const id = `ord_${Math.random().toString(16).slice(2)}`;
        const order = { id, ...(payload as any), createdAt: new Date().toISOString() };
        orders.set(id, order);
        return send(res, 200, { ok: true, order, routedFrom: "agent-action" });
      }

      if (actionType === "cancel_order") {
        const orderId = (payload as any)?.orderId;
        if (!orderId || typeof orderId !== "string") {
          return send(res, 400, { ok: false, error: "missing_orderId" });
        }
        if (!orders.has(orderId)) return send(res, 404, { ok: false, error: "order_not_found" });
        const existing = orders.get(orderId)!;
        orders.delete(orderId);
        return send(res, 200, { ok: true, cancelled: existing, routedFrom: "agent-action" });
      }

      return send(res, 400, { ok: false, error: "unknown_actionType" });
    }
    if (method === "GET" && url.pathname === "/orders") {
      return send(res, 200, { ok: true, orders: Array.from(orders.values()) });
    }

    return send(res, 404, { ok: false, error: "not_found" });
  } catch (err: any) {
    return send(res, 500, { ok: false, error: "server_error", detail: String(err?.message ?? err) });
  }
});

const PORT = Number(process.env.MOCK_EXCHANGE_PORT ?? 8787);
server.listen(PORT, () => {
  console.log(`MockExchange listening on http://localhost:${PORT}`);
  console.log(`Health: curl http://localhost:${PORT}/health`);
});