// libs/common/src/money/account-currencies.ts
/**
 * ✅ DEVISES DE CHAQUE COMPTE
 *  Chaque compte F-Pay (client, marchand, caisse d'agence, wallet des frais) possède un wallet par devise
 *  de ACCOUNT_CURRENCIES (défaut : CDF,USD), en plus des devises de son pays (opérateurs Mobile Money).
 *  Ainsi un client peut recevoir, payer et convertir dans chaque devise, sans dépendre d'un seul wallet.
 */
export const WALLET_CURRENCIES = ['USD', 'EUR', 'CDF', 'XOF', 'XAF', 'KES', 'RWF', 'UGX', 'ZMW', 'SLE'];

export function configuredAccountCurrencies(raw: string | undefined = process.env.ACCOUNT_CURRENCIES): string[] {
  const list = String(raw ?? 'CDF,USD')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter((c) => WALLET_CURRENCIES.includes(c));
  return list.length ? [...new Set(list)] : ['CDF', 'USD'];
}

/** Devises à créer : devises obligatoires + devises du pays (valides uniquement, sans doublon, CDF/USD d'abord) */
export function requiredAccountCurrencies(countryCurrencies: string[] = [], raw?: string): string[] {
  const out: string[] = [];
  for (const c of [...configuredAccountCurrencies(raw), ...countryCurrencies.map((x) => String(x || '').trim().toUpperCase())]) {
    if (WALLET_CURRENCIES.includes(c) && !out.includes(c)) out.push(c);
  }
  return out;
}
