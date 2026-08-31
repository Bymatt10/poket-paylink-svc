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
import { recordPaylink } from './audit';
import { logger } from './logger';

const IDEM_TTL_SECONDS = 86_400;

/** Tope del campo "concepto" del portal. La marca no puede empujar más allá. */
const CONCEPT_MAX_CHARS = 100;

export type PaylinkResult = PaylinkData & { reused: boolean };

/** Otra request con el mismo idempotencyKey está en vuelo → 409. */
export class IdempotencyInFlightError extends Error {
  constructor(key: string) {
    super(`Ya hay una creación en vuelo para idempotencyKey "${key}"`);
    this.name = 'IdempotencyInFlightError';
  }
}

/** El monto pedido supera el fusible `MAX_AMOUNT` → 400. */
export class AmountLimitError extends Error {
  constructor(amount: number, max: number) {
    super(`El monto ${amount} supera el máximo configurado (${max})`);
    this.name = 'AmountLimitError';
  }
}

/** El cache de idempotencia devolvió algo que no es un enlace usable. */
export class CorruptIdempotencyCacheError extends Error {
  constructor(key: string) {
    super(
      `La entrada de idempotencia "${key}" está corrupta. Verificá el enlace en el ` +
        `portal antes de reintentar con otra clave.`,
    );
    this.name = 'CorruptIdempotencyCacheError';
  }
}

function isPaylinkData(value: unknown): value is PaylinkData {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Partial<PaylinkData>;
  return typeof p.id === 'string' && typeof p.url === 'string' && typeof p.amount === 'number';
}

/**
 * Concepto que se manda al portal, con el `idempotencyKey` marcado. Es lo único
 * nuestro que queda registrado del lado de Poket, así que es lo que permite
 * reconciliar un fallo ambiguo antes de reintentar.
 *
 * Al recortar sacrifica la descripción, nunca la marca.
 */
export function buildConcept(description: string, idempotencyKey?: string): string {
  if (!idempotencyKey || !loadConfig().CONCEPT_MARKER) {
    return description.slice(0, CONCEPT_MAX_CHARS);
  }
  const marker = ` #${idempotencyKey}`;
  if (marker.length >= CONCEPT_MAX_CHARS) return description.slice(0, CONCEPT_MAX_CHARS);
  return description.slice(0, CONCEPT_MAX_CHARS - marker.length) + marker;
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
  const { idempotencyKey, ...rest } = input;
  const cfg = loadConfig();

  // Se valida acá y no solo en el esquema HTTP para que el fusible valga también
  // para el modo asíncrono, que entra por otro camino.
  if (rest.amount > cfg.MAX_AMOUNT) {
    throw new AmountLimitError(rest.amount, cfg.MAX_AMOUNT);
  }

  const paylinkInput: CreatePaylinkInput = {
    ...rest,
    description: buildConcept(rest.description, idempotencyKey),
  };

  const audit = (result: PaylinkData, reused: boolean): void =>
    recordPaylink({
      idempotencyKey,
      paylinkId: result.id,
      url: result.url,
      amount: result.amount,
      currency: result.currency,
      concept: paylinkInput.description,
      reused,
    });

  if (!idempotencyKey) {
    const result = await runCreate(paylinkInput);
    audit(result, false);
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
    // Ya existe: o resultado previo, o una creación en vuelo.
    const existing = await redis.get(key);
    let parsed: unknown = null;
    try {
      parsed = existing ? JSON.parse(existing) : null;
    } catch {
      throw new CorruptIdempotencyCacheError(idempotencyKey);
    }
    if (parsed && (parsed as Record<string, unknown>).status === 'in-flight') {
      throw new IdempotencyInFlightError(idempotencyKey);
    }
    // Nunca devolver un enlace a medias: acá se falla fuerte en vez de acuñar
    // otro, porque el original bien puede existir del lado de Poket.
    if (!isPaylinkData(parsed)) {
      throw new CorruptIdempotencyCacheError(idempotencyKey);
    }
    audit(parsed, true);
    return { ...parsed, reused: true };
  }

  // Lock adquirido: crear y persistir el resultado.
  try {
    const result = await runCreate(paylinkInput);
    await redis.set(key, JSON.stringify(result), 'EX', IDEM_TTL_SECONDS);
    audit(result, false);
    return { ...result, reused: false };
  } catch (e) {
    // Liberar el lock permite reintentar, pero si el fallo ocurrió DESPUÉS de
    // disparar el POST el enlace puede existir igual: de ahí la marca en el
    // concepto, que deja verificarlo en el portal antes de acuñar otro.
    await redis.del(key).catch(() => {});
    logger.warn(
      { idempotencyKey, concept: paylinkInput.description, err: (e as Error).message },
      'Creación fallida: buscá esta marca en el portal (Enlaces de pago) antes de reintentar',
    );
    throw e;
  }
}
