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

- **Escalar horizontalmente.** Hoy el mutex de login es por proceso, así que no
  se puede correr más de una réplica. Un lock distribuido en Redis lo
  destrabaría, y con eso el servicio deja de ser un punto único de falla.
- **La key de idempotencia se libera ante cualquier fallo.** Si el fallo fue un
  timeout *después* de disparar el POST del Server Action, el enlace pudo
  haberse creado igual y el reintento acuña un segundo. Distinguir "falló antes
  de disparar" de "falló después" evitaría enlaces huérfanos en el portal.
  Ver `src/paylinkService.ts`.
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
- **Los comentarios explican el porqué, no el qué.** Buena parte del código son
  workarounds no obvios contra el portal (la máscara de react-aria, la
  hidratación que se come caracteres, el listener que va antes del click). Si
  agregás uno, explicá qué pasa si no está — es lo que evita que el próximo lo
  "simplifique" y rompa el cobro.
- Nada de `console.log` en el código del servicio: usá el `logger` (pino).
- **Nunca loguees `POKET_USER`, `POKET_CODE` ni la API key.** El body RSC crudo
  se loguea solo cuando el parseo falla, nunca en el happy path.

## Pull requests

- Un PR por tema.
- Si tocás el driver, decí contra qué probaste: portal real o solo tests.
- Si tocás algo que mueve dinero (montos, idempotencia, reintentos), explicá en
  la descripción cuál es el peor caso si tu cambio está mal. Acá un bug no es
  una excepción en un log: es un cobro que no debería haber existido, o uno que
  se perdió.
