import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { AppError } from "./errors";
import { createLogger } from "./logger";
import { scoreIdentity } from "./reputation";
import type {
  ActionRecord,
  BondRecord,
  BondStatus,
  IdentityRecord,
  IdentityStats,
  MarketRecord,
  ResolveOutcome
} from "./types";
import type {
  CreateIdentityInput,
  ExecuteActionInput,
  LockBondInput
} from "./schemas";
import { postJson } from "./http";
interface SettledAmounts {
  refundCents: number;
  burnedCents: number;
  slashedCents: number;
  bondStatus: BondStatus;
}

interface BondTotals {
  burned_cents: number;
  slashed_cents: number;
}

interface MarketPositionPayload {
  marketId: string;
  side: "yes" | "no";
}

const RISK_MULTIPLIER = 1.2;
const MAX_TTL_SECONDS = 86400; // 24 hours
const MAX_PAYLOAD_BYTES = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class AgentGateService {
  constructor(private readonly db: Database.Database) { }

  createIdentity(input: CreateIdentityInput) {
    const id = `id_${randomUUID()}`;
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO identities (id, public_key, agent_name, created_at)
         VALUES (@id, @public_key, @agent_name, @created_at)`
      )
      .run({
        id,
        public_key: input.publicKey,
        agent_name: input.agentName ?? null,
        created_at: createdAt
      });

    return { identityId: id };
  }

  lockBond(input: LockBondInput) {
    this.assertNotBanned(input.identityId);
    this.getIdentityOrThrow(input.identityId);

    if (input.ttlSeconds > MAX_TTL_SECONDS) {
      throw new AppError(
        400,
        "TTL_TOO_LONG",
        `TTL exceeds maximum of ${MAX_TTL_SECONDS} seconds (24 hours)`
      );
    }

    const id = `bond_${randomUUID()}`;
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + input.ttlSeconds * 1000).toISOString();

    this.db
      .prepare(
        `INSERT INTO bonds (
          id, identity_id, amount_cents, currency, ttl_seconds, reason, status,
          expires_at, created_at, closed_at, refund_cents, burned_cents, slashed_cents
        ) VALUES (
          @id, @identity_id, @amount_cents, @currency, @ttl_seconds, @reason, @status,
          @expires_at, @created_at, NULL, 0, 0, 0
        )`
      )
      .run({
        id,
        identity_id: input.identityId,
        amount_cents: input.amountCents,
        currency: input.currency.toUpperCase(),
        ttl_seconds: input.ttlSeconds,
        reason: input.reason,
        status: "active",
        expires_at: expiresAt,
        created_at: createdAt.toISOString()
      });

    return {
      bondId: id,
      status: "active" as const,
      expiresAt
    };
  }

  async executeAction(input: ExecuteActionInput) {
    this.assertNotBanned(input.identityId);
    this.getIdentityOrThrow(input.identityId);

    if (input.exposure_cents <= 0) {
      throw new AppError(400, "INVALID_EXPOSURE", "exposure_cents must be a positive integer");
    }

    if (input.actionType === "market.position") {
      const pos = this.parseMarketPositionPayload(input.payload, "market.position payload");
      const marketCreatorId = this.getMarketCreatorId(pos.marketId);
      if (input.identityId === marketCreatorId) {
        throw new AppError(403, "CREATOR_CANNOT_TAKE_POSITION", "The identity that created a market cannot take a position in it");
      }
    }

    const payloadStr = input.payload !== undefined ? (JSON.stringify(input.payload) ?? "") : "";
    if (Buffer.byteLength(payloadStr, "utf8") > MAX_PAYLOAD_BYTES) {
      throw new AppError(
        400,
        "PAYLOAD_TOO_LARGE",
        `Payload exceeds maximum size of ${MAX_PAYLOAD_BYTES} bytes`
      );
    }

    const bond = this.getBondOrThrow(input.bondId);
    this.assertBondCanBackAction(bond, input.identityId);
    const declaredExposureCents = input.exposure_cents;
    const effectiveExposureCents = Math.ceil(declaredExposureCents * RISK_MULTIPLIER);
    if (bond.outstanding_exposure_cents + effectiveExposureCents > bond.amount_cents) {
      throw new AppError(
        400,
        "INSUFFICIENT_BOND_CAPACITY",
        "Bond capacity exceeded for this action"
      );
    }

    const id = `action_${randomUUID()}`;
    const nowMs = Date.now();
    const createdAt = new Date().toISOString();

    const tx = this.db.transaction(() => {
      this.assertExecuteRateLimit(input.identityId, nowMs);
      this.assertProgressiveMinBond(input.identityId, bond.amount_cents, nowMs);

      // Re-fetch and re-check the bond inside the transaction so the
      // expiration check and the write are atomic.
      const freshBond = this.getBondOrThrow(input.bondId);
      this.assertBondCanBackAction(freshBond, input.identityId);
      if (freshBond.outstanding_exposure_cents + effectiveExposureCents > freshBond.amount_cents) {
        throw new AppError(
          400,
          "INSUFFICIENT_BOND_CAPACITY",
          "Bond capacity exceeded for this action"
        );
      }

      this.db
        .prepare(
          `INSERT INTO actions (
  id, identity_id, action_type, payload, bond_id, exposure_cents, status, created_at
) VALUES (
  @id, @identity_id, @action_type, @payload, @bond_id, @exposure_cents, @status, @created_at
)`
        )
        .run({
          id,
          identity_id: input.identityId,
          action_type: input.actionType,
          payload: this.serializePayload(input.payload),
          bond_id: input.bondId,
          exposure_cents: effectiveExposureCents,
          status: "open",
          created_at: createdAt
        });
      this.db
        .prepare(`
    UPDATE bonds
    SET outstanding_exposure_cents = outstanding_exposure_cents + @delta,
        status = 'occupied'
    WHERE id = @bond_id
  `)
        .run({
          delta: effectiveExposureCents,
          bond_id: freshBond.id
        });
      this.recordExecuteAttempt(input.identityId, nowMs);
    });

    tx();

    let result: unknown = undefined;

    // If this is a market HTTP action, execute it immediately (demo only)
    if (input.actionType === "market.http") {
      const p = input.payload as any;

      const url = p?.url;
      const body = p?.body;

      if (!url || typeof url !== "string") {
        this.rollbackFailedAction(id, input.bondId, effectiveExposureCents);
        throw new AppError(400, "VALIDATION_ERROR", "market.http payload.url is required");
      }

      try {
        result = await postJson(url, body);
      } catch (e: any) {
        this.rollbackFailedAction(id, input.bondId, effectiveExposureCents);
        throw new AppError(400, "DESTINATION_BLOCKED", String(e?.message ?? e));
      }

      // Store a sanitized version of the result for audit/debugging.
      // Truncate the response body to 1024 characters and strip headers —
      // the full result is still returned to the caller.
      const sanitizedResult = this.sanitizeResultForStorage(result);
      this.db
        .prepare(
          `UPDATE actions
           SET payload = @payload
           WHERE id = @id`
        )
        .run({
          id,
          payload: this.serializePayload({
            ...p,
            result: sanitizedResult
          })
        });
    }

    return {
      actionId: id,
      status: "open" as const,
      result
    };
  }
  resolveAction(actionId: string, input: { outcome: ResolveOutcome }) {
    const action = this.getActionOrThrow(actionId);

    const bond = this.getBondOrThrow(action.bond_id);
    const settlement = this.calculateSettlement(action.exposure_cents, input.outcome);
    const resolvedAt = new Date().toISOString();

    const tx = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE actions
           SET status = @status, resolved_at = @resolved_at
           WHERE id = @id AND status = 'open'`
        )
        .run({
          id: actionId,
          status: input.outcome,
          resolved_at: resolvedAt
        });

      if (result.changes === 0) {
        throw new AppError(409, "ACTION_ALREADY_RESOLVED", "Action has already been resolved");
      }

      // Subtract this action's exposure and accumulate settlement amounts
      this.db
        .prepare(
          `UPDATE bonds
           SET outstanding_exposure_cents = outstanding_exposure_cents - @action_exposure,
               slashed_cents = slashed_cents + @slashed_cents,
               refund_cents = refund_cents + @refund_cents,
               burned_cents = burned_cents + @burned_cents
           WHERE id = @id`
        )
        .run({
          id: bond.id,
          action_exposure: action.exposure_cents,
          slashed_cents: settlement.slashedCents,
          refund_cents: settlement.refundCents,
          burned_cents: settlement.burnedCents
        });

      // For malicious outcomes, reduce the bond's amount by the slashed amount
      if (settlement.slashedCents > 0) {
        this.db
          .prepare(
            `UPDATE bonds
             SET amount_cents = MAX(0, amount_cents - @slashed_cents)
             WHERE id = @id`
          )
          .run({ id: bond.id, slashed_cents: settlement.slashedCents });
      }

      // Only change bond status when no other open actions remain on this bond
      const { remaining } = this.db
        .prepare(
          `SELECT COUNT(*) AS remaining FROM actions
           WHERE bond_id = @bond_id AND status = 'open'`
        )
        .get({ bond_id: bond.id }) as { remaining: number };

      if (remaining === 0) {
        const totals = this.db
          .prepare(`SELECT burned_cents, slashed_cents FROM bonds WHERE id = @id`)
          .get({ id: bond.id }) as BondTotals;

        this.db
          .prepare(`UPDATE bonds SET status = @status, closed_at = @closed_at WHERE id = @id`)
          .run({
            id: bond.id,
            status: this.getClosedBondStatus(totals),
            closed_at: resolvedAt
          });
      }
    });

    tx();

    if (input.outcome === "malicious") {
      createLogger().warn("bond slashed", {
        event: "bond_slashed",
        actionId: actionId.slice(0, 20),
        identityId: action.identity_id.slice(0, 16),
        bondId: action.bond_id.slice(0, 20),
        slashedCents: settlement.slashedCents,
      });

      const { count: maliciousCount } = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM actions
           WHERE identity_id = ? AND status = 'malicious'`
        )
        .get(action.identity_id) as { count: number };

      if (maliciousCount >= 3) {
        const identity = this.db
          .prepare(`SELECT public_key FROM identities WHERE id = ?`)
          .get(action.identity_id) as { public_key: string } | undefined;
        if (identity) {
          this.banIdentity(identity.public_key);
          createLogger().warn("identity auto-banned", {
            event: "identity_auto_banned",
            identityId: action.identity_id.slice(0, 16),
            maliciousCount,
          });
        }
      }
    }

    return {
      actionId,
      outcome: input.outcome,
      refundCents: settlement.refundCents,
      burnedCents: settlement.burnedCents,
      slashedCents: settlement.slashedCents
    };
  }

  getIdentitySummary(identityId: string) {
    const identity = this.getIdentityOrThrow(identityId);

    const stats = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM bonds WHERE identity_id = @identity_id) AS locks,
           (SELECT COUNT(*) FROM actions WHERE identity_id = @identity_id) AS actions,
           (SELECT COUNT(*) FROM actions WHERE identity_id = @identity_id AND status = 'success') AS successes,
           (SELECT COUNT(*) FROM actions WHERE identity_id = @identity_id AND status = 'failed') AS failures,
           (SELECT COUNT(*) FROM actions WHERE identity_id = @identity_id AND status = 'malicious') AS malicious`
      )
      .get({ identity_id: identityId }) as IdentityStats;

    return {
      identityId: identity.id,
      publicKey: identity.public_key,
      reputation: {
        score: scoreIdentity(stats),
        stats
      }
    };
  }

  getStats() {
    const stats = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM identities) AS totalIdentities,
           (SELECT COUNT(*) FROM actions) AS totalActions,
           (SELECT COUNT(*) FROM bonds WHERE status IN ('active', 'occupied')) AS totalActiveBonds,
           (SELECT COALESCE(SUM(amount_cents), 0) FROM bonds WHERE status IN ('active', 'occupied')) AS totalLockedCents`
      )
      .get() as {
        totalIdentities: number;
        totalActions: number;
        totalActiveBonds: number;
        totalLockedCents: number;
      };

    return stats;
  }

  /**
   * Finds all open actions whose bond has expired (created_at + ttl_seconds in the past)
   * and auto-resolves each one as 'malicious', slashing the bond. This enforces the
   * economic guarantee that agents cannot leave actions open indefinitely to avoid
   * consequences. Returns the number of actions that were slashed.
   */
  sweepExpiredActions(): { slashedCount: number } {
    const now = new Date().toISOString();

    const expired = this.db
      .prepare(
        `SELECT a.id AS action_id
         FROM actions a
         JOIN bonds b ON a.bond_id = b.id
         WHERE a.status = 'open'
           AND b.expires_at <= @now`
      )
      .all({ now }) as Array<{ action_id: string }>;

    let slashedCount = 0;

    for (const row of expired) {
      try {
        this.resolveAction(row.action_id, { outcome: "malicious" });
        slashedCount++;
      } catch {
        // Action may have already been resolved concurrently — skip it
      }
    }

    return { slashedCount };
  }

  cleanExpiredNonces(): { purgedCount: number } {
    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
    const result = this.db
      .prepare(`DELETE FROM nonces WHERE created_at <= @cutoff`)
      .run({ cutoff });
    return { purgedCount: result.changes };
  }

  cleanExpiredBuckets(): { purgedCount: number } {
    const cutoff = Date.now() - 60_000;
    const result = this.db
      .prepare(`DELETE FROM action_execute_buckets WHERE requested_at < @cutoff`)
      .run({ cutoff });
    return { purgedCount: result.changes };
  }

  getDashboardData() {
    const identities = this.db.prepare(`SELECT * FROM identities`).all();
    const bonds = this.db.prepare(`SELECT * FROM bonds`).all();
    const actions = this.db.prepare(`SELECT * FROM actions`).all();
    const markets = this.db.prepare(`SELECT * FROM markets`).all();
    return { identities, bonds, actions, markets };
  }

  createMarket(input: { creatorId: string; question: string; resolutionDeadline: string }) {
    this.assertNotBanned(input.creatorId);
    this.getIdentityOrThrow(input.creatorId);

    const id = `market_${randomUUID()}`;
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO markets (id, creator_id, question, resolution_deadline, status, outcome, created_at)
         VALUES (@id, @creator_id, @question, @resolution_deadline, 'open', NULL, @created_at)`
      )
      .run({
        id,
        creator_id: input.creatorId,
        question: input.question,
        resolution_deadline: input.resolutionDeadline,
        created_at: createdAt
      });

    return { marketId: id, status: 'open' as const };
  }

  getMarketCreatorId(marketId: string): string {
    const market = this.db
      .prepare(`SELECT creator_id FROM markets WHERE id = ?`)
      .get(marketId) as { creator_id: string | null } | undefined;
    if (!market) {
      throw new AppError(404, "MARKET_NOT_FOUND", "Market not found");
    }
    if (!market.creator_id) {
      throw new AppError(400, "MARKET_MISSING_CREATOR", "Market has no creator identity");
    }
    return market.creator_id;
  }

  resolveMarket(marketId: string, outcome: 'yes' | 'no') {
    const market = this.db
      .prepare(`SELECT * FROM markets WHERE id = ?`)
      .get(marketId) as MarketRecord | undefined;

    if (!market) {
      throw new AppError(404, "MARKET_NOT_FOUND", "Market not found");
    }

    if (market.status !== 'open') {
      throw new AppError(409, "MARKET_ALREADY_RESOLVED", "Market has already been resolved");
    }

    const deadlineMs = new Date(market.resolution_deadline).getTime();
    if (Number.isNaN(deadlineMs)) {
      throw new AppError(500, "INVALID_DEADLINE_FORMAT", "Market has a malformed resolution_deadline — manual investigation required");
    }
    if (deadlineMs > Date.now()) {
      throw new AppError(400, "MARKET_NOT_YET_RESOLVABLE", "Market cannot be resolved before its resolution deadline");
    }

    if (market.creator_id) {
      this.assertNotBanned(market.creator_id);
    }

    // Fetch all open positions for this market BEFORE marking resolved
    const marketPositions = this.db
      .prepare(
        `SELECT * FROM actions
         WHERE action_type = 'market.position'
           AND status = 'open'
           AND json_extract(
             CASE WHEN json_valid(payload) THEN payload ELSE NULL END,
             '$.marketId'
           ) = @marketId`
      )
      .all({ marketId }) as ActionRecord[];

    // Parse and validate ALL position payloads upfront — reject if any are malformed
    const parsedPositions: Array<{ position: ActionRecord; side: string }> = [];
    for (const position of marketPositions) {
      const payload = this.parseStoredMarketPositionPayload(position);
      parsedPositions.push({ position, side: payload.side });
    }

    // All payloads validated — mark resolved and settle in a single transaction
    const resolvedAt = new Date().toISOString();
    let settledCount = 0;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE markets SET status = 'resolved', outcome = @outcome, resolved_at = @resolved_at WHERE id = @id`
        )
        .run({ id: marketId, outcome, resolved_at: resolvedAt });

      for (const { position, side } of parsedPositions) {
        const positionOutcome = side === outcome ? 'success' : 'failed';
        try {
          this.resolveAction(position.id, { outcome: positionOutcome });
          settledCount++;
        } catch (err) {
          if (err instanceof AppError && err.code === "ACTION_ALREADY_RESOLVED") {
            // Expected: action was settled concurrently (e.g. by sweeper) — skip
            continue;
          }
          createLogger().error("unexpected error settling market position", {
            event: "market_position_settlement_failed",
            marketId,
            positionId: position.id,
            error: String(err),
          });
          throw err;
        }
      }
    });

    tx();

    return { marketId, outcome, settledCount };
  }

  getIdentityPublicKey(identityId: string) {
    return this.getIdentityOrThrow(identityId).public_key;
  }

  getActionIdentityId(actionId: string) {
    return this.getActionOrThrow(actionId).identity_id;
  }

  getActionIdentityPublicKey(actionId: string) {
    const action = this.getActionOrThrow(actionId);
    return this.getIdentityOrThrow(action.identity_id).public_key;
  }

  getIdentityStatus(publicKey: string): 'active' | 'banned' | null {
    const row = this.db
      .prepare(`SELECT status FROM identities WHERE public_key = ?`)
      .get(publicKey) as { status: 'active' | 'banned' } | undefined;
    return row?.status ?? null;
  }

  banIdentity(publicKey: string): boolean {
    const result = this.db
      .prepare(`UPDATE identities SET status = 'banned' WHERE public_key = ?`)
      .run(publicKey);
    return result.changes > 0;
  }

  unbanIdentity(publicKey: string): boolean {
    const result = this.db
      .prepare(`UPDATE identities SET status = 'active' WHERE public_key = ?`)
      .run(publicKey);
    return result.changes > 0;
  }

  assertNotBanned(identityId: string) {
    const row = this.db
      .prepare(`SELECT status FROM identities WHERE id = ?`)
      .get(identityId) as { status: string } | undefined;
    if (row?.status === 'banned') {
      createLogger().warn("banned identity attempted action", {
        event: "auth_failed",
        reason: "identity_banned",
        identityId: identityId.slice(0, 16),
      });
      throw new AppError(403, "IDENTITY_BANNED", "This identity has been banned and cannot perform actions");
    }
  }

  private getIdentityOrThrow(identityId: string) {
    const record = this.db
      .prepare(`SELECT id, public_key, agent_name, status, created_at FROM identities WHERE id = ?`)
      .get(identityId) as IdentityRecord | undefined;

    if (!record) {
      throw new AppError(404, "IDENTITY_NOT_FOUND", "Identity not found");
    }

    return record;
  }

  private getBondOrThrow(bondId: string) {
    const record = this.db
      .prepare(`SELECT * FROM bonds WHERE id = ?`)
      .get(bondId) as BondRecord | undefined;

    if (!record) {
      throw new AppError(404, "BOND_NOT_FOUND", "Bond not found");
    }

    return record;
  }

  private getActionOrThrow(actionId: string) {
    const record = this.db
      .prepare(`SELECT * FROM actions WHERE id = ?`)
      .get(actionId) as ActionRecord | undefined;

    if (!record) {
      throw new AppError(404, "ACTION_NOT_FOUND", "Action not found");
    }

    return record;
  }

  private assertBondCanBackAction(bond: BondRecord, identityId: string) {
    if (bond.identity_id !== identityId) {
      throw new AppError(409, "BOND_IDENTITY_MISMATCH", "Bond does not belong to the supplied identity");
    }

    if (bond.status !== "active" && bond.status !== "occupied") {
      throw new AppError(409, "BOND_NOT_ACTIVE", "Bond is not active");
    }

    if (new Date(bond.expires_at).getTime() <= Date.now()) {
      this.db
        .prepare(`UPDATE bonds SET status = 'expired', closed_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), bond.id);
      throw new AppError(409, "BOND_EXPIRED", "Bond has expired");
    }
  }

  /**
   * Rolls back a committed action that failed during outbound execution (market.http).
   * Marks the action as "failed", subtracts its exposure from the bond, and restores
   * the bond to "active" if no other open actions remain.
   */
  private rollbackFailedAction(actionId: string, bondId: string, exposureCents: number) {
    const rollback = this.db.transaction(() => {
      const action = this.db
        .prepare(`SELECT status FROM actions WHERE id = ?`)
        .get(actionId) as { status: string } | undefined;

      if (!action || action.status !== "open") {
        createLogger().warn(`[rollback] skipped — action ${actionId} already resolved (status: ${action?.status ?? "not found"})`);
        return;
      }

      this.db
        .prepare(`UPDATE actions SET status = 'failed', resolved_at = @resolved_at WHERE id = @id`)
        .run({ id: actionId, resolved_at: new Date().toISOString() });

      this.db
        .prepare(
          `UPDATE bonds
           SET outstanding_exposure_cents = outstanding_exposure_cents - @action_exposure
           WHERE id = @id`
        )
        .run({ id: bondId, action_exposure: exposureCents });

      const { remaining } = this.db
        .prepare(`SELECT COUNT(*) AS remaining FROM actions WHERE bond_id = @bond_id AND status = 'open'`)
        .get({ bond_id: bondId }) as { remaining: number };

      if (remaining === 0) {
        this.db
          .prepare(`UPDATE bonds SET status = 'active' WHERE id = @id`)
          .run({ id: bondId });
      }
    });
    rollback();
  }

  private assertExecuteRateLimit(identityId: string, nowMs: number) {
    const recentRequests = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM action_execute_buckets
         WHERE identity_id = @identity_id
           AND bucket_start >= @oldest_bucket_start
           AND requested_at >= @window_start`
      )
      .get({
        identity_id: identityId,
        oldest_bucket_start: this.getBucketStart(nowMs - 60_000),
        window_start: nowMs - 60_000
      }) as { count: number };

    if (recentRequests.count >= 10) {
      throw new AppError(
        429,
        "RATE_LIMIT_EXCEEDED",
        "Identity is limited to 10 action executes per 60 seconds"
      );
    }
  }

  private assertProgressiveMinBond(identityId: string, amountCents: number, nowMs: number) {
    const recentActions = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM actions
         WHERE identity_id = @identity_id
           AND created_at >= @window_start`
      )
      .get({
        identity_id: identityId,
        window_start: new Date(nowMs - 10 * 60_000).toISOString()
      }) as { count: number };

    const minimumBondCents = recentActions.count > 20 ? 5000 : recentActions.count > 10 ? 2000 : 0;

    if (minimumBondCents > 0 && amountCents < minimumBondCents) {
      throw new AppError(
        409,
        "MIN_BOND_REQUIRED",
        `Minimum bond is ${minimumBondCents} cents for this identity's recent action volume`
      );
    }
  }

  private recordExecuteAttempt(identityId: string, nowMs: number) {
    this.db
      .prepare(
        `INSERT INTO action_execute_buckets (identity_id, bucket_start, requested_at)
         VALUES (@identity_id, @bucket_start, @requested_at)`
      )
      .run({
        identity_id: identityId,
        bucket_start: this.getBucketStart(nowMs),
        requested_at: nowMs
      });
  }

  private calculateSettlement(amountCents: number, outcome: ResolveOutcome): SettledAmounts {
    if (outcome === "success") {
      return {
        refundCents: amountCents,
        burnedCents: 0,
        slashedCents: 0,
        bondStatus: "released"
      };
    }

    if (outcome === "failed") {
      const refundCents = Math.floor(amountCents * 0.95);
      return {
        refundCents,
        burnedCents: amountCents - refundCents,
        slashedCents: 0,
        bondStatus: "burned"
      };
    }

    return {
      refundCents: 0,
      burnedCents: 0,
      slashedCents: amountCents,
      bondStatus: "slashed"
    };
  }

  private getClosedBondStatus(totals: BondTotals): BondStatus {
    if (totals.slashed_cents > 0) {
      return "slashed";
    }

    if (totals.burned_cents > 0) {
      return "burned";
    }

    return "released";
  }

  private parseMarketPositionPayload(payload: unknown, label: string): MarketPositionPayload {
    if (!isRecord(payload)) {
      throw new AppError(400, "INVALID_POSITION_PAYLOAD", `${label} must be a JSON object`);
    }

    const marketId = typeof payload.marketId === "string" ? payload.marketId.trim() : "";
    const side = payload.side;

    if (!marketId) {
      throw new AppError(400, "INVALID_POSITION_PAYLOAD", `${label} is missing marketId`);
    }

    if (side !== "yes" && side !== "no") {
      throw new AppError(400, "INVALID_POSITION_PAYLOAD", `${label} must include side 'yes' or 'no'`);
    }

    return { marketId, side };
  }

  private parseStoredMarketPositionPayload(position: ActionRecord): MarketPositionPayload {
    try {
      return this.parseMarketPositionPayload(
        JSON.parse(position.payload ?? "null"),
        `Position ${position.id}`
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        400,
        "INVALID_POSITION_PAYLOAD",
        `Position ${position.id} has a malformed payload that cannot be parsed`
      );
    }
  }

  private serializePayload(payload: unknown) {
    if (payload === undefined) {
      return null;
    }

    if (typeof payload === "string") {
      return payload;
    }

    return JSON.stringify(payload);
  }

  /**
   * Sanitizes an outbound HTTP result before persisting to the database.
   * Truncates the response body to 1024 characters and strips any response
   * headers, storing only the status code and truncated body.
   */
  private sanitizeResultForStorage(result: unknown): { statusCode?: number; body: string } {
    const MAX_BODY_CHARS = 1024;

    // Extract statusCode if result is an object with one
    let statusCode: number | undefined;
    if (result && typeof result === "object" && "statusCode" in result) {
      statusCode = (result as { statusCode?: number }).statusCode;
    }

    // Serialize the result body (strip headers by not copying them)
    let bodyStr: string;
    if (result && typeof result === "object" && "body" in result) {
      bodyStr = typeof (result as { body?: unknown }).body === "string"
        ? (result as { body: string }).body
        : JSON.stringify((result as { body: unknown }).body);
    } else {
      bodyStr = typeof result === "string" ? result : (JSON.stringify(result) ?? "");
    }

    // Truncate if needed
    if (bodyStr && bodyStr.length > MAX_BODY_CHARS) {
      bodyStr = bodyStr.slice(0, MAX_BODY_CHARS) + "[truncated]";
    }

    return statusCode !== undefined ? { statusCode, body: bodyStr } : { body: bodyStr };
  }

  private getBucketStart(timestampMs: number) {
    return Math.floor(timestampMs / 60_000) * 60_000;
  }
}
