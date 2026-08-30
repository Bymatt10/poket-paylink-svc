# SELECTORS.md — Mapa del portal de Poket

> Recon original: **2026-07-17** sobre `https://portal.pagoconpoket.com`.
>
> **Este es el documento que hay que actualizar cuando Poket cambie su front.**
> El portal es Next.js con clases generadas, así que los selectores se rompen en
> cualquier deploy de ellos. Todos viven en `src/poket/selectors.ts`; acá está el
> porqué de cada uno y el mapa del flujo completo.
>
> **Cómo re-correr el recon:**
> ```bash
> npx playwright codegen https://portal.pagoconpoket.com/
> ```
> Repetí el flujo login → crear enlace → confirmar, actualizá este archivo y
> `src/poket/selectors.ts`, y mandá el PR. Poné la fecha del recon arriba.
>
> **Señal de que los selectores están rotos:** `/healthz` en verde pero
> `POST /v1/paylinks` devolviendo `502 rsc_parse_error` o `504`.

---

## Autenticación

El portal tiene **dos** pantallas de entrada según si el dispositivo fue
recordado o no. El driver siempre parte de un `BrowserContext` fresco o
restaurado, así que el camino normal es el login en frío.

### Pantalla de sesión recordada ("Enter Poket")

Aparece cuando el `storageState` restaurado tiene el dispositivo recordado.

- Título: `¡Hola, <nombre del comercio>!`
- Subtítulo: `Haz clic en "Entrar a Poket" para iniciar sesión.`
- Teléfono del comercio precargado (solo display).

| Elemento | Selector recomendado |
|---|---|
| Botón entrar | `getByRole('button', { name: 'Enter Poket' })` |
| Cambiar usuario | `getByText('Iniciar con otro usuario')` (link) |
| Saludo (assert) | `getByText(/¡Hola,/)` presente ⇒ **NO** logueado aún |

> **Logout no borra el dispositivo recordado.** El modal de "Salir"
> (`¿Ya terminaste por hoy?`) guarda los datos de acceso: al volver aparece esta
> pantalla, no el login completo. Para forzar el login en frío hay que pasar por
> **"Iniciar con otro usuario"**.

### Login en frío — pantalla 1 (identificador)

Título: **"¡Que bueno verte aquí!"**

| Elemento | Selector recomendado | Notas |
|---|---|---|
| Código de país | combobox (botón `Select an option`) | observados: **+505** (default), +506, +504 |
| **Celular o correo** (`POKET_USER`) | `getByPlaceholder('ejemplo@negocio.com o 8888-8888')` | `type="tel"`; acepta teléfono **o** email |
| Recordar dispositivo | `getByRole('checkbox', { name: 'Recordarme en este dispositivo' })` | marcarlo crea el estado recordado que cachea `storageState` |
| Entrar | `getByRole('button', { name: 'Entrar a Poket' })` | disabled hasta llenar el identificador |

> ⚠️ **El driver asume el código de país por defecto (+505).** Si tu comercio
> usa otro, hay que seleccionarlo en el combobox — no está implementado, ver
> "Pendientes" al final.

### Login en frío — pantalla 2 (código de acceso)

Título: **"Ingresa el código de acceso que creaste para tu comercio"**.

El `POKET_CODE` es un **valor fijo definido por el comercio, no un OTP** — es lo
que hace automatizable el login. Son 6 dígitos.

- **Input segmentado de 6 casillas** (6 `textbox` `type="text"`, un dígito cada
  una, con auto-avance al tipear).
- Link `¿Aún no tienes un código? Haz clic aquí`.
- Botón `Entrar a Poket` (`type="submit"`, disabled hasta completar los 6).

| Elemento | Selector recomendado | Notas |
|---|---|---|
| Casillas de código | `page.getByRole('textbox')` → 6 elementos (nth 0..5) | un dígito por casilla |
| Entrar | `getByRole('button', { name: 'Entrar a Poket' })` | `type="submit"` |
| Regresar | `getByRole('button', { name: 'Regresar' })` | |

**Secuencia que usa el driver:**

1. `pressSequentially(POKET_USER)` en el campo de identificador — **no `fill()`**:
   el portal usa react-aria y `fill()` no dispara la validación, el botón queda
   disabled.
2. Marcar "Recordarme en este dispositivo".
3. Click "Entrar a Poket" → pantalla de código.
4. **Esperar el título de la pantalla del código ANTES de contar las casillas.**
   Si se cuenta antes, se lee el estado transitorio (todavía el campo del
   teléfono), el conteo da < 6 y se cae al fallback equivocado.
5. Enfocar y teclear **cada casilla explícitamente**: el auto-avance no es
   confiable con `keyboard.type`.
6. Click "Entrar a Poket" → dashboard.
7. Capturar `context.storageState()` y guardarlo en Redis.

**Validación de sesión:** navegar a `/dashboard`. Si redirige a `/` y aparece
"Enter Poket" / "¡Hola,", la sesión murió → re-login. Si se ve el saludo
`Bienvenido, <COMERCIO>!`, la sesión es válida.

---

## Navegación

| Acción | Cómo |
|---|---|
| URL base | `https://portal.pagoconpoket.com` |
| Dashboard | `/dashboard` |
| **Crear enlace** | `/create-paylink` (navegar directo funciona) |
| Botón en dashboard | `getByRole('button', { name: 'Crear enlace' })` |
| Listado de enlaces | sidebar "Enlaces de pago" |

> ⚠️ Con **sesión vencida**, `/create-paylink` redirige a `/` (pantalla "Enter
> Poket") en vez de al wizard. El driver detecta esto **antes** de tocar el
> formulario y lanza `SessionExpiredError`, que es la única condición que
> habilita el reintento.

---

## Wizard de creación — 3 pasos, la URL NO cambia entre pasos

Stepper (columna izquierda): **Configurar enlace → Confirmar → Compartir**.

### Paso 1 — "Configurar enlace"

Título: **"Crea tu próximo Enlace de Pago"**.

| Campo | Selector recomendado | Notas |
|---|---|---|
| Tab "Cobro único" | `getByRole('tab', { name: 'Cobro único' })` | activo por defecto = `SingleUse` |
| Tab "Cobro múltiple" | `getByRole('tab', { name: 'Cobro múltiple' })` | multi-uso **sí** es configurable |
| **Concepto** | `getByPlaceholder('Ej: Promociones Diciembre')` | label "Agrega un concepto"; `type="text"` |
| Selector de moneda | `getByRole('button', { name: 'Seleccionar moneda' })` | combobox con `value="NIO"` (muestra "C$") |
| **Monto** | `getByRole('textbox', { name: 'Digite la cantidad' })` | "Digite la cantidad" es **aria-label, NO placeholder** |
| Toggle vencimiento | `getByRole('switch', { name: 'Toggle schedule' })` | off por defecto ⇒ 24h |
| Continuar | `getByRole('button', { name: 'Continuar' })` | disabled hasta llenar concepto + monto |
| Limpiar | `getByRole('button', { name: 'Limpiar' })` | |

#### ⚠️ La máscara del campo monto

- Se muestra como **`C$ 0.00`**; su `value` en el DOM arranca en `"0"`.
- Es un **NumberField de react-aria**. La secuencia que funciona:
  1. `click()` el campo,
  2. `selectText()` para seleccionar el `"0"` por defecto — si no, teclear
     antepone y queda `"01"`,
  3. `pressSequentially(String(amount))` (keystrokes reales; `fill()` no valida),
  4. **`keyboard.press('Tab')`** para blur → react-aria confirma el valor y
     **recién ahí se habilita "Continuar"**.
- Escribir `1` da **C$1.00**: interpreta enteros, no centavos.
- El driver hace **assert del valor mostrado** antes de confirmar y aborta si no
  coincide con lo pedido. No lo quites: confirmar un monto distinto al pedido
  acuña un cobro equivocado que no se puede deshacer.
- **Decimales no probados** (solo se validó con enteros). Ver "Pendientes".

#### ⚠️ La hidratación del formulario

Teclear el **concepto** apenas carga `/create-paylink` **pierde los primeros
caracteres** (`"prueba"` → `"eba"`). El driver espera `networkidle` + ~400 ms, y
además `typeVerified()` reintenta hasta 3 veces verificando el `inputValue()`.

#### Moneda

Combobox con `value="NIO"` mostrado como "C$". Hay una segunda opción vacía;
**no se confirmó si es USD**. En el paso Confirmar se muestra una conversión
informativa ("Monto en dólares: U$… | Tasa de cambio C$…"), pero la moneda del
cobro es NIO. El servicio rechaza cualquier `currency` distinta de `NIO`.

### Paso 2 — "Confirmar"

Título: **"Estás por crear un enlace de pago único"**. Resumen mostrado:

- Monto + conversión informativa a USD y tasa de cambio.
- **Descripción** (el concepto del paso 1).
- **Cantidad de usos**: "1 uso", con botón "Editar" → `maxUsages` es editable acá.
- **Fecha de expiración**: default **+24h** respecto a la creación, con botón
  "Editar" → también editable.

| Elemento | Selector recomendado |
|---|---|
| **Confirmar (dispara el POST)** | `getByRole('button', { name: 'Confirmar' })` |
| Regresar | `getByRole('button', { name: 'Regresar' })` |
| Editar usos | dentro de la tarjeta "Cantidad de usos" |
| Editar expiración | dentro de la tarjeta "Fecha de expiración" |

#### 🎯 Dónde se dispara el Server Action

En el **click de "Confirmar" (paso 2)**:

```
POST https://portal.pagoconpoket.com/create-paylink   → 200
```

El "Continuar" del paso 1 es solo transición client-side, **no** hace POST.

El cuerpo de esa respuesta es **RSC (React Server Components / Flight)** y trae
el payload útil: `isSuccess`, `data.url` completa, `id`, `amount`,
`expirationDate`, `maxUsages`, `type`, `status`, `createdAt`. Lo captura:

```ts
page.waitForResponse(r =>
  r.url().includes('/create-paylink') && r.request().method() === 'POST'
).then(r => r.text())
```

> ⚠️ El listener se registra **antes** de hacer click en Confirmar. Al revés se
> pierde la respuesta.

El parseo vive en `src/poket/rscParser.ts` — función pura, con tests, sin
browser ni red. Es lo primero que hay que revisar si el formato cambia.

### Paso 3 — "Compartir"

Título: **"Enlace de Pago creado por C$…"** + tarjeta "Comparte tu enlace".

| Elemento | Notas |
|---|---|
| URL mostrada | **truncada por CSS** (`https://pagoconpoket.com/payment/xxxxxxxx-xxxx-40a9...`) |
| **URL completa** | sí está en el DOM; la truncación es puramente visual |
| Botón "Copiar" | copia la URL completa al clipboard |
| "Mostrar código QR" | genera el QR — **no scrapearlo**, generalo en el consumidor con `qrcode` a partir de la `url` |
| "Nuevo enlace" | reinicia el wizard |
| "Volver al inicio" | vuelve al dashboard |

**La fuente de verdad es la RSC, no el DOM**: trae `id`, `amount`,
`expirationDate`, `status` y no solo la URL, en un único parseo testeable. La
URL del DOM sirve como fallback o verificación cruzada si la RSC cambiara de
forma.

---

## Pendientes / no explorado

Buenos puntos de entrada si querés contribuir:

1. **Código de país distinto de +505** — el driver asume el default. Falta
   seleccionar la opción en el combobox cuando `POKET_COUNTRY_CODE` difiere.
2. **Montos con decimales** — la máscara solo se validó con enteros. Hoy el
   servicio acepta cualquier `amount > 0`, pero el consumidor debería mandar
   enteros hasta que esto se confirme.
3. **Moneda USD** — verificar si el combobox realmente ofrece otra opción.
4. **`maxUsages` y `expirationDate` configurables** — ambos son editables en el
   paso 2 del wizard, pero la API no los expone todavía.
