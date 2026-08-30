/**
 * Capa HTTP (Fastify).
 *
 *   POST /v1/paylinks   (X-API-Key)  → crea un enlace de pago
 *   GET  /healthz                    → estado de browser/redis/sesión
 *
 * Auth con X-API-Key comparada con timingSafeEqual. Este servicio ACUÑA
 * enlaces de cobro: quien le pegue, cobra a tu nombre. NO exponerlo a internet
 * — solo red interna de Docker / firewall.
 */
import 'dotenv/config';
import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { loadConfig } from './config';
import { logger } from './logger';
import { getBrowser, isBrowserUp, closeBrowser } from './browser';
import { getRedis, closeRedis } from './redis';
import { hasLiveContext } from './poket/driver';
import { PoketRejectedError, RscParseError } from './poket/rscParser';
import {
  createPaylinkService,
  drainQueue,
  IdempotencyInFlightError,
} from './paylinkService';

const cfg = loadConfig();

/** Comparación en tiempo constante (rechaza si difiere el largo). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Valida el header X-API-Key contra POKET_SVC_API_KEY. */
function apiKeyValid(provided: string | undefined): boolean {
  return typeof provided === 'string' && safeEqual(provided, cfg.POKET_SVC_API_KEY);
}

/** Valida Basic Auth (usuario + contraseña) para la doc Swagger. */
function basicAuthValid(header: string | undefined): boolean {
  if (!cfg.SWAGGER_PASSWORD) return false;
  if (!header || !header.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  const user = decoded.slice(0, i);
  const pass = decoded.slice(i + 1);
  return safeEqual(user, cfg.SWAGGER_USER) && safeEqual(pass, cfg.SWAGGER_PASSWORD);
}

const paylinkBodySchema = {
  type: 'object',
  required: ['description', 'amount'],
  additionalProperties: false,
  properties: {
    description: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description: 'Concepto del cobro',
    },
    amount: {
      type: 'number',
      exclusiveMinimum: 0,
      description: 'Monto entero en la moneda (por ahora córdobas)',
    },
    currency: { type: 'string', enum: ['NIO'], default: 'NIO' },
    idempotencyKey: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'Recomendado: id de la orden. Evita cobros duplicados en reintentos.',
    },
  },
} as const;

const paylinkResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    url: { type: 'string', description: 'URL pública del enlace de pago' },
    amount: { type: 'number' },
    currency: { type: 'string' },
    description: { type: 'string' },
    expirationDate: { type: 'string' },
    maxUsages: { type: 'number' },
    type: { type: 'string' },
    status: { type: 'string' },
    createdAt: { type: 'string' },
    reused: {
      type: 'boolean',
      description: 'true si vino del cache de idempotencia (no se creó uno nuevo)',
    },
  },
} as const;

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
} as const;

const healthzResponseSchema = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    browser: { type: 'string' },
    redis: { type: 'string' },
    session: { type: 'string' },
  },
} as const;

type PaylinkBody = {
  description: string;
  amount: number;
  currency?: string;
  idempotencyKey?: string;
};

export async function buildServer() {
  const app = Fastify({
    loggerInstance: logger,
    requestIdHeader: 'x-request-id',
    // No quitar props extra silenciosamente: rechazarlas (additionalProperties:false → 400).
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  // La doc Swagger solo se sirve si hay SWAGGER_PASSWORD, y va detrás de Basic Auth.
  const docsEnabled = Boolean(cfg.SWAGGER_PASSWORD);
  if (docsEnabled) {
    // Registrar (con await) ANTES de las rutas: el plugin usa fastify-plugin y
    // engancha un hook onRoute global; sin await el spec sale vacío.
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'poket-paylink-svc',
          description:
            'Crea Enlaces de Pago en Poket y los devuelve como API HTTP interna. ' +
            'Autenticación por header X-API-Key.',
          version: '0.1.0',
        },
        components: {
          securitySchemes: {
            apiKey: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
          },
        },
        tags: [
          { name: 'paylinks', description: 'Enlaces de pago' },
          { name: 'ops', description: 'Operación / salud' },
        ],
      },
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  // Auth:
  //  - /healthz          → público
  //  - /docs*            → Basic Auth (usuario + contraseña)
  //  - resto             → X-API-Key
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if (path === '/healthz') return;

    if (docsEnabled && (path === '/docs' || path.startsWith('/docs/'))) {
      if (!basicAuthValid(req.headers.authorization)) {
        await reply
          .code(401)
          .header('WWW-Authenticate', 'Basic realm="poket-paylink-svc docs"')
          .send({ error: 'unauthorized', message: 'Basic auth requerida para /docs' });
      }
      return;
    }

    const provided = req.headers['x-api-key'];
    if (!apiKeyValid(typeof provided === 'string' ? provided : undefined)) {
      await reply
        .code(401)
        .send({ error: 'unauthorized', message: 'X-API-Key inválida o ausente' });
    }
  });

  app.get(
    '/healthz',
    {
      schema: {
        tags: ['ops'],
        summary: 'Estado del servicio (browser, redis, sesión)',
        response: { 200: healthzResponseSchema },
      },
    },
    async () => {
    let redisUp = false;
    try {
      redisUp = (await getRedis().ping()) === 'PONG';
    } catch {
      redisUp = false;
    }
    const browserUp = isBrowserUp();
    return {
      status: browserUp && redisUp ? 'ok' : 'degraded',
      browser: browserUp ? 'up' : 'down',
      redis: redisUp ? 'up' : 'down',
      session: hasLiveContext() ? 'valid' : 'expired',
    };
  });

  app.post<{ Body: PaylinkBody }>(
    '/v1/paylinks',
    {
      schema: {
        tags: ['paylinks'],
        summary: 'Crear un enlace de pago',
        description:
          'Crea un enlace de pago en Poket y devuelve la URL pública. ' +
          'Enviá idempotencyKey (ej. id de la orden) para evitar cobros duplicados.',
        security: [{ apiKey: [] }],
        body: paylinkBodySchema,
        response: {
          201: paylinkResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
          502: errorResponseSchema,
          504: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { description, amount, currency, idempotencyKey } = req.body;
      const result = await createPaylinkService({
        description,
        amount,
        currency,
        idempotencyKey,
      });
      // Nunca loguear credenciales; sí el id del enlace y si fue reuso.
      req.log.info({ id: result.id, reused: result.reused }, 'Enlace creado');
      await reply.code(201).send(result);
    },
  );

  // Mapeo de errores → contrato { error, message }.
  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { validation?: unknown };
    if (e.validation) {
      reply.code(400).send({ error: 'validation_error', message: e.message });
      return;
    }
    if (e instanceof IdempotencyInFlightError) {
      reply.code(409).send({ error: 'idempotency_in_flight', message: e.message });
      return;
    }
    if (e instanceof PoketRejectedError) {
      reply.code(502).send({ error: 'poket_rejected', message: e.message });
      return;
    }
    if (e instanceof RscParseError) {
      reply
        .code(502)
        .send({ error: 'rsc_parse_error', message: 'No se pudo interpretar la respuesta de Poket' });
      return;
    }
    if (e.name === 'TimeoutError' || /Timeout \d+ms exceeded|timeout/i.test(e.message)) {
      reply
        .code(504)
        .send({ error: 'poket_timeout', message: 'El portal de Poket no respondió a tiempo' });
      return;
    }
    req.log.error({ err: e.message }, 'Error no manejado');
    reply.code(500).send({ error: 'internal_error', message: 'Error interno' });
  });

  return app;
}

async function start() {
  const app = await buildServer();

  // Levantar el browser al arrancar para que /healthz sea significativo.
  await getBrowser().catch((e) => {
    logger.error({ err: (e as Error).message }, 'No se pudo lanzar el browser al arrancar');
  });

  await app.listen({ host: cfg.HOST, port: cfg.PORT });
  logger.info(
    { host: cfg.HOST, port: cfg.PORT, docs: Boolean(cfg.SWAGGER_PASSWORD) },
    'poket-paylink-svc escuchando',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Apagando: drenando cola…');
    try {
      await drainQueue();
      await app.close();
      await closeBrowser();
      await closeRedis();
    } catch (e) {
      logger.error({ err: (e as Error).message }, 'Error durante el shutdown');
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Arrancar solo si se ejecuta directamente (no al importar en tests).
// Nota: bajo tsx, import.meta.url no coincide con argv[1]; se chequea por nombre.
const invoked = process.argv[1] ?? '';
const isMain = /(?:^|[\\/])server\.(ts|js)$/.test(invoked);
if (isMain) {
  start().catch((e) => {
    logger.error({ err: (e as Error).message }, 'Fallo al arrancar');
    process.exit(1);
  });
}
