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
    // Create identities: operator creates the market, alice and bob take positions
    const operator = service.createIdentity({ publicKey: "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO=", agentName: "operator" });
    const alice = service.createIdentity({ publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", agentName: "alice" });
    const bob = service.createIdentity({ publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=", agentName: "bob" });

    // Each locks a bond
    const aliceBond = service.lockBond({ identityId: alice.identityId, amountCents: 100, currency: "USD", ttlSeconds: 3600, reason: "market bet" });
    const bobBond = service.lockBond({ identityId: bob.identityId, amountCents: 100, currency: "USD", ttlSeconds: 3600, reason: "market bet" });

    // Create a market (by operator, not by a participant)
    const market = service.createMarket({ creatorId: operator.identityId, question: "Will BTC hit 100k by Friday?", resolutionDeadline: new Date(Date.now() - 1000).toISOString() });
    expect(market.status).toBe("open");

    // Alice bets YES, Bob bets NO
    const alicePos = await service.executeAction({
      identityId: alice.identityId,
      actionType: "market.position",
      payload: { marketId: market.marketId, side: "yes" },
      bondId: aliceBond.bondId,
      exposure_cents: 10
    });

    const bobPos = await service.executeAction({
      identityId: bob.identityId,
      actionType: "market.position",
      payload: { marketId: market.marketId, side: "no" },
      bondId: bobBond.bondId,
      exposure_cents: 10
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

    const market = service.createMarket({ creatorId: alice.identityId, question: "Will it rain tomorrow?", resolutionDeadline: new Date(Date.now() - 1000).toISOString() });

    // Resolve once — should work
    const result = service.resolveMarket(market.marketId, "yes");
    expect(result.outcome).toBe("yes");

    // Resolve again — should throw
    expect(() => service.resolveMarket(market.marketId, "no")).toThrow("Market has already been resolved");
  });

  it("resolving one market does not affect positions on a different market", async () => {
    const operator = service.createIdentity({ publicKey: "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO=", agentName: "operator" });
    const alice = service.createIdentity({ publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", agentName: "alice" });
    const bond = service.lockBond({ identityId: alice.identityId, amountCents: 100, currency: "USD", ttlSeconds: 3600, reason: "multi-market test" });

    const market1 = service.createMarket({ creatorId: operator.identityId, question: "Market 1?", resolutionDeadline: new Date(Date.now() - 1000).toISOString() });
    const market2 = service.createMarket({ creatorId: operator.identityId, question: "Market 2?", resolutionDeadline: new Date(Date.now() - 1000).toISOString() });

    // Alice takes a position on each market
    await service.executeAction({
      identityId: alice.identityId,
      actionType: "market.position",
      payload: { marketId: market1.marketId, side: "yes" },
      bondId: bond.bondId,
      exposure_cents: 10
    });

    const market2Pos = await service.executeAction({
      identityId: alice.identityId,
      actionType: "market.position",
      payload: { marketId: market2.marketId, side: "no" },
      bondId: bond.bondId,
      exposure_cents: 10
    });

    // Resolve only market 1
    service.resolveMarket(market1.marketId, "yes");

    // Market 2 position should still be open
    const actions = service.getDashboardData().actions as any[];
    const m2Action = actions.find((a: any) => a.id === market2Pos.actionId);
    expect(m2Action.status).toBe("open");
  });

  it("rejects invalid market.position payloads during execution", async () => {
    const operator = service.createIdentity({ publicKey: "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO=", agentName: "operator" });
    const alice = service.createIdentity({ publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", agentName: "alice" });
    const bond = service.lockBond({ identityId: alice.identityId, amountCents: 100, currency: "USD", ttlSeconds: 3600, reason: "payload validation" });
    const market = service.createMarket({ creatorId: operator.identityId, question: "Validation test?", resolutionDeadline: new Date(Date.now() - 1000).toISOString() });

    await expect(service.executeAction({
      identityId: alice.identityId,
      actionType: "market.position",
      payload: { marketId: market.marketId },
      bondId: bond.bondId,
      exposure_cents: 10
    })).rejects.toMatchObject({ code: "INVALID_POSITION_PAYLOAD" });
  });

  it("rejects position from the identity that created the market", async () => {
    const creator = service.createIdentity({ publicKey: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=", agentName: "creator" });
    const participant = service.createIdentity({ publicKey: "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP=", agentName: "participant" });
    const creatorBond = service.lockBond({ identityId: creator.identityId, amountCents: 100, currency: "USD", ttlSeconds: 3600, reason: "creator bond" });
    const participantBond = service.lockBond({ identityId: participant.identityId, amountCents: 100, currency: "USD", ttlSeconds: 3600, reason: "participant bond" });

    const market = service.createMarket({ creatorId: creator.identityId, question: "Creator position test?", resolutionDeadline: new Date(Date.now() - 1000).toISOString() });

    // Creator cannot take a position in their own market
    await expect(service.executeAction({
      identityId: creator.identityId,
      actionType: "market.position",
      payload: { marketId: market.marketId, side: "yes" },
      bondId: creatorBond.bondId,
      exposure_cents: 10
    })).rejects.toMatchObject({ code: "CREATOR_CANNOT_TAKE_POSITION" });

    // A different identity can take a position
    const pos = await service.executeAction({
      identityId: participant.identityId,
      actionType: "market.position",
      payload: { marketId: market.marketId, side: "yes" },
      bondId: participantBond.bondId,
      exposure_cents: 10
    });
    expect(pos.status).toBe("open");
  });

  it("ignores malformed legacy rows that do not contain valid market JSON", async () => {
    const operator = service.createIdentity({ publicKey: "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO=", agentName: "operator" });
    const alice = service.createIdentity({ publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", agentName: "alice" });
    const bond = service.lockBond({ identityId: alice.identityId, amountCents: 100, currency: "USD", ttlSeconds: 3600, reason: "malformed test" });

    const market = service.createMarket({ creatorId: operator.identityId, question: "Malformed payload test?", resolutionDeadline: new Date(Date.now() - 1000).toISOString() });

    // Create a valid position
    await service.executeAction({
      identityId: alice.identityId,
      actionType: "market.position",
      payload: { marketId: market.marketId, side: "yes" },
      bondId: bond.bondId,
      exposure_cents: 10
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
      exposure_cents: 10,
      status: "open",
      created_at: new Date().toISOString()
    });

    const result = service.resolveMarket(market.marketId, "yes");
    expect(result.outcome).toBe("yes");
    expect(result.settledCount).toBe(1);

    // Market resolution must still succeed for the valid position instead of failing globally.
    const dashboard = service.getDashboardData();
    const marketRow = (dashboard.markets as any[]).find((m: any) => m.id === market.marketId);
    expect(marketRow.status).toBe("resolved");
  });

  it("rejects resolution before the deadline has passed", () => {
    const alice = service.createIdentity({ publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", agentName: "alice" });
    const market = service.createMarket({ creatorId: alice.identityId, question: "Future market?", resolutionDeadline: new Date(Date.now() + 86400000).toISOString() });

    expect(() => service.resolveMarket(market.marketId, "yes")).toThrow("Market cannot be resolved before its resolution deadline");
  });
});
