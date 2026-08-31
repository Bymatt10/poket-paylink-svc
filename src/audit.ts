/**
 * Rastro de auditoría de los enlaces acuñados.
 *
 * El estado del servicio es efímero (sesión y claves con TTL) y el registro real
 * vive en Poket. Esto es lo que contesta, ante un incidente, qué se acuñó,
 * cuándo, por cuánto y con qué clave.
 */
import { appendFile } from 'node:fs/promises';
import { loadConfig } from './config';
import { logger } from './logger';

export type AuditEntry = {
  at: string;
  event: 'paylink.created';
  idempotencyKey?: string;
  paylinkId: string;
  url: string;
  amount: number;
  currency: string;
  concept: string;
  reused: boolean;
};

/**
 * Asienta un enlace creado. Nunca lanza ni bloquea: el enlace ya existe del lado
 * de Poket, y perder la respuesta por un fallo de auditoría sería peor que
 * perder la línea de log.
 */
export function recordPaylink(entry: Omit<AuditEntry, 'at' | 'event'>): void {
  const full: AuditEntry = { at: new Date().toISOString(), event: 'paylink.created', ...entry };
  logger.info(full, 'paylink.created');

  const path = loadConfig().AUDIT_LOG_PATH;
  if (!path) return;

  void appendFile(path, JSON.stringify(full) + '\n', 'utf8').catch((e: unknown) => {
    logger.warn(
      { err: (e as Error).message, path },
      'No se pudo escribir el archivo de auditoría (¿falta el volumen?)',
    );
  });
}
