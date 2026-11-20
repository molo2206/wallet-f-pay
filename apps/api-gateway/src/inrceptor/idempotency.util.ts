// apps/api-gateway/src/inrceptor/idempotency.util.ts
import * as crypto from 'crypto';

/** Routes qui déplacent de l'argent (POST / PUT / PATCH) */
export const FINANCIAL_ROUTES: RegExp[] = [
  /^\/wallet\/(topup|cashout|send|pay|convert|credit|debit|transfer)\/?$/,
  /^\/wallet\/deposit\/(request|confirm|cancel|pawapay)\/?$/,
  /^\/api\/external\/(pay|send|salary|send\/parrainage|send\/taxi|pay\/mobile_money|cashout\/confirm)\/?$/,
  /^\/taxi\/driver\/(commission|cashout)\/?$/,
  /^\/admin\/wallet\/(topup|cashout|send|pay|validate-transfer|reconcile\/[^/]+)\/?$/,
  /^\/admin\/branches\/transfer-cash\/?$/,
  /^\/(topup|cashout)\/brute\/?$/,
];

export function isFinancialRoute(path: string): boolean {
  const p = String(path || '').split('?')[0];
  return FINANCIAL_ROUTES.some((r) => r.test(p));
}

/** JSON stable (clés triées) pour comparer deux corps de requête */
export function canonicalJson(value: any): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Clé fournie par le client : en-tête Idempotency-Key, sinon idempotencyKey / requestId du corps */
export function requestKeyOf(req: any): string | null {
  const h = req?.headers || {};
  const raw =
    h['idempotency-key'] ||
    h['x-idempotency-key'] ||
    req?.body?.idempotencyKey ||
    req?.body?.idempotency_key ||
    req?.body?.requestId ||
    null;
  if (raw === null || raw === undefined) return null;
  const key = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!key) return null;
  return key.slice(0, 150);
}

/** Propriétaire de la requête : utilisateur connecté, clé API ou, à défaut, empreinte de l'en-tête d'authentification */
export function ownerOf(req: any): string {
  const user = req?.currentUser || req?.user;
  if (user?.id) return `user:${user.id}`;
  if (req?.apiKey?.id) return `apikey:${req.apiKey.id}`;
  const auth = req?.headers?.authorization || req?.headers?.['x-api-key'] || req?.ip || 'anonymous';
  return `anon:${crypto.createHash('sha256').update(String(auth)).digest('hex').slice(0, 40)}`;
}
