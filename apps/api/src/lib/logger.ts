import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import pino, { type LoggerOptions } from 'pino';
import pinoHttp from 'pino-http';

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';
const isPrettyEnabled = !isProduction && !isTest;

export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'request.headers.authorization',
      'request.headers.cookie',
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      'headers.cookie',
      '*.password',
      '*.access_token',
      '*.refresh_token',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
  ...(isPrettyEnabled
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
            singleLine: true,
          },
        },
      }
    : {}),
};

export const logger = pino(loggerOptions);

export const pinoHttpLogger = pinoHttp({
  logger,
  autoLogging: false,
  customAttributeKeys: {
    req: 'request',
    res: 'response',
  },
});

const httpLoggerPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onResponse', async (request, reply) => {
    const auth = (request as {
      auth?: {
        userId?: string;
        profile?: {
          user_id?: string;
        };
      };
    }).auth;
    const userId = auth?.userId ?? auth?.profile?.user_id;

    request.log.info({
      event: 'request.complete',
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      status_code: reply.statusCode,
      latency_ms: Number(reply.elapsedTime.toFixed(3)),
      ...(userId ? { user_id: userId } : {}),
    }, 'Request completed');
  });
};

export const httpLogger = fp(httpLoggerPlugin, {
  name: 'tokensrank-http-logger',
});
