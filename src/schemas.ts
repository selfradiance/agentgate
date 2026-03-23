import { z } from "zod";
import { isEd25519PublicKey } from "./signing";

export const createIdentitySchema = z.object({
  publicKey: z
    .string()
    .trim()
    .min(1, "publicKey is required")
    .refine(isEd25519PublicKey, "publicKey must be a base64-encoded Ed25519 public key"),
  agentName: z.string().trim().min(1).max(64).optional()
});

export const lockBondSchema = z.object({
  identityId: z.string().trim().min(1, "identityId is required").max(64),
  amountCents: z.number().int().positive("amountCents must be a positive integer").max(1_000_000_000, "amountCents cannot exceed 1,000,000,000"),
  currency: z.string().trim().min(3, "currency must be at least 3 characters").max(16),
  ttlSeconds: z.number().int().positive("ttlSeconds must be a positive integer"),
  reason: z.string().trim().min(1, "reason is required").max(280)
});

export const executeActionSchema = z.object({
  identityId: z.string().trim().min(1, "identityId is required").max(64),
  actionType: z.string().trim().min(1, "actionType is required").max(128),
  payload: z.unknown().optional(),
  bondId: z.string().trim().min(1, "bondId is required").max(64),
  exposure_cents: z.number().int().positive("exposure_cents must be a positive integer").max(1_000_000_000, "exposure_cents cannot exceed 1,000,000,000")
});

export const resolveActionSchema = z.object({
  outcome: z.enum(["success", "failed", "malicious"]),
  resolverId: z.string().trim().min(1, "resolverId is required").max(64)
});

export const banIdentitySchema = z.object({
  publicKey: z.string().trim().min(1, "publicKey is required")
});

export const unbanIdentitySchema = z.object({
  publicKey: z.string().trim().min(1, "publicKey is required")
});

export const createMarketSchema = z.object({
  creatorId: z.string().trim().min(1, "creatorId is required").max(64),
  question: z.string().trim().min(1, "question is required").max(500),
  resolutionDeadline: z.string().trim().min(1, "resolutionDeadline is required").refine(
    (value) => {
      const date = new Date(value);
      const ms = date.getTime();
      const maxMs = Date.now() + 365 * 24 * 60 * 60 * 1000; // 1 year
      return !Number.isNaN(ms) && ms > Date.now() && ms <= maxMs;
    },
    "resolutionDeadline must be a valid future ISO timestamp no more than 1 year from now"
  )
});

export const resolveMarketSchema = z.object({
  outcome: z.enum(["yes", "no"]),
  resolverId: z.string().trim().min(1, "resolverId is required").max(64)
});

export type CreateIdentityInput = z.infer<typeof createIdentitySchema>;
export type LockBondInput = z.infer<typeof lockBondSchema>;
export type ExecuteActionInput = z.infer<typeof executeActionSchema>;
export type ResolveActionInput = z.infer<typeof resolveActionSchema>;
export type BanIdentityInput = z.infer<typeof banIdentitySchema>;
export type UnbanIdentityInput = z.infer<typeof unbanIdentitySchema>;
