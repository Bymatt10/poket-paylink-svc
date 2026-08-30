/**
 * Logger central (pino). El nivel viene de LOG_LEVEL.
 * Regla: NUNCA loguear POKET_USER ni POKET_CODE. El body RSC crudo solo se
 * loguea cuando el parseo falla (ver driver/paylinkService).
 */
import pino from 'pino';
import { loadConfig } from './config';

export const logger = pino({
  level: loadConfig().LOG_LEVEL,
  // Red de seguridad: si alguien loguea un objeto con estas llaves, se remueven.
  redact: {
    paths: ['POKET_USER', 'POKET_CODE', 'code', 'password', '*.POKET_CODE', '*.code'],
    remove: true,
  },
});
