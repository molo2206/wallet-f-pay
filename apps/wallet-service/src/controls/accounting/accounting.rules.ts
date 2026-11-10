// apps/wallet-service/src/controls/accounting/accounting.rules.ts
/**
 * ✅ COMPTABILITÉ SYSCOHADA (OHADA) — règles pures, sans base de données (testées dans accounting.rules.spec.ts)
 *
 *  Chaque transaction RÉUSSIE d'un wallet devient une écriture équilibrée (débit = crédit) :
 *   - wallet client       → 4191 Clients – fonds de monnaie électronique (PASSIF : ce que F-Pay doit aux clients)
 *   - wallet marchand     → 4192 Marchands – fonds de monnaie électronique (PASSIF)
 *   - caisse d'agence     → 5711 Caisses des agences (ACTIF : cash détenu)
 *   - wallet des frais    → 706x Produits (REVENU de F-Pay)
 *   - contrepartie selon le moyen de paiement : 5311 opérateurs Mobile Money, 5211 banque, 5851 virements internes,
 *     5852 conversions de devises, 5312 partenaires API.
 *  Frais « implicites » (déduits du montant sans passer par le wallet des frais) : reconnus en produit
 *   (dépôts Mobile Money, retraits Mobile Money, paiements internationaux 1 %).
 *  Coûts opérateur estimés (taux configurés) : 6318 Commissions des opérateurs Mobile Money / 5311.
 */
import { round3 } from '@app/common';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

/** Plan comptable SYSCOHADA révisé — comptes utilisés par F-Pay (sous-comptes à 4 chiffres) */
export const SYSCOHADA_ACCOUNTS: { code: string; label: string; type: AccountType }[] = [
  // Classe 1 — Capitaux
  { code: '101', label: 'Capital social', type: 'EQUITY' },
  { code: '121', label: 'Report à nouveau créditeur', type: 'EQUITY' },
  { code: '129', label: 'Report à nouveau débiteur', type: 'EQUITY' },
  { code: '131', label: 'Résultat net : bénéfice', type: 'EQUITY' },
  { code: '139', label: 'Résultat net : perte', type: 'EQUITY' },
  // Classe 4 — Tiers
  { code: '4011', label: 'Fournisseurs – opérateurs Mobile Money', type: 'LIABILITY' },
  { code: '4191', label: 'Clients – fonds de monnaie électronique', type: 'LIABILITY' },
  { code: '4192', label: 'Marchands – fonds de monnaie électronique', type: 'LIABILITY' },
  { code: '421', label: 'Personnel, rémunérations dues', type: 'LIABILITY' },
  { code: '441', label: 'État, impôt sur les bénéfices', type: 'LIABILITY' },
  { code: '443', label: 'État, TVA facturée', type: 'LIABILITY' },
  { code: '4711', label: "Compte d'attente – opérations à analyser", type: 'LIABILITY' },
  // Classe 5 — Trésorerie
  { code: '5211', label: 'Banques locales', type: 'ASSET' },
  { code: '5311', label: 'Opérateurs Mobile Money (PawaPay)', type: 'ASSET' },
  { code: '5312', label: 'Partenaires API – encaissements', type: 'ASSET' },
  { code: '5711', label: 'Caisses des agences', type: 'ASSET' },
  { code: '5712', label: 'Caisse siège', type: 'ASSET' },
  { code: '5851', label: 'Virements internes de fonds (compensation)', type: 'ASSET' },
  { code: '5852', label: 'Compensation des conversions de devises', type: 'ASSET' },
  // Classe 6 — Charges
  { code: '6318', label: 'Commissions des opérateurs Mobile Money', type: 'EXPENSE' },
  { code: '631', label: 'Frais bancaires', type: 'EXPENSE' },
  { code: '622', label: 'Locations et charges locatives', type: 'EXPENSE' },
  { code: '624', label: 'Entretien, réparations et maintenance', type: 'EXPENSE' },
  { code: '628', label: 'Frais de télécommunications', type: 'EXPENSE' },
  { code: '632', label: "Rémunérations d'intermédiaires et de conseils", type: 'EXPENSE' },
  { code: '6371', label: 'Frais de SMS et notifications', type: 'EXPENSE' },
  { code: '641', label: 'Impôts et taxes directs', type: 'EXPENSE' },
  { code: '661', label: 'Rémunérations directes du personnel', type: 'EXPENSE' },
  { code: '6588', label: 'Autres charges diverses', type: 'EXPENSE' },
  { code: '676', label: 'Pertes de change', type: 'EXPENSE' },
  // Classe 7 — Produits
  { code: '7061', label: 'Commissions sur dépôts Mobile Money', type: 'REVENUE' },
  { code: '7062', label: 'Commissions sur retraits', type: 'REVENUE' },
  { code: '7063', label: 'Frais de transfert national', type: 'REVENUE' },
  { code: '7064', label: 'Frais de transfert et paiement international', type: 'REVENUE' },
  { code: '7065', label: 'Frais de tenue de compte (maintenance)', type: 'REVENUE' },
  { code: '7066', label: 'Commissions de parrainage', type: 'REVENUE' },
  { code: '7067', label: 'Commissions sur paiements taxi', type: 'REVENUE' },
  { code: '7068', label: 'Autres commissions et frais de service', type: 'REVENUE' },
  { code: '758', label: 'Produits divers', type: 'REVENUE' },
  { code: '776', label: 'Gains de change', type: 'REVENUE' },
];

export const ACCOUNT_LABEL: Record<string, string> = Object.fromEntries(SYSCOHADA_ACCOUNTS.map((a) => [a.code, a.label]));

/** Nature d'un compte d'après sa classe SYSCOHADA (comptes ajoutés par l'utilisateur compris) */
export function accountType(code: string): AccountType {
  const known = SYSCOHADA_ACCOUNTS.find((a) => a.code === code);
  if (known) return known.type;
  const c = String(code)[0];
  if (c === '1') return 'EQUITY';
  if (c === '2' || c === '3' || c === '5') return 'ASSET';
  if (c === '6' || c === '8') return 'EXPENSE';
  if (c === '7') return 'REVENUE';
  // Classe 4 : clients (41) et débiteurs divers (46, 47 débiteurs) sont plutôt actifs ; on garde PASSIF par défaut
  return String(code).startsWith('41') && !String(code).startsWith('419') ? 'ASSET' : 'LIABILITY';
}

export type WalletKind = 'CUSTOMER' | 'MERCHANT' | 'BRANCH_CASH' | 'SYSTEM_FEES';

/** Produit (706x) d'après le libellé d'un crédit sur le wallet des frais (libellés en plusieurs langues) */
export function revenueAccountFromDescription(description: string | null | undefined): string {
  const d = String(description || '').toLowerCase();
  if (/maintenance|matengenezo|mantenimiento|الصيانة|tenue de compte/.test(d)) return '7065';
  if (/parrainage|referral/.test(d)) return '7066';
  if (/taxi/.test(d)) return '7067';
  if (/international/.test(d)) return '7064';
  if (/transfert|transfer/.test(d)) return '7063';
  if (/retrait|withdraw|cashout/.test(d)) return '7062';
  if (/dépôt|depot|deposit|recharge|top.?up/.test(d)) return '7061';
  return '7068';
}

/** Compte de contrepartie selon le moyen de paiement */
export function counterpartAccount(paymentMethod: string | null | undefined, isFx: boolean): string {
  if (isFx) return '5852';
  switch (String(paymentMethod || 'INTERNAL').toUpperCase()) {
    case 'MOBILE_MONEY':
      return '5311';
    case 'BANK_TRANSFERT':
    case 'CREDIT_DEBIT_CARD':
      return '5211';
    case 'EXTERNAL_API':
      return '5312';
    default:
      return '5851'; // CASH (compensé par la caisse d'agence), INTERNAL…
  }
}

/** Journal SYSCOHADA (code à 2 lettres) */
export function journalFor(paymentMethod: string | null | undefined, walletKind: WalletKind, isFx: boolean): string {
  if (walletKind === 'SYSTEM_FEES') return 'PR';
  if (isFx) return 'CH';
  const pm = String(paymentMethod || '').toUpperCase();
  if (pm === 'MOBILE_MONEY') return 'MM';
  if (pm === 'CASH' || walletKind === 'BRANCH_CASH') return 'CA';
  if (pm === 'BANK_TRANSFERT' || pm === 'CREDIT_DEBIT_CARD') return 'BQ';
  return 'VI';
}

export const JOURNALS: Record<string, string> = {
  MM: 'Opérations Mobile Money',
  CA: 'Caisses des agences',
  VI: 'Virements internes',
  PR: 'Produits (commissions et frais)',
  CH: 'Conversions de devises',
  BQ: 'Banque',
  OD: 'Opérations diverses (écritures manuelles)',
};

/**
 * Frais implicites d'une transaction (déduits du montant, sans crédit sur le wallet des frais).
 *  - Dépôt Mobile Money : « frais X% : Y CDF déduits » ou métadonnées PAWAPAY_DEPOSIT
 *  - Retrait Mobile Money : montant débité − « Net reçu »
 *  - Paiement international : « frais internationaux 1%: Y »
 */
export function implicitFee(t: {
  type: string | null;
  movement: string;
  paymentMethod: string | null;
  amount: number;
  description: string | null;
  external_reference?: string | null;
}): { account: string; fee: number } | null {
  const type = String(t.type || '').toUpperCase();
  const pm = String(t.paymentMethod || '').toUpperCase();
  const desc = String(t.description || '');
  const amount = Number(t.amount) || 0;
  let meta: any = null;
  try {
    meta = t.external_reference && String(t.external_reference).startsWith('{') ? JSON.parse(String(t.external_reference)) : null;
  } catch {
    meta = null;
  }
  const num = (s: string | undefined) => {
    const n = Number(String(s ?? '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  };

  if (type === 'DEPOSIT' && t.movement === 'CREDIT' && pm === 'MOBILE_MONEY') {
    let fee = meta?.kind === 'PAWAPAY_DEPOSIT' ? num(meta.feeAmount) : 0;
    if (!fee) {
      const m = desc.match(/frais\s+[\d.,]+\s*%\s*:\s*([\d.,]+)\s*[A-Z]{3}\s+d[ée]duits/i);
      if (m) fee = num(m[1]);
    }
    return fee > 0 ? { account: '7061', fee: round3(fee) } : null;
  }
  if (type === 'WITHDRAW' && t.movement === 'DEBIT' && pm === 'MOBILE_MONEY') {
    const m = desc.match(/Net re[çc]u\s*:\s*([\d.,]+)/i);
    if (m) {
      const fee = round3(amount - num(m[1]));
      if (fee > 0 && fee < amount) return { account: '7062', fee };
    }
    const f = desc.match(/frais PawaPay\s+[\d.,]+\s*%\s*:\s*([\d.,]+)/i);
    if (f && num(f[1]) > 0 && num(f[1]) < amount) return { account: '7062', fee: round3(num(f[1])) };
    return null;
  }
  if (type === 'PAYMENT' && t.movement === 'DEBIT') {
    const m = desc.match(/frais internationaux\s+[\d.,]+\s*%\s*:\s*([\d.,]+)/i);
    if (m && num(m[1]) > 0 && num(m[1]) < amount) return { account: '7064', fee: round3(num(m[1])) };
  }
  return null;
}

export type AccountingLine = { account: string; debit: number; credit: number; label?: string };

/**
 * Écriture d'une transaction de wallet (montant effectif delta : > 0 = mouvement, < 0 = annulation / correction).
 * providerCostRate : % estimé facturé par l'opérateur sur ce flux Mobile Money (0 = pas d'estimation).
 */
export function entryLines(params: {
  walletKind: WalletKind;
  movement: 'CREDIT' | 'DEBIT';
  paymentMethod: string | null;
  isFx: boolean;
  delta: number;
  description: string | null;
  fee: { account: string; fee: number } | null;
  providerCost?: number;
}): AccountingLine[] {
  const amount = round3(Math.abs(params.delta));
  if (amount === 0) return [];
  const sign = params.delta > 0 ? 1 : -1;
  const lines: AccountingLine[] = [];
  // Ligne « normale » (delta > 0) puis inversée si annulation
  const push = (account: string, debit: number, credit: number, label?: string) => {
    if (debit === 0 && credit === 0) return;
    lines.push(sign > 0 ? { account, debit: round3(debit), credit: round3(credit), label } : { account, debit: round3(credit), credit: round3(debit), label });
  };
  const counter = counterpartAccount(params.paymentMethod, params.isFx);

  if (params.walletKind === 'SYSTEM_FEES') {
    if (params.movement === 'CREDIT') {
      // Frais encaissés par F-Pay
      const revenue = revenueAccountFromDescription(params.description);
      push(counter, amount, 0);
      push(revenue, 0, amount, 'Frais encaissés');
    } else {
      // Sortie de fonds du wallet des frais : à analyser par le comptable
      push('4711', amount, 0, 'Sortie du wallet des frais (à analyser)');
      push(counter, 0, amount);
    }
    return lines;
  }

  const walletAccount = params.walletKind === 'BRANCH_CASH' ? '5711' : params.walletKind === 'MERCHANT' ? '4192' : '4191';
  const isAsset = params.walletKind === 'BRANCH_CASH';
  const fee = params.fee && params.fee.fee > 0 && params.fee.fee < amount ? round3(params.fee.fee) : 0;

  if (params.movement === 'CREDIT') {
    if (isAsset) {
      // Cash reçu en caisse
      push(walletAccount, amount, 0);
      push(counter, 0, amount);
    } else {
      // Client crédité ; s'il y a des frais déduits, l'opérateur a reçu le brut (net + frais)
      push(counter, amount + fee, 0);
      push(walletAccount, 0, amount);
      if (fee) push(params.fee!.account, 0, fee, 'Frais déduits');
    }
  } else {
    if (isAsset) {
      push(counter, amount, 0);
      push(walletAccount, 0, amount);
    } else {
      // Client débité du total ; frais conservés par F-Pay, le reste sort vers la contrepartie
      push(walletAccount, amount, 0);
      push(counter, 0, amount - fee);
      if (fee) push(params.fee!.account, 0, fee, 'Frais retenus');
    }
  }

  // Coût estimé de l'opérateur Mobile Money (prélevé sur le float)
  const cost = round3(params.providerCost || 0);
  if (cost > 0 && counter === '5311') {
    push('6318', cost, 0, 'Commission opérateur (estimation)');
    push('5311', 0, cost, 'Commission opérateur (estimation)');
  }
  return lines;
}

export function isBalanced(lines: AccountingLine[]): boolean {
  const d = lines.reduce((s, l) => s + l.debit, 0);
  const c = lines.reduce((s, l) => s + l.credit, 0);
  return Math.abs(round3(d - c)) < 0.001;
}

/** Contrôle d'une écriture manuelle : comptes, montants positifs, équilibre */
export function validateManualLines(lines: any[], knownAccounts: Set<string>): string | null {
  if (!Array.isArray(lines) || lines.length < 2) return 'Une écriture comporte au moins deux lignes';
  if (lines.length > 50) return 'Une écriture comporte au plus 50 lignes';
  for (const l of lines) {
    if (!knownAccounts.has(String(l?.account))) return `Compte inconnu : ${l?.account}`;
    const d = Number(l?.debit || 0);
    const c = Number(l?.credit || 0);
    if (!Number.isFinite(d) || !Number.isFinite(c) || d < 0 || c < 0) return 'Montants invalides';
    if ((d > 0 && c > 0) || (d === 0 && c === 0)) return 'Chaque ligne doit avoir soit un débit, soit un crédit';
  }
  if (!isBalanced(lines.map((l) => ({ account: l.account, debit: round3(l.debit || 0), credit: round3(l.credit || 0) })))) {
    return "L'écriture n'est pas équilibrée : total débit ≠ total crédit";
  }
  return null;
}

/** Coût opérateur estimé : % × montant opéré (+ fixe) */
export function providerCost(rates: { operation: string; currency: string; percentage: number; fixed_fee: number }[], op: 'DEPOSIT' | 'PAYOUT', currency: string, base: number): number {
  const r =
    rates.find((x) => x.operation === op && String(x.currency).toUpperCase() === String(currency).toUpperCase()) ??
    rates.find((x) => x.operation === op && x.currency === '*');
  if (!r) return 0;
  return round3((Number(base) * Number(r.percentage || 0)) / 100 + Number(r.fixed_fee || 0));
}
