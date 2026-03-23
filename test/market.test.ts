import { describe, it, expect, beforeEach } from "vitest";
import { createDatabase } from "../src/db";
import { AgentGateService } from "../src/service";

describe("Prediction Market", () => {
  let service: AgentGateService;

  beforeEach(() => {
    const { db } = createDatabase(":memory:");
    service = new AgentGateService(db);
  });

  it("happy path: create market, two positions, resolve — winner released, loser burned", async () => {
    // Create two identities
    const alice = service.createIdentity({ publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", agentName: "alice" });
    const bob = service.createIdentity({ publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=", agentName: "bob" });

    // Each locks a bond
    const aliceBond = service.lockBond({ identityId: alice.identityId, amountCents: 5000, currency: "USD", ttlSeconds: 3600, reason: "market bet" });
    const bobBond = service.lockBond({ identityId: bob.identityId, amountCents: 5000, currency: "USD", ttlSeconds: 3600, reason: "market bet" });

    // Create a market
    const market = service.createMarket({ question: "Will BTC hit 100k by Friday?", resolutionDeadline: new Date(Date.now() - 1000).toISOString() });
    expect(market.status).toBe("open");

    // Alice bets YES, Bob bets NO
    const alicePos = await service.executeAction({
      identityId: alice.identityId,
      actionType: "market.position",
      payload: { marketId: market.marketId, side: "yes" },
      bondId: aliceBond.bondId,
      exposure_cents: 1000
    });

    const bobPos = await service.executeAction({
      identityId: bob.identityId,
      actionType: "market.position",
      payload: { marketId: market.marketId, side: "no" },
      bondId: bobBond.bondId,
      exposure_cents: 1000
    });

    expect(alicePos.status).toBe("open");
    expect(bobPos.status).toBe("open");

    // Market resolves YES — Alice wins, Bob loses
    const result = service.resolveMarket(market.marketId, "yes");
    expect(result.outcome).toBe("yes");
    expect(result.settledCount).toBe(2);

    // Check Alice's bond was released (success)
    const aliceRep = service.getIdentitySummary(alice.identityId);
    expect(aliceRep.reputation.stats.successes).toBe(1);

    // Check Bob's bond was burned (failed)
    const bobRep = service.getIdentitySummary(bob.identityId);
    expect(bobRep.reputation.stats.failures).toBe(1);
  });

  it("rejects double resolution of the same market", () => {
    const alice = service.createIdentity({ publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", agentName: "alice" });

    const market = service.createMarket({ question: "Will it rain tomorrow?", resolutionDeadline: new Date(Date.now() - 1000).toISOString() });

    // Resolve once — should work
    const result = service.resolveMarket(market.marketId, "yes");
    expect(result.outcome).toBe("yes");

    // Resolve again — should throw
    expect(() => service.resolveMarket(market.marketId, "no")).toThrow("Market has already been resolved");
  });

  it("resolving one market does not affect positions on a different market", async () => {
    const alice = service.createIdentity({ publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", agentName: "alice" });
    const bond = service.lockBond({ identityId: alice.identityId, amountCents: 10000, currency: "USD", ttlSeconds: 3600, reason: "multi-market test" });

    const market1 = service.createMarket({ question: "Market 1?", resolutionDeadline: new Date(Date.now() - 1000).toISOString() });
    const market2 = service.createMarket({ question: "Market 2?", resolutionDeadline: new Date(Date.now() - 1000).toISOString() });

    // Alice takes a position on each market
    await service.executeAction({
      identityId: alice.identityId,
      actionType: "market.position",
      payload: { marketId: market1.marketId, side: "yes" },
      bondId: bond.bondId,
      exposure_cents: 1000
    });

    const market2Pos = await service.executeAction({
      identityId: alice.identityId,
      actionType: "market.position",
      payload: { marketId: market2.marketId, side: "no" },
      bondId: bond.bondId,
      exposure_cents: 1000
    });

    // Resolve only market 1
    service.resolveMarket(market1.marketId, "yes");

    // Market 2 position should still be open
    const actions = service.getDashboardData().actions as any[];
    const m2Action = actions.find((a: any) => a.id === market2Pos.actionId);
    expect(m2Action.status).toBe("open");
  });

  it("rejects resolution when a position has a malformed payload — market stays open", async () => {
    const alice = service.createIdentity({ publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", agentName: "alice" });
    const bond = service.lockBond({ identityId: alice.identityId, amountCents: 5000, currency: "USD", ttlSeconds: 3600, reason: "malformed test" });

    const market = service.createMarket({ question: "Malformed payload test?", resolutionDeadline: new Date(Date.now() - 1000).toISOString() });

    // Create a valid position
    await service.executeAction({
      identityId: alice.identityId,
      actionType: "market.position",
      payload: { marketId: market.marketId, side: "yes" },
      bondId: bond.bondId,
      exposure_cents: 500
    });

    // Inject a position with a malformed (non-JSON) payload directly into the database
    const { db } = service as any;
    db.prepare(
      `INSERT INTO actions (id, identity_id, action_type, payload, bond_id, exposure_cents, status, created_at)
       VALUES (@id, @identity_id, @action_type, @payload, @bond_id, @exposure_cents, @status, @created_at)`
    ).run({
      id: "action_malformed_test",
      identity_id: alice.identityId,
      action_type: "market.position",
      payload: "{bad json<<<",
      bond_id: bond.bondId,
      exposure_cents: 500,
      status: "open",
      created_at: new Date().toISOString()
    });

    // Resolution should fail with INVALID_POSITION_PAYLOAD
    expect(() => service.resolveMarket(market.marketId, "yes")).toThrow("malformed");

    // Market must still be open — not stuck in resolved-but-unsettled state
    const dashboard = service.getDashboardData();
    const marketRow = (dashboard.markets as any[]).find((m: any) => m.id === market.marketId);
    expect(marketRow.status).toBe("open");

    // Retry should not throw MARKET_ALREADY_RESOLVED
    expect(() => service.resolveMarket(market.marketId, "yes")).toThrow("malformed");
  });

  it("rejects resolution before the deadline has passed", () => {
    const market = service.createMarket({ question: "Future market?", resolutionDeadline: new Date(Date.now() + 86400000).toISOString() });

    expect(() => service.resolveMarket(market.marketId, "yes")).toThrow("Market cannot be resolved before its resolution deadline");
  });
});
