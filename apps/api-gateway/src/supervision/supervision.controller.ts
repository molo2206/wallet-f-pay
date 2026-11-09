// apps/api-gateway/src/supervision/supervision.controller.ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthentificationGuard } from 'apps/auth-service/src/utility/guards/authentification.guard';
import { JwtAuthGuard } from 'apps/auth-service/src/utility/guards/jwt-auth.guard';
import { CurrentUser } from 'apps/auth-service/src/utility/decorators/current-user-decorator';
import { PrismaService } from 'apps/user-service/src/prisma/prisma.service';
import { round3 } from '@app/common';
import { localParts, isValidTimezone } from 'apps/auth-service/src/work-schedules/work-schedule.util';
import { assertAdminResource } from '../work-schedules/rpc-client.util';

const RESOURCE = 'SUPERVISION';
const TYPES = ['DEPOSIT', 'WITHDRAW', 'TRANSFER', 'PAYMENT', 'REFUND', 'CASH_IN', 'CASH_OUT', 'CASH_TRANSFER'];

/**
 * ✅ SUPERVISION (lecture seule) — SUPER_ADMIN, ou ADMIN disposant de la ressource SUPERVISION
 *  GET /admin/supervision/overview       indicateurs : soldes par devise, volumes / frais / taux de réussite de la période,
 *                                         opérations en attente, échecs, retraits Mobile Money à confirmer, sessions actives.
 *  GET /admin/supervision/pending        opérations nécessitant une intervention (PENDING depuis plus de N minutes), paginées.
 *  GET /admin/supervision/balance-check  wallets dont le solde ne correspond pas à la somme de leurs transactions.
 *  Toutes les requêtes sont en lecture seule et bornées (LIMIT) ; dates en UTC, « aujourd'hui » selon le fuseau de la plateforme.
 */
@Controller('admin/supervision')
@UseGuards(JwtAuthGuard, AuthentificationGuard)
export class SupervisionController {
  constructor(private readonly prisma: PrismaService) {}

  private get db(): any {
    return this.prisma as any;
  }

  private async timezone(): Promise<string> {
    try {
      const rows: any[] = await this.db.$queryRawUnsafe('SELECT `timezone` FROM `general_settings` WHERE `timezone` IS NOT NULL LIMIT 1');
      if (rows?.[0]?.timezone && isValidTimezone(rows[0].timezone)) return rows[0].timezone;
    } catch {
      /* défaut */
    }
    return 'Africa/Lubumbashi';
  }

  /** Début de période en UTC : today (minuit local), 7d, 30d, ou from/to explicites (ISO) */
  private async period(q: any): Promise<{ from: Date; to: Date; label: string; timezone: string }> {
    const tz = await this.timezone();
    const now = new Date();
    const to = q?.to && !isNaN(new Date(q.to).getTime()) ? new Date(q.to) : now;
    if (q?.from && !isNaN(new Date(q.from).getTime())) return { from: new Date(q.from), to, label: 'custom', timezone: tz };
    const lp = localParts(now, tz);
    const midnight = new Date(now.getTime() - lp.minutes * 60000 - now.getSeconds() * 1000 - now.getMilliseconds());
    const p = String(q?.period || 'today');
    const days = p === '7d' ? 6 : p === '30d' ? 29 : 0;
    return { from: new Date(midnight.getTime() - days * 86400000), to, label: days ? p : 'today', timezone: tz };
  }

  private n(v: any): number {
    return Number(v) || 0;
  }

  @Get('overview')
  async overview(@CurrentUser() user: any, @Query() q: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, false);
    const { from, to, label, timezone } = await this.period(q);
    const branch = q?.branchId ? String(q.branchId) : null;
    const bf = branch ? ' AND t.`branchId` = ?' : '';
    const bp = branch ? [branch] : [];
    const stuckMinutes = Math.max(1, Number(q?.stuckMinutes) || 15);

    const [balances, byType, pending, failedReasons, payouts, sessions, users] = await Promise.all([
      this.db.$queryRawUnsafe(
        'SELECT `currency`, COUNT(*) AS wallets, SUM(`balance`) AS total, SUM(CASE WHEN `balance` < 0 THEN 1 ELSE 0 END) AS negatives ' +
          'FROM `wallet` WHERE `isActive` = 1 GROUP BY `currency` ORDER BY `currency`',
      ),
      this.db.$queryRawUnsafe(
        'SELECT t.`currency`, t.`type`, t.`status`, COUNT(*) AS n, SUM(t.`amount`) AS volume FROM `transaction` t ' +
          `WHERE t.\`createdAt\` >= ? AND t.\`createdAt\` < ?${bf} GROUP BY t.\`currency\`, t.\`type\`, t.\`status\``,
        from,
        to,
        ...bp,
      ),
      this.db.$queryRawUnsafe(
        'SELECT t.`type`, COUNT(*) AS n, SUM(t.`amount`) AS volume, MIN(t.`createdAt`) AS oldest, ' +
          'SUM(CASE WHEN t.`createdAt` < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE) THEN 1 ELSE 0 END) AS stuck ' +
          `FROM \`transaction\` t WHERE t.\`status\` = 'PENDING'${bf} GROUP BY t.\`type\``,
        stuckMinutes,
        ...bp,
      ),
      this.db
        .$queryRawUnsafe(
          'SELECT `failure_code` AS code, LEFT(`failure_reason`, 120) AS reason, COUNT(*) AS n FROM `failed_transaction_log` ' +
            'WHERE `created_at` >= ? AND `created_at` < ? GROUP BY `failure_code`, LEFT(`failure_reason`, 120) ORDER BY n DESC LIMIT 10',
          from,
          to,
        )
        .catch(() => []),
      this.db.$queryRawUnsafe(
        "SELECT COUNT(*) AS n, SUM(t.`amount`) AS volume, MIN(t.`createdAt`) AS oldest FROM `transaction` t " +
          `WHERE t.\`status\` = 'PENDING' AND t.\`type\` = 'WITHDRAW' AND t.\`external_reference\` LIKE '%"kind":"PAWAPAY_PAYOUT"%'${bf}`,
        ...bp,
      ),
      this.db
        .$queryRawUnsafe('SELECT COUNT(DISTINCT `user_id`) AS users, COUNT(*) AS n FROM `sessions` WHERE `is_valid` = 1 AND `expires_at` > UTC_TIMESTAMP()')
        .catch(() => [{ users: 0, n: 0 }]),
      this.db.$queryRawUnsafe(
        'SELECT `status`, `role`, COUNT(*) AS n FROM `user` WHERE (`deleted` = 0 OR `deleted` IS NULL) GROUP BY `status`, `role`',
      ),
    ]);

    // Agrégats par devise : volumes réussis, taux de réussite
    const perCurrency: Record<string, any> = {};
    for (const r of byType as any[]) {
      const cur = r.currency || 'N/A';
      const c = (perCurrency[cur] ??= { currency: cur, count: 0, success: 0, failed: 0, pending: 0, cancelled: 0, volumeSuccess: 0, byType: {} as any });
      const n = this.n(r.n);
      c.count += n;
      const st = String(r.status).toLowerCase();
      if (st in c) c[st] += n;
      if (r.status === 'SUCCESS') c.volumeSuccess += this.n(r.volume);
      const t = (c.byType[r.type || 'OTHER'] ??= { count: 0, volumeSuccess: 0, failed: 0, pending: 0 });
      t.count += n;
      if (r.status === 'SUCCESS') t.volumeSuccess += this.n(r.volume);
      if (r.status === 'FAILED') t.failed += n;
      if (r.status === 'PENDING') t.pending += n;
    }
    const currencies = Object.values(perCurrency).map((c: any) => ({
      ...c,
      volumeSuccess: round3(c.volumeSuccess),
      successRate: c.success + c.failed > 0 ? Math.round((c.success / (c.success + c.failed)) * 10000) / 100 : null,
      byType: Object.fromEntries(Object.entries(c.byType).map(([k, v]: any) => [k, { ...v, volumeSuccess: round3(v.volumeSuccess) }])),
    }));

    const pendingRows = (pending as any[]).map((p) => ({
      type: p.type,
      count: this.n(p.n),
      volume: round3(p.volume),
      stuck: this.n(p.stuck),
      oldest: p.oldest,
    }));
    const p0: any = (payouts as any[])[0] || {};
    const alerts: any[] = [];
    const stuckTotal = pendingRows.reduce((a, p) => a + p.stuck, 0);
    if (stuckTotal) alerts.push({ level: 'warning', code: 'STUCK_PENDING', count: stuckTotal, message: `${stuckTotal} opération(s) en attente depuis plus de ${stuckMinutes} min` });
    if (this.n(p0.n)) alerts.push({ level: 'info', code: 'PAYOUTS_TO_CONFIRM', count: this.n(p0.n), message: `${this.n(p0.n)} retrait(s) Mobile Money en cours de confirmation (réconciliation automatique toutes les 2 min)` });
    const approvalsPending = this.n(
      (await this.db.$queryRawUnsafe("SELECT COUNT(*) AS n FROM `admin_operation_requests` WHERE `status` = 'PENDING' AND `expires_at` > UTC_TIMESTAMP()").catch(() => [{ n: 0 }]))?.[0]?.n,
    );
    if (approvalsPending) alerts.push({ level: 'warning', code: 'APPROVALS_PENDING', count: approvalsPending, message: `${approvalsPending} recharge(s) admin en attente de validation` });
    const uncertain = this.n(
      (await this.db.$queryRawUnsafe("SELECT COUNT(*) AS n FROM `admin_operation_requests` WHERE `status` = 'UNCERTAIN'").catch(() => [{ n: 0 }]))?.[0]?.n,
    );
    if (uncertain) alerts.push({ level: 'critical', code: 'APPROVALS_UNCERTAIN', count: uncertain, message: `${uncertain} recharge(s) validée(s) sans confirmation d'exécution : à vérifier` });
    const closingGaps = this.n(
      (await this.db.$queryRawUnsafe("SELECT COUNT(*) AS n FROM `branch_cash_closings` WHERE `status` = 'SUBMITTED' AND `difference_status` <> 'BALANCED'").catch(() => [{ n: 0 }]))?.[0]?.n,
    );
    if (closingGaps) alerts.push({ level: 'warning', code: 'CASH_CLOSING_GAPS', count: closingGaps, message: `${closingGaps} arrêté(s) de caisse avec écart à valider` });
    const negatives = (balances as any[]).reduce((a, b) => a + this.n(b.negatives), 0);
    if (negatives) alerts.push({ level: 'critical', code: 'NEGATIVE_BALANCES', count: negatives, message: `${negatives} wallet(s) avec un solde négatif` });

    return {
      message: 'Supervision',
      data: {
        period: { label, from, to, timezone },
        alerts,
        balances: (balances as any[]).map((b) => ({ currency: b.currency, wallets: this.n(b.wallets), total: round3(b.total), negatives: this.n(b.negatives) })),
        activity: currencies,
        pending: pendingRows,
        pendingPayouts: { count: this.n(p0.n), volume: round3(p0.volume), oldest: p0.oldest ?? null },
        topFailureReasons: (failedReasons as any[]).map((f) => ({ code: f.code, reason: f.reason, count: this.n(f.n) })),
        sessions: { activeUsers: this.n((sessions as any[])[0]?.users), activeSessions: this.n((sessions as any[])[0]?.n) },
        users: (users as any[]).map((u) => ({ status: u.status, role: u.role, count: this.n(u.n) })),
        generatedAt: new Date(),
      },
    };
  }

  @Get('pending')
  async pending(@CurrentUser() user: any, @Query() q: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, false);
    const page = Math.max(1, Number(q?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q?.limit) || 20));
    const minutes = Math.max(0, Number(q?.olderThanMinutes ?? 15) || 0);
    const parts = ["t.`status` = 'PENDING'", 't.`createdAt` < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)'];
    const params: any[] = [minutes];
    if (q?.type && TYPES.includes(String(q.type).toUpperCase())) {
      parts.push('t.`type` = ?');
      params.push(String(q.type).toUpperCase());
    }
    if (q?.currency) {
      parts.push('t.`currency` = ?');
      params.push(String(q.currency).toUpperCase());
    }
    if (q?.branchId) {
      parts.push('t.`branchId` = ?');
      params.push(String(q.branchId));
    }
    if (q?.search) {
      parts.push('(t.`reference` LIKE ? OR u.`full_name` LIKE ? OR u.`phone` LIKE ?)');
      const s = `%${String(q.search).slice(0, 60)}%`;
      params.push(s, s, s);
    }
    const where = parts.join(' AND ');
    const total = this.n(
      (await this.db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`transaction\` t LEFT JOIN \`user\` u ON u.\`id\` = t.\`userId\` WHERE ${where}`, ...params))?.[0]?.n,
    );
    const rows: any[] = await this.db.$queryRawUnsafe(
      'SELECT t.`id`, t.`reference`, t.`type`, t.`movement`, t.`amount`, t.`currency`, t.`paymentMethod`, t.`description`, t.`external_reference`, ' +
        't.`createdAt`, t.`updatedAt`, t.`branchId`, u.`id` AS userId, u.`full_name` AS userName, u.`phone` AS userPhone, ' +
        'TIMESTAMPDIFF(MINUTE, t.`createdAt`, UTC_TIMESTAMP()) AS ageMinutes ' +
        `FROM \`transaction\` t LEFT JOIN \`user\` u ON u.\`id\` = t.\`userId\` WHERE ${where} ORDER BY t.\`createdAt\` ASC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      ...params,
    );
    const data = rows.map((r) => {
      let ext: any = null;
      try {
        ext = r.external_reference && String(r.external_reference).startsWith('{') ? JSON.parse(r.external_reference) : null;
      } catch {
        ext = null;
      }
      const isPayout = ext?.kind === 'PAWAPAY_PAYOUT' || ext?.kind === 'PAWAPAY_DEPOSIT';
      return {
        id: r.id,
        reference: r.reference,
        type: r.type,
        movement: r.movement,
        amount: round3(r.amount),
        currency: r.currency,
        paymentMethod: r.paymentMethod,
        description: r.description,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        ageMinutes: this.n(r.ageMinutes),
        branchId: r.branchId,
        user: { id: r.userId, name: r.userName, phone: r.userPhone },
        provider: isPayout ? { kind: ext.kind, payoutId: ext.payoutId ?? null, depositId: ext.depositId ?? null, provider: ext.provider, phone: ext.phone } : null,
        // Action conseillée pour l'interface d'administration
        suggestedAction: isPayout
          ? 'AUTO_RECONCILIATION'
          : r.type === 'DEPOSIT'
            ? 'CONFIRM_OR_CANCEL_DEPOSIT'
            : r.type === 'TRANSFER'
              ? 'VALIDATE_OR_RECONCILE_TRANSFER'
              : 'RECONCILE',
      };
    });
    return { message: 'Opérations en attente', data: { data, total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  @Get('balance-check')
  async balanceCheck(@CurrentUser() user: any, @Query() q: any) {
    await assertAdminResource(this.prisma, user, RESOURCE, false);
    const limit = Math.min(500, Math.max(1, Number(q?.limit) || 100));
    const params: any[] = [];
    let where = 'w.`isActive` = 1';
    if (q?.currency) {
      where += ' AND w.`currency` = ?';
      params.push(String(q.currency).toUpperCase());
    }
    if (q?.userId) {
      where += ' AND w.`userId` = ?';
      params.push(String(q.userId));
    }
    const rows: any[] = await this.db.$queryRawUnsafe(
      'SELECT * FROM (SELECT w.`id`, w.`userId`, w.`currency`, w.`balance`, u.`full_name` AS userName, ' +
        "COALESCE(SUM(CASE WHEN t.`status` = 'SUCCESS' AND t.`movement` = 'CREDIT' THEN t.`amount` WHEN t.`status` = 'SUCCESS' AND t.`movement` = 'DEBIT' THEN -t.`amount` ELSE 0 END), 0) AS ledger, " +
        "COALESCE(SUM(CASE WHEN t.`status` = 'PENDING' AND t.`movement` = 'DEBIT' THEN t.`amount` ELSE 0 END), 0) AS reservedPending " +
        'FROM `wallet` w LEFT JOIN `user` u ON u.`id` = w.`userId` ' +
        "LEFT JOIN `transaction` t ON t.`walletId` = w.`id` AND t.`status` IN ('SUCCESS', 'PENDING') " +
        `WHERE ${where} GROUP BY w.\`id\`, w.\`userId\`, w.\`currency\`, w.\`balance\`, u.\`full_name\`) x ` +
        // Écart non expliqué ni par les mouvements réussis, ni par des débits réservés en attente (retraits Mobile Money)
        'WHERE ABS(x.`balance` - x.`ledger`) >= 0.001 AND ABS(x.`balance` - (x.`ledger` - x.`reservedPending`)) >= 0.001 ' +
        `ORDER BY ABS(x.\`balance\` - x.\`ledger\`) DESC LIMIT ${limit}`,
      ...params,
    );
    return {
      message:
        "Wallets dont le solde diffère de la somme de leurs transactions réussies (écart non expliqué par un retrait en attente). Un écart peut provenir d'un solde initial importé ou d'une opération sans transaction : à analyser.",
      data: rows.map((r) => ({
        walletId: r.id,
        userId: r.userId,
        userName: r.userName,
        currency: r.currency,
        balance: round3(r.balance),
        ledger: round3(r.ledger),
        reservedPending: round3(r.reservedPending),
        gap: round3(Number(r.balance) - Number(r.ledger)),
      })),
    };
  }
}
