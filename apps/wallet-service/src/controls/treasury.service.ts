// apps/wallet-service/src/controls/treasury.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import * as crypto from 'crypto';
import { round3 } from '@app/common';
import { localParts, isValidTimezone } from 'apps/auth-service/src/work-schedules/work-schedule.util';
import { PrismaService } from '../prisma/prisma.service';
import { PawapayService } from '../pawapay/pawapay.service';
import { WALLET_KIND_SQL, cashDifference, coverage, parseCurrencyMap } from './controls.util';

const ACCOUNT_KINDS = ['BANK', 'PROVIDER', 'CASH_OTHER', 'OTHER'];

/**
 * ✅ TRÉSORERIE : couverture de la monnaie électronique, floats opérateurs, arrêtés de caisse
 *
 *  Couverture (chaque devise) : soldes dus (wallets clients + frais) comparés à l'argent réellement détenu
 *    = cash des caisses d'agence + float PawaPay (API) + comptes déclarés (banque, autres opérateurs).
 *    Photo quotidienne à 23:50 (heure de la plateforme) dans coverage_snapshots + alerte en cas de manque.
 *  Floats : alerte aux SUPER_ADMIN quand un float PawaPay passe sous le seuil (FLOAT_ALERT_THRESHOLDS).
 *  Arrêtés de caisse : l'agence déclare le cash compté ; l'écart avec la caisse théorique est enregistré,
 *    justifié et validé par un SUPER_ADMIN. Aucun solde n'est modifié automatiquement.
 */
@Injectable()
export class TreasuryService {
  private readonly logger = new Logger(TreasuryService.name);
  private readonly alerted = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly pawapay: PawapayService,
    @Inject('NOTIFICATION_CLIENT') private readonly notificationClient: ClientProxy,
  ) {}

  private get db(): any {
    return this.prisma as any;
  }

  private fail(statusCode: number, message: string): never {
    throw new RpcException({ status: 'error', statusCode, message });
  }

  private async timezone(): Promise<string> {
    try {
      const rows: any[] = await this.db.$queryRawUnsafe('SELECT `timezone` FROM `general_settings` WHERE `timezone` IS NOT NULL LIMIT 1');
      if (rows?.[0]?.timezone && isValidTimezone(rows[0].timezone)) return rows[0].timezone;
    } catch {
      /* défaut */
    }
    return process.env.WORK_SCHEDULE_DEFAULT_TIMEZONE || 'Africa/Lubumbashi';
  }

  private async businessDate(date?: string): Promise<string> {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    return localParts(new Date(), await this.timezone()).ymd;
  }

  private async audit(userId: string | null, action: string, details: any) {
    try {
      await this.db.$executeRawUnsafe(
        'INSERT INTO `audit_log` (`id`, `userId`, `action`, `details`, `ipAddress`, `createdAt`) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())',
        crypto.randomUUID(),
        userId,
        action,
        JSON.stringify(details ?? {}),
        'system',
      );
    } catch {
      /* facultatif */
    }
  }

  private async notifySuperAdmins(title: string, body: string, data: Record<string, string>) {
    try {
      const admins: any[] = await this.db.$queryRawUnsafe(
        "SELECT `id` FROM `user` WHERE `role` = 'SUPER_ADMIN' AND `status` = 'ACTIVE' AND (`deleted` = 0 OR `deleted` IS NULL) LIMIT 20",
      );
      for (const a of admins) {
        this.notificationClient.emit('send_notification', { userId: a.id, title, body, type: 'alert', data }).subscribe({ error: () => undefined });
      }
    } catch {
      /* facultatif */
    }
  }

  // ============================================================
  // COMPTES DE TRÉSORERIE DÉCLARÉS (banque, autres opérateurs)
  // ============================================================
  async listAccounts() {
    const rows: any[] = await this.db.$queryRawUnsafe(
      'SELECT a.*, u.`full_name` AS updatedByName FROM `treasury_accounts` a LEFT JOIN `user` u ON u.`id` = a.`updated_by` ORDER BY a.`currency`, a.`kind`, a.`name`',
    );
    return {
      message: 'Comptes de trésorerie',
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        currency: r.currency,
        balance: round3(r.balance),
        reference: r.reference,
        isActive: !!Number(r.is_active),
        updatedBy: r.updatedByName || r.updated_by,
        updatedAt: r.updated_at,
      })),
    };
  }

  async saveAccount(payload: { id?: string; dto: any; adminId: string }) {
    const dto = payload.dto || {};
    if (payload.id) {
      const rows: any[] = await this.db.$queryRawUnsafe('SELECT * FROM `treasury_accounts` WHERE `id` = ? LIMIT 1', payload.id);
      const cur = rows?.[0];
      if (!cur) this.fail(404, 'Compte de trésorerie introuvable');
      const balanceChanged = dto.balance !== undefined && round3(dto.balance) !== round3(cur.balance);
      if (balanceChanged && !String(dto.note ?? '').trim()) this.fail(400, 'Indiquez la source du nouveau solde (relevé bancaire, rapport opérateur…)');
      await this.prisma.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe(
          'UPDATE `treasury_accounts` SET `name` = COALESCE(?, `name`), `reference` = COALESCE(?, `reference`), `is_active` = COALESCE(?, `is_active`), ' +
            '`balance` = COALESCE(?, `balance`), `updated_by` = ?, `updated_at` = UTC_TIMESTAMP() WHERE `id` = ?',
          dto.name ? String(dto.name).slice(0, 120) : null,
          dto.reference !== undefined ? String(dto.reference || '').slice(0, 120) : null,
          dto.isActive === undefined ? null : dto.isActive ? 1 : 0,
          dto.balance === undefined ? null : round3(dto.balance),
          payload.adminId,
          payload.id,
        );
        if (balanceChanged) {
          await tx.$executeRawUnsafe(
            'INSERT INTO `treasury_balance_history` (`id`, `account_id`, `previous_balance`, `balance`, `note`, `updated_by`, `created_at`) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
            crypto.randomUUID(),
            payload.id,
            round3(cur.balance),
            round3(dto.balance),
            String(dto.note).slice(0, 500),
            payload.adminId,
          );
        }
      });
      await this.audit(payload.adminId, 'TREASURY_ACCOUNT_UPDATE', { id: payload.id, dto });
      return { message: 'Compte de trésorerie mis à jour', data: { id: payload.id } };
    }
    const name = String(dto.name ?? '').trim();
    const kind = String(dto.kind ?? '').toUpperCase();
    const currency = String(dto.currency ?? '').toUpperCase();
    if (!name) this.fail(400, 'Le nom du compte est obligatoire');
    if (!ACCOUNT_KINDS.includes(kind)) this.fail(400, `Type invalide : ${ACCOUNT_KINDS.join(', ')}`);
    if (!/^[A-Z]{3}$/.test(currency)) this.fail(400, 'Devise invalide (ex. CDF, USD)');
    const id = crypto.randomUUID();
    await this.db.$executeRawUnsafe(
      'INSERT INTO `treasury_accounts` (`id`, `name`, `kind`, `currency`, `balance`, `reference`, `is_active`, `updated_by`, `updated_at`, `created_at`) ' +
        'VALUES (?, ?, ?, ?, ?, ?, 1, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
      id,
      name.slice(0, 120),
      kind,
      currency,
      round3(dto.balance || 0),
      dto.reference ? String(dto.reference).slice(0, 120) : null,
      payload.adminId,
    );
    await this.audit(payload.adminId, 'TREASURY_ACCOUNT_CREATE', { id, dto });
    return { message: 'Compte de trésorerie créé', data: { id } };
  }

  async accountHistory(accountId: string) {
    const rows: any[] = await this.db.$queryRawUnsafe(
      'SELECT h.*, u.`full_name` AS byName FROM `treasury_balance_history` h LEFT JOIN `user` u ON u.`id` = h.`updated_by` WHERE h.`account_id` = ? ORDER BY h.`created_at` DESC LIMIT 200',
      accountId,
    );
    return {
      message: 'Historique des soldes',
      data: rows.map((r) => ({
        previousBalance: round3(r.previous_balance),
        balance: round3(r.balance),
        note: r.note,
        by: r.byName || r.updated_by,
        at: r.created_at,
      })),
    };
  }

  // ============================================================
  // FLOATS OPÉRATEURS
  // ============================================================
  async providerFloats(): Promise<{ source: string; balances: { currency: string; country: string | null; provider: string | null; balance: number }[] }> {
    if (String(process.env.PAWAPAY_FLOAT_FROM_API ?? 'true').toLowerCase() === 'false') return { source: 'DISABLED', balances: [] };
    const res: any = await this.pawapay.getWalletBalances().catch(() => ({ balances: [] }));
    const balances = (res?.balances || [])
      .map((b: any) => ({
        currency: String(b.currency || '').toUpperCase(),
        country: b.country ?? null,
        provider: b.provider ?? null,
        balance: round3(Number(b.balance) || 0),
      }))
      .filter((b: any) => b.currency);
    return { source: balances.length ? 'PAWAPAY_API' : 'UNAVAILABLE', balances };
  }

  @Cron('0 7 * * * *')
  async floatAlerts() {
    const thresholds = parseCurrencyMap(process.env.FLOAT_ALERT_THRESHOLDS);
    if (!Object.keys(thresholds).length) return;
    const { balances } = await this.providerFloats();
    const totals: Record<string, number> = {};
    for (const b of balances) totals[b.currency] = round3((totals[b.currency] || 0) + b.balance);
    const today = new Date().toISOString().slice(0, 10);
    for (const [cur, min] of Object.entries(thresholds)) {
      if (totals[cur] === undefined || totals[cur] >= min) continue;
      const key = `float:${cur}`;
      if (this.alerted.get(key) === today) continue;
      this.alerted.set(key, today);
      const body = `Float PawaPay ${cur} bas : ${totals[cur].toFixed(3)} (seuil ${Number(min).toFixed(3)}). Les retraits Mobile Money risquent d'échouer : approvisionnez le compte opérateur.`;
      this.logger.warn(body);
      await this.notifySuperAdmins('Float opérateur bas', body, { action: 'FLOAT_LOW', currency: cur });
      await this.audit(null, 'FLOAT_LOW_ALERT', { currency: cur, balance: totals[cur], threshold: min });
    }
  }

  // ============================================================
  // COUVERTURE DE LA MONNAIE ÉLECTRONIQUE
  // ============================================================
  async coverage(q: { save?: boolean; date?: string } = {}) {
    const wallets: any[] = await this.db.$queryRawUnsafe(
      `SELECT w.\`currency\`, ${WALLET_KIND_SQL} AS kind, SUM(w.\`balance\`) AS total, COUNT(*) AS n, ` +
        'SUM(CASE WHEN w.`balance` < 0 THEN w.`balance` ELSE 0 END) AS negatives ' +
        'FROM `wallet` w LEFT JOIN `user` u ON u.`id` = w.`userId` WHERE w.`isActive` = 1 GROUP BY w.`currency`, kind',
    );
    const declared: any[] = await this.db
      .$queryRawUnsafe('SELECT `currency`, `kind`, SUM(`balance`) AS total, MAX(`updated_at`) AS updatedAt FROM `treasury_accounts` WHERE `is_active` = 1 GROUP BY `currency`, `kind`')
      .catch(() => []);
    const floats = await this.providerFloats();

    const cur = new Set<string>();
    const acc: Record<string, any> = {};
    const get = (c: string) => {
      cur.add(c);
      return (acc[c] ??= { customer: 0, fees: 0, branch: 0, provider: 0, bank: 0, wallets: 0, negatives: 0, declaredUpdatedAt: null });
    };
    for (const w of wallets) {
      const a = get(String(w.currency));
      const total = Number(w.total) || 0;
      if (w.kind === 'CUSTOMER') {
        a.customer += total;
        a.wallets += Number(w.n) || 0;
        a.negatives += Number(w.negatives) || 0;
      } else if (w.kind === 'SYSTEM_FEES') a.fees += total;
      else a.branch += total;
    }
    for (const b of floats.balances) get(b.currency).provider += b.balance;
    for (const d of declared) {
      const a = get(String(d.currency));
      if (d.kind === 'PROVIDER') a.provider += Number(d.total) || 0;
      else a.bank += Number(d.total) || 0;
      if (!a.declaredUpdatedAt || new Date(d.updatedAt) > new Date(a.declaredUpdatedAt)) a.declaredUpdatedAt = d.updatedAt;
    }

    const date = await this.businessDate(q.date);
    const result = [...cur].sort().map((c) => {
      const a = acc[c];
      return {
        ...coverage({ currency: c, customerLiabilities: a.customer, feeWallets: a.fees, branchCash: a.branch, providerFloat: a.provider, bankAndOther: a.bank }),
        customerWallets: a.wallets,
        negativeBalances: round3(a.negatives),
        declaredUpdatedAt: a.declaredUpdatedAt,
      };
    });

    if (q.save) {
      for (const r of result) {
        await this.db
          .$executeRawUnsafe(
            'INSERT INTO `coverage_snapshots` (`id`, `business_date`, `currency`, `customer_liabilities`, `fee_wallets`, `branch_cash`, `provider_float`, `provider_float_source`, ' +
              '`bank_and_other`, `assets_total`, `gap`, `coverage_ratio`, `status`, `created_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP()) ' +
              'ON DUPLICATE KEY UPDATE `customer_liabilities` = VALUES(`customer_liabilities`), `fee_wallets` = VALUES(`fee_wallets`), `branch_cash` = VALUES(`branch_cash`), ' +
              '`provider_float` = VALUES(`provider_float`), `provider_float_source` = VALUES(`provider_float_source`), `bank_and_other` = VALUES(`bank_and_other`), ' +
              '`assets_total` = VALUES(`assets_total`), `gap` = VALUES(`gap`), `coverage_ratio` = VALUES(`coverage_ratio`), `status` = VALUES(`status`), `created_at` = UTC_TIMESTAMP()',
            crypto.randomUUID(),
            date,
            r.currency,
            r.customerLiabilities,
            r.feeWallets,
            r.branchCash,
            r.providerFloat,
            floats.source,
            r.bankAndOther,
            r.assetsTotal,
            r.gap,
            r.coverageRatio,
            r.status,
          )
          .catch((e: any) => this.logger.warn(`Photo de couverture non enregistrée : ${e?.message}`));
      }
    }

    return {
      message: 'Couverture de la monnaie électronique',
      data: {
        date,
        providerFloatSource: floats.source,
        currencies: result,
        shortfalls: result.filter((r) => r.status === 'SHORTFALL').map((r) => r.currency),
        help:
          'Dû = soldes des wallets clients + frais encaissés. Détenu = cash des caisses + float PawaPay + comptes déclarés (banque, autres opérateurs). ' +
          "Mettez à jour les comptes déclarés chaque jour (relevés) pour un contrôle exact.",
      },
    };
  }

  async coverageHistory(q: { currency?: string; days?: number } = {}) {
    const days = Math.min(366, Math.max(1, Number(q.days) || 30));
    const params: any[] = [days];
    let extra = '';
    if (q.currency) {
      extra = ' AND `currency` = ?';
      params.push(String(q.currency).toUpperCase());
    }
    const rows: any[] = await this.db.$queryRawUnsafe(
      `SELECT * FROM \`coverage_snapshots\` WHERE \`business_date\` >= DATE_SUB(CURDATE(), INTERVAL ? DAY)${extra} ORDER BY \`business_date\` DESC, \`currency\``,
      ...params,
    );
    return {
      message: 'Historique de couverture',
      data: rows.map((r) => ({
        date: r.business_date,
        currency: r.currency,
        liabilitiesTotal: round3(Number(r.customer_liabilities) + Number(r.fee_wallets)),
        assetsTotal: round3(r.assets_total),
        gap: round3(r.gap),
        coverageRatio: r.coverage_ratio === null ? null : Number(r.coverage_ratio),
        status: r.status,
        providerFloatSource: r.provider_float_source,
      })),
    };
  }

  /** Photo quotidienne (23:50 heure de Lubumbashi) + alerte en cas de manque */
  @Cron('0 50 23 * * *', { timeZone: process.env.WORK_SCHEDULE_DEFAULT_TIMEZONE || 'Africa/Lubumbashi' })
  async dailyCoverage() {
    if (String(process.env.COVERAGE_DAILY_ENABLED ?? 'true').toLowerCase() === 'false') return;
    try {
      const res = await this.coverage({ save: true });
      for (const c of res.data.currencies.filter((x) => x.status === 'SHORTFALL')) {
        const body = `Couverture insuffisante en ${c.currency} : dû ${c.liabilitiesTotal.toFixed(3)}, détenu ${c.assetsTotal.toFixed(3)} (écart ${c.gap.toFixed(3)}). Vérifiez les comptes déclarés et les opérations du jour.`;
        this.logger.warn(body);
        await this.notifySuperAdmins('Couverture insuffisante', body, { action: 'COVERAGE_SHORTFALL', currency: c.currency });
      }
    } catch (e: any) {
      this.logger.error(`Couverture quotidienne : ${e?.message}`);
    }
  }

  // ============================================================
  // ARRÊTÉS DE CAISSE
  // ============================================================
  private async branchCashWallets(branchId: string, currency: string): Promise<any[]> {
    return this.db.$queryRawUnsafe(
      `SELECT w.\`id\`, w.\`balance\` FROM \`wallet\` w LEFT JOIN \`user\` u ON u.\`id\` = w.\`userId\` ` +
        `WHERE w.\`branchId\` = ? AND w.\`currency\` = ? AND w.\`isActive\` = 1 AND ${WALLET_KIND_SQL} = 'BRANCH_CASH'`,
      branchId,
      currency,
    );
  }

  /** Caisse théorique et mouvements du jour pour une agence */
  async expectedCash(q: { branchId: string; currency: string; date?: string }) {
    const currency = String(q.currency || 'CDF').toUpperCase();
    const wallets = await this.branchCashWallets(q.branchId, currency);
    const expected = round3(wallets.reduce((s, w) => s + (Number(w.balance) || 0), 0));
    const date = await this.businessDate(q.date);
    const tz = await this.timezone();
    // Bornes du jour local en UTC
    const now = new Date();
    const lp = localParts(now, tz);
    const offsetMin = Math.round((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes()) - Date.UTC(Number(lp.ymd.slice(0, 4)), Number(lp.ymd.slice(5, 7)) - 1, Number(lp.ymd.slice(8, 10)), Math.floor(lp.minutes / 60), lp.minutes % 60)) / 60000);
    const dayStart = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) + offsetMin * 60000);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    let movements: any = { cashIn: 0, cashOut: 0, count: 0 };
    if (wallets.length) {
      const ids = wallets.map((w) => w.id);
      const rows: any[] = await this.db.$queryRawUnsafe(
        `SELECT \`movement\`, COUNT(*) AS n, SUM(\`amount\`) AS total FROM \`transaction\` WHERE \`walletId\` IN (${ids.map(() => '?').join(',')}) ` +
          "AND `status` = 'SUCCESS' AND `createdAt` >= ? AND `createdAt` < ? GROUP BY `movement`",
        ...ids,
        dayStart,
        dayEnd,
      );
      for (const r of rows) {
        movements.count += Number(r.n) || 0;
        if (r.movement === 'CREDIT') movements.cashIn = round3(r.total);
        else movements.cashOut = round3(r.total);
      }
    }
    return { message: 'Caisse théorique', data: { branchId: q.branchId, currency, date, expected, wallets: wallets.length, movements } };
  }

  async submitClosing(payload: { adminId: string; branchId: string; dto: any }) {
    const dto = payload.dto || {};
    const currency = String(dto.currency || 'CDF').toUpperCase();
    const counted = Number(dto.countedAmount);
    if (!payload.branchId) this.fail(400, "Agence requise pour l'arrêté de caisse");
    if (!Number.isFinite(counted) || counted < 0) this.fail(400, 'Montant compté invalide');
    const exp = (await this.expectedCash({ branchId: payload.branchId, currency, date: dto.date })).data;
    if (!exp.wallets) this.fail(404, `Aucune caisse ${currency} pour cette agence`);
    const diff = cashDifference(exp.expected, counted);
    const note = String(dto.note ?? '').trim();
    if (diff.status !== 'BALANCED' && !note) this.fail(400, `Écart de ${diff.difference.toFixed(3)} ${currency} : une justification est obligatoire`);
    const id = crypto.randomUUID();
    try {
      await this.db.$executeRawUnsafe(
        'INSERT INTO `branch_cash_closings` (`id`, `branch_id`, `currency`, `business_date`, `expected_balance`, `counted_amount`, `difference`, `difference_status`, ' +
          "`cash_in`, `cash_out`, `movements_count`, `note`, `status`, `submitted_by`, `submitted_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', ?, UTC_TIMESTAMP())",
        id,
        payload.branchId,
        currency,
        exp.date,
        exp.expected,
        round3(counted),
        diff.difference,
        diff.status,
        exp.movements.cashIn,
        exp.movements.cashOut,
        exp.movements.count,
        note ? note.slice(0, 1000) : null,
        payload.adminId,
      );
    } catch (e: any) {
      if (/Duplicate|1062/.test(String(e?.message))) this.fail(409, `L'arrêté de caisse ${currency} du ${exp.date} a déjà été soumis pour cette agence`);
      throw e;
    }
    await this.audit(payload.adminId, 'CASH_CLOSING_SUBMIT', { id, branchId: payload.branchId, currency, expected: exp.expected, counted, ...diff });
    if (diff.status !== 'BALANCED') {
      await this.notifySuperAdmins(
        'Écart de caisse',
        `Arrêté ${currency} du ${exp.date} : ${diff.status === 'SHORTAGE' ? 'manquant' : 'excédent'} de ${Math.abs(diff.difference).toFixed(3)} ${currency}.`,
        { action: 'CASH_CLOSING_GAP', closingId: id },
      );
    }
    return {
      message: diff.status === 'BALANCED' ? 'Arrêté de caisse enregistré : caisse équilibrée' : `Arrêté de caisse enregistré avec un écart de ${diff.difference.toFixed(3)} ${currency}`,
      data: { id, ...exp, counted: round3(counted), ...diff },
    };
  }

  async listClosings(q: { branchId?: string; status?: string; currency?: string; from?: string; to?: string; page?: number; limit?: number }) {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    const parts: string[] = ['1 = 1'];
    const params: any[] = [];
    if (q.branchId) {
      parts.push('c.`branch_id` = ?');
      params.push(q.branchId);
    }
    if (q.status) {
      parts.push('c.`status` = ?');
      params.push(String(q.status).toUpperCase());
    }
    if (q.currency) {
      parts.push('c.`currency` = ?');
      params.push(String(q.currency).toUpperCase());
    }
    if (q.from) {
      parts.push('c.`business_date` >= ?');
      params.push(String(q.from).slice(0, 10));
    }
    if (q.to) {
      parts.push('c.`business_date` <= ?');
      params.push(String(q.to).slice(0, 10));
    }
    const where = parts.join(' AND ');
    const total = Number((await this.db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`branch_cash_closings\` c WHERE ${where}`, ...params))?.[0]?.n ?? 0);
    const rows: any[] = await this.db.$queryRawUnsafe(
      'SELECT c.*, b.`name` AS branchName, s.`full_name` AS submittedByName, r.`full_name` AS reviewedByName FROM `branch_cash_closings` c ' +
        'LEFT JOIN `branch` b ON b.`id` = c.`branch_id` LEFT JOIN `user` s ON s.`id` = c.`submitted_by` LEFT JOIN `user` r ON r.`id` = c.`reviewed_by` ' +
        `WHERE ${where} ORDER BY c.\`business_date\` DESC, c.\`submitted_at\` DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      ...params,
    );
    return {
      message: 'Arrêtés de caisse',
      data: {
        data: rows.map((r) => ({
          id: r.id,
          branchId: r.branch_id,
          branchName: r.branchName,
          currency: r.currency,
          date: r.business_date,
          expected: round3(r.expected_balance),
          counted: round3(r.counted_amount),
          difference: round3(r.difference),
          differenceStatus: r.difference_status,
          cashIn: round3(r.cash_in),
          cashOut: round3(r.cash_out),
          movementsCount: Number(r.movements_count) || 0,
          note: r.note,
          status: r.status,
          submittedBy: r.submittedByName || r.submitted_by,
          submittedAt: r.submitted_at,
          reviewedBy: r.reviewedByName || r.reviewed_by,
          reviewedAt: r.reviewed_at,
          reviewNote: r.review_note,
        })),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async reviewClosing(payload: { id: string; adminId: string; decision: string; note?: string }) {
    const decision = String(payload.decision || '').toUpperCase();
    if (!['APPROVED', 'REJECTED'].includes(decision)) this.fail(400, 'Décision invalide : APPROVED ou REJECTED');
    if (decision === 'REJECTED' && !String(payload.note ?? '').trim()) this.fail(400, 'Motif du rejet obligatoire');
    const n = Number(
      await this.db.$executeRawUnsafe(
        "UPDATE `branch_cash_closings` SET `status` = ?, `reviewed_by` = ?, `reviewed_at` = UTC_TIMESTAMP(), `review_note` = ? WHERE `id` = ? AND `status` = 'SUBMITTED' AND `submitted_by` <> ?",
        decision,
        payload.adminId,
        payload.note ? String(payload.note).slice(0, 1000) : null,
        payload.id,
        payload.adminId,
      ),
    );
    if (n !== 1) this.fail(409, "Arrêté introuvable, déjà traité, ou soumis par vous-même (un autre administrateur doit le valider)");
    await this.audit(payload.adminId, 'CASH_CLOSING_REVIEW', { id: payload.id, decision, note: payload.note });
    return { message: decision === 'APPROVED' ? 'Arrêté de caisse validé' : 'Arrêté de caisse rejeté', data: { id: payload.id, status: decision } };
  }
}
