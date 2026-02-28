// examples/marketgate/toy-trader.ts
const BASE = process.env.MOCK_EXCHANGE_BASE ?? "http://localhost:8787";

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`);
  const json = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  // 1) Place an order via /agent-action
  const placed = await post("/agent-action", {
    actionType: "place_order",
    payload: {
      market: "TEST",
      side: "yes",
      price: 0.62,
      size: 50,
      note: "placed_by_toy_trader",
    },
  });

  console.log("PLACED:", placed);

  // 2) List orders
  const listed1 = await get("/orders");
  console.log("ORDERS_AFTER_PLACE:", listed1);

  const orderId = placed?.order?.id;
  if (!orderId) throw new Error("No order id returned from exchange");

  // 3) Cancel the order via /agent-action
  const cancelled = await post("/agent-action", {
    actionType: "cancel_order",
    payload: { orderId },
  });

  console.log("CANCELLED:", cancelled);

  // 4) List orders again
  const listed2 = await get("/orders");
  console.log("ORDERS_AFTER_CANCEL:", listed2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});