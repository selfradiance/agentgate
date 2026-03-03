import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import { ZodError } from "zod";
import { createDatabase } from "./db";
import { AppError } from "./errors";
import { createLogger, generateRequestId } from "./logger";
import {
  createIdentitySchema,
  executeActionSchema,
  lockBondSchema,
  resolveActionSchema
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

function recordNonce(db: Database.Database, identityId: string, nonce: string): void {
  const result = db
    .prepare(`INSERT OR IGNORE INTO nonces (nonce, identity_id, created_at) VALUES (?, ?, ?)`)
    .run(nonce, identityId, new Date().toISOString());

  if (result.changes === 0) {
    throw new AppError(409, "DUPLICATE_NONCE", "Nonce already used");
  }
}

function assertSignedRequest(
  publicKey: string,
  timestampHeader: string | string[] | undefined,
  signatureHeader: string | string[] | undefined,
  body: unknown
) {
  const timestamp = getHeaderValue(timestampHeader);
  const signature = getHeaderValue(signatureHeader);

  if (!timestamp || !signature) {
    throw new AppError(401, "INVALID_SIGNATURE", "Signature headers are required");
  }

  if (!isFreshTimestamp(timestamp)) {
    throw new AppError(401, "INVALID_SIGNATURE", "Signature timestamp is invalid");
  }

  if (!verifyRequestSignature(publicKey, timestamp, body, signature)) {
    throw new AppError(401, "INVALID_SIGNATURE", "Signature is invalid");
  }
}

export type AppInstance = FastifyInstance & {
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
    const body = lockBondSchema.parse(request.body);
    // Verify identity exists before recording nonce (avoids FK violation)
    service.getIdentityPublicKey(body.identityId);
    recordNonce(database.db, body.identityId, nonce);
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
      rawBody
    );
    recordNonce(database.db, body.identityId, nonce);
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
      rawBody
    );
    recordNonce(database.db, identityId, nonce);
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
    sweep: () => service.sweepExpiredActions().slashedCount,
    sweepExpiredActions: () => service.sweepExpiredActions(),
    cleanExpiredNonces: () => service.cleanExpiredNonces(),
    getDashboardData: () => service.getDashboardData()
  });
}
