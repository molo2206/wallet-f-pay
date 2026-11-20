// apps/api-gateway/src/controls/limits.util.ts
/**
 * ✅ Plafonds de transaction (règles pures, testées dans limits.util.spec.ts)
 *  Les plafonds sont exprimés dans une devise de référence (USD par défaut) : chaque opération et chaque
 *  consommation passée est convertie avec les taux de la table exchange_rate.
 */
import { round3 } from '@app/common';

export type Limits = {
  source: 'USER' | 'KYC_TIER' | 'DEFAULT';
  tier: string | null;
  currency: string;
  perTransaction: number | null;
  daily: number | null;
  monthly: number | null;
  yearly: number | null;
  monthlyCount: number | null;
};

export type Usage = { day: number; month: number; year: number; monthCount: number };

export type RateRow = { from_currency: string; to_currency: string; rate: number };

/** Même logique que wallet-service.getExchangeRate : direct, via USD, puis inverse. null si inconnu. */
export function convert(amount: number, from: string, to: string, rates: RateRow[]): number | null {
  const f = String(from || '').toUpperCase();
  const t = String(to || '').toUpperCase();
  if (!f || f === t) return amount;
  const map = new Map<string, number>();
  for (const r of rates) map.set(`${String(r.from_currency).toUpperCase()}-${String(r.to_currency).toUpperCase()}`, Number(r.rate));
  if (map.has(`${f}-${t}`)) return amount * map.get(`${f}-${t}`)!;
  if (map.has(`${f}-USD`) && map.has(`USD-${t}`)) return amount * map.get(`${f}-USD`)! * map.get(`USD-${t}`)!;
  const inv = map.get(`${t}-${f}`);
  if (inv && inv > 0) return amount / inv;
  // Via USD avec taux inverses
  const fu = map.get(`${f}-USD`) ?? (map.get(`USD-${f}`) ? 1 / map.get(`USD-${f}`)! : undefined);
  const ut = map.get(`USD-${t}`) ?? (map.get(`${t}-USD`) ? 1 / map.get(`${t}-USD`)! : undefined);
  if (fu !== undefined && ut !== undefined && Number.isFinite(fu) && Number.isFinite(ut)) return amount * fu * ut;
  return null;
}

/** Débuts de jour / mois / année dans le fuseau donné, en UTC */
export function periodStarts(now: Date, timeZone: string): { day: Date; month: Date; year: Date } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const localAsUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
  const offset = localAsUtc - Math.floor(now.getTime() / 1000) * 1000; // fuseau − UTC (ms)
  const at = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d) - offset);
  return { day: at(g('year'), g('month') - 1, g('day')), month: at(g('year'), g('month') - 1, 1), year: at(g('year'), 0, 1) };
}

/** Plafonds applicables : dérogation utilisateur > niveau KYC > valeurs par défaut */
export function resolveLimits(params: {
  kycStatus: string | null;
  tiers: Record<string, Partial<Limits>>;
  userOverride?: Partial<Limits> | null;
  referenceCurrency: string;
}): Limits {
  const status = String(params.kycStatus || 'NOT_SUBMITTED').toUpperCase();
  const base: Limits = {
    source: 'DEFAULT',
    tier: status,
    currency: params.referenceCurrency,
    perTransaction: null,
    daily: null,
    monthly: null,
    yearly: null,
    monthlyCount: null,
  };
  const tier = params.tiers[status] ?? params.tiers.DEFAULT;
  const merged: Limits = tier ? { ...base, ...stripNull(tier), source: 'KYC_TIER', tier: status, currency: params.referenceCurrency } : base;
  if (params.userOverride) {
    return { ...merged, ...stripNull(params.userOverride), source: 'USER', currency: params.referenceCurrency };
  }
  return merged;
}

function stripNull<T extends object>(o: T): Partial<T> {
  const out: any = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== '') out[k] = typeof v === 'string' && !isNaN(Number(v)) ? Number(v) : v;
  return out;
}

export type LimitViolation = {
  period: 'PER_TRANSACTION' | 'DAILY' | 'MONTHLY' | 'YEARLY' | 'MONTHLY_COUNT';
  limit: number;
  used: number;
  remaining: number;
};

/** Contrôle d'une opération (montant déjà converti en devise de référence) */
export function checkLimits(limits: Limits, usage: Usage, amountRef: number): LimitViolation | null {
  const a = round3(amountRef);
  if (limits.perTransaction !== null && a > limits.perTransaction + 0.0005) {
    return { period: 'PER_TRANSACTION', limit: limits.perTransaction, used: 0, remaining: round3(limits.perTransaction) };
  }
  const checks: [LimitViolation['period'], number | null, number][] = [
    ['DAILY', limits.daily, usage.day],
    ['MONTHLY', limits.monthly, usage.month],
    ['YEARLY', limits.yearly, usage.year],
  ];
  for (const [period, limit, used] of checks) {
    if (limit !== null && round3(used + a) > limit + 0.0005) {
      return { period, limit, used: round3(used), remaining: round3(Math.max(0, limit - used)) };
    }
  }
  if (limits.monthlyCount !== null && usage.monthCount + 1 > limits.monthlyCount) {
    return { period: 'MONTHLY_COUNT', limit: limits.monthlyCount, used: usage.monthCount, remaining: Math.max(0, limits.monthlyCount - usage.monthCount) };
  }
  return null;
}

const LABELS: Record<LimitViolation['period'], string> = {
  PER_TRANSACTION: 'par opération',
  DAILY: 'journalier',
  MONTHLY: 'mensuel',
  YEARLY: 'annuel',
  MONTHLY_COUNT: "nombre d'opérations du mois",
};

export function limitMessage(v: LimitViolation, currency: string, tier: string | null): string {
  if (v.period === 'MONTHLY_COUNT') {
    return `Plafond atteint : ${v.limit} opérations par mois autorisées pour votre compte. Faites vérifier votre identité (KYC) pour augmenter vos plafonds.`;
  }
  const base = `Plafond ${LABELS[v.period]} dépassé : ${v.limit.toFixed(3)} ${currency}`;
  const rest = v.period === 'PER_TRANSACTION' ? '' : ` (déjà utilisé ${v.used.toFixed(3)}, disponible ${v.remaining.toFixed(3)} ${currency})`;
  const kyc = tier && tier !== 'VERIFIED' ? ' Faites vérifier votre identité (KYC) pour augmenter vos plafonds.' : '';
  return `${base}${rest}.${kyc}`;
}
