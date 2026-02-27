import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { AppError } from "./errors";
import { scoreIdentity } from "./reputation";
import type {
  BondRecord,
  BondStatus,
  IdentityRecord,
  IdentityStats,
  OfferRecord,
  ResolveOutcome
} from "./types";
import type {
  CreateIdentityInput,
  CreateOfferInput,
  LockBondInput,
  ResolveOfferInput
} from "./schemas";

interface SettledAmounts {
  refundCents: number;
  burnedCents: number;
  slashedCents: number;
  bondStatus: BondStatus;
  slashBps: number | null;
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

  createOffer(input: CreateOfferInput) {
    this.getIdentityOrThrow(input.identityId);

    const bond = this.getBondOrThrow(input.bondId);
    this.assertBondCanBackOffer(bond, input.identityId);

    const id = `offer_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO offers (
            id, identity_id, listing_id, price_cents, message, bond_id, status, created_at
          ) VALUES (
            @id, @identity_id, @listing_id, @price_cents, @message, @bond_id, @status, @created_at
          )`
        )
        .run({
          id,
          identity_id: input.identityId,
          listing_id: input.listingId,
          price_cents: input.priceCents,
          message: input.message,
          bond_id: input.bondId,
          status: "open",
          created_at: createdAt
        });

      this.db
        .prepare(`UPDATE bonds SET status = 'committed' WHERE id = ?`)
        .run(input.bondId);
    });

    tx();

    return {
      offerId: id,
      status: "open" as const
    };
  }

  resolveOffer(offerId: string, input: ResolveOfferInput) {
    const offer = this.getOfferOrThrow(offerId);
    if (offer.status !== "open") {
      throw new AppError(409, "OFFER_ALREADY_RESOLVED", "Offer has already been resolved");
    }

    const bond = this.getBondOrThrow(offer.bond_id);
    const settlement = this.calculateSettlement(bond.amount_cents, input.outcome, input.slashBps);
    const resolvedAt = new Date().toISOString();

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE offers
           SET status = @status, resolved_at = @resolved_at, slash_bps = @slash_bps
           WHERE id = @id`
        )
        .run({
          id: offerId,
          status: input.outcome,
          resolved_at: resolvedAt,
          slash_bps: settlement.slashBps
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
      offerId,
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
           (SELECT COUNT(*) FROM offers WHERE identity_id = @identity_id) AS offers,
           (SELECT COUNT(*) FROM offers WHERE identity_id = @identity_id AND status = 'accepted') AS accepts,
           (SELECT COUNT(*) FROM offers WHERE identity_id = @identity_id AND status = 'rejected') AS rejects,
           (SELECT COUNT(*) FROM offers WHERE identity_id = @identity_id AND status = 'expired') AS expires,
           (SELECT COUNT(*) FROM offers WHERE identity_id = @identity_id AND status = 'malicious') AS slashes`
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

  private getOfferOrThrow(offerId: string) {
    const record = this.db
      .prepare(`SELECT * FROM offers WHERE id = ?`)
      .get(offerId) as OfferRecord | undefined;

    if (!record) {
      throw new AppError(404, "OFFER_NOT_FOUND", "Offer not found");
    }

    return record;
  }

  private assertBondCanBackOffer(bond: BondRecord, identityId: string) {
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
  }

  private calculateSettlement(
    amountCents: number,
    outcome: ResolveOutcome,
    slashBps?: number
  ): SettledAmounts {
    if (outcome === "accepted" || outcome === "rejected") {
      return {
        refundCents: amountCents,
        burnedCents: 0,
        slashedCents: 0,
        bondStatus: "released",
        slashBps: null
      };
    }

    if (outcome === "expired") {
      const refundCents = Math.floor(amountCents * 0.95);
      return {
        refundCents,
        burnedCents: amountCents - refundCents,
        slashedCents: 0,
        bondStatus: "expired",
        slashBps: null
      };
    }

    const appliedSlashBps = slashBps ?? 10000;
    const slashedCents = Math.floor((amountCents * appliedSlashBps) / 10000);

    return {
      refundCents: amountCents - slashedCents,
      burnedCents: 0,
      slashedCents,
      bondStatus: "slashed",
      slashBps: appliedSlashBps
    };
  }
}
