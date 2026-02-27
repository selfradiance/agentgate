import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { createDatabase } from "./db";
import { AppError } from "./errors";
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

export function createApp(options: AppOptions = {}): FastifyInstance {
  const database = createDatabase(options.dbPath ?? "data/ibp.sqlite");
  const service = new IbpService(database.db);
  const app = Fastify({ logger: false });

  app.addHook("onClose", async () => {
    database.close();
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
    const body = createIdentitySchema.parse(request.body);
    reply.status(201).send(service.createIdentity(body));
  });

  app.post("/v1/bonds/lock", async (request, reply) => {
    const body = lockBondSchema.parse(request.body);
    reply.status(201).send(service.lockBond(body));
  });

  app.post("/v1/actions/execute", async (request, reply) => {
    const rawBody = request.body;
    const body = executeActionSchema.parse(rawBody);
    assertSignedRequest(
      service.getIdentityPublicKey(body.identityId),
      request.headers["x-agentgate-timestamp"],
      request.headers["x-agentgate-signature"],
      rawBody
    );
    reply.status(201).send(service.executeAction(body));
  });

  app.post("/v1/actions/:actionId/resolve", async (request, reply) => {
    const params = request.params as { actionId?: string };
    const rawBody = request.body;
    const body = resolveActionSchema.parse(rawBody);
    if (!params.actionId) {
      throw new AppError(400, "VALIDATION_ERROR", "Action id is required");
    }
    assertSignedRequest(
      service.getActionIdentityPublicKey(params.actionId),
      request.headers["x-agentgate-timestamp"],
      request.headers["x-agentgate-signature"],
      rawBody
    );
    reply.send(service.resolveAction(params.actionId, body));
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

  return app;
}
