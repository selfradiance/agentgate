import { z } from "zod";
import { isEd25519PublicKey } from "./signing";

export const createIdentitySchema = z.object({
  publicKey: z
    .string()
    .trim()
    .min(1, "publicKey is required")
    .refine(isEd25519PublicKey, "publicKey must be a base64-encoded Ed25519 public key")
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
  exposure_cents: z.number().int().positive("exposure_cents must be a positive integer")
});

export const resolveActionSchema = z.object({
  outcome: z.enum(["success", "failed", "malicious"])
});

export type CreateIdentityInput = z.infer<typeof createIdentitySchema>;
export type LockBondInput = z.infer<typeof lockBondSchema>;
export type ExecuteActionInput = z.infer<typeof executeActionSchema>;
export type ResolveActionInput = z.infer<typeof resolveActionSchema>;
