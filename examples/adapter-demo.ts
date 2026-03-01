import { AgentAdapter } from "../src/agent-adapter";

const baseUrl = process.env.AGENTGATE_BASE_URL ?? "http://localhost:3000";

async function main() {
  const adapter = new AgentAdapter(baseUrl);

  await adapter.createIdentity();

  const bond = await adapter.lockBond(10000, 3600, "adapter demo");
  const bondId = (bond as any).bondId ?? (bond as any).bond_id;
  if (!bondId) {
    throw new Error("Missing bond_id from lockBond response");
  }

  const execute = await adapter.executeBondedAction(
    bondId,
    "market.http",
    { url: "http://127.0.0.1:3000/v1/demo/echo", body: { ping: "pong" } },
    500
  );

  const actionId = (execute as any).actionId ?? (execute as any).action_id;
  if (!actionId) {
    throw new Error("Missing action_id from executeBondedAction response");
  }

  const resolved = await adapter.resolveAction(actionId, "success", { note: "demo" });

  console.log({ baseUrl, bond, execute, resolved });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
