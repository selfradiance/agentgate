import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { AppError } from "./errors";
import { scoreIdentity } from "./reputation";
import type {
  ActionRecord,
  BondRecord,
  BondStatus,
  IdentityRecord,
  IdentityStats,
  ResolveOutcome
} from "./types";
import type {
  CreateIdentityInput,
  ExecuteActionInput,
  LockBondInput,
  ResolveActionInput
} from "./schemas";

interface SettledAmounts {
  refundCents: number;
  burnedCents: number;
  slashedCents: number;
  bondStatus: BondStatus;
}

export class IbpService {
  constructor(private readonly db: Database.Database) {}

  createIdentity(input: CreateIdentityInput) {
    const id = `id_${randomUUID()}`;
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO identities (id, public_key, created_at)
         VALUES (@id, @public_key, @created_at)`
      )
      .run({
        id,
        public_key: input.publicKey,
        created_at: createdAt
      });

    return { identityId: id };
  }

  lockBond(input: LockBondInput) {
    this.getIdentityOrThrow(input.identityId);

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

  executeAction(input: ExecuteActionInput) {
    this.getIdentityOrThrow(input.identityId);

    const bond = this.getBondOrThrow(input.bondId);
    this.assertBondCanBackAction(bond, input.identityId);

    const id = `action_${randomUUID()}`;
    const nowMs = Date.now();
    const createdAt = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.assertExecuteRateLimit(input.identityId, nowMs);
      this.assertProgressiveMinBond(input.identityId, bond.amount_cents, nowMs);

      this.db
        .prepare(
          `INSERT INTO actions (
            id, identity_id, action_type, payload, bond_id, status, created_at
          ) VALUES (
            @id, @identity_id, @action_type, @payload, @bond_id, @status, @created_at
          )`
        )
        .run({
          id,
          identity_id: input.identityId,
          action_type: input.actionType,
          payload: this.serializePayload(input.payload),
          bond_id: input.bondId,
          status: "open",
          created_at: createdAt
        });

      this.recordExecuteAttempt(input.identityId, nowMs);
    });

    tx();

    return {
      actionId: id,
      status: "open" as const
    };
  }

  resolveAction(actionId: string, input: ResolveActionInput) {
    const action = this.getActionOrThrow(actionId);
    if (action.status !== "open") {
      throw new AppError(409, "ACTION_ALREADY_RESOLVED", "Action has already been resolved");
    }

    const bond = this.getBondOrThrow(action.bond_id);
    const settlement = this.calculateSettlement(bond.amount_cents, input.outcome);
    const resolvedAt = new Date().toISOString();

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE actions
           SET status = @status, resolved_at = @resolved_at
           WHERE id = @id`
        )
        .run({
          id: actionId,
          status: input.outcome,
          resolved_at: resolvedAt
        });

      this.db
        .prepare(
          `UPDATE bonds
           SET status = @status,
               closed_at = @closed_at,
               refund_cents = @refund_cents,
               burned_cents = @burned_cents,
               slashed_cents = @slashed_cents
           WHERE id = @id`
        )
        .run({
          id: bond.id,
          status: settlement.bondStatus,
          closed_at: resolvedAt,
          refund_cents: settlement.refundCents,
          burned_cents: settlement.burnedCents,
          slashed_cents: settlement.slashedCents
        });
    });

    tx();

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
           (SELECT COUNT(*) FROM bonds WHERE status = 'active') AS totalActiveBonds,
           (SELECT COALESCE(SUM(amount_cents), 0) FROM bonds WHERE status = 'active') AS totalLockedCents`
      )
      .get() as {
        totalIdentities: number;
        totalActions: number;
        totalActiveBonds: number;
        totalLockedCents: number;
      };

    return stats;
  }

  getIdentityPublicKey(identityId: string) {
    return this.getIdentityOrThrow(identityId).public_key;
  }

  getActionIdentityPublicKey(actionId: string) {
    const action = this.getActionOrThrow(actionId);
    return this.getIdentityOrThrow(action.identity_id).public_key;
  }

  private getIdentityOrThrow(identityId: string) {
    const record = this.db
      .prepare(`SELECT id, public_key, created_at FROM identities WHERE id = ?`)
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

    if (bond.status !== "active") {
      throw new AppError(409, "BOND_NOT_ACTIVE", "Bond is not active");
    }

    if (new Date(bond.expires_at).getTime() <= Date.now()) {
      this.db
        .prepare(`UPDATE bonds SET status = 'expired', closed_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), bond.id);
      throw new AppError(409, "BOND_EXPIRED", "Bond has expired");
    }

    const existingAction = this.db
      .prepare(`SELECT id FROM actions WHERE bond_id = ? LIMIT 1`)
      .get(bond.id) as { id: string } | undefined;

    if (existingAction) {
      throw new AppError(409, "BOND_NOT_ACTIVE", "Bond is not active");
    }
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

  private serializePayload(payload: unknown) {
    if (payload === undefined) {
      return null;
    }

    if (typeof payload === "string") {
      return payload;
    }

    return JSON.stringify(payload);
  }

  private getBucketStart(timestampMs: number) {
    return Math.floor(timestampMs / 60_000) * 60_000;
  }
}
