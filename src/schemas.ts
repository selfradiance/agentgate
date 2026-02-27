import { z } from "zod";

export const createIdentitySchema = z.object({
  publicKey: z.string().trim().min(1, "publicKey is required")
});

export const lockBondSchema = z.object({
  identityId: z.string().trim().min(1, "identityId is required"),
  amountCents: z.number().int().positive("amountCents must be a positive integer"),
  currency: z.string().trim().min(3, "currency must be at least 3 characters").max(16),
  ttlSeconds: z.number().int().positive("ttlSeconds must be a positive integer"),
  reason: z.string().trim().min(1, "reason is required").max(280)
});

export const createOfferSchema = z.object({
  identityId: z.string().trim().min(1, "identityId is required"),
  listingId: z.string().trim().min(1, "listingId is required"),
  priceCents: z.number().int().nonnegative("priceCents must be a non-negative integer"),
  message: z.string().trim().min(1, "message is required").max(1000),
  bondId: z.string().trim().min(1, "bondId is required")
});

export const resolveOfferSchema = z
  .object({
    outcome: z.enum(["accepted", "rejected", "expired", "malicious"]),
    slashBps: z.number().int().min(0).max(10000).optional()
  })
  .superRefine((value, ctx) => {
    if (value.outcome !== "malicious" && value.slashBps !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "slashBps is only allowed when outcome is malicious",
        path: ["slashBps"]
      });
    }
  });

export type CreateIdentityInput = z.infer<typeof createIdentitySchema>;
export type LockBondInput = z.infer<typeof lockBondSchema>;
export type CreateOfferInput = z.infer<typeof createOfferSchema>;
export type ResolveOfferInput = z.infer<typeof resolveOfferSchema>;
