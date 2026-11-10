// apps/api-gateway/src/maintenance/maintenance.util.ts
/**
 * ✅ Règles pures du mode maintenance (testées dans maintenance.util.spec.ts)
 */

export type MaintenanceScope = 'FULL' | 'READ_ONLY' | 'MODULES';

/** Modules pouvant être mis en maintenance séparément */
export const MAINTENANCE_MODULES = [
  'LOGIN',
  'REGISTRATION',
  'DEPOSITS',
  'WITHDRAWALS',
  'TRANSFERS',
  'PAYMENTS',
  'CONVERSION',
  'EXTERNAL_API',
  'KYC',
  'CASH_DESK',
] as const;
export type MaintenanceModule = (typeof MAINTENANCE_MODULES)[number];

export type MaintenanceWindow = {
  id: string;
  title: string;
  messages: Record<string, string>;
  scope: MaintenanceScope;
  modules: string[];
  startsAt: Date;
  endsAt: Date | null;
  status: string;
  allowRoles: string[];
  allowUserIds: string[];
  allowIps: string[];
  legacy?: boolean;
};

/** Correspondance route → module (méthodes d'écriture ; LOGIN/REGISTRATION quelle que soit la méthode) */
const MODULE_ROUTES: [MaintenanceModule, RegExp][] = [
  ['LOGIN', /^\/auth\/(login|verify-otp|send-otp|link-user|fpay\/link-user|fpay\/send-otp|fpay\/verify-otp|generate-token|verify-token|send-reset-otp|reset-password)/],
  ['REGISTRATION', /^\/auth\/register|^\/users\/?$|^\/auth\/signup/],
  ['DEPOSITS', /^\/wallet\/(topup|deposit)|^\/admin\/wallet\/topup|^\/api\/external\/pay\/mobile_money|^\/topup\/brute/],
  ['WITHDRAWALS', /^\/wallet\/cashout|^\/admin\/wallet\/cashout|^\/api\/external\/cashout|^\/taxi\/driver\/cashout|^\/cashout\/brute/],
  ['TRANSFERS', /^\/wallet\/(send|transfer)|^\/admin\/wallet\/(send|validate-transfer)|^\/api\/external\/(send|salary)|^\/admin\/branches\/transfer-cash/],
  ['PAYMENTS', /^\/wallet\/pay|^\/admin\/wallet\/pay|^\/api\/external\/pay(?!\/mobile_money)|^\/taxi\/driver\/commission/],
  ['CONVERSION', /^\/wallet\/convert/],
  ['EXTERNAL_API', /^\/api\/external\//],
  ['KYC', /^\/users\/kyc|^\/admin\/kyc/],
  ['CASH_DESK', /^\/admin\/wallet\/|^\/admin\/branches\/|^\/admin\/cash-closings/],
];

/** Routes jamais bloquées (consultation du statut, gestion de la maintenance, déconnexion) */
const ALWAYS_ALLOWED = /^\/maintenance\/status|^\/admin\/maintenance(\/|$)|^\/auth\/logout|^\/health|^\/admin\/settings\/app$/;

export function modulesOfRoute(method: string, path: string): MaintenanceModule[] {
  const m = String(method || 'GET').toUpperCase();
  const p = String(path || '').split('?')[0];
  const write = m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
  const out: MaintenanceModule[] = [];
  for (const [mod, re] of MODULE_ROUTES) {
    if (!re.test(p)) continue;
    // Connexion / inscription : bloquées quelle que soit la méthode ; les autres modules seulement en écriture
    if (mod === 'LOGIN' || mod === 'REGISTRATION' || write) out.push(mod);
  }
  return out;
}

export type Requester = {
  method: string;
  path: string;
  ip?: string | null;
  role?: string | null;
  userId?: string | null;
};

/** La fenêtre est-elle en cours à cet instant ? */
export function isActive(w: MaintenanceWindow, now: Date = new Date()): boolean {
  if (['CANCELLED', 'ENDED'].includes(w.status)) return false;
  if (w.startsAt.getTime() > now.getTime()) return false;
  if (w.endsAt && w.endsAt.getTime() <= now.getTime()) return false;
  return true;
}

/** Le demandeur est-il exempté (rôle, compte ou adresse IP autorisés) ? */
export function isExempt(w: MaintenanceWindow, r: Requester): boolean {
  if (r.role && w.allowRoles.map((x) => x.toUpperCase()).includes(String(r.role).toUpperCase())) return true;
  if (r.userId && w.allowUserIds.includes(r.userId)) return true;
  const ip = normalizeIp(r.ip);
  if (ip && w.allowIps.map(normalizeIp).includes(ip)) return true;
  return false;
}

export function normalizeIp(ip?: string | null): string {
  return String(ip || '')
    .trim()
    .replace(/^::ffff:/, '');
}

/**
 * Décision pour une requête : null = autorisée ; sinon les modules bloqués (vide pour FULL / READ_ONLY).
 *  FULL      : tout est bloqué (sauf routes toujours permises et personnes exemptées)
 *  READ_ONLY : consultation permise, toute écriture bloquée (connexion permise)
 *  MODULES   : seules les routes des modules choisis sont bloquées
 */
export function blockingDecision(w: MaintenanceWindow, r: Requester): { blocked: true; modules: string[] } | null {
  const path = String(r.path || '').split('?')[0];
  // Le front peut passer par un préfixe /api (proxy nginx / Next) : on l'ignore pour les routes toujours permises
  if (ALWAYS_ALLOWED.test(path) || ALWAYS_ALLOWED.test(path.replace(/^\/api(?=\/)/, ''))) return null;
  if (isExempt(w, r)) return null;
  const method = String(r.method || 'GET').toUpperCase();
  const write = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  const mods = modulesOfRoute(method, path);
  if (w.scope === 'FULL') return { blocked: true, modules: mods };
  if (w.scope === 'READ_ONLY') {
    if (!write || mods.includes('LOGIN')) return null;
    return { blocked: true, modules: mods };
  }
  const hit = mods.filter((m) => w.modules.includes(m));
  return hit.length ? { blocked: true, modules: hit } : null;
}

/** Message dans la langue demandée (sinon français, sinon première langue disponible) */
export function pickMessage(messages: Record<string, string> | null | undefined, lang: string): string | null {
  if (!messages) return null;
  const l = String(lang || 'fr').slice(0, 2).toLowerCase();
  return messages[l] || messages.fr || Object.values(messages).find(Boolean) || null;
}

/** Secondes avant la fin (en-tête Retry-After), bornées */
export function retryAfterSeconds(w: MaintenanceWindow, now: Date = new Date()): number {
  if (!w.endsAt) return 600;
  return Math.min(86400, Math.max(60, Math.round((w.endsAt.getTime() - now.getTime()) / 1000)));
}
