import { describe, it, expect } from 'vitest';
import {
  parsePaylinkResponse,
  PoketRejectedError,
  RscParseError,
} from '../src/poket/rscParser';

/**
 * Payload de éxito real observado en el recon (§0 del plan), con ids completos
 * para que sea JSON válido. La línea útil es la "1:"; incluye los prefijos
 * Flight `$D` (createdAt) y `$undefined` (terminalId).
 */
const SUCCESS_BODY = [
  '0:{"a":"$@1","f":"","q":"","i":false,"b":"fqlJ8kXyqXOH3AttjMxg3"}',
  '1:{"isSuccess":true,"data":{"id":"e7693adc-05c5-4930-81d0-a1d5a01bd98d","url":"https://pagoconpoket.com/payment/90fdba47-1234-5678-9abc-def012345678","amount":1,"currency":"NIO","description":"ps5","expirationDate":"2026-07-18T16:25:39.273Z","maxUsages":1,"type":"SingleUse","terminalId":"$undefined","status":"Created","createdAt":"$D2026-07-17T16:26:32.541Z"}}',
].join('\n');

describe('parsePaylinkResponse', () => {
  it('parsea el payload real de éxito y limpia los prefijos Flight', () => {
    const r = parsePaylinkResponse(SUCCESS_BODY);

    expect(r.id).toBe('e7693adc-05c5-4930-81d0-a1d5a01bd98d');
    expect(r.url).toBe(
      'https://pagoconpoket.com/payment/90fdba47-1234-5678-9abc-def012345678',
    );
    expect(r.amount).toBe(1);
    expect(r.currency).toBe('NIO');
    expect(r.description).toBe('ps5');
    expect(r.expirationDate).toBe('2026-07-18T16:25:39.273Z');
    expect(r.maxUsages).toBe(1);
    expect(r.type).toBe('SingleUse');
    expect(r.status).toBe('Created');
    // `$D` removido → ISO limpio.
    expect(r.createdAt).toBe('2026-07-17T16:26:32.541Z');
    // `$undefined` → undefined.
    expect(r.terminalId).toBeUndefined();
  });

  it('lanza PoketRejectedError cuando isSuccess:false', () => {
    const body = [
      '0:{"a":"$@1","f":"","q":"","i":false,"b":"xxx"}',
      '1:{"isSuccess":false,"error":"Monto inválido","data":null}',
    ].join('\n');

    expect(() => parsePaylinkResponse(body)).toThrow(PoketRejectedError);
    try {
      parsePaylinkResponse(body);
    } catch (e) {
      expect(e).toBeInstanceOf(PoketRejectedError);
      expect((e as PoketRejectedError).message).toContain('Monto inválido');
    }
  });

  it('lanza RscParseError con body vacío', () => {
    expect(() => parsePaylinkResponse('')).toThrow(RscParseError);
    expect(() => parsePaylinkResponse('   \n  ')).toThrow(RscParseError);
  });

  it('lanza RscParseError con HTML de error (no una respuesta RSC)', () => {
    const html = '<!DOCTYPE html><html><body><h1>500 Internal Server Error</h1></body></html>';
    expect(() => parsePaylinkResponse(html)).toThrow(RscParseError);
    // El body crudo queda disponible para el log.
    try {
      parsePaylinkResponse(html);
    } catch (e) {
      expect((e as RscParseError).rawBody).toBe(html);
    }
  });

  it('encuentra el resultado aunque venga en la línea "2:" y no en "1:"', () => {
    const body = [
      '0:{"a":"$@1","f":"","q":"","i":false,"b":"xxx"}',
      '1:{"algoIntermedio":"que no tiene isSuccess"}',
      '2:{"isSuccess":true,"data":{"id":"abc","url":"https://pagoconpoket.com/payment/zzz","amount":5,"currency":"NIO","description":"otra","expirationDate":"2026-08-01T00:00:00.000Z","maxUsages":3,"type":"MultiUse","terminalId":"$undefined","status":"Created","createdAt":"$D2026-07-31T00:00:00.000Z"}}',
    ].join('\n');

    const r = parsePaylinkResponse(body);
    expect(r.id).toBe('abc');
    expect(r.amount).toBe(5);
    expect(r.type).toBe('MultiUse');
    expect(r.maxUsages).toBe(3);
    expect(r.createdAt).toBe('2026-07-31T00:00:00.000Z');
  });

  it('ignora líneas Flight que no son JSON parseable', () => {
    const body = [
      '0:I["$","$L1",null,{}]', // línea Flight no-JSON: debe saltarse sin romper
      '1:{"isSuccess":true,"data":{"id":"id1","url":"https://pagoconpoket.com/payment/u","amount":2,"currency":"NIO","description":"x","expirationDate":"2026-08-01T00:00:00.000Z","maxUsages":1,"type":"SingleUse","terminalId":"$undefined","status":"Created","createdAt":"$D2026-07-31T00:00:00.000Z"}}',
    ].join('\n');

    const r = parsePaylinkResponse(body);
    expect(r.id).toBe('id1');
    expect(r.amount).toBe(2);
  });
});
