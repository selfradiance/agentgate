export type BondStatus = "active" | "released" | "expired" | "burned" | "slashed";
export type ActionStatus = "open" | "success" | "failed" | "malicious";
export type ResolveOutcome = Exclude<ActionStatus, "open">;

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
  outstanding_exposure_cents: number;
}

export interface ActionRecord {
  id: string;
  identity_id: string;
  action_type: string;
  payload: string | null;
  bond_id: string;
  exposure_cents: number;
  status: ActionStatus;
  created_at: string;
  resolved_at: string | null;
}

export interface IdentityStats {
  locks: number;
  actions: number;
  successes: number;
  failures: number;
  malicious: number;
}
