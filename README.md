# poket-paylink-svc

API HTTP para crear **Enlaces de Pago** de [Poket](https://pagoconpoket.com)
desde tu backend, n8n, o lo que uses.

Poket no publica una API de comercio: los enlaces se crean a mano en
`portal.pagoconpoket.com`. Este servicio automatiza ese portal con un navegador
headless y te deja un endpoint normal contra el que programar.

```bash
curl -X POST http://localhost:8080/v1/paylinks \
  -H "X-API-Key: $POKET_SVC_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"description":"Orden #1234","amount":350,"idempotencyKey":"orden-1234"}'
```

```json
{ "url": "https://pagoconpoket.com/payment/90fdba47-…", "id": "e7693adc-…", "amount": 350, "reused": false }
```

## Cómo funciona

```
Fastify (HTTP)  →  PaylinkService (idempotencia + cola)
                →  PoketDriver (Playwright: login + wizard del portal)
                →  rscParser (parsea la respuesta del Server Action)
                →  Redis (sesión cacheada + claves de idempotencia)
```

Loguea en el portal con las credenciales de **tu propio comercio**, recorre el
wizard de creación, intercepta el POST del Server Action y parsea su respuesta
**RSC (React Server Components / Flight)** para sacar la URL del enlace.

La sesión se cachea en Redis (`storageState` de Playwright), así que solo el
primer request paga el costo del login.

---

## Quickstart

Necesitás **Node.js ≥ 22**, **Redis** y las credenciales de tu comercio en Poket.

```bash
git clone https://github.com/Bymatt10/poket-paylink-svc.git
cd poket-paylink-svc
npm install
npx playwright install chromium

cp .env.example .env
```

Completá en `.env`:

```bash
POKET_USER=88887777                                  # tu teléfono o correo del comercio
POKET_CODE=123456                                    # tu código de acceso de 6 dígitos
POKET_SVC_API_KEY=<pegá acá: openssl rand -hex 32>   # la key con la que llamás a ESTE servicio
```

Levantá Redis y el servicio:

```bash
docker run -d -p 6379:6379 redis:7-alpine    # si no tenés uno
npm run dev
```

Verificá que respire y creá tu primer enlace:

```bash
curl localhost:8080/healthz
# {"status":"ok","browser":"up","redis":"up","session":"expired"}

curl -X POST localhost:8080/v1/paylinks \
  -H "X-API-Key: $POKET_SVC_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"description":"prueba","amount":1,"idempotencyKey":"prueba-1"}'
```

> El primer request tarda más (login en frío + wizard). Los siguientes reusan la
> sesión cacheada. Y sí: ese enlace de C$1 es **real** — borralo desde el portal,
> sidebar → "Enlaces de pago".

## Configuración

Todas las variables, validadas con zod al arrancar. Si falta una requerida el
proceso **no arranca** y te dice cuál (sin imprimir su valor).

| Variable | Requerida | Default | Qué es |
|---|:--:|---|---|
| `POKET_USER` | ✅ | — | Teléfono (sin código de país) o correo del comercio |
| `POKET_CODE` | ✅ | — | Código de acceso fijo de 6 dígitos del comercio (no es OTP) |
| `POKET_SVC_API_KEY` | ✅ | — | API key para llamar a este servicio. Mínimo 16 chars |
| `POKET_COUNTRY_CODE` | | `+505` | Código de país del teléfono |
| `POKET_BASE_URL` | | `https://portal.pagoconpoket.com` | Base del portal |
| `REDIS_URL` | | `redis://localhost:6379` | Conexión a Redis |
| `REDIS_PASSWORD` | | — | Solo la usa el compose de prod para armar `REDIS_URL` |
| `PORT` | | `8080` | Puerto HTTP |
| `HOST` | | `0.0.0.0` | Bind. `127.0.0.1` en local para no exponer a la LAN |
| `LOG_LEVEL` | | `info` | `fatal`…`trace`, `silent` |
| `SESSION_TTL_SECONDS` | | `3600` | TTL de la sesión cacheada en Redis |
| `MAX_CONCURRENCY` | | `1` | Creaciones en paralelo. **Dejalo en 1** (ver Límites) |
| `MAX_AMOUNT` | | `100000` | **Fusible**: monto máximo acuñable, en córdobas. Por encima → `400` |
| `CONCEPT_MARKER` | | `true` | Marca el `idempotencyKey` dentro del concepto (ver [Reconciliación](#reconciliación-cuando-no-sabés-si-se-creó)) |
| `AUDIT_LOG_PATH` | | — | Archivo JSONL de auditoría. Sin él, el rastro va a stdout |
| `JOB_TTL_SECONDS` | | `86400` | TTL de los jobs del modo asíncrono |
| `HEADLESS` | | `true` | `false` para ver el navegador y depurar |
| `SWAGGER_USER` | | `admin` | Usuario de la doc |
| `SWAGGER_PASSWORD` | | — | **Si está vacía, `/docs` no se sirve.** Si la ponés, queda tras Basic Auth |

### Secretos por archivo

En producción, en vez de dejar las credenciales en un `.env` plano, podés apuntar
a un archivo con el valor — sirve directo con **Docker secrets** o Kubernetes:

```bash
POKET_CODE_FILE=/run/secrets/poket_code
POKET_SVC_API_KEY_FILE=/run/secrets/poket_svc_api_key
```

Aplica a `POKET_USER`, `POKET_CODE`, `POKET_SVC_API_KEY`, `REDIS_PASSWORD` y
`SWAGGER_PASSWORD`. Si definís las dos formas, gana la variable directa.

---

## API

Todos los endpoints salvo `/healthz` piden el header `X-API-Key`.

### `POST /v1/paylinks`

```jsonc
{
  "description": "Orden #1234",   // requerido, 1..100 chars. Lo ve quien paga
  "amount": 350,                   // requerido, > 0. Entero, en córdobas
  "currency": "NIO",              // opcional. Único valor soportado
  "idempotencyKey": "orden-1234"  // opcional, muy recomendado. Máx 200 chars
}
```

**`201 Created`**

```jsonc
{
  "id": "e7693adc-…",                                     // id del enlace en Poket
  "url": "https://pagoconpoket.com/payment/90fdba47-…",   // esto es lo que le mandás al cliente
  "amount": 350,
  "currency": "NIO",
  "description": "Orden #1234",
  "expirationDate": "2026-07-18T16:25:39.273Z",           // ~24h desde la creación
  "maxUsages": 1,
  "type": "SingleUse",
  "status": "Created",
  "createdAt": "2026-07-17T16:26:32.541Z",
  "reused": false                                          // true = vino del cache de idempotencia
}
```

**Errores** — todos con la forma `{ "error": "codigo", "message": "…" }`:

| Código | `error` | Qué pasó | ¿Reintentable? |
|---|---|---|---|
| `400` | `validation_error` | El body no cumple el esquema | ❌ corregí el request |
| `401` | `unauthorized` | `X-API-Key` ausente o inválida | ❌ |
| `409` | `idempotency_in_flight` | Otra request con el mismo `idempotencyKey` está corriendo | ✅ esperá y reintentá |
| `502` | `poket_rejected` | Poket rechazó la creación (`isSuccess:false`) | ⚠️ revisá el `message` |
| `502` | `rsc_parse_error` | No se pudo interpretar la respuesta del portal | ❌ ver Troubleshooting |
| `504` | `poket_timeout` | El portal no respondió a tiempo | ⚠️ ver la nota de abajo |

> ⚠️ **Ante un `504`, reintentá con el MISMO `idempotencyKey`** — y si querés
> certeza, verificá primero contra el portal: ver
> [Reconciliación](#reconciliación-cuando-no-sabés-si-se-creó).

### Modo asíncrono

Mandá el header **`Prefer: respond-async`** y en vez de esperar recibís un `202`
con un `jobId`:

```bash
curl -X POST localhost:8080/v1/paylinks \
  -H "X-API-Key: $POKET_SVC_API_KEY" \
  -H 'Prefer: respond-async' \
  -H 'Content-Type: application/json' \
  -d '{"description":"Orden #1234","amount":350,"idempotencyKey":"orden-1234"}'
```

```jsonc
// 202 Accepted   ·   Location: /v1/paylinks/jobs/d919e9a5-…
{ "jobId": "d919e9a5-…", "status": "pending", "createdAt": "2026-08-31T00:08:27.175Z" }
```

**Usalo si podés.** Elimina la clase entera de bugs por timeout: el resultado
—o el error— queda guardado con TTL, así que podés recuperarlo aunque se te
corte la conexión. Con el modo síncrono, un timeout te deja sin saber si el
enlace se creó.

> El POST **sigue siendo síncrono por default**: el modo async es opt-in, así que
> los consumidores existentes no cambian.

### `GET /v1/paylinks/jobs/:jobId`

```jsonc
{ "jobId": "d919e9a5-…", "status": "done", "createdAt": "…", "result": { /* el enlace */ } }
{ "jobId": "d919e9a5-…", "status": "error", "error": { "error": "poket_timeout", "message": "…" } }
```

`status` es `pending`, `done` o `error`. Los errores usan el **mismo contrato**
que el modo síncrono. `404` si el job no existe o ya venció.

### `GET /v1/selftest`

Recorre el wizard del portal hasta el paso 2 y **se detiene sin confirmar** — no
acuña ningún cobro. Valida en vivo lo que `/healthz` no puede: que la sesión
sirva, que los selectores sigan matcheando, y que la hidratación y la máscara del
monto se comporten igual.

```json
{ "ok": true, "ms": 4820 }
```

`503` con `{ ok: false, error, message }` si algo se rompió. **Corrélo en cron**
y te enterás de que Poket cambió el front antes de que le falle a un cliente:

```cron
*/15 * * * * curl -fsS -H "X-API-Key: $KEY" http://poket-paylink-svc:8080/v1/selftest || avisar
```

### `GET /healthz`

Público, sin API key. Útil como healthcheck de contenedor.

```json
{ "status": "ok", "browser": "up", "redis": "up", "session": "valid" }
```

`status` es `degraded` si el browser o Redis están caídos.

### `GET /docs` · `GET /docs/json`

Swagger UI y el spec OpenAPI 3. **Solo se sirven si definís `SWAGGER_PASSWORD`**,
y quedan detrás de Basic Auth (`SWAGGER_USER` / `SWAGGER_PASSWORD`).

---

## Ejemplos de cliente

<details open>
<summary><b>Node.js</b></summary>

```js
async function crearEnlace({ descripcion, monto, ordenId }) {
  const res = await fetch('http://poket-paylink-svc:8080/v1/paylinks', {
    method: 'POST',
    headers: {
      'X-API-Key': process.env.POKET_SVC_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      description: descripcion,
      amount: monto,
      idempotencyKey: ordenId,      // el id de tu orden: nunca dos enlaces por orden
    }),
    signal: AbortSignal.timeout(120_000),   // el camino frío puede pasar del minuto
  });
  if (!res.ok) {
    const { error, message } = await res.json();
    throw new Error(`paylink ${res.status} ${error}: ${message}`);
  }
  return res.json();
}
```
</details>

<details>
<summary><b>Python</b></summary>

```python
import os, httpx

def crear_enlace(descripcion: str, monto: int, orden_id: str) -> dict:
    r = httpx.post(
        "http://poket-paylink-svc:8080/v1/paylinks",
        headers={"X-API-Key": os.environ["POKET_SVC_API_KEY"]},
        json={
            "description": descripcion,
            "amount": monto,
            "idempotencyKey": orden_id,
        },
        timeout=120.0,      # el camino frío puede pasar del minuto
    )
    r.raise_for_status()
    return r.json()
```
</details>

<details>
<summary><b>Generar el QR del enlace</b></summary>

El QR se genera de tu lado a partir de la `url`; no se scrapea del portal.

```bash
npm install qrcode
```

```js
import QRCode from 'qrcode';

const { url } = await crearEnlace({ descripcion: 'Orden #1234', monto: 350, ordenId: '1234' });
const dataUrl = await QRCode.toDataURL(url);   // <img src={dataUrl}>
```
</details>

<details>
<summary><b>n8n</b></summary>

Nodo **HTTP Request** → `POST http://poket-paylink-svc:8080/v1/paylinks`.

Poné la API key en las **credenciales de n8n**, no en el workflow: los JSON de
workflow se exportan y se comparten. Usá el id de la orden como `idempotencyKey`.
</details>

---

## Idempotencia

Mandá siempre `idempotencyKey` — usá **el id de tu orden**. Con la misma clave el
servicio no crea un segundo enlace: te devuelve el primero con `reused: true`.
Si hay una creación de esa clave en vuelo, responde `409`.

Las claves viven 24h en Redis.

**Para regenerar un enlace vencido necesitás una clave distinta.** Los enlaces de
Poket duran ~24h y la ventana de idempotencia también, así que pedirlo con la
misma clave te devuelve el enlace vencido. La convención es sufijar:

```
orden-1234      → primer enlace
orden-1234:2    → regenerado tras vencer
orden-1234:3    → …
```

### Reconciliación: cuando no sabés si se creó

La idempotencia protege contra reintentos, pero **no cubre el caso ambiguo**: si
el request revienta *después* de que el portal ya procesó la creación, el enlace
puede existir aunque vos hayas recibido un error.

Por eso el `idempotencyKey` **viaja dentro del concepto** que se manda al portal:

```
description: "Orden #1234"  +  idempotencyKey: "orden-1234"
        ↓
concepto en Poket:  "Orden #1234 #orden-1234"
```

Es lo único nuestro que queda registrado del otro lado. Ante un fallo ambiguo:

1. Entrá al portal → sidebar **"Enlaces de pago"**.
2. Buscá la marca (`#orden-1234`).
3. Si está, el enlace ya existe: usalo, no reintentes.
4. Si no está, reintentá con tranquilidad.

El log del servicio te lo recuerda con la marca exacta cuando una creación falla.

> El concepto **lo ve quien paga**. Si tus claves de idempotencia son sensibles o
> feas de mostrar, apagá la marca con `CONCEPT_MARKER=false` — a cambio de perder
> la reconciliación. Si no entra en los 100 chars del campo, se recorta la
> descripción, nunca la marca.

## Auditoría

Cada enlace creado se asienta con `event: "paylink.created"` e incluye
`idempotencyKey`, `paylinkId`, `url`, `amount`, `concept` y `reused`. Va siempre
al log estructurado de stdout (lo levanta cualquier agregador), y además a un
JSONL propio si definís `AUDIT_LOG_PATH`.

Existe porque todo el estado del servicio es efímero —sesión y claves con TTL— y
el registro real vive en Poket. Ante un incidente, esto es lo que contesta "qué
acuñó este servicio, cuándo, por cuánto y con qué clave".

> En el contenedor de producción el filesystem es read-only: si usás
> `AUDIT_LOG_PATH`, montale un volumen a esa ruta. Sin volumen, el servicio
> avisa por log y sigue — nunca falla un cobro ya acuñado por no poder auditarlo.

## Límites y comportamiento a tener en cuenta

- **Montos enteros en córdobas.** El wizard del portal no tiene un campo de
  centavos reconocido; el driver aborta si el monto mostrado no coincide con el
  pedido, en vez de acuñar un cobro por otra cifra.
- **Solo NIO.** Cualquier otra `currency` se rechaza.
- **Enlaces de un solo uso, ~24h.** Es el default del portal. `maxUsages` y
  `expirationDate` son editables en el wizard pero la API todavía no los expone.
- **Latencia alta y variable.** Detrás hay un navegador recorriendo un wizard. Con
  sesión cacheada son segundos; el camino frío (login completo) puede pasar del
  minuto. **Poné timeouts de cliente ≥ 120s.**
- **Una creación a la vez.** `MAX_CONCURRENCY=1` y una cola: el portal no está
  pensado para tráfico de bot. Los requests se encolan, no se rechazan.
- **Una sola instancia.** El mutex de login es por proceso: dos réplicas
  compartirían la sesión en Redis pero se pisarían los logins. Hoy es un punto
  único de falla — [mejorarlo es una contribución bienvenida](./CONTRIBUTING.md).

---

## Despliegue

### Desarrollo

```bash
docker compose up --build
```

Levanta el servicio + Redis. Publica el puerto solo en `127.0.0.1:8080` para que
puedas probar con `curl` desde tu máquina. Usa `ipc: host` (Chromium necesita
`/dev/shm`) e `init: true` (para reapear los zombies de Chromium).

### Producción

`docker-compose.prod.yml` usa una imagen ya construida y viene endurecido:
filesystem read-only + tmpfs, `cap_drop: ALL`, `no-new-privileges`, límites de
CPU/memoria/PIDs, y Redis con contraseña en una red `internal: true` sin salida a
internet.

**Redis persiste con AOF (`everysec`)**, a propósito: las claves de idempotencia
son la defensa contra el doble cobro, así que un restart que las borrara
reintroduciría justo el fallo que se quiere evitar. El costo es que el volumen
`redis-data` guarda también la sesión de Poket, que es material de
autenticación — protegelo como al `.env` y cifralo o excluilo de los backups que
salgan del host. Si preferís el trade-off inverso, el compose documenta cómo.

Tu pipeline tiene que dejar un `.env` junto al compose con los secretos más
`IMAGE` e `IMAGE_TAG`, y correr:

```bash
docker compose -f docker-compose.prod.yml up -d
```

### Conectar tu aplicación

En producción el servicio **no publica puerto**: se alcanza por DNS interno desde
la red `paylink-edge`. En el compose de tu app:

```yaml
services:
  mi-backend:
    # ...
    environment:
      PAYLINK_URL: http://poket-paylink-svc:8080
      POKET_SVC_API_KEY: ${POKET_SVC_API_KEY}
    networks:
      - default
      - paylink-edge

networks:
  paylink-edge:
    external: true      # la crea el compose de poket-paylink-svc
```

### Seguridad del despliegue

Este servicio crea instrumentos de cobro a nombre de tu comercio, así que tratalo
como un componente interno, no como una API pública:

- **Mantenelo en red interna.** El compose de producción no publica puerto a
  propósito; el consumidor le habla por la red `paylink-edge`. Si necesitás
  alcanzarlo desde fuera del host, ponelo detrás de un proxy con su propia
  autenticación en vez de exponer el puerto.
- **Usá una API key larga y exclusiva**: `openssl rand -hex 32`. Es la única
  autenticación del endpoint, así que no la reuses de otro servicio y guardala
  como secreto (no en el repo, no en el workflow de n8n). Mejor aún: pasala por
  archivo con [`POKET_SVC_API_KEY_FILE`](#secretos-por-archivo) en vez de dejarla
  en un `.env` plano.
- **Dejá `MAX_AMOUNT` en un techo realista para tu negocio.** Es el fusible que
  acota el daño si la key se filtra o el consumidor tiene un bug.
- **Dejá `SWAGGER_PASSWORD` vacía en producción** si no necesitás la doc: sin
  ella, `/docs` no se sirve.
- Si sospechás que la key se filtró, rotala y revisá los enlaces creados en el
  portal. El código de acceso de Poket se cambia desde el propio portal.

---

## Troubleshooting

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `502 rsc_parse_error` con `/healthz` en verde | Poket cambió su front y los selectores ya no matchean | Re-mapear: ver [`SELECTORS.md`](./SELECTORS.md) |
| `/v1/selftest` → `503` | Lo mismo, detectado antes de que falle un cobro | Re-mapear selectores |
| `409 idempotency_corrupt` | La entrada en Redis quedó ilegible | Buscá la marca en el portal antes de reintentar con otra clave |
| `504 poket_timeout` esporádico | Camino frío (login completo) más lento que tu timeout | Subí el timeout del cliente a ≥120s |
| `504` sistemático | El portal no responde, o Chromium no arranca | `docker compose logs`; revisá `/healthz` |
| `healthz` → `browser: down` | Falta Chromium | `npx playwright install chromium` (fuera de Docker) |
| `healthz` → `redis: down` | `REDIS_URL` mal, o Redis caído | Verificá la URL y que Redis responda `PING` |
| El proceso no arranca | Falta una variable requerida | El error dice cuál. Ver [Configuración](#configuración) |
| `409 idempotency_in_flight` | Otra request con esa misma clave sigue corriendo | Esperá y reintentá; la cola es serial |
| Login falla siempre | Credenciales, o código de país ≠ +505 | Probá `HEADLESS=false npm run login:check` y mirá el navegador |

**Monitoreá la tasa de `502` del endpoint, no solo `/healthz`.** Si Poket cambia
su front, el healthcheck sigue en verde y solo las creaciones fallan.

## Estructura

```
src/
  server.ts          Capa HTTP (Fastify): rutas, auth, mapeo de errores
  paylinkService.ts  Idempotencia, fusible de monto, marca del concepto, cola
  jobs.ts            Modo asíncrono: encolado y estado de los jobs
  audit.ts           Rastro de los enlaces acuñados
  poket/
    driver.ts        Playwright: login, cache de sesión, wizard, selftest
    selectors.ts     TODOS los selectores del portal, centralizados acá
    rscParser.ts     Parser del wire format RSC/Flight (puro, testeable)
  browser.ts         Singleton del Browser de Playwright
  redis.ts           Cliente Redis y nombres de claves
  config.ts          Config validada con zod (falla al arrancar si algo falta)
test/
  rscParser.test.ts  Tests del parser (sin red, sin browser)
  concept.test.ts    Tests de la marca del concepto y del fusible de monto
```

## Desarrollo

| Script | Qué hace |
|---|---|
| `npm run dev` | Levanta el servicio con watch |
| `npm start` | Levanta el servicio |
| `npm test` | Tests del parser RSC. Sin red: seguro de correr siempre |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run login:check` | Prueba el login y el cache de sesión contra el portal |
| `npm run create:check` | 🔴 **Crea un enlace de pago REAL de C$1 en tu comercio** |

> `create:check` no es un test: hace una creación real. Se borra desde el portal,
> sidebar → "Enlaces de pago". Ajustable con `AMOUNT` y `DESC`.

Para depurar visualmente, `HEADLESS=false` abre el navegador y podés ver el
wizard ejecutándose.

## Cuando Poket cambie el front

Va a pasar: el portal es Next.js con clases generadas. Todos los selectores están
centralizados en `src/poket/selectors.ts`, y [`SELECTORS.md`](./SELECTORS.md)
documenta el flujo completo con las trampas de cada campo (la máscara de
react-aria del monto, la hidratación que se come los primeros caracteres, el
listener que va antes del click).

```bash
npx playwright codegen https://portal.pagoconpoket.com/
```

Rehacé login → crear enlace → confirmar, actualizá `selectors.ts` y
`SELECTORS.md`, y mandá un PR.

## Contribuir

Ver [`CONTRIBUTING.md`](./CONTRIBUTING.md) — hay una lista de puntos de entrada
concretos. Soporte best-effort: esto depende del HTML de un tercero y puede
romperse sin aviso. Los PRs que re-mapeen selectores son muy bienvenidos.

## Aviso legal

Este software automatiza el portal web de Poket usando **las credenciales de tu
propio comercio**, porque Poket no ofrece una API pública. No explota ninguna
vulnerabilidad ni accede a datos ajenos.

Aun así, automatizar el portal puede ir contra los términos de servicio de Poket.
Usarlo es decisión y responsabilidad tuya, incluyendo cualquier consecuencia
sobre tu cuenta de comercio. Este proyecto no tiene relación, respaldo ni
afiliación con Poket.

## Licencia

[Apache-2.0](./LICENSE) © 2026 Matthew Reyes
