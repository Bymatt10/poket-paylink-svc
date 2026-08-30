/**
 * Parser de la respuesta RSC (React Server Components / "Flight") que devuelve
 * el Server Action de creación de enlace de Poket.
 *
 * La respuesta NO es JSON plano: son líneas "índice:payload", por ejemplo:
 *
 *   0:{"a":"$@1","f":"","q":"","i":false,"b":"fqlJ8kXyqXOH3AttjMxg3"}
 *   1:{"isSuccess":true,"data":{"id":"...","url":"https://pagoconpoket.com/payment/...",...}}
 *
 * La línea útil es la primera cuyo JSON parseado tenga la propiedad `isSuccess`
 * (NO se asume que siempre es la línea "1:"). El payload usa prefijos de Flight
 * que hay que limpiar: `$D<iso>` (fecha), `$undefined`, `$$` (literal escapado).
 *
 * Función PURA: sin browser, sin red. Testeable con el payload real.
 */

export type PaylinkData = {
  id: string;
  url: string;
  amount: number;
  currency: string;
  description: string;
  /** ISO 8601, ya sin el prefijo Flight `$D`. */
  expirationDate: string;
  maxUsages: number;
  /** "SingleUse" | "MultiUse" | ... */
  type: string;
  /** "Created" | ... */
  status: string;
  /** ISO 8601, ya sin el prefijo Flight `$D`. */
  createdAt: string;
  /** `$undefined` en el wire → `undefined`. */
  terminalId?: string;
};

/** El body no se pudo interpretar como una respuesta RSC de paylink. */
export class RscParseError extends Error {
  constructor(
    message: string,
    /** Body crudo, para loguear cuando el parseo falla (nunca en el happy path). */
    readonly rawBody: string,
  ) {
    super(message);
    this.name = 'RscParseError';
  }
}

/** Poket respondió `isSuccess:false` — rechazó la creación del enlace. */
export class PoketRejectedError extends Error {
  constructor(
    message: string,
    /** Objeto de la línea `isSuccess` tal cual, para diagnóstico. */
    readonly payload: unknown,
  ) {
    super(message);
    this.name = 'PoketRejectedError';
  }
}

/**
 * Limpia recursivamente los prefijos del wire format de Flight sobre los
 * valores string de un objeto/array ya parseado.
 */
function cleanFlightValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value === '$undefined') return undefined;
    if (value.startsWith('$D')) return value.slice(2); // marcador de fecha → ISO
    if (value.startsWith('$$')) return value.slice(1); // literal escapado "$$x" → "$x"
    return value; // otras referencias Flight ($@1, etc.) no aparecen en `data`
  }
  if (Array.isArray(value)) return value.map(cleanFlightValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = cleanFlightValue(v);
    return out;
  }
  return value;
}

/**
 * Parsea el body de la respuesta del Server Action y devuelve los datos del
 * enlace de pago.
 *
 * @throws {RscParseError}    body vacío, HTML de error, o sin línea `isSuccess`.
 * @throws {PoketRejectedError} `isSuccess:false`.
 */
export function parsePaylinkResponse(body: string): PaylinkData {
  if (!body || !body.trim()) {
    throw new RscParseError('Respuesta RSC vacía', body ?? '');
  }

  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  let matched: Record<string, unknown> | null = null;
  for (const line of lines) {
    const m = /^(\d+):(.*)$/.exec(line);
    if (!m) continue;
    let json: unknown;
    try {
      json = JSON.parse(m[2]!);
    } catch {
      continue; // línea Flight que no es JSON puro (referencias, chunks, etc.)
    }
    if (json !== null && typeof json === 'object' && 'isSuccess' in json) {
      matched = json as Record<string, unknown>;
      break;
    }
  }

  if (!matched) {
    throw new RscParseError(
      'No se encontró ninguna línea con `isSuccess` en la respuesta RSC',
      body,
    );
  }

  if (matched.isSuccess === false) {
    const data = matched.data as Record<string, unknown> | null | undefined;
    const msg =
      (matched.error as string | undefined) ??
      (matched.message as string | undefined) ??
      (data?.error as string | undefined) ??
      (data?.message as string | undefined) ??
      'Poket rechazó la creación del enlace (isSuccess:false)';
    throw new PoketRejectedError(String(msg), matched);
  }

  const data = cleanFlightValue(matched.data) as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== 'object') {
    throw new RscParseError('isSuccess:true pero `data` ausente o inválida', body);
  }

  const { id, url, amount } = data;
  if (typeof id !== 'string' || typeof url !== 'string' || typeof amount !== 'number') {
    throw new RscParseError(
      'Faltan campos requeridos (id/url/amount) en `data`',
      body,
    );
  }

  return {
    id,
    url,
    amount,
    currency: String(data.currency ?? ''),
    description: String(data.description ?? ''),
    expirationDate: String(data.expirationDate ?? ''),
    maxUsages: Number(data.maxUsages ?? 0),
    type: String(data.type ?? ''),
    status: String(data.status ?? ''),
    createdAt: String(data.createdAt ?? ''),
    terminalId: data.terminalId as string | undefined,
  };
}
