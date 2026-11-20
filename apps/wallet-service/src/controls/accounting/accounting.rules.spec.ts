import { accountType, entryLines, implicitFee, isBalanced, journalFor, providerCost, revenueAccountFromDescription, validateManualLines } from './accounting.rules';

describe('comptabilité SYSCOHADA — règles', () => {
  it('classe les frais encaissés par nature de produit (706x)', () => {
    expect(revenueAccountFromDescription('Frais de transfert international (2%) - A → B')).toBe('7064');
    expect(revenueAccountFromDescription('Frais de transfert national - A → B')).toBe('7063');
    expect(revenueAccountFromDescription('Frais maintenance reçus de Jean (2 USD)')).toBe('7065');
    expect(revenueAccountFromDescription('Ada ya matengenezo imepokelewa')).toBe('7065');
    expect(revenueAccountFromDescription('Frais de parrainage international (1%)')).toBe('7066');
    expect(revenueAccountFromDescription('Frais de paiement taxi international')).toBe('7067');
    expect(revenueAccountFromDescription('Divers')).toBe('7068');
  });

  it('reconnaît les frais implicites (dépôt, retrait, paiement international)', () => {
    expect(
      implicitFee({ type: 'DEPOSIT', movement: 'CREDIT', paymentMethod: 'MOBILE_MONEY', amount: 9700, description: 'Dépôt (frais 3% : 300.000 CDF déduits) - Net crédité: 9700.000 CDF' }),
    ).toEqual({ account: '7061', fee: 300 });
    expect(
      implicitFee({ type: 'DEPOSIT', movement: 'CREDIT', paymentMethod: 'MOBILE_MONEY', amount: 97, description: 'x', external_reference: JSON.stringify({ kind: 'PAWAPAY_DEPOSIT', feeAmount: 3 }) }),
    ).toEqual({ account: '7061', fee: 3 });
    expect(implicitFee({ type: 'WITHDRAW', movement: 'DEBIT', paymentMethod: 'MOBILE_MONEY', amount: 1000, description: 'Retrait (frais PawaPay 2%: 20.000 CDF) - Net reçu: 980.000 CDF' })).toEqual({
      account: '7062',
      fee: 20,
    });
    expect(implicitFee({ type: 'PAYMENT', movement: 'DEBIT', paymentMethod: 'INTERNAL', amount: 101, description: 'Paiement (frais internationaux 1%: 1 USD)' })).toEqual({ account: '7064', fee: 1 });
    expect(implicitFee({ type: 'TRANSFER', movement: 'DEBIT', paymentMethod: 'INTERNAL', amount: 100, description: 'Envoi (frais: 2 USD)' })).toBeNull();
  });

  it('dépôt Mobile Money avec frais : opérateur au brut, client au net, produit 7061', () => {
    const l = entryLines({ walletKind: 'CUSTOMER', movement: 'CREDIT', paymentMethod: 'MOBILE_MONEY', isFx: false, delta: 970, description: '', fee: { account: '7061', fee: 30 } });
    expect(l).toEqual([
      { account: '5311', debit: 1000, credit: 0, label: undefined },
      { account: '4191', debit: 0, credit: 970, label: undefined },
      { account: '7061', debit: 0, credit: 30, label: 'Frais déduits' },
    ]);
    expect(isBalanced(l)).toBe(true);
  });

  it('retrait avec frais et commission opérateur estimée', () => {
    const l = entryLines({ walletKind: 'CUSTOMER', movement: 'DEBIT', paymentMethod: 'MOBILE_MONEY', isFx: false, delta: 1000, description: '', fee: { account: '7062', fee: 20 }, providerCost: 9.8 });
    expect(isBalanced(l)).toBe(true);
    expect(l.find((x) => x.account === '7062')!.credit).toBe(20);
    expect(l.find((x) => x.account === '6318')!.debit).toBe(9.8);
    expect(l.filter((x) => x.account === '5311').reduce((s, x) => s + x.credit, 0)).toBe(989.8);
  });

  it('frais encaissés dans le wallet des frais = produit ; marchand = 4192 ; caisse = 5711', () => {
    expect(entryLines({ walletKind: 'SYSTEM_FEES', movement: 'CREDIT', paymentMethod: 'MOBILE_MONEY', isFx: false, delta: 5, description: 'Frais de transfert international', fee: null })).toEqual([
      { account: '5311', debit: 5, credit: 0, label: undefined },
      { account: '7064', debit: 0, credit: 5, label: 'Frais encaissés' },
    ]);
    expect(entryLines({ walletKind: 'MERCHANT', movement: 'CREDIT', paymentMethod: 'INTERNAL', isFx: false, delta: 10, description: '', fee: null })[1].account).toBe('4192');
    expect(entryLines({ walletKind: 'BRANCH_CASH', movement: 'CREDIT', paymentMethod: 'CASH', isFx: false, delta: 10, description: '', fee: null })[0]).toMatchObject({ account: '5711', debit: 10 });
  });

  it('recharge au guichet : le compte de passage 5851 s’annule (client + caisse)', () => {
    const lines = [
      ...entryLines({ walletKind: 'CUSTOMER', movement: 'CREDIT', paymentMethod: 'CASH', isFx: false, delta: 100, description: '', fee: null }),
      ...entryLines({ walletKind: 'BRANCH_CASH', movement: 'CREDIT', paymentMethod: 'CASH', isFx: false, delta: 100, description: '', fee: null }),
    ];
    const net = lines.filter((x) => x.account === '5851').reduce((s, x) => s + x.debit - x.credit, 0);
    expect(net).toBe(0);
  });

  it('annulation = écriture inverse', () => {
    const a = entryLines({ walletKind: 'CUSTOMER', movement: 'DEBIT', paymentMethod: 'MOBILE_MONEY', isFx: false, delta: 50, description: '', fee: { account: '7062', fee: 1 } });
    const b = entryLines({ walletKind: 'CUSTOMER', movement: 'DEBIT', paymentMethod: 'MOBILE_MONEY', isFx: false, delta: -50, description: '', fee: { account: '7062', fee: 1 } });
    for (let i = 0; i < a.length; i++) {
      expect(b[i].debit).toBe(a[i].credit);
      expect(b[i].credit).toBe(a[i].debit);
    }
  });

  it('journaux, nature des comptes, coût opérateur, écritures manuelles', () => {
    expect(journalFor('MOBILE_MONEY', 'CUSTOMER', false)).toBe('MM');
    expect(journalFor('CASH', 'CUSTOMER', false)).toBe('CA');
    expect(journalFor('MOBILE_MONEY', 'SYSTEM_FEES', false)).toBe('PR');
    expect(journalFor('MOBILE_MONEY', 'CUSTOMER', true)).toBe('CH');
    expect(accountType('7061')).toBe('REVENUE');
    expect(accountType('6221')).toBe('EXPENSE');
    expect(accountType('4191')).toBe('LIABILITY');
    expect(accountType('5211')).toBe('ASSET');
    const rates = [
      { operation: 'PAYOUT', currency: '*', percentage: 1, fixed_fee: 0 },
      { operation: 'PAYOUT', currency: 'CDF', percentage: 1.5, fixed_fee: 0 },
    ];
    expect(providerCost(rates, 'PAYOUT', 'CDF', 1000)).toBe(15);
    expect(providerCost(rates, 'PAYOUT', 'USD', 100)).toBe(1);
    expect(providerCost(rates, 'DEPOSIT', 'USD', 100)).toBe(0);
    const known = new Set(['6318', '5311']);
    expect(validateManualLines([{ account: '6318', debit: 10 }, { account: '5311', credit: 10 }], known)).toBeNull();
    expect(validateManualLines([{ account: '6318', debit: 10 }, { account: '5311', credit: 9 }], known)).toContain('équilibrée');
    expect(validateManualLines([{ account: '9999', debit: 10 }, { account: '5311', credit: 10 }], known)).toContain('inconnu');
  });
});
