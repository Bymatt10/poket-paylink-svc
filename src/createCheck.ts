/**
 * Verificación manual de F3 (createPaylink).
 * CREA UN ENLACE DE PAGO REAL de C$1. Usar solo para pruebas.
 *
 *   npm run create:check
 *   HEADLESS=false npm run create:check   # para ver el navegador
 */
import 'dotenv/config';
import { loadConfig } from './config';
import { createPaylink } from './poket/driver';
import { closeBrowser } from './browser';
import { closeRedis } from './redis';
import { logger } from './logger';

async function main(): Promise<void> {
  loadConfig();
  const amount = Number(process.env.AMOUNT ?? '1');
  const description = process.env.DESC ?? 'prueba api F3';
  const t0 = Date.now();
  const paylink = await createPaylink({ description, amount });
  logger.info({ ms: Date.now() - t0 }, 'createPaylink OK');
  // Imprimir el resultado parseado (incluye la URL completa).
  console.log(JSON.stringify(paylink, null, 2));
}

main()
  .then(async () => {
    await closeBrowser();
    await closeRedis();
    logger.info('OK');
  })
  .catch(async (e) => {
    logger.error({ err: (e as Error).message }, 'createCheck falló');
    await closeBrowser().catch(() => {});
    await closeRedis().catch(() => {});
    process.exitCode = 1;
  });
