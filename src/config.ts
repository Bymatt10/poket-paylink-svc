/**
 * Configuración del servicio, validada con zod al arrancar.
 * Si falta una variable requerida, el proceso NO arranca (falla temprano y
 * claro, nunca a mitad de un request).
 *
 * NUNCA loguear los valores de POKET_USER ni POKET_CODE.
 */
import { z } from 'zod';

const EnvSchema = z.object({
  // Credenciales del portal (login en frío)
  POKET_USER: z.string().min(1, 'requerido (teléfono o correo del comercio)'),
  POKET_CODE: z.string().min(1, 'requerido (código de acceso fijo del comercio)'),
  POKET_COUNTRY_CODE: z.string().default('+505'),

  POKET_BASE_URL: z.string().min(1).default('https://portal.pagoconpoket.com'),

  // Auth del propio servicio (usado en F4)
  POKET_SVC_API_KEY: z.string().min(16, 'debe tener al menos 16 caracteres'),

  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  PORT: z.coerce.number().int().positive().default(8080),
  // 0.0.0.0 para Docker; en local podés poner 127.0.0.1 para no exponer a la LAN.
  HOST: z.string().min(1).default('0.0.0.0'),

  // Swagger/OpenAPI: la doc solo se sirve si SWAGGER_PASSWORD está seteada, y
  // queda detrás de Basic Auth (usuario + contraseña).
  SWAGGER_USER: z.string().min(1).default('admin'),
  SWAGGER_PASSWORD: z.string().min(1).optional(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  MAX_CONCURRENCY: z.coerce.number().int().positive().default(1),

  // Playwright
  HEADLESS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  RUN_SMOKE: z.enum(['0', '1']).default('0'),
});

export type Config = z.infer<typeof EnvSchema>;

let cached: Config | null = null;

/** Carga y valida la config una sola vez. Lanza si algo falta/está mal. */
export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Reportar qué variables fallan, SIN imprimir sus valores.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuración de entorno inválida:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Solo para tests: resetea el cache de config. */
export function _resetConfigCache(): void {
  cached = null;
}
