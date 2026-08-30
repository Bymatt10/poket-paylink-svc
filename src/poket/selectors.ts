/**
 * TODOS los selectores del portal Poket, centralizados.
 * Fuente: SELECTORS.md (recon F0, 2026-07-17).
 *
 * Preferimos getByRole/getByPlaceholder/getByText sobre CSS: el portal es
 * Next.js con clases generadas que mueren en cada deploy de ellos.
 * Cuando Poket cambie el front, este archivo (y SELECTORS.md) es lo único a
 * tocar. Re-correr: `npx playwright codegen https://portal.pagoconpoket.com/`.
 */
import type { Page } from 'playwright';

export const URLS = {
  root: (base: string) => `${base}/`,
  dashboard: (base: string) => `${base}/dashboard`,
  createPaylink: (base: string) => `${base}/create-paylink`,
} as const;

/** Selectores de las pantallas de login (recordada + en frío). */
export function loginSelectors(page: Page) {
  return {
    // --- Pantalla de sesión recordada ("Enter Poket") ---
    greeting: page.getByText(/¡Hola,/), // presente ⇒ NO logueado aún
    enterPoketBtn: page.getByRole('button', { name: 'Enter Poket' }),
    useAnotherUser: page.getByText('Iniciar con otro usuario'),

    // --- Login en frío, pantalla 1 (identificador) ---
    phoneOrEmail: page.getByPlaceholder('ejemplo@negocio.com o 8888-8888'),
    rememberDevice: page.getByRole('checkbox', {
      name: 'Recordarme en este dispositivo',
    }),
    // Mismo botón ("Entrar a Poket") en pantalla 1 y 2 del login en frío.
    submit: page.getByRole('button', { name: 'Entrar a Poket' }),

    // --- Login en frío, pantalla 2 (código de 6 dígitos) ---
    // Señal estable de que ya estamos en la pantalla del código (evita la
    // carrera con la transición desde la pantalla del identificador).
    codeScreenHeading: page.getByText(/Ingresa el código de acceso/i),
    // La pantalla del código solo tiene estos 6 textbox.
    codeBoxes: page.getByRole('textbox'),

    // --- Dashboard (assert de sesión válida) ---
    dashboardWelcome: page.getByText(/Bienvenido,/i),
  };
}

/** Selectores del wizard de creación de enlace (usados en F3). */
export function createPaylinkSelectors(page: Page) {
  return {
    tabSingleUse: page.getByRole('tab', { name: 'Cobro único' }),
    tabMultiUse: page.getByRole('tab', { name: 'Cobro múltiple' }),
    concept: page.getByPlaceholder('Ej: Promociones Diciembre'),
    // El campo monto expone "Digite la cantidad" como aria-label (no placeholder).
    amount: page.getByRole('textbox', { name: 'Digite la cantidad' }),
    scheduleToggle: page.getByRole('switch', { name: 'Toggle schedule' }),
    continueBtn: page.getByRole('button', { name: 'Continuar' }),
    confirmBtn: page.getByRole('button', { name: 'Confirmar' }),
    clearBtn: page.getByRole('button', { name: 'Limpiar' }),
  };
}
