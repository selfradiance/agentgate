import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { createDatabase } from "./db";
import { AppError } from "./errors";
import {
  createIdentitySchema,
  createOfferSchema,
  lockBondSchema,
  resolveOfferSchema
} from "./schemas";
import { IbpService } from "./service";

export interface AppOptions {
  dbPath?: string;
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

  app.post("/v1/offers", async (request, reply) => {
    const body = createOfferSchema.parse(request.body);
    reply.status(201).send(service.createOffer(body));
  });

  app.post("/v1/offers/:id/resolve", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = resolveOfferSchema.parse(request.body);
    if (!params.id) {
      throw new AppError(400, "VALIDATION_ERROR", "Offer id is required");
    }
    reply.send(service.resolveOffer(params.id, body));
  });

  app.get("/v1/identities/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    if (!params.id) {
      throw new AppError(400, "VALIDATION_ERROR", "Identity id is required");
    }
    reply.send(service.getIdentitySummary(params.id));
  });

  return app;
}
