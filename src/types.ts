export type BondStatus = "active" | "committed" | "released" | "expired" | "slashed";
export type OfferStatus = "open" | "accepted" | "rejected" | "expired" | "malicious";
export type ResolveOutcome = Exclude<OfferStatus, "open">;

export interface IdentityRecord {
  id: string;
  public_key: string;
  created_at: string;
}

export interface BondRecord {
  id: string;
  identity_id: string;
  amount_cents: number;
  currency: string;
  ttl_seconds: number;
  reason: string;
  status: BondStatus;
  expires_at: string;
  created_at: string;
  closed_at: string | null;
  refund_cents: number;
  burned_cents: number;
  slashed_cents: number;
}

export interface OfferRecord {
  id: string;
  identity_id: string;
  listing_id: string;
  price_cents: number;
  message: string;
  bond_id: string;
  status: OfferStatus;
  created_at: string;
  resolved_at: string | null;
  slash_bps: number | null;
}

export interface IdentityStats {
  locks: number;
  offers: number;
  accepts: number;
  rejects: number;
  expires: number;
  slashes: number;
}
