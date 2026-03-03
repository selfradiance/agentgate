# MarketGate (AgentGate + Mock Exchange) — Build Log

Date: 2026-02-28 (Honolulu time)

This document captures what was built in the “MarketGate” session inside the AI Creative Projects workspace. It is a parallel demo to AgentGate: it proves that **signed + bonded agent actions** can safely trigger **market-style actions** (place/cancel orders) through a single gated choke point, with outbound safety rails.

---

## 1) What was built (high level)

### Components
1) **Mock Exchange (fake market API)**
- Runs locally.
- Accepts “place order” and “cancel order”.
- Provides `/orders` to view current open orders.

2) **AgentGate server**
- Your “gate” that enforces:
  - identity (public key)
  - signed requests (timestamp + signature)
  - bond / stake requirement
  - rate limiting & progressive minimum bond logic (already in repo)
- Extended with a demo action type: **`market.http`** which performs an outbound POST.

3) **Toy Agent script**
- Simulates an agent that:
  - creates an identity
  - locks a bond
  - executes a `market.http` action to place an order
  - locks a second bond
  - executes a `market.http` action to cancel the order
  - resolves both actions as `success`

---

## 2) Key endpoints (what “endpoint” means)

An endpoint is just a URL path your running program listens to.

### Mock exchange endpoints (port 8787)
- `POST http://localhost:8787/agent-action`
  - Accepts:
    - `{ "actionType": "place_order", "payload": { ... } }`
    - `{ "actionType": "cancel_order", "payload": { "orderId": "..." } }`
- `GET http://localhost:8787/orders`
  - Lists currently open orders.

### AgentGate endpoints (port 3000)
- `POST http://127.0.0.1:3000/v1/identities`
- `POST http://127.0.0.1:3000/v1/bonds/lock`
- `POST http://127.0.0.1:3000/v1/actions/execute`
  - Requires signed headers:
    - `x-agentgate-timestamp`
    - `x-agentgate-signature`
- `POST http://127.0.0.1:3000/v1/actions/:actionId/resolve`

---

## 3) Files added/changed

### New files
- `examples/marketgate/mock-exchange.ts`
- `examples/marketgate/toy-trader.ts`
- `src/http.ts`  *(outbound HTTP helper with safety rails)*

### Modified files
- `src/app.ts`
  - Updated to `await service.executeAction(...)` since executeAction became async.
- `src/service.ts`
  - `executeAction` updated to support `market.http`:
    - executes outbound POST
    - stores response result in payload for audit/debug
    - returns `{ actionId, status, result }`
  - wraps outbound errors into:
    - `AppError(400, "DESTINATION_BLOCKED", "...")`
- `examples/toy-agent.ts`
  - Updated to demonstrate:
    - place order via AgentGate
    - resolve
    - lock second bond
    - cancel order via AgentGate
    - resolve
- `README.md`
  - Added a “MarketGate demo” section with run instructions.

---

## 4) Outbound safety rails added for `market.http`

Implemented in `src/http.ts`:

1) **Host allowlist**
- Default allowlist: `localhost`, `127.0.0.1`, `::1`
- Any non-allowlisted host returns:
  - `400 DESTINATION_BLOCKED`
  - message includes the allowlist and the blocked host

2) **Timeout**
- Default: 2500ms
- Implemented via `AbortController`

3) **Max request body size**
- Default: 4096 bytes
- Enforced before sending the request
- Oversize requests return:
  - `400 DESTINATION_BLOCKED`
  - message: `Request body too large: ... (max ...)`

### Env vars (optional)
- `IBP_HTTP_ALLOWLIST="localhost,127.0.0.1"`
- `IBP_HTTP_TIMEOUT_MS=2500`
- `IBP_HTTP_MAX_BODY_BYTES=4096`

---

## 5) How to run the demo (local)

### Terminal 1: start mock exchange
```bash
cd /path/to/intent-bond-protocol
node examples/marketgate/mock-exchange.ts
```

### Terminal 2: start AgentGate server
```bash
cd /path/to/intent-bond-protocol
npm install
npm run dev
```
AgentGate defaults to `127.0.0.1:3000`.

### Terminal 3: run toy agent demo (place + cancel via AgentGate)
```bash
cd /path/to/intent-bond-protocol
npm run example:toy-agent
```

### Optional sanity checks
List open orders on the mock exchange:
```bash
curl -s http://localhost:8787/orders
```

Health check:
```bash
curl http://localhost:8787/health
```

---

## 6) What was proven

- A signed + bonded action (`market.http`) can safely trigger market-style API calls.
- AgentGate can sit in front of “market actions” as a choke point (place/cancel).
- Outbound HTTP risks were reduced with allowlist + timeout + max-body.

This is the concrete “MarketGate” wedge: **AgentGate + market-shaped actions**.

---

## 7) GitHub status

Changes were committed and pushed to the repository:
- Repo: `selfradiance/agentgate`
- Branch: `main`
- Commit message: `Add MarketGate demo and outbound safety rails`
- Working tree ended clean (`nothing to commit, working tree clean`).

---

## 8) Next possible phases (if/when you resume)

- Add **max response size** and structured logging for blocked outbound calls.
- Restrict allowed **ports** (e.g., only 8787 during dev).
- Make bonds reusable for a “session” (multiple actions per bond) if desired.
- Expand mock exchange to feel closer to prediction markets (market creation, resolution, disputes).
