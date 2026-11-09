import { canonicalJson, isFinancialRoute, ownerOf, requestKeyOf } from './idempotency.util';

describe('idempotency.util', () => {
  it('reconnaît les routes financières', () => {
    expect(isFinancialRoute('/wallet/cashout')).toBe(true);
    expect(isFinancialRoute('/wallet/send?x=1')).toBe(true);
    expect(isFinancialRoute('/admin/wallet/reconcile/abc-123')).toBe(true);
    expect(isFinancialRoute('/api/external/pay/mobile_money')).toBe(true);
    expect(isFinancialRoute('/wallet/transactions')).toBe(false);
    expect(isFinancialRoute('/auth/login')).toBe(false);
  });

  it('JSON canonique indépendant de l’ordre des clés', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });

  it('lit la clé d’idempotence (en-tête prioritaire, puis corps)', () => {
    expect(requestKeyOf({ headers: { 'idempotency-key': ' k1 ' }, body: { requestId: 'r' } })).toBe('k1');
    expect(requestKeyOf({ headers: {}, body: { idempotencyKey: 'k2' } })).toBe('k2');
    expect(requestKeyOf({ headers: {}, body: { requestId: 'r3' } })).toBe('r3');
    expect(requestKeyOf({ headers: {}, body: {} })).toBeNull();
    expect(requestKeyOf({ headers: { 'idempotency-key': 'x'.repeat(300) } })!.length).toBe(150);
  });

  it('identifie le propriétaire (utilisateur, clé API, sinon empreinte)', () => {
    expect(ownerOf({ currentUser: { id: 'u1' } })).toBe('user:u1');
    expect(ownerOf({ apiKey: { id: 'k1' } })).toBe('apikey:k1');
    const a = ownerOf({ headers: { authorization: 'Bearer abc' } });
    expect(a.startsWith('anon:')).toBe(true);
    expect(a).toBe(ownerOf({ headers: { authorization: 'Bearer abc' } }));
    expect(a).not.toBe(ownerOf({ headers: { authorization: 'Bearer xyz' } }));
  });
});
