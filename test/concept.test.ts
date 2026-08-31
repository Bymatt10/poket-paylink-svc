import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _resetConfigCache } from '../src/config';

/**
 * La marca del idempotencyKey en el concepto es lo único que permite reconciliar
 * un fallo ambiguo contra el portal, así que su recorte tiene que ser correcto:
 * si el campo se pasa de 100 chars el wizard falla, y si se recorta la MARCA en
 * vez de la descripción, se pierde justamente la parte que sirve.
 */
const ENV = {
  POKET_USER: '00000000',
  POKET_CODE: '000000',
  POKET_SVC_API_KEY: 'test-key-0123456789abcdef0123456789',
};

let original: NodeJS.ProcessEnv;

beforeEach(() => {
  original = { ...process.env };
  Object.assign(process.env, ENV);
  _resetConfigCache();
});

afterEach(() => {
  process.env = original;
  _resetConfigCache();
});

async function build(description: string, key?: string): Promise<string> {
  const { buildConcept } = await import('../src/paylinkService');
  return buildConcept(description, key);
}

describe('buildConcept', () => {
  it('marca el concepto con el idempotencyKey', async () => {
    expect(await build('ps5', 'orden-1234')).toBe('ps5 #orden-1234');
  });

  it('deja el concepto intacto si no hay idempotencyKey', async () => {
    expect(await build('ps5')).toBe('ps5');
  });

  it('no marca nada si CONCEPT_MARKER=false', async () => {
    process.env.CONCEPT_MARKER = 'false';
    _resetConfigCache();
    expect(await build('ps5', 'orden-1234')).toBe('ps5');
  });

  it('nunca supera los 100 chars del campo del portal', async () => {
    const largo = 'x'.repeat(200);
    const out = await build(largo, 'orden-1234');
    expect(out.length).toBeLessThanOrEqual(100);
  });

  it('al recortar sacrifica la DESCRIPCIÓN, nunca la marca', async () => {
    const out = await build('x'.repeat(200), 'orden-1234');
    // La marca sobrevive entera: es lo que permite reconciliar contra el portal.
    expect(out.endsWith(' #orden-1234')).toBe(true);
    expect(out.startsWith('x')).toBe(true);
  });

  it('con una clave absurdamente larga prefiere el concepto pelado a un campo inválido', async () => {
    const out = await build('ps5', 'k'.repeat(150));
    expect(out).toBe('ps5');
    expect(out.length).toBeLessThanOrEqual(100);
  });
});

describe('fusible MAX_AMOUNT', () => {
  it('rechaza un monto por encima del techo configurado', async () => {
    process.env.MAX_AMOUNT = '500';
    _resetConfigCache();
    const { createPaylinkService, AmountLimitError } = await import('../src/paylinkService');
    await expect(
      createPaylinkService({ description: 'ps5', amount: 501 }),
    ).rejects.toBeInstanceOf(AmountLimitError);
  });

  it('deja pasar un monto en el límite exacto', async () => {
    process.env.MAX_AMOUNT = '500';
    _resetConfigCache();
    const { createPaylinkService, AmountLimitError } = await import('../src/paylinkService');
    // No llega a crear nada (no hay browser en los tests): lo que importa es
    // que NO sea el fusible lo que lo detiene.
    await expect(
      createPaylinkService({ description: 'ps5', amount: 500 }),
    ).rejects.not.toBeInstanceOf(AmountLimitError);
  });
});
