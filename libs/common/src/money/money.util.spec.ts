import {
  formatMoney3,
  hasAtMost3Decimals,
  isMoneyKey,
  percentOf,
  round3,
  roundMoneyFields,
  subMoney,
  sumMoney,
} from './money.util';

describe('money.util (3 décimales)', () => {
  it('formate toujours avec 3 décimales', () => {
    expect(formatMoney3(10)).toBe('10.000');
    expect(formatMoney3(10.5)).toBe('10.500');
    expect(formatMoney3(10.25)).toBe('10.250');
    expect(formatMoney3(10.256)).toBe('10.256');
    expect(formatMoney3(1250.789)).toBe('1250.789');
    expect(formatMoney3(null)).toBe('0.000');
  });

  it('arrondit au demi-supérieur malgré le bruit binaire', () => {
    expect(round3(1.0005)).toBe(1.001);
    expect(round3(-10.0005)).toBe(-10.001);
    expect(round3(10.2999999999)).toBe(10.3);
    expect(round3(12345.669921875)).toBe(12345.67); // valeur FLOAT héritée
    expect(round3('10,25')).toBe(10.25);
    expect(round3('abc')).toBe(0);
  });

  it('additionne et soustrait sans dérive', () => {
    expect(sumMoney(0.1, 0.2)).toBe(0.3);
    expect(sumMoney(1000.001, 2000.002, 0.003)).toBe(3000.006);
    expect(subMoney(10, 9.99)).toBe(0.01);
    expect(percentOf(1000, 1.5)).toBe(15);
    expect(percentOf(333.333, 2.5)).toBe(8.333);
  });

  it('valide le nombre de décimales saisies', () => {
    expect(hasAtMost3Decimals('10.250')).toBe(true);
    expect(hasAtMost3Decimals('10.2500')).toBe(true); // zéros finaux tolérés
    expect(hasAtMost3Decimals('10.2567')).toBe(false);
    expect(hasAtMost3Decimals(10.5)).toBe(true);
    expect(hasAtMost3Decimals('1e3')).toBe(false);
  });

  it('reconnaît les champs de montant (pas les taux ni la pagination)', () => {
    expect(isMoneyKey('amount')).toBe(true);
    expect(isMoneyKey('feeAmount')).toBe(true);
    expect(isMoneyKey('totalDebit')).toBe(true);
    expect(isMoneyKey('withdraw_fee')).toBe(true);
    expect(isMoneyKey('daily_limit')).toBe(true);
    expect(isMoneyKey('rate')).toBe(false);
    expect(isMoneyKey('exchangeRate')).toBe(false);
    expect(isMoneyKey('transfer_percentage')).toBe(false);
    expect(isMoneyKey('totalPages')).toBe(false);
    expect(isMoneyKey('limit')).toBe(false);
  });

  it('arrondit les réponses sans toucher au reste ni à l’original', () => {
    const src = {
      data: { balance: 10.29999999, exchangeRate: 1.2345678, items: [{ amount: 1 / 3 }], createdAt: new Date(0) },
      meta: { total: 42, page: 1, totalPages: 3 },
    };
    const out: any = roundMoneyFields(src, true);
    expect(out.data.balance).toBe(10.3);
    expect(out.data.balanceFormatted).toBe('10.300');
    expect(out.data.exchangeRate).toBe(1.2345678);
    expect(out.data.items[0].amount).toBe(0.333);
    expect(out.data.createdAt).toBeInstanceOf(Date);
    expect(out.meta.total).toBe(42);
    expect(out.meta.totalFormatted).toBeUndefined();
    expect(src.data.balance).toBe(10.29999999);
  });
});
