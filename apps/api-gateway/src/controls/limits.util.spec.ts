import { checkLimits, convert, limitMessage, periodStarts, resolveLimits } from './limits.util';

const rates = [
  { from_currency: 'USD', to_currency: 'CDF', rate: 2800 },
  { from_currency: 'EUR', to_currency: 'USD', rate: 1.1 },
];

describe('limits.util', () => {
  it('convertit comme le wallet-service (direct, inverse, via USD)', () => {
    expect(convert(10, 'USD', 'USD', rates)).toBe(10);
    expect(convert(1, 'USD', 'CDF', rates)).toBe(2800);
    expect(convert(2800, 'CDF', 'USD', rates)).toBe(1);
    expect(convert(10, 'EUR', 'CDF', rates)).toBeCloseTo(30800, 6);
    expect(convert(10, 'KES', 'USD', rates)).toBeNull();
  });

  it('dérogation utilisateur > niveau KYC > aucun plafond', () => {
    const tiers = { NOT_SUBMITTED: { perTransaction: 100, daily: 200 }, VERIFIED: { perTransaction: 2000, daily: 5000 } };
    expect(resolveLimits({ kycStatus: null, tiers, referenceCurrency: 'USD' })).toMatchObject({ source: 'KYC_TIER', perTransaction: 100, daily: 200 });
    expect(resolveLimits({ kycStatus: 'VERIFIED', tiers, referenceCurrency: 'USD' }).perTransaction).toBe(2000);
    expect(resolveLimits({ kycStatus: 'VERIFIED', tiers, userOverride: { daily: 9000, monthly: null }, referenceCurrency: 'USD' })).toMatchObject({
      source: 'USER',
      perTransaction: 2000,
      daily: 9000,
    });
    expect(resolveLimits({ kycStatus: 'PENDING', tiers: {}, referenceCurrency: 'USD' }).source).toBe('DEFAULT');
  });

  it('détecte le premier plafond dépassé', () => {
    const limits: any = { perTransaction: 100, daily: 200, monthly: 1000, yearly: null, monthlyCount: 5, currency: 'USD', tier: 'NOT_SUBMITTED', source: 'KYC_TIER' };
    expect(checkLimits(limits, { day: 0, month: 0, year: 0, monthCount: 0 }, 150)).toMatchObject({ period: 'PER_TRANSACTION' });
    expect(checkLimits(limits, { day: 150, month: 150, year: 150, monthCount: 1 }, 60)).toMatchObject({ period: 'DAILY', remaining: 50 });
    expect(checkLimits(limits, { day: 0, month: 990, year: 990, monthCount: 1 }, 20)).toMatchObject({ period: 'MONTHLY' });
    expect(checkLimits(limits, { day: 0, month: 0, year: 0, monthCount: 5 }, 1)).toMatchObject({ period: 'MONTHLY_COUNT' });
    expect(checkLimits(limits, { day: 100, month: 100, year: 100, monthCount: 1 }, 100)).toBeNull(); // pile au plafond : autorisé
    expect(limitMessage({ period: 'DAILY', limit: 200, used: 150, remaining: 50 }, 'USD', 'NOT_SUBMITTED')).toContain('KYC');
  });

  it('périodes dans le fuseau de la plateforme (UTC+2)', () => {
    const s = periodStarts(new Date('2026-11-09T21:30:00Z'), 'Africa/Lubumbashi'); // 23:30 locale
    expect(s.day.toISOString()).toBe('2026-11-08T22:00:00.000Z');
    expect(s.month.toISOString()).toBe('2026-10-31T22:00:00.000Z');
    expect(s.year.toISOString()).toBe('2025-12-31T22:00:00.000Z');
    const late = periodStarts(new Date('2026-11-09T22:30:00Z'), 'Africa/Lubumbashi'); // 00:30 le 10
    expect(late.day.toISOString()).toBe('2026-11-09T22:00:00.000Z');
  });
});
