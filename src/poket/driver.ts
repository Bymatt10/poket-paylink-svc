/**
 * PoketDriver — interacción con el portal vía Playwright.
 *
 * F2: login() con cache de sesión (storageState en Redis) + mutex.
 *     - Reusa context en memoria si la sesión sigue válida.
 *     - Si no, restaura storageState de Redis y lo valida contra el portal.
 *     - Si no hay o está muerto: login en frío (teléfono + código) y guarda
 *       el nuevo storageState en Redis con TTL.
 *     Todo bajo mutex: dos requests concurrentes con sesión vencida NO disparan
 *     dos logins simultáneos.
 *
 * F3 (createPaylink) va en un commit aparte.
 */
import { Mutex } from 'async-mutex';
import type { Browser, BrowserContext } from 'playwright';
import { getBrowser, REAL_UA } from '../browser';
import { getRedis, REDIS_KEYS } from '../redis';
import { loadConfig } from '../config';
import { logger } from '../logger';
import { createPaylinkSelectors, loginSelectors, URLS } from './selectors';
import { parsePaylinkResponse, type PaylinkData } from './rscParser';

const loginMutex = new Mutex();

/** Context de sesión vivo en memoria (uno por proceso). */
let context: BrowserContext | null = null;

async function newContext(
  browser: Browser,
  storageState?: Awaited<ReturnType<BrowserContext['storageState']>>,
): Promise<BrowserContext> {
  return browser.newContext({
    storageState,
    userAgent: REAL_UA,
    viewport: { width: 1280, height: 800 },
    locale: 'es-NI',
  });
}

/**
 * ¿La sesión de este context sigue válida? Navega a /dashboard: si redirige al
 * login o no muestra "Bienvenido," la sesión está muerta.
 */
async function isSessionValid(ctx: BrowserContext): Promise<boolean> {
  const cfg = loadConfig();
  const page = await ctx.newPage();
  try {
    await page.goto(URLS.dashboard(cfg.POKET_BASE_URL), {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });
    // Dar chance a la redirección client-side del portal.
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    if (!page.url().includes('/dashboard')) return false;
    const welcome = await loginSelectors(page)
      .dashboardWelcome.count()
      .catch(() => 0);
    return welcome > 0;
  } catch {
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Login en frío: teléfono/correo (POKET_USER) + código fijo de 6 dígitos
 * (POKET_CODE). Deja la sesión iniciada en el context.
 */
async function coldLogin(ctx: BrowserContext): Promise<void> {
  const cfg = loadConfig();
  const page = await ctx.newPage();
  try {
    await page.goto(URLS.root(cfg.POKET_BASE_URL), {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });
    const s = loginSelectors(page);

    // Un context fresco no tiene dispositivo recordado; debería mostrar el
    // formulario de identificador. Si por algún estado apareciera la pantalla
    // "Enter Poket", saltar a "Iniciar con otro usuario".
    if (await s.useAnotherUser.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await s.useAnotherUser.click();
    }

    // Pantalla 1: identificador.
    // El portal usa react-aria: fill() no dispara la validación (el botón queda
    // disabled). Hay que teclear de verdad con pressSequentially.
    await s.phoneOrEmail.waitFor({ state: 'visible', timeout: 10_000 });
    // NOTA: se asume código de país por defecto (+505). Si POKET_COUNTRY_CODE
    // difiere, hay que seleccionar la opción en el combobox de país (pendiente
    // de recon; ver SELECTORS.md).
    await s.phoneOrEmail.click();
    await s.phoneOrEmail.pressSequentially(cfg.POKET_USER, { delay: 40 });
    if (await s.rememberDevice.isVisible().catch(() => false)) {
      await s.rememberDevice.check().catch(() => {});
    }
    // El botón se habilita al validar el identificador.
    await s.submit.waitFor({ state: 'visible', timeout: 10_000 });
    await s.submit.click();

    // Pantalla 2: código en casillas segmentadas (una por dígito, enmascaradas).
    // Esperar la señal estable de la pantalla del código ANTES de contar las
    // casillas: si no, se lee el estado transitorio (aún la casilla del teléfono)
    // y el conteo sale < 6, cayendo al fallback equivocado.
    await s.codeScreenHeading.waitFor({ state: 'visible', timeout: 10_000 });
    await s.codeBoxes.first().waitFor({ state: 'visible', timeout: 10_000 });
    const digits = cfg.POKET_CODE.split('');
    // El auto-avance de foco no es confiable con keyboard.type; hay que enfocar
    // y teclear cada casilla explícitamente para que react-aria registre el valor.
    const boxCount = await s.codeBoxes.count();
    if (boxCount >= digits.length) {
      for (let i = 0; i < digits.length; i++) {
        await s.codeBoxes.nth(i).click();
        await s.codeBoxes.nth(i).pressSequentially(digits[i]!, { delay: 30 });
      }
    } else {
      // Fallback: input único con auto-avance.
      await s.codeBoxes.first().click();
      await page.keyboard.type(cfg.POKET_CODE, { delay: 80 });
    }

    await s.submit.waitFor({ state: 'visible', timeout: 10_000 });
    await s.submit.click();

    // Confirmar llegada al dashboard.
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
    await s.dashboardWelcome.waitFor({ state: 'visible', timeout: 10_000 });
    logger.info('Login en frío exitoso');
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Garantiza un BrowserContext con sesión válida. Punto de entrada del login.
 * Serializa todo bajo mutex.
 */
export async function ensureSession(): Promise<BrowserContext> {
  return loginMutex.runExclusive(async () => {
    const cfg = loadConfig();
    const browser = await getBrowser();

    // 1. Context vivo en memoria: validar y reusar.
    if (context) {
      if (await isSessionValid(context)) {
        logger.debug('Sesión en memoria válida, reusando');
        return context;
      }
      await context.close().catch(() => {});
      context = null;
    }

    // 2. storageState desde Redis.
    const saved = await getRedis().get(REDIS_KEYS.sessionState);
    if (saved) {
      logger.info('Restaurando sesión desde Redis');
      const ctx = await newContext(browser, JSON.parse(saved));
      if (await isSessionValid(ctx)) {
        context = ctx;
        return context;
      }
      logger.warn('Sesión de Redis inválida/vencida; se re-loguea');
      await ctx.close().catch(() => {});
      await getRedis().del(REDIS_KEYS.sessionState);
    }

    // 3. Login en frío.
    logger.info('Sin sesión cacheada; login en frío');
    const ctx = await newContext(browser);
    await coldLogin(ctx);
    const state = await ctx.storageState();
    await getRedis().set(
      REDIS_KEYS.sessionState,
      JSON.stringify(state),
      'EX',
      cfg.SESSION_TTL_SECONDS,
    );
    context = ctx;
    return context;
  });
}

/**
 * Invalida la sesión (memoria + Redis). Usado por el retry de F3 cuando el
 * fallo huele a sesión vencida.
 */
export async function invalidateSession(): Promise<void> {
  await getRedis().del(REDIS_KEYS.sessionState).catch(() => {});
  if (context) {
    await context.close().catch(() => {});
    context = null;
  }
}

/** Estado de la sesión para /healthz (sin tocar la red). */
export function hasLiveContext(): boolean {
  return context !== null;
}

// ---------------------------------------------------------------------------
// F3 — createPaylink
// ---------------------------------------------------------------------------

export type CreatePaylinkInput = {
  /** Concepto del cobro (1..100 chars). */
  description: string;
  /** Monto en unidades enteras de la moneda (por ahora córdobas). > 0. */
  amount: number;
  /** Solo NIO por ahora (la UI está en córdobas; USD sin reconocer aún). */
  currency?: string;
};

/**
 * Falla que huele a sesión vencida detectada ANTES de disparar el POST del
 * Server Action. Solo esta condición habilita el único reintento — nunca se
 * reintenta después de disparar el POST (evita doble cobro).
 */
export class SessionExpiredError extends Error {
  constructor() {
    super('Sesión vencida antes de crear el enlace');
    this.name = 'SessionExpiredError';
  }
}

/**
 * Teclea `text` en un campo react-aria y verifica que quedó bien. La hidratación
 * del form puede comerse los primeros caracteres; se reintenta hasta 3 veces.
 */
async function typeVerified(
  page: import('playwright').Page,
  locator: import('playwright').Locator,
  text: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await locator.click();
    await locator.fill(''); // limpia el valor previo/parcial
    await locator.pressSequentially(text, { delay: 30 });
    if ((await locator.inputValue()) === text) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`No se pudo escribir "${text}" en el campo tras 3 intentos`);
}

/**
 * Navega al wizard, rellena el paso 1 y avanza al paso 2, **sin confirmar**.
 *
 * Vive aparte porque lo comparten la creación real y {@link selfTest}: si el
 * chequeo de salud recorriera un camino propio, podría pasar en verde mientras
 * el camino que sí cobra está roto. Todo lo que puede romperse cuando Poket
 * cambia el front —la detección de sesión, la hidratación, el tecleo del
 * concepto, la máscara del monto, el botón Continuar— pasa por acá.
 */
async function openWizardAtStepTwo(
  page: import('playwright').Page,
  input: CreatePaylinkInput,
): Promise<void> {
  const cfg = loadConfig();
  const c = createPaylinkSelectors(page);
  const l = loginSelectors(page);

  await page.goto(URLS.createPaylink(cfg.POKET_BASE_URL), {
    waitUntil: 'domcontentloaded',
    timeout: 20_000,
  });

  // Detectar sesión vencida ANTES de tocar el form / disparar el POST.
  try {
    await c.concept.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (e) {
    const onLogin =
      !page.url().includes('/create-paylink') ||
      (await l.enterPoketBtn.isVisible().catch(() => false)) ||
      (await l.phoneOrEmail.isVisible().catch(() => false));
    if (onLogin) throw new SessionExpiredError();
    throw e;
  }

  // Esperar a que el form hidrate: si se teclea demasiado pronto se pierden
  // los primeros caracteres del concepto.
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(400);

  // --- Paso 1: concepto + monto (keystrokes reales; react-aria + máscara) ---
  // Concepto: tecleo verificado (la hidratación puede comerse los primeros chars).
  await typeVerified(page, c.concept, input.description);

  // Monto: arranca en "0"; seleccionar para reemplazar, y el NumberField de
  // react-aria confirma/valida el valor al perder foco (Tab).
  await c.amount.click();
  await c.amount.selectText().catch(() => {});
  await c.amount.pressSequentially(String(input.amount), { delay: 60 });
  await page.keyboard.press('Tab');

  // Assert del monto mostrado antes de continuar: nunca confirmar un monto que
  // no coincide con lo pedido.
  const shown = await c.amount.inputValue();
  const shownNum = Number(shown.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(shownNum) || Math.round(shownNum) !== input.amount) {
    throw new Error(
      `El monto mostrado ("${shown}") no coincide con ${input.amount}; se aborta antes de confirmar`,
    );
  }

  // Continuar → paso 2. Esperar que el botón habilite (react-aria valida async).
  await c.continueBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await c.continueBtn.click({ timeout: 15_000 });
}

/**
 * Recorre el wizard hasta el paso 2 y se detiene **sin tocar "Confirmar"**, que
 * es el único click que acuña un cobro. Valida en vivo lo que `/healthz` no
 * puede: que la sesión sirva, que los selectores matcheen, que la hidratación y
 * la máscara del monto sigan comportándose igual, y que el botón de confirmar
 * exista donde se espera.
 *
 * Pensado para correr en cron: te enterás de que Poket cambió el front antes de
 * que falle el cobro de un cliente real, no después.
 */
export async function selfTest(): Promise<{ ok: true; ms: number }> {
  const started = Date.now();
  const ctx = await ensureSession();
  const page = await ctx.newPage();
  try {
    await openWizardAtStepTwo(page, { description: 'selftest', amount: 1 });
    // Última verificación: el botón que dispararía el cobro está presente.
    // NO se hace click. Acá termina el selftest.
    const c = createPaylinkSelectors(page);
    await c.confirmBtn.waitFor({ state: 'visible', timeout: 10_000 });
    return { ok: true, ms: Date.now() - started };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Un intento de creación (sin lógica de reintento). */
async function attemptCreate(input: CreatePaylinkInput): Promise<PaylinkData> {
  const ctx = await ensureSession();
  const page = await ctx.newPage();
  try {
    const c = createPaylinkSelectors(page);

    await openWizardAtStepTwo(page, input);

    // --- Paso 2: registrar el listener del POST ANTES de confirmar ---
    const resPromise = page.waitForResponse(
      (r) => r.url().includes('/create-paylink') && r.request().method() === 'POST',
      { timeout: 20_000 },
    );
    await c.confirmBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await c.confirmBtn.click();

    const res = await resPromise;
    const body = await res.text();
    try {
      return parsePaylinkResponse(body);
    } catch (e) {
      // Loguear el body RSC crudo SOLO cuando el parseo falla.
      logger.error(
        { err: (e as Error).message, body },
        'Falló el parseo de la respuesta RSC del create-paylink',
      );
      throw e;
    }
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Crea un Enlace de Pago y devuelve sus datos parseados.
 * Un solo reintento, y SOLO si el fallo fue sesión vencida antes del POST.
 */
export async function createPaylink(input: CreatePaylinkInput): Promise<PaylinkData> {
  if (input.currency && input.currency !== 'NIO') {
    throw new Error(`Moneda "${input.currency}" no soportada aún (solo NIO)`);
  }
  try {
    return await attemptCreate(input);
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      logger.warn('Sesión vencida durante createPaylink; re-login y 1 reintento');
      await invalidateSession();
      return await attemptCreate(input);
    }
    throw e;
  }
}
