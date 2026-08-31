# Contribuir

Gracias por pasar. Este proyecto existe porque Poket no publica una API de
comercio; lo mantiene la gente que lo necesita.

## Antes que nada: seguridad

Este servicio **acuña instrumentos de cobro**. Si encontrás un problema de
seguridad —una forma de saltarse la API key, una fuga de credenciales, un
camino que permita acuñar enlaces sin autorización— **no abras un issue
público**. Escribí directo por el [security advisory privado de GitHub](https://github.com/Bymatt10/poket-paylink-svc/security/advisories/new).

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env      # completá lo tuyo
npm run typecheck && npm test
```

`npm test` corre los tests del parser RSC: son **puros**, sin browser ni red, y
son seguros de correr siempre.

> 🔴 `npm run create:check` **crea un enlace de pago real de C$1** en el comercio
> configurado en tu `.env`. No es un test. Se borra desde el portal, sidebar →
> "Enlaces de pago".

## Qué hace falta

### Re-mapear selectores (lo más frecuente y lo más útil)

Cuando Poket hace deploy, los selectores se rompen. El síntoma es `/healthz` en
verde con `POST /v1/paylinks` devolviendo `502 rsc_parse_error` o `504`.

1. `npx playwright codegen https://portal.pagoconpoket.com/`
2. Rehacé el flujo: login → crear enlace → confirmar.
3. Actualizá `src/poket/selectors.ts` **y** `SELECTORS.md` (poné la fecha nueva
   del recon arriba).
4. Si cambió el formato de la respuesta del Server Action, agregá el payload
   nuevo como caso en `test/rscParser.test.ts`.

### Puntos de entrada concretos

- **Escalar horizontalmente.** El mutex de login es por proceso, así que no se
  puede correr más de una réplica: dos se pisarían los logins. Un lock
  distribuido en Redis lo destrabaría y sacaría el punto único de falla. El modo
  asíncrono ya existe, pero por sí solo **no** resuelve esto.
- **Detectar si el POST llegó a dispararse.** Ante un fallo, la clave de
  idempotencia se libera para permitir reintentos; si el fallo ocurrió después
  del POST, el enlace puede existir igual. Hoy se mitiga con la marca en el
  concepto (reconciliación manual). Distinguir "falló antes" de "falló después"
  lo resolvería de raíz. Ver `src/paylinkService.ts`.
- **Exponer `maxUsages` y `expirationDate`.** Ambos son editables en el paso 2
  del wizard (ver `SELECTORS.md`), pero la API todavía no los ofrece.
- **Código de país distinto de +505.** El driver asume el default; falta
  seleccionar la opción del combobox cuando `POKET_COUNTRY_CODE` difiere.
- **Montos con decimales.** La máscara del campo solo se validó con enteros.
- **Abstraer el driver.** `src/poket/` ya está aislado del resto; extraer una
  interfaz permitiría soportar otros portales de pago sin tocar el core.

Más detalle en la sección "Pendientes" de [`SELECTORS.md`](./SELECTORS.md).

## Estilo

- TypeScript estricto; `npm run typecheck` tiene que pasar.
- **Pocos comentarios, y solo donde el porqué no se deduce del código.** El
  código contra el portal tiene workarounds no obvios (la máscara de react-aria,
  la hidratación que se come caracteres, el listener que va antes del click):
  ahí un comentario evita que alguien lo "simplifique" y rompa el cobro. En el
  resto, que hable el código.
- Nada de `console.log` en el servicio: usá el `logger` (pino).
- **Nunca loguees `POKET_USER`, `POKET_CODE` ni la API key.** El body RSC crudo
  se loguea solo cuando el parseo falla, nunca en el happy path.
- Errores tipados, no strings: cada fallo esperable tiene su clase y su entrada
  en `mapError` (`src/server.ts`), para que el modo síncrono y el asíncrono
  devuelvan el mismo contrato.

## Pull requests

- Un PR por tema.
- Si tocás el driver, decí contra qué probaste: portal real o solo tests.
- Si tocás algo que mueve dinero (montos, idempotencia, reintentos), explicá en
  la descripción cuál es el peor caso si tu cambio está mal. Acá un bug no es
  una excepción en un log: es un cobro que no debería haber existido, o uno que
  se perdió.
