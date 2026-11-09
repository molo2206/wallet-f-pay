import { cashDifference, clearingAccount, coverage, effectiveAmount, ledgerLines, parseCurrencyMap, providerDecision, walletLedgerBalance } from './controls.util';

const sum = (lines: any[], k: 'debit' | 'credit') => lines.reduce((a, l) => a + l[k], 0);

describe('controls.util — grand livre', () => {
  it('chaque mouvement produit deux écritures équilibrées', () => {
    for (const movement of ['CREDIT', 'DEBIT'] as const) {
      for (const walletKind of ['CUSTOMER', 'BRANCH_CASH', 'SYSTEM_FEES'] as const) {
        for (const delta of [100, -40.5]) {
          const l = ledgerLines({ walletId: 'w', walletKind, movement, paymentMethod: 'CASH', currency: 'CDF', delta });
          expect(l.length).toBe(2);
          expect(sum(l, 'debit')).toBe(sum(l, 'credit'));
        }
      }
    }
  });

  it('crédit client = passif en hausse (crédit du wallet)', () => {
    const [w, c] = ledgerLines({ walletId: 'w1', walletKind: 'CUSTOMER', movement: 'CREDIT', paymentMethod: 'MOBILE_MONEY', currency: 'cdf', delta: 50 });
    expect(w).toMatchObject({ account: 'WALLET:w1', accountKind: 'WALLET_LIABILITY', credit: 50, debit: 0 });
    expect(c).toMatchObject({ account: 'CLEARING:MOBILE_MONEY:CDF', debit: 50, credit: 0 });
  });

  it('recharge au guichet : client crédité + caisse créditée → le compte de passage CASH s’annule', () => {
    const client = ledgerLines({ walletId: 'c', walletKind: 'CUSTOMER', movement: 'CREDIT', paymentMethod: 'CASH', currency: 'USD', delta: 100 });
    const caisse = ledgerLines({ walletId: 'k', walletKind: 'BRANCH_CASH', movement: 'CREDIT', paymentMethod: 'CASH', currency: 'USD', delta: 100 });
    const clearing = [...client, ...caisse].filter((l) => l.accountKind === 'CLEARING');
    expect(sum(clearing, 'debit') - sum(clearing, 'credit')).toBe(0);
    expect(caisse[0]).toMatchObject({ accountKind: 'WALLET_ASSET', debit: 100 });
  });

  it('virement interne : le compte de passage INTERNAL s’annule', () => {
    const a = ledgerLines({ walletId: 'a', walletKind: 'CUSTOMER', movement: 'DEBIT', paymentMethod: 'INTERNAL', currency: 'CDF', delta: 30 });
    const b = ledgerLines({ walletId: 'b', walletKind: 'CUSTOMER', movement: 'CREDIT', paymentMethod: 'INTERNAL', currency: 'CDF', delta: 30 });
    const clearing = [...a, ...b].filter((l) => l.accountKind === 'CLEARING');
    expect(sum(clearing, 'debit')).toBe(sum(clearing, 'credit'));
  });

  it('annulation (delta négatif) = écritures inverses', () => {
    const plus = ledgerLines({ walletId: 'w', walletKind: 'CUSTOMER', movement: 'CREDIT', paymentMethod: null, currency: 'CDF', delta: 10 });
    const minus = ledgerLines({ walletId: 'w', walletKind: 'CUSTOMER', movement: 'CREDIT', paymentMethod: null, currency: 'CDF', delta: -10 });
    expect(minus[0].debit).toBe(plus[0].credit);
    expect(walletLedgerBalance('CUSTOMER', minus[0].debit + plus[0].debit, minus[0].credit + plus[0].credit)).toBe(0);
    expect(clearingAccount(null, 'cdf')).toBe('CLEARING:INTERNAL:CDF');
  });

  it('seules les transactions réussies comptent', () => {
    expect(effectiveAmount('SUCCESS', 10.0004)).toBe(10);
    expect(effectiveAmount('PENDING', 10)).toBe(0);
    expect(effectiveAmount('FAILED', 10)).toBe(0);
    expect(ledgerLines({ walletId: 'w', walletKind: 'CUSTOMER', movement: 'CREDIT', paymentMethod: 'CASH', currency: 'CDF', delta: 0 })).toEqual([]);
  });
});

describe('controls.util — trésorerie', () => {
  it('couverture OK / insuffisante', () => {
    const ok = coverage({ currency: 'USD', customerLiabilities: 1000, feeWallets: 50, branchCash: 300, providerFloat: 500, bankAndOther: 250 });
    expect(ok).toMatchObject({ liabilitiesTotal: 1050, assetsTotal: 1050, gap: 0, status: 'OK', coverageRatio: 100 });
    const ko = coverage({ currency: 'CDF', customerLiabilities: 1000, feeWallets: 0, branchCash: 100, providerFloat: 0, bankAndOther: 0 });
    expect(ko.status).toBe('SHORTFALL');
    expect(ko.gap).toBe(-900);
  });

  it('arrêté de caisse : équilibré, excédent, manquant', () => {
    expect(cashDifference(1000, 1000)).toEqual({ difference: 0, status: 'BALANCED' });
    expect(cashDifference(1000, 1000.5)).toEqual({ difference: 0.5, status: 'SURPLUS' });
    expect(cashDifference(1000, 990)).toEqual({ difference: -10, status: 'SHORTAGE' });
  });

  it('seuils par devise et statuts opérateur', () => {
    expect(parseCurrencyMap('cdf:5000000, USD:2000,bad,EUR:x')).toEqual({ CDF: 5000000, USD: 2000 });
    expect(providerDecision('COMPLETED')).toBe('COMPLETED');
    expect(providerDecision('rejected')).toBe('FAILED');
    expect(providerDecision('SUBMITTED')).toBe('WAIT');
    expect(providerDecision(null)).toBe('WAIT');
  });
});
