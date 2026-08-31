/**
 * Jobs del modo asíncrono (`Prefer: respond-async`).
 *
 * Crear un enlace tarda lo que tarda un navegador recorriendo un wizard, y un
 * timeout del consumidor deja la peor ambigüedad posible: no saber si el enlace
 * se creó. Con jobs el resultado queda en Redis con TTL y se puede recuperar
 * después.
 */
import { randomUUID } from 'node:crypto';
import { getRedis, REDIS_KEYS } from './redis';
import { loadConfig } from './config';
import { logger } from './logger';
import { createPaylinkService, type PaylinkResult } from './paylinkService';
import type { CreatePaylinkInput } from './poket/driver';

export type JobStatus = 'pending' | 'done' | 'error';

export type JobError = { error: string; message: string };

export type Job = {
  jobId: string;
  status: JobStatus;
  createdAt: string;
  result?: PaylinkResult;
  error?: JobError;
};

export type ErrorMapper = (e: unknown) => JobError;

const FALLBACK_ERROR: JobError = { error: 'internal_error', message: 'Error interno' };

function isJob(value: unknown): value is Job {
  if (typeof value !== 'object' || value === null) return false;
  const j = value as Partial<Job>;
  return typeof j.jobId === 'string' && typeof j.status === 'string';
}

async function save(job: Job): Promise<void> {
  await getRedis().set(
    REDIS_KEYS.job(job.jobId),
    JSON.stringify(job),
    'EX',
    loadConfig().JOB_TTL_SECONDS,
  );
}

/** Devuelve null si no existe, venció, o quedó ilegible. */
export async function getJob(jobId: string): Promise<Job | null> {
  const raw = await getRedis().get(REDIS_KEYS.job(jobId));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isJob(parsed)) {
      logger.warn({ jobId }, 'Job con forma inesperada en Redis');
      return null;
    }
    return parsed;
  } catch {
    logger.warn({ jobId }, 'Job ilegible en Redis');
    return null;
  }
}

/**
 * Encola una creación y devuelve el job en `pending`. El trabajo corre sobre la
 * misma cola que el modo síncrono, así que async no aumenta la carga sobre el
 * portal: solo evita que el consumidor espere.
 */
export async function enqueuePaylink(
  input: CreatePaylinkInput & { idempotencyKey?: string },
  mapError: ErrorMapper,
): Promise<Job> {
  const job: Job = {
    jobId: randomUUID(),
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  await save(job);

  void runJob(job, input, mapError);
  return job;
}

/** Nunca rechaza: un throw acá sería una unhandled rejection que tumba el proceso. */
async function runJob(
  job: Job,
  input: CreatePaylinkInput & { idempotencyKey?: string },
  mapError: ErrorMapper,
): Promise<void> {
  try {
    const result = await createPaylinkService(input);
    await save({ ...job, status: 'done', result });
    logger.info({ jobId: job.jobId, paylinkId: result.id }, 'Job completado');
  } catch (e) {
    let mapped = FALLBACK_ERROR;
    try {
      mapped = mapError(e);
    } catch {
      /* si el mapeo falla, el genérico igual deja el job cerrado */
    }
    // Persistir el fallo importa: si no, el job queda en `pending` para siempre
    // y el consumidor no distingue "corriendo" de "falló hace una hora".
    try {
      await save({ ...job, status: 'error', error: mapped });
    } catch (saveErr) {
      logger.error(
        { jobId: job.jobId, err: (saveErr as Error).message },
        'No se pudo persistir el fallo del job',
      );
    }
    logger.warn({ jobId: job.jobId, ...mapped }, 'Job falló');
  }
}
