/**
 * PaylinkService — idempotencia, cola de concurrencia y orquestación sobre
 * driver.createPaylink().
 *
 * Idempotencia (Redis): SET poket:idem:<key> <json> NX EX 86400
 *   - NX gana            → creamos; al terminar guardamos el resultado.
 *   - ya existe (result) → devolvemos ese, reused:true.
 *   - ya existe (in-flight) → 409 (otra request en vuelo con el mismo key).
 *
 * Cola: p-queue con concurrency = MAX_CONCURRENCY (default 1). El portal no
 * está pensado para tráfico de bot: mejor encolar que arriesgar bloqueo.
 */
import PQueue from 'p-queue';
import { getRedis, REDIS_KEYS } from './redis';
import { createPaylink, type CreatePaylinkInput } from './poket/driver';
import type { PaylinkData } from './poket/rscParser';
import { loadConfig } from './config';

const IDEM_TTL_SECONDS = 86_400;

export type PaylinkResult = PaylinkData & { reused: boolean };

/** Otra request con el mismo idempotencyKey está en vuelo → 409. */
export class IdempotencyInFlightError extends Error {
  constructor(key: string) {
    super(`Ya hay una creación en vuelo para idempotencyKey "${key}"`);
    this.name = 'IdempotencyInFlightError';
  }
}

let queue: PQueue | null = null;
function getQueue(): PQueue {
  if (!queue) queue = new PQueue({ concurrency: loadConfig().MAX_CONCURRENCY });
  return queue;
}

/** Drena la cola (para el shutdown ordenado). */
export async function drainQueue(): Promise<void> {
  await getQueue().onIdle();
}

async function runCreate(input: CreatePaylinkInput): Promise<PaylinkData> {
  const result = await getQueue().add(() => createPaylink(input));
  // p-queue tipa add() como T | void; acá siempre resuelve a PaylinkData.
  return result as PaylinkData;
}

export async function createPaylinkService(
  input: CreatePaylinkInput & { idempotencyKey?: string },
): Promise<PaylinkResult> {
  const { idempotencyKey, ...paylinkInput } = input;

  if (!idempotencyKey) {
    const result = await runCreate(paylinkInput);
    return { ...result, reused: false };
  }

  const redis = getRedis();
  const key = REDIS_KEYS.idem(idempotencyKey);

  // Intentar adquirir el lock de idempotencia.
  const acquired = await redis.set(
    key,
    JSON.stringify({ status: 'in-flight', at: Date.now() }),
    'EX',
    IDEM_TTL_SECONDS,
    'NX',
  );

  if (acquired === null) {
    // Ya existe: o resultado previo, o en vuelo.
    const existing = await redis.get(key);
    const parsed = existing ? (JSON.parse(existing) as Record<string, unknown>) : null;
    if (parsed && parsed.status === 'in-flight') {
      throw new IdempotencyInFlightError(idempotencyKey);
    }
    return { ...(parsed as unknown as PaylinkData), reused: true };
  }

  // Lock adquirido: crear y persistir el resultado.
  try {
    const result = await runCreate(paylinkInput);
    await redis.set(key, JSON.stringify(result), 'EX', IDEM_TTL_SECONDS);
    return { ...result, reused: false };
  } catch (e) {
    // Liberar el lock in-flight para permitir reintentos posteriores.
    await redis.del(key).catch(() => {});
    throw e;
  }
}
