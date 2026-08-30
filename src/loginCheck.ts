/**
 * Verificación manual de F2 (login + cache de sesión).
 *
 * Uso:
 *   1. Copiar .env.example a .env y llenar POKET_USER / POKET_CODE / POKET_SVC_API_KEY.
 *   2. Tener Redis corriendo (docker: `docker run -p 6379:6379 redis`).
 *   3. Primera corrida  → login en frío ("Sin sesión cacheada; login en frío").
 *      `npm run login:check`
 *   4. Segunda corrida  → reutiliza Redis ("Restaurando sesión desde Redis").
 *      `npm run login:check`
 *   5. `redis-cli del poket:session:state` → vuelve a loguear en frío.
 *
 * Para ver el navegador: HEADLESS=false npm run login:check
 */
import 'dotenv/config';
import { loadConfig } from './config';
import { ensureSession } from './poket/driver';
import { closeBrowser } from './browser';
import { closeRedis } from './redis';
import { logger } from './logger';

async function main(): Promise<void> {
  loadConfig(); // falla temprano si falta env
  const t0 = Date.now();
  const ctx = await ensureSession();
  logger.info({ ms: Date.now() - t0 }, 'ensureSession OK — sesión lista');
  // Prueba extra: la sesión sirve para navegar sin re-login.
  const page = await ctx.newPage();
  await page.goto(`${loadConfig().POKET_BASE_URL}/dashboard`, {
    waitUntil: 'domcontentloaded',
  });
  logger.info({ url: page.url() }, 'Navegación a /dashboard con sesión activa');
  await page.close();
}

main()
  .then(async () => {
    await closeBrowser();
    await closeRedis();
    logger.info('OK');
  })
  .catch(async (e) => {
    logger.error({ err: (e as Error).message }, 'loginCheck falló');
    await closeBrowser().catch(() => {});
    await closeRedis().catch(() => {});
    process.exitCode = 1;
  });
