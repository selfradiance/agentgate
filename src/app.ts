import { timingSafeEqual } from "node:crypto";
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
import { AgentGateService } from "./service";

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
  nonce: string,
  method: string,
  path: string,
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

  if (!verifyRequestSignature(publicKey, nonce, method, path, timestamp, body, signature)) {
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
  cleanExpiredBuckets(): { purgedCount: number };
  getDashboardData(): { identities: unknown[]; bonds: unknown[]; actions: unknown[]; markets: unknown[] };
};

export function createApp(options: AppOptions = {}): AppInstance {
  const database = createDatabase(options.dbPath ?? "data/agentgate.sqlite");
  const service = new AgentGateService(database.db);
  const requestStartTimes = new WeakMap<FastifyRequest, number>();
  const app = Fastify({ logger: false, genReqId: () => generateRequestId() });

  const devMode = process.env.AGENTGATE_DEV_MODE === "true";

  if (!process.env.AGENTGATE_REST_KEY) {
    if (devMode) {
      createLogger().warn("AGENTGATE_REST_KEY is not set — REST API auth is disabled (dev mode)");
    } else {
      createLogger().warn("AGENTGATE_REST_KEY is not set — requests will be rejected until it is configured");
    }
  }
  if (!process.env.AGENTGATE_ADMIN_KEY) {
    if (devMode) {
      createLogger().warn("AGENTGATE_ADMIN_KEY is not set — admin endpoint auth is disabled (dev mode)");
    } else {
      createLogger().warn("AGENTGATE_ADMIN_KEY is not set — admin requests will be rejected until it is configured");
    }
  }

  // Require x-agentgate-key on POST routes using the appropriate key per context
  app.addHook("preHandler", async (request, reply) => {
    if (request.method !== "POST") return;

    const isAdmin = request.url.startsWith("/admin/");
    const keyName = isAdmin ? "AGENTGATE_ADMIN_KEY" : "AGENTGATE_REST_KEY";
    const secret = isAdmin ? process.env.AGENTGATE_ADMIN_KEY : process.env.AGENTGATE_REST_KEY;
    if (!secret) {
      if (devMode) return;
      createLogger(request.id).error(`${keyName} is not set — rejecting request (set AGENTGATE_DEV_MODE=true to skip auth)`, {
        event: "auth_misconfigured",
        endpoint: request.url,
        missingKey: keyName,
      });
      reply.status(500).send({ error: "SERVER_MISCONFIGURED", message: `Server misconfigured: ${keyName} not set` });
      return;
    }

    const provided = getHeaderValue(request.headers["x-agentgate-key"]);
    const providedBuf = Buffer.from(provided ?? "");
    const secretBuf = Buffer.from(secret);
    if (!provided || providedBuf.length !== secretBuf.length || !timingSafeEqual(providedBuf, secretBuf)) {
      createLogger(request.id).warn(`${isAdmin ? "Admin" : "REST"} auth failed`, {
        event: "auth_failed",
        endpoint: request.url,
        reason: provided ? "wrong_key" : "missing_key",
      });
      return reply.status(401).send({ error: "UNAUTHORIZED", message: "Invalid or missing x-agentgate-key header" });
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
    const nonce = getNonce(request.headers["x-nonce"]);
    const rawBody = request.body;
    const body = createIdentitySchema.parse(rawBody);
    // Proof-of-possession: verify the caller owns the private key for the public key being registered
    assertSignedRequest(
      body.publicKey,
      nonce,
      request.method,
      request.url,
      request.headers["x-agentgate-timestamp"],
      request.headers["x-agentgate-signature"],
      rawBody,
      { requestId: request.id, endpoint: request.url }
    );
    let result;
    try {
      result = service.createIdentity(body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("UNIQUE constraint failed") || message.includes("SQLITE_CONSTRAINT")) {
        throw new AppError(409, "DUPLICATE_IDENTITY", "This public key is already registered");
      }
      throw err;
    }
    recordNonce(database.db, result.identityId, nonce, request.id);
    reply.status(201).send(result);
  });

  app.post("/v1/bonds/lock", async (request, reply) => {
    const nonce = getNonce(request.headers["x-nonce"]);
    const rawBody = request.body;
    const body = lockBondSchema.parse(rawBody);
    assertSignedRequest(
      service.getIdentityPublicKey(body.identityId),
      nonce,
      request.method,
      request.url,
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
      nonce,
      request.method,
      request.url,
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
    assertSignedRequest(
      service.getIdentityPublicKey(body.resolverId),
      nonce,
      request.method,
      request.url,
      request.headers["x-agentgate-timestamp"],
      request.headers["x-agentgate-signature"],
      rawBody,
      { identityId: body.resolverId, requestId: request.id, endpoint: request.url }
    );
    recordNonce(database.db, body.resolverId, nonce, request.id);
    const executorIdentityId = service.getActionIdentityId(params.actionId);
    if (body.resolverId === executorIdentityId) {
      throw new AppError(403, "SELF_RESOLUTION_FORBIDDEN", "The identity that executed an action cannot resolve it");
    }
    reply.send(service.resolveAction(params.actionId, body));
  });

  if (devMode) {
    app.post("/v1/demo/echo", async (request, reply) => {
      // Nonce presence validated; no identity context so dedup is skipped here
      getNonce(request.headers["x-nonce"]);
      reply.status(200).send({
        ok: true,
        received: request.body
      });
    });
  }

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
    const nonce = getNonce(req.headers["x-nonce"]);
    const rawBody = req.body;
    const body = createMarketSchema.parse(rawBody);
    assertSignedRequest(
      service.getIdentityPublicKey(body.creatorId),
      nonce,
      req.method,
      req.url,
      req.headers["x-agentgate-timestamp"],
      req.headers["x-agentgate-signature"],
      rawBody,
      { identityId: body.creatorId, requestId: req.id, endpoint: req.url }
    );
    recordNonce(database.db, body.creatorId, nonce, req.id);
    service.assertNotBanned(body.creatorId);
    return reply.code(201).send(service.createMarket(body));
  });

  app.post("/markets/:marketId/resolve", async (req, reply) => {
    const nonce = getNonce(req.headers["x-nonce"]);
    const { marketId } = req.params as { marketId: string };
    const rawBody = req.body;
    const body = resolveMarketSchema.parse(rawBody);
    assertSignedRequest(
      service.getIdentityPublicKey(body.resolverId),
      nonce,
      req.method,
      req.url,
      req.headers["x-agentgate-timestamp"],
      req.headers["x-agentgate-signature"],
      rawBody,
      { identityId: body.resolverId, requestId: req.id, endpoint: req.url }
    );
    recordNonce(database.db, body.resolverId, nonce, req.id);
    const creatorId = service.getMarketCreatorId(marketId);
    if (body.resolverId !== creatorId) {
      throw new AppError(403, "NOT_MARKET_CREATOR", "Only the identity that created the market can resolve it");
    }
    service.assertNotBanned(body.resolverId);
    return reply.code(200).send(service.resolveMarket(marketId, body.outcome));
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
    cleanExpiredBuckets: () => service.cleanExpiredBuckets(),
    getDashboardData: () => service.getDashboardData()
  });
}
