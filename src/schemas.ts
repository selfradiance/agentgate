import { z } from "zod";
import { isEd25519PublicKey } from "./signing";

export const createIdentitySchema = z.object({
  publicKey: z
    .string()
    .trim()
    .min(1, "publicKey is required")
    .refine(isEd25519PublicKey, "publicKey must be a base64-encoded Ed25519 public key"),
  agentName: z.string().trim().min(1).optional()
});

export const lockBondSchema = z.object({
  identityId: z.string().trim().min(1, "identityId is required"),
  amountCents: z.number().int().positive("amountCents must be a positive integer"),
  currency: z.string().trim().min(3, "currency must be at least 3 characters").max(16),
  ttlSeconds: z.number().int().positive("ttlSeconds must be a positive integer"),
  reason: z.string().trim().min(1, "reason is required").max(280)
});

export const executeActionSchema = z.object({
  identityId: z.string().trim().min(1, "identityId is required"),
  actionType: z.string().trim().min(1, "actionType is required"),
  payload: z.unknown().optional(),
  bondId: z.string().trim().min(1, "bondId is required"),
  exposure_cents: z.number().int().nonnegative("exposure_cents must be a non-negative integer").optional().default(0)
});

export const resolveActionSchema = z.object({
  outcome: z.enum(["success", "failed", "malicious"])
});

export const banIdentitySchema = z.object({
  publicKey: z.string().trim().min(1, "publicKey is required")
});

export const unbanIdentitySchema = z.object({
  publicKey: z.string().trim().min(1, "publicKey is required")
});

export type CreateIdentityInput = z.infer<typeof createIdentitySchema>;
export type LockBondInput = z.infer<typeof lockBondSchema>;
export type ExecuteActionInput = z.infer<typeof executeActionSchema>;
export type ResolveActionInput = z.infer<typeof resolveActionSchema>;
export type BanIdentityInput = z.infer<typeof banIdentitySchema>;
export type UnbanIdentityInput = z.infer<typeof unbanIdentitySchema>;
