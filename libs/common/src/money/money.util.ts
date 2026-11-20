// libs/common/src/money/money.util.ts
/**
 * ✅ MONTANTS À 3 DÉCIMALES (règle unique pour tout F-Pay)
 *
 *  - Les calculs se font en pleine précision ; on n'arrondit QU'AU MOMENT d'enregistrer ou d'afficher.
 *  - Arrondi « demi-supérieur » symétrique (10.0005 → 10.001 ; -10.0005 → -10.001), corrigé des
 *    imprécisions binaires (1.0005 est stocké 1.000499999… : on l'arrondit bien à 1.001).
 *  - Additions / soustractions de montants : en millièmes entiers (aucune dérive 0.1 + 0.2).
 *  - Affichage : toujours 3 décimales (10 → "10.000", 10.5 → "10.500", 1250.789 → "1250.789").
 */
export const MONEY_DECIMALS = 3;
const FACTOR = 10 ** MONEY_DECIMALS;

/** Arrondit un montant à 3 décimales (null / NaN → 0) */
export function round3(value: number | string | null | undefined): number {
  const n = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  // toPrecision(15) élimine le bruit binaire avant l'arrondi
  const abs = Number(Math.abs(n).toPrecision(15));
  const r = Math.round(abs * FACTOR + 1e-9) / FACTOR;
  return r === 0 ? 0 : sign * r;
}

/** Convertit en millièmes entiers (pour additionner sans erreur) */
export function toMilli(value: number | string | null | undefined): number {
  return Math.round(round3(value) * FACTOR);
}

export function fromMilli(milli: number): number {
  return round3(milli / FACTOR);
}

/** Somme exacte de montants (arrondis à 3 décimales) */
export function sumMoney(...values: Array<number | string | null | undefined>): number {
  return fromMilli(values.reduce<number>((acc, v) => acc + toMilli(v), 0));
}

/** a - b exact à 3 décimales */
export function subMoney(a: number | string, b: number | string): number {
  return fromMilli(toMilli(a) - toMilli(b));
}

/** Pourcentage d'un montant (le résultat seul est arrondi) */
export function percentOf(amount: number, percent: number): number {
  return round3((Number(amount) * Number(percent)) / 100);
}

/** Texte à 3 décimales, point décimal, sans séparateur de milliers : "10.000" */
export function formatMoney3(value: number | string | null | undefined): string {
  return round3(value).toFixed(MONEY_DECIMALS);
}

/** Valide qu'une saisie a au plus 3 décimales (ex. 10.2567 refusé) */
export function hasAtMost3Decimals(value: number | string): boolean {
  const s = String(value).trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return false;
  const dec = s.split('.')[1] || '';
  return dec.replace(/0+$/, '').length <= MONEY_DECIMALS;
}

/** Noms de champs considérés comme des montants dans les réponses API */
export const MONEY_KEY_RE =
  /^(amount|balance|fee|fees|total|subtotal|net|gross|commission|solde|montant|frais|price|cost|limit|debit|credit)$|(amount|balance|fee|fees|total|commission|limit|Amount|Balance|Fee|Fees|Total|Commission|Limit|_limit|Debit|Credit|Net|Price|Cost|_amount|_balance|_fee)$/;

/** Exclusions : taux, pourcentages, coordonnées, compteurs… (jamais arrondis à 3 décimales) */
export const NON_MONEY_KEY_RE = /(rate|Rate|percent|Percent|percentage|pourcentage|multiplier|count|Count|lat|lng|latitude|longitude|page|limit$|Limit$|_limit$)/;

/** Un champ est-il un montant ? (les « limit » sont des montants de plafond : traités à part) */
export function isMoneyKey(key: string): boolean {
  if (/(daily|monthly|yearly|per_transaction)_limit$|(daily|monthly|yearly|perTransaction)Limit$/.test(key)) return true;
  if (NON_MONEY_KEY_RE.test(key)) return false;
  return MONEY_KEY_RE.test(key);
}

/**
 * Arrondit récursivement les montants d'un objet de réponse (copie ; l'original n'est pas modifié).
 * withFormatted = true ajoute « <champ>Formatted: "10.000" » à côté de chaque montant.
 */
export function roundMoneyFields<T = any>(input: T, withFormatted = false, depth = 0): T {
  if (input === null || input === undefined || depth > 12) return input;
  if (Array.isArray(input)) return input.map((v) => roundMoneyFields(v, withFormatted, depth + 1)) as any;
  if (input instanceof Date || typeof input !== 'object') return input;
  if (typeof (input as any).toJSON === 'function' && !(input.constructor === Object)) {
    // Decimal Prisma, Buffer… : laissés tels quels
    return input;
  }
  const out: any = {};
  // Objet de pagination : « total » est un nombre d'éléments, pas un montant
  const paginated = 'totalPages' in (input as any) || 'page' in (input as any);
  for (const [k, v] of Object.entries(input as any)) {
    if (typeof v === 'number' && Number.isFinite(v) && isMoneyKey(k) && !(paginated && k === 'total')) {
      out[k] = round3(v);
      if (withFormatted && !(`${k}Formatted` in (input as any))) out[`${k}Formatted`] = formatMoney3(v);
    } else {
      out[k] = roundMoneyFields(v, withFormatted, depth + 1);
    }
  }
  return out;
}

export type ExchangeRateRow = { from_currency: string; to_currency: string; rate: number };

/** Conversion avec les taux de la table exchange_rate : direct, via USD, inverse (null si aucun taux) */
export function convertWithRates(amount: number, from: string, to: string, rates: ExchangeRateRow[]): number | null {
  const f = String(from || '').toUpperCase();
  const t = String(to || '').toUpperCase();
  if (!f || f === t) return amount;
  const map = new Map<string, number>();
  for (const r of rates) map.set(`${String(r.from_currency).toUpperCase()}-${String(r.to_currency).toUpperCase()}`, Number(r.rate));
  if (map.has(`${f}-${t}`)) return amount * map.get(`${f}-${t}`)!;
  if (map.has(`${f}-USD`) && map.has(`USD-${t}`)) return amount * map.get(`${f}-USD`)! * map.get(`USD-${t}`)!;
  const inv = map.get(`${t}-${f}`);
  if (inv && inv > 0) return amount / inv;
  const fu = map.get(`${f}-USD`) ?? (map.get(`USD-${f}`) ? 1 / map.get(`USD-${f}`)! : undefined);
  const ut = map.get(`USD-${t}`) ?? (map.get(`${t}-USD`) ? 1 / map.get(`${t}-USD`)! : undefined);
  if (fu !== undefined && ut !== undefined && Number.isFinite(fu) && Number.isFinite(ut)) return amount * fu * ut;
  return null;
}
