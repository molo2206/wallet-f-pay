// apps/api-gateway/src/controls/limits.interceptor.ts
import { CallHandler, ExecutionContext, HttpException, HttpStatus, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import * as crypto from 'crypto';
import { PrismaService } from 'apps/user-service/src/prisma/prisma.service';
import { round3 } from '@app/common';
import { Limits, RateRow, checkLimits, convert, limitMessage, periodStarts, resolveLimits } from './limits.util';

/** Opérations sortantes initiées par l'utilisateur (le wallet source et le montant sont dans le corps) */
const LIMITED_ROUTES = /^\/wallet\/(send|pay|cashout|transfer|debit)\/?$/;

/**
 * ✅ PLAFONDS PAR NIVEAU KYC (côté serveur, avant l'envoi au wallet-service)
 *
 *  Plafonds : par opération, jour, mois, année et nombre d'opérations par mois, en devise de référence
 *  (LIMITS_REFERENCE_CURRENCY, USD par défaut ; conversion avec la table exchange_rate).
 *  Source : dérogation de l'utilisateur (user_transaction_limit, seulement si LIMITS_USE_USER_OVERRIDES=true :
 *           d'anciennes lignes ont été créées automatiquement avec des valeurs par défaut)
 *           > niveau KYC (table kyc_limit_tiers) > aucun plafond.
 *  Consommation : débits réussis + retraits Mobile Money en attente, hors conversions entre ses propres wallets.
 *  LIMITS_MODE : off | monitor (défaut : dépassements journalisés dans audit_log, rien n'est bloqué) | enforce (403 LIMIT_EXCEEDED).
 */
@Injectable()
export class LimitsInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LimitsInterceptor.name);
  private ratesCache: { rows: RateRow[]; at: number } | null = null;
  private tiersCache: { tiers: Record<string, Partial<Limits>>; at: number } | null = null;
  private tzCache: { tz: string; at: number } | null = null;
  private missingLogged = false;

  constructor(private readonly prisma: PrismaService) {}

  private get db(): any {
    return this.prisma as any;
  }

  private get mode(): 'off' | 'monitor' | 'enforce' {
    const m = String(process.env.LIMITS_MODE ?? 'monitor').toLowerCase();
    return m === 'enforce' ? 'enforce' : m === 'off' ? 'off' : 'monitor';
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http' || this.mode === 'off') return next.handle();
    const req = context.switchToHttp().getRequest();
    if (String(req?.method).toUpperCase() !== 'POST') return next.handle();
    const path = String(req.path || req.url || '').split('?')[0];
    if (!LIMITED_ROUTES.test(path)) return next.handle();
    const user = req.currentUser || req.user;
    if (!user?.id) return next.handle();
    const exempt = String(process.env.LIMITS_EXEMPT_ROLES || 'ADMIN,SUPER_ADMIN')
      .split(',')
      .map((r) => r.trim().toUpperCase());
    if (exempt.includes(String(user.role).toUpperCase())) return next.handle();

    return from(this.check(user, req.body || {}, path)).pipe(mergeMap(() => next.handle()));
  }

  private async check(user: any, body: any, path: string): Promise<void> {
    let decision: Awaited<ReturnType<LimitsInterceptor['evaluate']>> | null = null;
    try {
      decision = await this.evaluate(user.id, body);
    } catch (e: any) {
      if (/doesn't exist|1146|ER_NO_SUCH_TABLE/i.test(String(e?.message))) {
        if (!this.missingLogged) this.logger.warn('Table kyc_limit_tiers absente : plafonds non contrôlés (exécutez le SQL)');
        this.missingLogged = true;
      } else {
        this.logger.warn(`Plafonds non vérifiés (${e?.message}) : opération autorisée`);
      }
      return; // jamais de blocage sur une erreur technique
    }
    if (!decision?.violation) return;
    const message = limitMessage(decision.violation, decision.limits.currency, decision.limits.tier);
    await this.db
      .$executeRawUnsafe(
        'INSERT INTO `audit_log` (`id`, `userId`, `action`, `details`, `ipAddress`, `createdAt`) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())',
        crypto.randomUUID(),
        user.id,
        this.mode === 'enforce' ? 'LIMIT_EXCEEDED_BLOCKED' : 'LIMIT_EXCEEDED_MONITOR',
        JSON.stringify({ path, amount: body?.amount, ...decision }),
        'system',
      )
      .catch(() => undefined);
    if (this.mode === 'enforce') {
      throw new HttpException(
        {
          statusCode: 403,
          code: 'LIMIT_EXCEEDED',
          message,
          limit: { ...decision.violation, currency: decision.limits.currency, source: decision.limits.source, tier: decision.limits.tier },
        },
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async rates(): Promise<RateRow[]> {
    if (this.ratesCache && Date.now() - this.ratesCache.at < 5 * 60 * 1000) return this.ratesCache.rows;
    const rows: RateRow[] = await this.db.$queryRawUnsafe('SELECT `from_currency`, `to_currency`, `rate` FROM `exchange_rate`');
    this.ratesCache = { rows, at: Date.now() };
    return rows;
  }

  private async tiers(): Promise<Record<string, Partial<Limits>>> {
    if (this.tiersCache && Date.now() - this.tiersCache.at < 5 * 60 * 1000) return this.tiersCache.tiers;
    const rows: any[] = await this.db.$queryRawUnsafe('SELECT * FROM `kyc_limit_tiers` WHERE `is_active` = 1');
    const tiers: Record<string, Partial<Limits>> = {};
    for (const r of rows) {
      tiers[String(r.kyc_status).toUpperCase()] = {
        perTransaction: r.per_transaction_limit,
        daily: r.daily_limit,
        monthly: r.monthly_limit,
        yearly: r.yearly_limit,
        monthlyCount: r.monthly_count_limit,
      };
    }
    this.tiersCache = { tiers, at: Date.now() };
    return tiers;
  }

  private async timezone(): Promise<string> {
    if (this.tzCache && Date.now() - this.tzCache.at < 10 * 60 * 1000) return this.tzCache.tz;
    let tz = process.env.WORK_SCHEDULE_DEFAULT_TIMEZONE || 'Africa/Lubumbashi';
    try {
      const rows: any[] = await this.db.$queryRawUnsafe('SELECT `timezone` FROM `general_settings` WHERE `timezone` IS NOT NULL LIMIT 1');
      if (rows?.[0]?.timezone) {
        new Intl.DateTimeFormat('en-US', { timeZone: rows[0].timezone });
        tz = rows[0].timezone;
      }
    } catch {
      /* défaut */
    }
    this.tzCache = { tz, at: Date.now() };
    return tz;
  }

  /** Plafonds, consommation et éventuel dépassement pour une opération */
  async evaluate(userId: string, body: any, opts: { summary?: boolean } = {}) {
    const amount = opts.summary ? 0 : Number(body?.amount);
    if (!opts.summary && (!Number.isFinite(amount) || amount <= 0)) return null;
    const ref = String(process.env.LIMITS_REFERENCE_CURRENCY || 'USD').toUpperCase();

    // Devise de l'opération = devise du wallet source (indiqué, sinon wallet par défaut)
    const walletId = body?.fromWalletId || body?.walletId || null;
    const wallets: any[] = walletId
      ? await this.db.$queryRawUnsafe('SELECT `currency` FROM `wallet` WHERE `id` = ? AND `userId` = ? LIMIT 1', walletId, userId)
      : await this.db.$queryRawUnsafe(
          'SELECT `currency` FROM `wallet` WHERE `userId` = ? AND `isActive` = 1 AND (`isBranchWallet` = 0 OR `isBranchWallet` IS NULL) ORDER BY `isDefault` DESC, `createdAt` ASC LIMIT 1',
          userId,
        );
    const currency = wallets?.[0]?.currency;
    if (!currency) return null; // le wallet-service répondra « wallet introuvable »

    const users: any[] = await this.db.$queryRawUnsafe('SELECT `kycStatus` FROM `user` WHERE `id` = ? LIMIT 1', userId);
    let override: Partial<Limits> | null = null;
    if (String(process.env.LIMITS_USE_USER_OVERRIDES ?? 'false').toLowerCase() === 'true') {
      const o: any[] = await this.db
        .$queryRawUnsafe(
          'SELECT `per_transaction_limit`, `daily_limit`, `monthly_limit`, `yearly_limit`, `monthly_transaction_count` FROM `user_transaction_limit` WHERE `user_id` = ? LIMIT 1',
          userId,
        )
        .catch(() => []);
      if (o?.[0]) {
        override = {
          perTransaction: o[0].per_transaction_limit,
          daily: o[0].daily_limit,
          monthly: o[0].monthly_limit,
          yearly: o[0].yearly_limit,
          monthlyCount: o[0].monthly_transaction_count,
        };
      }
    }
    const limits = resolveLimits({ kycStatus: users?.[0]?.kycStatus ?? null, tiers: await this.tiers(), userOverride: override, referenceCurrency: ref });
    if (limits.source === 'DEFAULT' && !opts.summary) return { limits, violation: null };

    const rates = await this.rates();
    const amountRef = convert(amount, currency, ref, rates);
    if (amountRef === null) {
      this.logger.warn(`Plafonds : taux ${currency} → ${ref} absent, opération non contrôlée`);
      return null;
    }

    const starts = periodStarts(new Date(), await this.timezone());
    const rows: any[] = await this.db.$queryRawUnsafe(
      'SELECT t.`currency`, ' +
        'SUM(CASE WHEN t.`createdAt` >= ? THEN t.`amount` ELSE 0 END) AS dayTotal, ' +
        'SUM(CASE WHEN t.`createdAt` >= ? THEN t.`amount` ELSE 0 END) AS monthTotal, ' +
        'SUM(t.`amount`) AS yearTotal, ' +
        'SUM(CASE WHEN t.`createdAt` >= ? THEN 1 ELSE 0 END) AS monthCount ' +
        "FROM `transaction` t WHERE t.`userId` = ? AND t.`movement` = 'DEBIT' AND t.`createdAt` >= ? " +
        "AND (t.`status` = 'SUCCESS' OR (t.`status` = 'PENDING' AND t.`external_reference` LIKE '%\"kind\":\"PAWAPAY_PAYOUT\"%')) " +
        // Conversions entre ses propres wallets exclues (même référence, même utilisateur, crédit dans une autre devise)
        "AND NOT EXISTS (SELECT 1 FROM `transaction` t2 WHERE t2.`reference` = t.`reference` AND t2.`userId` = t.`userId` AND t2.`movement` = 'CREDIT' AND t2.`currency` <> t.`currency`) " +
        'GROUP BY t.`currency`',
      starts.day,
      starts.month,
      starts.month,
      userId,
      starts.year,
    );
    const usage = { day: 0, month: 0, year: 0, monthCount: 0 };
    for (const r of rows) {
      const c = (v: any) => convert(Number(v) || 0, r.currency || currency, ref, rates) ?? 0;
      usage.day += c(r.dayTotal);
      usage.month += c(r.monthTotal);
      usage.year += c(r.yearTotal);
      usage.monthCount += Number(r.monthCount) || 0;
    }
    usage.day = round3(usage.day);
    usage.month = round3(usage.month);
    usage.year = round3(usage.year);
    return {
      limits,
      usage,
      amountRef: round3(amountRef),
      currency,
      violation: opts.summary ? null : checkLimits(limits, usage, amountRef),
      mode: this.mode,
    };
  }
}
