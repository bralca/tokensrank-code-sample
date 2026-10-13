import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { IngestionService } from '../services/ingestion';
import { determineIngestionMode } from '../services/mode';
import { handleIngest } from './ingestion-handler';

const DEFAULT_INGESTION_BODY_LIMIT_BYTES = 256 * 1024;

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue.trim() === '') {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const ingestionBodyLimitBytes = readPositiveIntegerEnv(
  'INGESTION_BODY_LIMIT_BYTES',
  DEFAULT_INGESTION_BODY_LIMIT_BYTES,
);

function isJsonContentType(contentType: string | undefined): boolean {
  return typeof contentType === 'string'
    && contentType.toLowerCase().split(';', 1)[0]?.trim() === 'application/json';
}

async function requireJsonContentType(request: FastifyRequest, reply: FastifyReply) {
  if (isJsonContentType(request.headers['content-type'])) {
    return;
  }

  request.log.warn({
    event: 'ingestion.unsupported_content_type',
    content_type: request.headers['content-type'] ?? null,
  }, 'Rejected ingestion request with unsupported content type');

  return reply.code(415).send({
    error: {
      code: 'unsupported_media_type',
      message: 'Content-Type must be application/json',
    },
  });
}

export async function scriptSessionsRoutes(fastify: FastifyInstance) {
  const ingestionService = new IngestionService();

  fastify.addHook('onClose', async () => {
    ingestionService.dispose();
  });

  fastify.post(
    '/api/script/sessions',
    {
      bodyLimit: ingestionBodyLimitBytes,
      preValidation: requireJsonContentType,
      preHandler: fastify.requireAccessKey,
    },
    async (request, reply) => {
      return handleIngest(request, reply, 'script', determineIngestionMode('script'), ingestionService);
    },
  );
}
