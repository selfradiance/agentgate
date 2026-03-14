import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import { ZodError } from "zod";
import { createDatabase } from "./db";
import { AppError } from "./errors";
import { createLogger, generateRequestId } from "./logger";
import {
  banIdentitySchema,
  createIdentitySchema,
  createMarketSchema,
  executeActionSchema,
  lockBondSchema,
  resolveActionSchema,
  resolveMarketSchema,
  unbanIdentitySchema
} from "./schemas";
import { isFreshTimestamp, verifyRequestSignature } from "./signing";
import { IbpService } from "./service";

export interface AppOptions {
  dbPath?: string;
}

function getHeaderValue(header: string | string[] | undefined) {
  if (Array.isArray(header)) {
    return header[0];
  }

  return header;
}

function getNonce(nonceHeader: string | string[] | undefined): string {
  const nonce = getHeaderValue(nonceHeader);
  if (!nonce || nonce.trim() === "") {
    throw new AppError(400, "MISSING_NONCE", "Missing required x-nonce header");
  }
  return nonce.trim();
}

function recordNonce(db: Database.Database, identityId: string, nonce: string, requestId?: string): void {
  const result = db
    .prepare(`INSERT OR IGNORE INTO nonces (nonce, identity_id, created_at) VALUES (?, ?, ?)`)
    .run(nonce, identityId, new Date().toISOString());

  if (result.changes === 0) {
    createLogger(requestId).warn("duplicate nonce rejected", {
      event: "duplicate_nonce",
      identityId: identityId.slice(0, 16),
    });
    throw new AppError(409, "DUPLICATE_NONCE", "Nonce already used");
  }
}

function assertSignedRequest(
  publicKey: string,
  timestampHeader: string | string[] | undefined,
  signatureHeader: string | string[] | undefined,
  body: unknown,
  context?: { identityId?: string; requestId?: string; endpoint?: string }
) {
  const timestamp = getHeaderValue(timestampHeader);
  const signature = getHeaderValue(signatureHeader);

  if (!timestamp || !signature) {
    createLogger(context?.requestId).warn("signature verification failed", {
      event: "signature_failed",
      reason: "missing_headers",
      identityId: context?.identityId?.slice(0, 16),
      endpoint: context?.endpoint,
    });
    throw new AppError(401, "INVALID_SIGNATURE", "Signature headers are required");
  }

  if (!isFreshTimestamp(timestamp)) {
    createLogger(context?.requestId).warn("signature verification failed", {
      event: "signature_failed",
      reason: "stale_timestamp",
      identityId: context?.identityId?.slice(0, 16),
      endpoint: context?.endpoint,
    });
    throw new AppError(401, "INVALID_SIGNATURE", "Signature timestamp is invalid");
  }

  if (!verifyRequestSignature(publicKey, timestamp, body, signature)) {
    createLogger(context?.requestId).warn("signature verification failed", {
      event: "signature_failed",
      reason: "invalid_signature",
      identityId: context?.identityId?.slice(0, 16),
      endpoint: context?.endpoint,
    });
    throw new AppError(401, "INVALID_SIGNATURE", "Signature is invalid");
  }
}

export type AppInstance = FastifyInstance & {
  db: Database.Database;
  sweep(): number;
  sweepExpiredActions(): { slashedCount: number };
  cleanExpiredNonces(): { purgedCount: number };
  getDashboardData(): { identities: unknown[]; bonds: unknown[]; actions: unknown[] };
};

export function createApp(options: AppOptions = {}): AppInstance {
  const database = createDatabase(options.dbPath ?? "data/ibp.sqlite");
  const service = new IbpService(database.db);
  const requestStartTimes = new WeakMap<FastifyRequest, number>();
  const app = Fastify({ logger: false, genReqId: () => generateRequestId() });

  if (!process.env.AGENTGATE_REST_KEY) {
    createLogger().warn("AGENTGATE_REST_KEY is not set — REST API auth is disabled");
  }

  // Require x-agentgate-key on all POST routes when AGENTGATE_REST_KEY is configured
  app.addHook("preHandler", async (request, reply) => {
    const secret = process.env.AGENTGATE_REST_KEY;
    if (!secret || request.method !== "POST") return;
    const provided = getHeaderValue(request.headers["x-agentgate-key"]);
    if (!provided || provided !== secret) {
      createLogger(request.id).warn("REST auth failed", {
        event: "auth_failed",
        endpoint: request.url,
        reason: provided ? "wrong_key" : "missing_key",
      });
      reply.status(401).send({ error: "UNAUTHORIZED", message: "Invalid or missing x-agentgate-key header" });
    }
  });

  app.addHook("onClose", async () => {
    database.close();
  });

  app.addHook("onRequest", async (request) => {
    requestStartTimes.set(request, Date.now());
  });

  app.addHook("onResponse", async (request, reply) => {
    const startTime = requestStartTimes.get(request);
    const durationMs = startTime !== undefined ? Date.now() - startTime : -1;
    const logger = createLogger(request.id);
    logger.info(`${request.method} ${request.url} ${reply.statusCode} ${durationMs}ms`);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({
        error: "VALIDATION_ERROR",
        message: error.issues.map((issue) => issue.message).join("; ")
      });
      return;
    }

    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        error: error.code,
        message: error.message
      });
      return;
    }

    reply.status(500).send({
      error: "INTERNAL_ERROR",
      message: "Internal server error"
    });
  });

  app.post("/v1/identities", async (request, reply) => {
    // Nonce presence validated; no identity exists yet so dedup is skipped here
    getNonce(request.headers["x-nonce"]);
    const body = createIdentitySchema.parse(request.body);
    reply.status(201).send(service.createIdentity(body));
  });

  app.post("/v1/bonds/lock", async (request, reply) => {
    const nonce = getNonce(request.headers["x-nonce"]);
    const rawBody = request.body;
    const body = lockBondSchema.parse(rawBody);
    assertSignedRequest(
      service.getIdentityPublicKey(body.identityId),
      request.headers["x-agentgate-timestamp"],
      request.headers["x-agentgate-signature"],
      rawBody,
      { identityId: body.identityId, requestId: request.id, endpoint: request.url }
    );
    recordNonce(database.db, body.identityId, nonce, request.id);
    reply.status(201).send(service.lockBond(body));
  });

  app.post("/v1/actions/execute", async (request, reply) => {
    const nonce = getNonce(request.headers["x-nonce"]);
    const rawBody = request.body;
    const body = executeActionSchema.parse(rawBody);
    assertSignedRequest(
      service.getIdentityPublicKey(body.identityId),
      request.headers["x-agentgate-timestamp"],
      request.headers["x-agentgate-signature"],
      rawBody,
      { identityId: body.identityId, requestId: request.id, endpoint: request.url }
    );
    recordNonce(database.db, body.identityId, nonce, request.id);
    reply.status(201).send(await service.executeAction(body));
  });

  app.post("/v1/actions/:actionId/resolve", async (request, reply) => {
    const nonce = getNonce(request.headers["x-nonce"]);
    const params = request.params as { actionId?: string };
    const rawBody = request.body;
    const body = resolveActionSchema.parse(rawBody);
    if (!params.actionId) {
      throw new AppError(400, "VALIDATION_ERROR", "Action id is required");
    }
    const identityId = service.getActionIdentityId(params.actionId);
    assertSignedRequest(
      service.getActionIdentityPublicKey(params.actionId),
      request.headers["x-agentgate-timestamp"],
      request.headers["x-agentgate-signature"],
      rawBody,
      { identityId, requestId: request.id, endpoint: request.url }
    );
    recordNonce(database.db, identityId, nonce, request.id);
    reply.send(service.resolveAction(params.actionId, body));
  });

  app.post("/v1/demo/echo", async (request, reply) => {
    // Nonce presence validated; no identity context so dedup is skipped here
    getNonce(request.headers["x-nonce"]);
    reply.status(200).send({
      ok: true,
      received: request.body
    });
  });

  app.post("/admin/ban-identity", async (request, reply) => {
    const body = banIdentitySchema.parse(request.body);
    const updated = service.banIdentity(body.publicKey);
    if (!updated) {
      throw new AppError(404, "IDENTITY_NOT_FOUND", "Identity not found");
    }
    reply.send({ status: "banned" });
  });

  app.post("/admin/unban-identity", async (request, reply) => {
    const body = unbanIdentitySchema.parse(request.body);
    const updated = service.unbanIdentity(body.publicKey);
    if (!updated) {
      throw new AppError(404, "IDENTITY_NOT_FOUND", "Identity not found");
    }
    reply.send({ status: "active" });
  });

  app.post("/markets", async (req, reply) => {
    const body = createMarketSchema.parse(req.body);
    const result = service.createMarket(body);
    return reply.code(201).send(result);
  });

  app.post("/markets/:marketId/resolve", async (req, reply) => {
    const { marketId } = req.params as { marketId: string };
    const body = resolveMarketSchema.parse(req.body);
    const result = service.resolveMarket(marketId, body.outcome);
    return reply.code(200).send(result);
  });

  app.get("/health", async (_request, reply) => {
    reply.send({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/v1/identities/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    if (!params.id) {
      throw new AppError(400, "VALIDATION_ERROR", "Identity id is required");
    }
    reply.send(service.getIdentitySummary(params.id));
  });

  app.get("/v1/stats", async (_request, reply) => {
    reply.send(service.getStats());
  });

  return Object.assign(app, {
    db: database.db,
    sweep: () => service.sweepExpiredActions().slashedCount,
    sweepExpiredActions: () => service.sweepExpiredActions(),
    cleanExpiredNonces: () => service.cleanExpiredNonces(),
    getDashboardData: () => service.getDashboardData()
  });
}
