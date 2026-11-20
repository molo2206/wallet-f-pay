// apps/wallet-service/src/controls/controls.util.ts
/**
 * Règles pures (sans base de données) des contrôles financiers : grand livre, couverture, caisses.
 * Testées dans controls.util.spec.ts.
 */
import { round3 } from '@app/common';

export type WalletKind = 'CUSTOMER' | 'BRANCH_CASH' | 'SYSTEM_FEES';

/** Classification SQL d'un wallet (w = wallet, u = user) */
export const WALLET_KIND_SQL =
  // Wallets des frais : utilisateur system@fpay.com (frais réellement encaissés) ou ancien compte system-fee-account
  "CASE WHEN w.`userId` = 'system-fee-account' OR u.`email` = 'system@fpay.com' THEN 'SYSTEM_FEES' " +
  "WHEN w.`isBranchWallet` = 1 OR (u.`email` LIKE 'caisse.%' AND u.`branchId` IS NOT NULL AND u.`branchId` = w.`branchId`) THEN 'BRANCH_CASH' " +
  "ELSE 'CUSTOMER' END";

export type LedgerLine = {
  line: number;
  account: string;
  accountKind: 'WALLET_LIABILITY' | 'WALLET_ASSET' | 'CLEARING';
  walletId: string | null;
  debit: number;
  credit: number;
};

/** Compte de contrepartie : flux externe (Mobile Money, banque) ou compte de passage interne */
export function clearingAccount(paymentMethod: string | null | undefined, currency: string): string {
  const pm = String(paymentMethod || 'INTERNAL').toUpperCase();
  return `CLEARING:${pm}:${String(currency || 'N/A').toUpperCase()}`;
}

/**
 * Écritures d'un mouvement de wallet en partie double (somme des débits = somme des crédits).
 *  - Wallet client / frais = PASSIF (ce que la plateforme doit) : CREDIT de wallet → crédit du compte wallet.
 *  - Caisse d'agence = ACTIF (cash détenu) : CREDIT de caisse → débit du compte caisse.
 *  - La contrepartie est un compte de passage par moyen de paiement et devise : un virement interne
 *    (débit d'un wallet + crédit d'un autre) s'annule ; un solde restant = flux externe (Mobile Money, cash…).
 * delta > 0 : mouvement appliqué ; delta < 0 : correction / annulation (écritures inversées).
 */
export function ledgerLines(params: {
  walletId: string;
  walletKind: WalletKind;
  movement: 'CREDIT' | 'DEBIT';
  paymentMethod: string | null | undefined;
  currency: string;
  delta: number;
}): LedgerLine[] {
  const amount = round3(Math.abs(params.delta));
  if (amount === 0) return [];
  const isAsset = params.walletKind === 'BRANCH_CASH';
  // Le solde du wallet augmente-t-il ?
  const walletUp = (params.movement === 'CREDIT') === params.delta > 0;
  // Passif : hausse = crédit ; actif : hausse = débit
  const walletSideIsDebit = isAsset ? walletUp : !walletUp;
  const wallet: LedgerLine = {
    line: 1,
    account: `WALLET:${params.walletId}`,
    accountKind: isAsset ? 'WALLET_ASSET' : 'WALLET_LIABILITY',
    walletId: params.walletId,
    debit: walletSideIsDebit ? amount : 0,
    credit: walletSideIsDebit ? 0 : amount,
  };
  const counter: LedgerLine = {
    line: 2,
    account: clearingAccount(params.paymentMethod, params.currency),
    accountKind: 'CLEARING',
    walletId: null,
    debit: walletSideIsDebit ? 0 : amount,
    credit: walletSideIsDebit ? amount : 0,
  };
  return [wallet, counter];
}

/** Montant à refléter dans le grand livre pour une transaction (seules les transactions réussies comptent) */
export function effectiveAmount(status: string | null | undefined, amount: number | null | undefined): number {
  return String(status) === 'SUCCESS' ? round3(Number(amount) || 0) : 0;
}

/** Solde d'un compte wallet selon sa nature */
export function walletLedgerBalance(kind: WalletKind, debit: number, credit: number): number {
  return kind === 'BRANCH_CASH' ? round3(debit - credit) : round3(credit - debit);
}

export type CoverageInput = {
  currency: string;
  customerLiabilities: number;
  feeWallets: number;
  branchCash: number;
  providerFloat: number;
  bankAndOther: number;
};

/**
 * Couverture de la monnaie électronique pour une devise.
 *  Ce que la plateforme doit : soldes des clients (+ frais encaissés, qui restent dans les mêmes comptes).
 *  Ce qu'elle détient : cash des caisses + floats opérateurs + banque / autres comptes déclarés.
 *  OK si actifs ≥ dû ; SHORTFALL sinon.
 */
export function coverage(i: CoverageInput) {
  const liabilities = round3(i.customerLiabilities + i.feeWallets);
  const assets = round3(i.branchCash + i.providerFloat + i.bankAndOther);
  const gap = round3(assets - liabilities);
  return {
    currency: i.currency,
    customerLiabilities: round3(i.customerLiabilities),
    feeWallets: round3(i.feeWallets),
    liabilitiesTotal: liabilities,
    branchCash: round3(i.branchCash),
    providerFloat: round3(i.providerFloat),
    bankAndOther: round3(i.bankAndOther),
    assetsTotal: assets,
    gap,
    coverageRatio: liabilities > 0 ? Math.round((assets / liabilities) * 10000) / 100 : null,
    status: gap >= -0.001 ? 'OK' : 'SHORTFALL',
  };
}

/** Seuils « CDF:5000000,USD:2000 » → { CDF: 5000000, USD: 2000 } */
export function parseCurrencyMap(raw: string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of String(raw || '').split(',')) {
    const [cur, val] = part.split(':').map((x) => x?.trim());
    const n = Number(val);
    if (cur && Number.isFinite(n)) out[cur.toUpperCase()] = n;
  }
  return out;
}

/** Arrêté de caisse : écart compté − théorique (positif = excédent, négatif = manquant) */
export function cashDifference(expected: number, counted: number): { difference: number; status: 'BALANCED' | 'SURPLUS' | 'SHORTAGE' } {
  const difference = round3(Number(counted) - Number(expected));
  return { difference, status: Math.abs(difference) < 0.001 ? 'BALANCED' : difference > 0 ? 'SURPLUS' : 'SHORTAGE' };
}

/** Statut PawaPay → décision */
export function providerDecision(status: string | null | undefined): 'COMPLETED' | 'FAILED' | 'WAIT' {
  const s = String(status || '').toUpperCase();
  if (s === 'COMPLETED') return 'COMPLETED';
  if (['FAILED', 'REJECTED', 'CANCELED', 'CANCELLED', 'EXPIRED'].includes(s)) return 'FAILED';
  return 'WAIT';
}
