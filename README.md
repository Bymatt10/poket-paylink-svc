# poket-paylink-svc

Microservicio que automatiza la creación de **Enlaces de Pago** en
`portal.pagoconpoket.com` — que no publica API de comercio — y los expone como
una API HTTP con idempotencia, consumible desde n8n, tu backend o lo que sea.

Por dentro maneja un navegador headless (Playwright/Chromium) que loguea en el
portal con **las credenciales de tu propio comercio**, recorre el wizard de
creación y parsea la respuesta **RSC (React Server Components / Flight)** del
Server Action para extraer la URL del enlace.

---

> # ⚠️ ESTE SERVICIO ACUÑA COBROS A TU NOMBRE
>
> **Quien pueda hacerle una petición HTTP puede generar enlaces de pago que
> cobran a tu comercio.** La API key es la única barrera.
>
> - **NUNCA lo expongas a internet.** Solo red interna de Docker o detrás de un firewall.
> - El `docker-compose.prod.yml` **no publica puerto al host** a propósito. No le agregues uno.
> - Generá la API key con `openssl rand -hex 32`. No reuses una de otro servicio.
> - Si el contenedor queda accesible desde afuera, asumí el comercio comprometido:
>   rotá la API key y el código de acceso de Poket.

---

## Qué hay acá que te pueda servir

Aunque no uses Poket, hay dos piezas reutilizables:

- **`src/poket/rscParser.ts`** — parser del wire format de **React Server
  Components (Flight)**. Función pura, con tests, sin browser ni red. Sirve para
  la respuesta de **cualquier Server Action de Next.js**, no solo la de Poket.
- **El patrón completo**: portal sin API → Playwright con sesión cacheada +
  cola serial + idempotencia en Redis + parseo testeable. `src/poket/` está
  aislado del resto justamente para que se pueda cambiar por otro portal.

## Requisitos

- Node.js ≥ 22
- Redis
- Credenciales del comercio en Poket (teléfono/correo + código de acceso fijo)

## Setup

```bash
cp .env.example .env      # y completá POKET_USER, POKET_CODE, POKET_SVC_API_KEY
npm install
npx playwright install chromium   # solo para correr fuera de Docker
```

Generá la API key del servicio:

```bash
openssl rand -hex 32
```

### Variables de entorno

Ver `.env.example`. Las críticas:

| Var | Descripción |
|---|---|
| `POKET_USER` | teléfono (sin código de país) o correo del comercio |
| `POKET_CODE` | código de acceso fijo de 6 dígitos (NO es OTP) |
| `POKET_COUNTRY_CODE` | default `+505` |
| `POKET_SVC_API_KEY` | API key del servicio (header `X-API-Key`) |
| `REDIS_URL` | `redis://localhost:6379` |
| `HEADLESS` | `true` en prod; `false` para debug visual |

La config se valida con zod al arrancar: si falta algo, **el proceso no arranca**.

## Correr

### Local (dev)

```bash
# Redis (si no tenés uno):
docker run -d -p 6379:6379 redis:7-alpine

npm run dev      # tsx watch
# o
npm start        # tsx
```

### Docker

```bash
docker compose up --build
```

`docker-compose.yml` (dev) levanta el servicio + Redis con `ipc: host` (Chromium
necesita /dev/shm) e `init: true` (reap de zombies de Chromium). En dev el puerto
se publica solo en `127.0.0.1:8080` para poder probar con `curl` desde el host.

**Producción** usa `docker-compose.prod.yml`, endurecido:

- **Sin puerto publicado**: el servicio no es visible desde el host ni la LAN.
  El consumidor (otro contenedor) le pega por DNS interno `poket-paylink-svc:8080`
  uniéndose a la red `paylink-edge` (`external: true` en su propio compose).
- **Redis aislado** en la red interna `paylink-backend` (`internal: true`): sin
  internet y sin ser alcanzable por el consumidor. Con contraseña (`REDIS_PASSWORD`)
  y **sin persistencia a disco** (la sesión y la idempotencia son efímeras).
- **Contenedor blindado**: filesystem read-only + tmpfs, `cap_drop: ALL`,
  `no-new-privileges`, y límites de CPU/memoria/PIDs.

---

## API

### `POST /v1/paylinks`

Headers: `X-API-Key: <POKET_SVC_API_KEY>`, `Content-Type: application/json`

```jsonc
{
  "description": "ps5",           // requerido, 1..100 chars
  "amount": 1,                     // requerido, > 0 (entero, córdobas)
  "currency": "NIO",              // opcional, default/único: NIO
  "idempotencyKey": "order-1234"  // opcional pero MUY recomendado
}
```

**201**

```jsonc
{
  "id": "e7693adc-…",
  "url": "https://pagoconpoket.com/payment/90fdba47-…",
  "amount": 1,
  "currency": "NIO",
  "description": "ps5",
  "expirationDate": "2026-07-18T16:25:39.273Z",
  "maxUsages": 1,
  "type": "SingleUse",
  "status": "Created",
  "createdAt": "2026-07-17T16:26:32.541Z",
  "reused": false                 // true si vino del cache de idempotencia
}
```

**Errores** (`{ "error": "code", "message": "…" }`):

| Código | Causa |
|---|---|
| `400` | validación del body |
| `401` | X-API-Key inválida o ausente |
| `409` | idempotencyKey con una creación en vuelo |
| `502` | Poket rechazó (`isSuccess:false`) o RSC ilegible |
| `504` | timeout del portal |

Ejemplo:

```bash
curl -X POST http://localhost:8080/v1/paylinks \
  -H "X-API-Key: $POKET_SVC_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"description":"ps5","amount":1,"idempotencyKey":"order-1234"}'
```

> ⚠️ **Los timeouts del consumidor tienen que ser generosos.** Detrás de este
> endpoint hay un navegador recorriendo un wizard. El camino frío (sin sesión
> cacheada: login completo + wizard) puede pasar del minuto. Un cliente que
> corta a los 60s va a reintentar sobre un enlace que quizá ya se creó.

### `GET /healthz`

```json
{ "status": "ok", "browser": "up", "redis": "up", "session": "valid" }
```

Verifica que el browser respire de verdad (`browser.isConnected()`).

> ⚠️ **`/healthz` no detecta el modo de falla más común.** Si Poket cambia su
> front y los selectores dejan de matchear, esto sigue en verde y
> `POST /v1/paylinks` devuelve `502 rsc_parse_error`. Monitoreá la tasa de 502
> del endpoint, no solo `/healthz`.

### Documentación interactiva (Swagger / OpenAPI)

- **UI**: `GET /docs` — Swagger UI para explorar y probar el endpoint.
- **Spec**: `GET /docs/json` — OpenAPI 3 crudo (para importar en Postman, n8n, etc.).

La doc **solo se sirve si `SWAGGER_PASSWORD` está seteada**, y queda detrás de
Basic Auth. Dejala vacía en producción para deshabilitarla.

---

## Idempotencia

`POST` con el mismo `idempotencyKey` **no crea un segundo enlace**: devuelve el
primero con `reused: true`. Si hay una creación del mismo key en vuelo → `409`.
Clave TTL: 24h. **Usá el id de la orden como `idempotencyKey`.**

Dos límites que conviene conocer:

- **El TTL es 24h y el enlace de Poket también dura ~24h.** Para regenerar un
  enlace vencido hay que pedirlo con una key distinta (p. ej. `<orden>:2`); con
  la misma te devuelve el vencido.
- **Redis corre sin persistencia en el compose de prod.** Un restart borra la
  idempotencia. Y ante un fallo, el servicio libera la key para permitir
  reintentos — si el fallo fue un timeout *después* de disparar el POST, el
  enlace pudo haberse creado igual y el reintento acuña otro.

## Integración con n8n

Nodo **HTTP Request** → `POST http://poket-paylink-svc:8080/v1/paylinks`, con la
API key desde **credenciales de n8n** (no hardcodeada en el workflow — los JSON
se exportan y se comparten), e `idempotencyKey` = id de la orden.

Generá el QR en el consumidor con el paquete `qrcode` a partir de la `url` (no se
scrapea el QR del portal).

---

## Cuando Poket cambie el front

El portal es Next.js con clases generadas; los selectores se rompen en cualquier
deploy de ellos. Todo está centralizado en `src/poket/selectors.ts` y
documentado en **[`SELECTORS.md`](./SELECTORS.md)**, que tiene el mapa completo
del flujo y las trampas de cada campo.

```bash
npx playwright codegen https://portal.pagoconpoket.com/
```

Rehacé el flujo login → crear enlace → confirmar, actualizá `selectors.ts` y
`SELECTORS.md`, y mandá un PR.

## Scripts

| Script | Qué hace |
|---|---|
| `npm test` | tests del parser RSC (sin red) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm start` / `npm run dev` | levanta el servicio |
| `npm run login:check` | verifica login + cache de sesión |
| `npm run create:check` | 🔴 **CREA UN ENLACE DE PAGO REAL de C$1 en tu comercio** |

> 🔴 **`create:check` no es un test: es una llamada real al portal** que deja un
> enlace cobrable de C$1 en tu cuenta. Se borra desde el sidebar →
> "Enlaces de pago". El monto y el concepto se pueden cambiar con `AMOUNT` y
> `DESC`. `npm test` **no** toca la red y es seguro.

## Arquitectura

```
Fastify (HTTP)  →  PaylinkService (idempotencia, cola p-queue)
                →  PoketDriver (Playwright: login + wizard)
                →  rscParser (puro, testeable)
                →  Redis (poket:session:state | poket:idem:<key>)
```

- Un solo `Browser`; un `BrowserContext` por sesión (cacheada vía `storageState`
  en Redis); una `Page` efímera por request, cerrada en `finally`.
- Login serializado con mutex; creación encolada con `p-queue` (concurrency 1).
- Un solo reintento en `createPaylink`, y **solo** por sesión vencida detectada
  antes de disparar el POST (evita doble cobro).

> **No escala horizontalmente tal como está.** El mutex de login es por proceso:
> dos réplicas compartirían el `storageState` en Redis pero se pisarían los
> logins. Hoy es un único punto de falla, y arreglarlo es una contribución
> bienvenida.

---

## Contribuir

Ver [`CONTRIBUTING.md`](./CONTRIBUTING.md). Hay una lista de puntos de entrada
concretos ahí y en la sección "Pendientes" de [`SELECTORS.md`](./SELECTORS.md).

**Soporte best-effort.** Esto depende del HTML de un tercero: puede romperse en
cualquier momento y sin aviso. Los PRs que re-mapeen selectores son
especialmente bienvenidos.

## Aviso legal

Este software automatiza el portal web de Poket usando **las credenciales de tu
propio comercio**, porque Poket no ofrece una API pública. No explota ninguna
vulnerabilidad ni accede a datos ajenos.

Aun así, **automatizar el portal puede ir contra los términos de servicio de
Poket**. Usarlo es decisión y responsabilidad tuya, incluyendo cualquier
consecuencia sobre tu cuenta de comercio. Este proyecto no tiene relación,
respaldo ni afiliación con Poket.

## Licencia

[Apache-2.0](./LICENSE) © 2026 Matthew Reyes
