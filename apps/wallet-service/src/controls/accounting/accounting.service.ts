// apps/wallet-service/src/controls/accounting/accounting.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RpcException } from '@nestjs/microservices';
import * as crypto from 'crypto';
import { ExchangeRateRow, convertWithRates, round3 } from '@app/common';
import { isValidTimezone, localParts } from 'apps/auth-service/src/work-schedules/work-schedule.util';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ACCOUNT_LABEL,
  JOURNALS,
  SYSCOHADA_ACCOUNTS,
  WalletKind,
  accountType,
  entryLines,
  implicitFee,
  journalFor,
  providerCost,
  validateManualLines,
} from './accounting.rules';

const KIND_SQL =
  "CASE WHEN w.`userId` = 'system-fee-account' OR u.`email` = 'system@fpay.com' THEN 'SYSTEM_FEES' " +
  "WHEN w.`isBranchWallet` = 1 OR (u.`email` LIKE 'caisse.%' AND u.`branchId` IS NOT NULL AND u.`branchId` = w.`branchId`) THEN 'BRANCH_CASH' " +
  "WHEN u.`role` = 'MERCHANT' THEN 'MERCHANT' ELSE 'CUSTOMER' END";

const REVENUE_GROUPS: Record<string, string> = {
  '7061': 'Dépôts Mobile Money',
  '7062': 'Retraits',
  '7063': 'Transferts nationaux',
  '7064': 'Transferts et paiements internationaux',
  '7065': 'Frais de tenue de compte (maintenance)',
  '7066': 'Parrainage',
  '7067': 'Paiements taxi',
  '7068': 'Autres frais de service',
  '758': 'Produits divers',
  '776': 'Gains de change',
};

/**
 * ✅ COMPTABILITÉ SYSCOHADA (OHADA)
 *
 *  Écritures automatiques : chaque transaction réussie est passée au journal (toutes les 5 min + reprise complète la nuit),
 *  avec les montants dans la devise d'origine ET dans la devise comptable (ACCOUNTING_CURRENCY, CDF par défaut,
 *  au taux de la table exchange_rate au moment de la passation). Une transaction annulée ou corrigée produit une
 *  écriture d'extourne : le journal n'est jamais modifié.
 *  Écritures manuelles (journal OD) : charges réelles (facture PawaPay, loyer, salaires, SMS…), équilibrées, périodes clôturées protégées.
 *  États : ce que F-Pay gagne (produits − charges), compte de résultat, balance, grand livre, journal, bilan simplifié.
 */
@Injectable()
export class AccountingService {
  private readonly logger = new Logger(AccountingService.name);
  private running = false;
  private missingLogged = false;
  private ratesCache: { rows: ExchangeRateRow[]; at: number } | null = null;
  private tzCache: { tz: string; at: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  private get db(): any {
    return this.prisma as any;
  }

  get currency(): string {
    return String(process.env.ACCOUNTING_CURRENCY || 'CDF').toUpperCase();
  }

  private fail(statusCode: number, message: string): never {
    throw new RpcException({ status: 'error', statusCode, message });
  }

  private isMissing(e: any) {
    return /doesn't exist|1146|ER_NO_SUCH_TABLE/i.test(String(e?.message || ''));
  }

  private async rates(): Promise<ExchangeRateRow[]> {
    if (this.ratesCache && Date.now() - this.ratesCache.at < 5 * 60 * 1000) return this.ratesCache.rows;
    const rows: ExchangeRateRow[] = await this.db.$queryRawUnsafe('SELECT `from_currency`, `to_currency`, `rate` FROM `exchange_rate`');
    this.ratesCache = { rows, at: Date.now() };
    return rows;
  }

  private async timezone(): Promise<string> {
    if (this.tzCache && Date.now() - this.tzCache.at < 10 * 60 * 1000) return this.tzCache.tz;
    let tz = process.env.WORK_SCHEDULE_DEFAULT_TIMEZONE || 'Africa/Lubumbashi';
    try {
      const rows: any[] = await this.db.$queryRawUnsafe('SELECT `timezone` FROM `general_settings` WHERE `timezone` IS NOT NULL LIMIT 1');
      if (rows?.[0]?.timezone && isValidTimezone(rows[0].timezone)) tz = rows[0].timezone;
    } catch {
      /* défaut */
    }
    this.tzCache = { tz, at: Date.now() };
    return tz;
  }

  private async localDate(d: Date): Promise<string> {
    return localParts(d, await this.timezone()).ymd;
  }

  private async meta(key: string): Promise<string | null> {
    const rows: any[] = await this.db.$queryRawUnsafe('SELECT `v` FROM `accounting_meta` WHERE `k` = ? LIMIT 1', key);
    return rows?.[0]?.v ?? null;
  }

  private async setMeta(key: string, value: string) {
    await this.db.$executeRawUnsafe('INSERT INTO `accounting_meta` (`k`, `v`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `v` = VALUES(`v`)', key, value);
  }

  // ============================================================
  // ÉCRITURES AUTOMATIQUES
  // ============================================================
  @Cron('45 */5 * * * *')
  async incremental() {
    await this.project('incremental');
  }

  @Cron('0 45 2 * * *')
  async nightly() {
    await this.project('full', 2000);
  }

  async project(mode: 'incremental' | 'full' = 'incremental', maxBatches = 200): Promise<{ processed: number; entries: number; skipped: number }> {
    const stats = { processed: 0, entries: 0, skipped: 0 };
    if (String(process.env.ACCOUNTING_ENABLED ?? 'true').toLowerCase() === 'false' || this.running) return stats;
    this.running = true;
    try {
      const batch = 500;
      const startedAt = new Date();
      let since = new Date(0);
      if (mode === 'incremental') {
        const c = await this.meta('cursor_updated_at');
        if (c) since = new Date(new Date(c).getTime() - 2 * 60 * 1000);
      }
      let lastUpdated = since;
      let lastId = '';
      const costRates: any[] = await this.db.$queryRawUnsafe('SELECT * FROM `accounting_provider_costs`').catch(() => []);
      for (let i = 0; i < maxBatches; i++) {
        const rows: any[] = await this.db.$queryRawUnsafe(
          'SELECT t.`id`, t.`walletId`, t.`amount`, t.`status`, t.`movement`, t.`paymentMethod`, t.`currency`, t.`type`, t.`reference`, t.`description`, ' +
            't.`external_reference`, t.`branchId`, t.`createdAt`, t.`updatedAt`, w.`currency` AS walletCurrency, ' +
            `${KIND_SQL} AS walletKind, ` +
            '(SELECT COUNT(*) FROM `transaction` t2 WHERE t2.`reference` = t.`reference` AND t2.`userId` = t.`userId` AND t2.`id` <> t.`id` AND t2.`currency` <> t.`currency`) AS fxPeers, ' +
            'st.`amount` AS stAmount, st.`status` AS stStatus, st.`version` AS stVersion ' +
            'FROM `transaction` t INNER JOIN `wallet` w ON w.`id` = t.`walletId` LEFT JOIN `user` u ON u.`id` = w.`userId` ' +
            'LEFT JOIN `accounting_tx_state` st ON st.`transaction_id` = t.`id` ' +
            'WHERE (t.`updatedAt` > ? OR (t.`updatedAt` = ? AND t.`id` > ?)) ORDER BY t.`updatedAt` ASC, t.`id` ASC LIMIT ' +
            batch,
          lastUpdated,
          lastUpdated,
          lastId,
        );
        if (!rows.length) break;
        for (const t of rows) {
          stats.processed++;
          const r = await this.projectOne(t, costRates);
          if (r === 'posted') stats.entries++;
          if (r === 'skipped') stats.skipped++;
        }
        const last = rows[rows.length - 1];
        lastUpdated = new Date(last.updatedAt);
        lastId = last.id;
        if (rows.length < batch) break;
      }
      await this.setMeta('cursor_updated_at', (lastUpdated > since ? lastUpdated : startedAt).toISOString());
      await this.setMeta(`last_${mode}_run`, startedAt.toISOString());
      if (stats.entries) this.logger.log(`📗 Comptabilité (${mode}) : ${stats.entries} écriture(s) passée(s)`);
    } catch (e: any) {
      if (this.isMissing(e)) {
        if (!this.missingLogged) this.logger.warn('Tables accounting_* absentes : comptabilité désactivée (exécutez le SQL)');
        this.missingLogged = true;
      } else this.logger.error(`Comptabilité : ${e?.message}`);
    } finally {
      this.running = false;
    }
    return stats;
  }

  private async projectOne(t: any, costRates: any[]): Promise<'posted' | 'none' | 'skipped'> {
    const eff = (status: any, amount: any) => (String(status) === 'SUCCESS' ? round3(Number(amount) || 0) : 0);
    const target = eff(t.status, t.amount);
    const current = t.stStatus ? eff(t.stStatus, t.stAmount) : 0;
    const delta = round3(target - current);
    const same = t.stStatus != null && String(t.stStatus) === String(t.status) && round3(t.stAmount) === round3(t.amount);
    if (delta === 0 && same) return 'none';

    const currency = String(t.currency || t.walletCurrency || '').toUpperCase();
    const isFx = Number(t.fxPeers) > 0;
    const kind = (t.walletKind || 'CUSTOMER') as WalletKind;
    const fee = kind === 'SYSTEM_FEES' || isFx ? null : implicitFee(t);
    let cost = 0;
    if (!isFx && String(t.paymentMethod).toUpperCase() === 'MOBILE_MONEY' && kind !== 'SYSTEM_FEES') {
      const op = t.movement === 'CREDIT' ? 'DEPOSIT' : 'PAYOUT';
      const base = Math.abs(delta) + (op === 'DEPOSIT' ? fee?.fee ?? 0 : -(fee?.fee ?? 0));
      cost = (delta >= 0 ? 1 : -1) * providerCost(costRates, op, currency, base);
    }
    const lines = entryLines({
      walletKind: kind,
      movement: t.movement === 'DEBIT' ? 'DEBIT' : 'CREDIT',
      paymentMethod: t.paymentMethod,
      isFx,
      delta,
      description: t.description,
      fee,
      providerCost: Math.abs(cost),
    });
    // Annulation : le coût estimé est aussi extourné (entryLines inverse déjà toutes les lignes)
    const version = (Number(t.stVersion) || 0) + (lines.length ? 1 : 0);

    // Conversion en devise comptable
    const rate = convertWithRates(1, currency, this.currency, await this.rates());
    if (lines.length && rate === null) {
      this.logger.warn(`Comptabilité : taux ${currency} → ${this.currency} absent, transaction ${t.reference} reportée`);
      return 'skipped';
    }

    const entryDate = await this.localDate(new Date(version <= 1 ? t.createdAt : t.updatedAt));
    try {
      await this.prisma.$transaction(async (tx: any) => {
        if (t.stStatus == null) {
          await tx.$executeRawUnsafe(
            'INSERT INTO `accounting_tx_state` (`transaction_id`, `amount`, `status`, `version`, `updated_at`) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())',
            t.id,
            round3(t.amount),
            String(t.status),
            version,
          );
        } else {
          const n = Number(
            await tx.$executeRawUnsafe(
              'UPDATE `accounting_tx_state` SET `amount` = ?, `status` = ?, `version` = ?, `updated_at` = UTC_TIMESTAMP() WHERE `transaction_id` = ? AND `version` = ?',
              round3(t.amount),
              String(t.status),
              version,
              t.id,
              Number(t.stVersion) || 0,
            ),
          );
          if (n !== 1) throw new Error('concurrent');
        }
        if (!lines.length) return;
        const entryId = crypto.randomUUID();
        const journal = journalFor(t.paymentMethod, kind, isFx);
        const label = String(t.description || `${t.type} ${t.reference}`).slice(0, 250);
        await tx.$executeRawUnsafe(
          'INSERT INTO `accounting_entries` (`id`, `journal`, `entry_date`, `reference`, `label`, `source`, `transaction_id`, `version`, `currency`, `rate_to_ref`, ' +
            '`branch_id`, `created_by`, `created_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, UTC_TIMESTAMP())',
          entryId,
          journal,
          entryDate,
          t.reference ?? null,
          version > 1 ? `Extourne / correction — ${label}`.slice(0, 250) : label,
          version > 1 ? 'AUTO_CORRECTION' : 'AUTO',
          t.id,
          version,
          currency,
          rate,
        );
        let i = 0;
        for (const l of lines) {
          await tx.$executeRawUnsafe(
            'INSERT INTO `accounting_lines` (`id`, `entry_id`, `line`, `account_code`, `debit`, `credit`, `debit_ref`, `credit_ref`, `currency`, `entry_date`, `branch_id`, `label`) ' +
              'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            crypto.randomUUID(),
            entryId,
            ++i,
            l.account,
            l.debit,
            l.credit,
            round3(l.debit * rate!),
            round3(l.credit * rate!),
            currency,
            entryDate,
            t.branchId ?? null,
            l.label ?? null,
          );
        }
      });
    } catch (e: any) {
      if (String(e?.message) === 'concurrent' || /Duplicate|1062/.test(String(e?.message))) return 'none';
      throw e;
    }
    return lines.length ? 'posted' : 'none';
  }

  // ============================================================
  // FILTRES COMMUNS
  // ============================================================
  private async period(q: any): Promise<{ from: string; to: string }> {
    const today = await this.localDate(new Date());
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(q?.to || '')) ? String(q.to) : today;
    let from = /^\d{4}-\d{2}-\d{2}$/.test(String(q?.from || '')) ? String(q.from) : '';
    if (!from) {
      if (q?.period === 'today') from = to;
      else if (q?.period === 'year') from = `${to.slice(0, 4)}-01-01`;
      else from = `${to.slice(0, 7)}-01`; // mois en cours par défaut
    }
    if (from > to) this.fail(400, 'La date de début doit précéder la date de fin');
    return { from, to };
  }

  /** Montant en devise d'affichage (devise comptable par défaut) */
  private async display(q: any): Promise<{ code: string; factor: number }> {
    const code = String(q?.currency || this.currency).toUpperCase();
    if (code === this.currency) return { code, factor: 1 };
    const f = convertWithRates(1, this.currency, code, await this.rates());
    if (f === null) this.fail(400, `Taux ${this.currency} → ${code} non configuré`);
    return { code, factor: f! };
  }

  // ============================================================
  // CE QUE F-PAY GAGNE
  // ============================================================
  async earnings(q: any) {
    const { from, to } = await this.period(q);
    const disp = await this.display(q);
    const params: any[] = [from, to];
    let branch = '';
    if (q?.branchId) {
      branch = ' AND l.`branch_id` = ?';
      params.push(String(q.branchId));
    }
    const rows: any[] = await this.db.$queryRawUnsafe(
      'SELECT l.`account_code` AS account, l.`currency`, SUM(l.`credit` - l.`debit`) AS net, SUM(l.`credit_ref` - l.`debit_ref`) AS netRef, COUNT(DISTINCT l.`entry_id`) AS entries ' +
        "FROM `accounting_lines` l WHERE l.`entry_date` BETWEEN ? AND ? AND (l.`account_code` LIKE '7%' OR l.`account_code` LIKE '6%')" +
        branch +
        ' GROUP BY l.`account_code`, l.`currency`',
      ...params,
    );
    const groupBy = q?.groupBy === 'day' ? '%Y-%m-%d' : '%Y-%m';
    const series: any[] = await this.db.$queryRawUnsafe(
      `SELECT DATE_FORMAT(l.\`entry_date\`, '${groupBy}') AS bucket, ` +
        "SUM(CASE WHEN l.`account_code` LIKE '7%' THEN l.`credit_ref` - l.`debit_ref` ELSE 0 END) AS revenue, " +
        "SUM(CASE WHEN l.`account_code` LIKE '6%' THEN l.`debit_ref` - l.`credit_ref` ELSE 0 END) AS expenses " +
        'FROM `accounting_lines` l WHERE l.`entry_date` BETWEEN ? AND ?' +
        branch +
        ' GROUP BY bucket ORDER BY bucket',
      ...params,
    );

    const revenue: Record<string, any> = {};
    const expenses: Record<string, any> = {};
    let totalRevenue = 0;
    let totalExpenses = 0;
    for (const r of rows) {
      const isRev = String(r.account).startsWith('7');
      const target = isRev ? revenue : expenses;
      const valueRef = isRev ? Number(r.netRef) : -Number(r.netRef);
      const value = isRev ? Number(r.net) : -Number(r.net);
      const g = (target[r.account] ??= {
        account: r.account,
        label: REVENUE_GROUPS[r.account] || ACCOUNT_LABEL[r.account] || r.account,
        total: 0,
        byCurrency: {} as Record<string, number>,
      });
      g.total += valueRef * disp.factor;
      g.byCurrency[r.currency] = round3((g.byCurrency[r.currency] || 0) + value);
      if (isRev) totalRevenue += valueRef * disp.factor;
      else totalExpenses += valueRef * disp.factor;
    }
    const fx: any[] = await this.db.$queryRawUnsafe(
      "SELECT SUM(l.`debit_ref` - l.`credit_ref`) AS v FROM `accounting_lines` l WHERE l.`account_code` = '5852' AND l.`entry_date` BETWEEN ? AND ?" + branch,
      ...params,
    );
    const fxResult = round3(-Number(fx?.[0]?.v || 0) * disp.factor); // compensation créditrice = gain
    const fin = (o: Record<string, any>) =>
      Object.values(o)
        .map((g: any) => ({ ...g, total: round3(g.total) }))
        .sort((a: any, b: any) => b.total - a.total);
    const revenueList = fin(revenue);
    const net = round3(totalRevenue - totalExpenses);
    return {
      message: 'Ce que F-Pay gagne',
      data: {
        period: { from, to },
        currency: disp.code,
        accountingCurrency: this.currency,
        summary: {
          revenue: round3(totalRevenue),
          expenses: round3(totalExpenses),
          netResult: net,
          margin: totalRevenue > 0 ? Math.round((net / totalRevenue) * 10000) / 100 : null,
          fxDifference: fxResult,
          netResultWithFx: round3(net + fxResult),
        },
        revenue: revenueList,
        expenses: fin(expenses),
        topSource: revenueList[0] ?? null,
        series: series.map((s) => ({
          period: s.bucket,
          revenue: round3(Number(s.revenue) * disp.factor),
          expenses: round3(Number(s.expenses) * disp.factor),
          net: round3((Number(s.revenue) - Number(s.expenses)) * disp.factor),
        })),
        lastPosting: await this.meta('last_incremental_run').catch(() => null),
        notes: [
          'Produits = frais encaissés dans le wallet des frais + frais déduits des dépôts/retraits Mobile Money + frais des paiements internationaux.',
          "Charges = commissions opérateur estimées (si un taux est configuré) + écritures manuelles (factures PawaPay, loyers, salaires…).",
          `Montants convertis en ${disp.code} au taux du jour de chaque opération.`,
        ],
      },
    };
  }

  // ============================================================
  // ÉTATS SYSCOHADA
  // ============================================================
  /** Balance générale : mouvements de la période et solde cumulé à la date de fin, par compte */
  async trialBalance(q: any) {
    const { from, to } = await this.period(q);
    const disp = await this.display(q);
    const rows: any[] = await this.db.$queryRawUnsafe(
      'SELECT l.`account_code` AS account, ' +
        'SUM(CASE WHEN l.`entry_date` < ? THEN l.`debit_ref` ELSE 0 END) AS openD, SUM(CASE WHEN l.`entry_date` < ? THEN l.`credit_ref` ELSE 0 END) AS openC, ' +
        'SUM(CASE WHEN l.`entry_date` >= ? THEN l.`debit_ref` ELSE 0 END) AS movD, SUM(CASE WHEN l.`entry_date` >= ? THEN l.`credit_ref` ELSE 0 END) AS movC ' +
        'FROM `accounting_lines` l WHERE l.`entry_date` <= ? GROUP BY l.`account_code` ORDER BY l.`account_code`',
      from,
      from,
      from,
      from,
      to,
    );
    const labels = await this.labels();
    let tD = 0;
    let tC = 0;
    const accounts = rows.map((r) => {
      const f = disp.factor;
      const openD = Number(r.openD) * f;
      const openC = Number(r.openC) * f;
      const movD = Number(r.movD) * f;
      const movC = Number(r.movC) * f;
      const bal = openD + movD - openC - movC;
      tD += movD;
      tC += movC;
      return {
        account: r.account,
        label: labels[r.account] || r.account,
        class: String(r.account)[0],
        opening: { debit: round3(Math.max(0, openD - openC)), credit: round3(Math.max(0, openC - openD)) },
        movements: { debit: round3(movD), credit: round3(movC) },
        closing: { debit: round3(Math.max(0, bal)), credit: round3(Math.max(0, -bal)) },
      };
    });
    return {
      message: 'Balance générale',
      data: { period: { from, to }, currency: disp.code, accounts, totals: { debit: round3(tD), credit: round3(tC), balanced: Math.abs(round3(tD - tC)) < 0.01 } },
    };
  }

  /** Compte de résultat (présentation SYSCOHADA simplifiée) */
  async incomeStatement(q: any) {
    const { from, to } = await this.period(q);
    const disp = await this.display(q);
    const rows: any[] = await this.db.$queryRawUnsafe(
      "SELECT l.`account_code` AS account, SUM(l.`credit_ref` - l.`debit_ref`) AS net FROM `accounting_lines` l WHERE l.`entry_date` BETWEEN ? AND ? AND (l.`account_code` LIKE '6%' OR l.`account_code` LIKE '7%') GROUP BY l.`account_code` ORDER BY l.`account_code`",
      from,
      to,
    );
    const labels = await this.labels();
    const f = disp.factor;
    const line = (r: any, sign: number) => ({ account: r.account, label: labels[r.account] || r.account, amount: round3(Number(r.net) * f * sign) });
    const isFin = (a: string) => a.startsWith('77') || a.startsWith('67');
    const prodExpl = rows.filter((r) => r.account.startsWith('7') && !isFin(r.account)).map((r) => line(r, 1));
    const chExpl = rows.filter((r) => r.account.startsWith('6') && !isFin(r.account) && !r.account.startsWith('69')).map((r) => line(r, -1));
    const prodFin = rows.filter((r) => r.account.startsWith('77')).map((r) => line(r, 1));
    const chFin = rows.filter((r) => r.account.startsWith('67')).map((r) => line(r, -1));
    const impots = rows.filter((r) => r.account.startsWith('89') || r.account.startsWith('69')).map((r) => line(r, -1));
    const sum = (a: any[]) => round3(a.reduce((s, x) => s + x.amount, 0));
    const fx: any[] = await this.db.$queryRawUnsafe(
      "SELECT SUM(l.`credit_ref` - l.`debit_ref`) AS v FROM `accounting_lines` l WHERE l.`account_code` = '5852' AND l.`entry_date` BETWEEN ? AND ?",
      from,
      to,
    );
    const fxUnposted = round3(Number(fx?.[0]?.v || 0) * f);
    const re = sum(prodExpl) - sum(chExpl);
    const rf = sum(prodFin) - sum(chFin);
    return {
      message: 'Compte de résultat',
      data: {
        period: { from, to },
        currency: disp.code,
        exploitation: { produits: prodExpl, totalProduits: sum(prodExpl), charges: chExpl, totalCharges: sum(chExpl), resultat: round3(re) },
        financier: { produits: prodFin, charges: chFin, resultat: round3(rf), ecartsDeConversionNonPasses: fxUnposted },
        impots: { lignes: impots, total: sum(impots) },
        resultatNet: round3(re + rf - sum(impots)),
        note:
          fxUnposted !== 0
            ? "Le compte 5852 (conversions de devises) présente un solde : passez une écriture OD vers 776 (gain) ou 676 (perte) lors de la clôture."
            : null,
      },
    };
  }

  /** Bilan simplifié à une date */
  async balanceSheet(q: any) {
    const { to } = await this.period(q);
    const disp = await this.display(q);
    const rows: any[] = await this.db.$queryRawUnsafe(
      'SELECT l.`account_code` AS account, SUM(l.`debit_ref` - l.`credit_ref`) AS bal FROM `accounting_lines` l WHERE l.`entry_date` <= ? GROUP BY l.`account_code`',
      to,
    );
    const labels = await this.labels();
    const f = disp.factor;
    const actif: any[] = [];
    const passif: any[] = [];
    let resultat = 0;
    for (const r of rows) {
      const bal = Number(r.bal) * f;
      const t = accountType(r.account);
      if (t === 'REVENUE' || t === 'EXPENSE') {
        resultat += -bal; // produits créditeurs − charges débitrices
        continue;
      }
      const item = { account: r.account, label: labels[r.account] || r.account };
      if (t === 'ASSET') actif.push({ ...item, amount: round3(bal) });
      else passif.push({ ...item, amount: round3(-bal) });
    }
    passif.push({ account: resultat >= 0 ? '131' : '139', label: resultat >= 0 ? 'Résultat net : bénéfice (non affecté)' : 'Résultat net : perte (non affectée)', amount: round3(resultat) });
    const totalActif = round3(actif.reduce((s, x) => s + x.amount, 0));
    const totalPassif = round3(passif.reduce((s, x) => s + x.amount, 0));
    return {
      message: 'Bilan simplifié',
      data: { date: to, currency: disp.code, actif, passif, totalActif, totalPassif, equilibre: Math.abs(round3(totalActif - totalPassif)) < 0.01 },
    };
  }

  /** Grand livre d'un compte */
  async generalLedger(q: any) {
    if (!q?.account) this.fail(400, 'Indiquez le compte (account)');
    const { from, to } = await this.period(q);
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const like = String(q.account).endsWith('*') ? String(q.account).slice(0, -1) + '%' : String(q.account);
    const op = like.includes('%') ? 'LIKE' : '=';
    const open: any[] = await this.db.$queryRawUnsafe(
      `SELECT SUM(\`debit_ref\` - \`credit_ref\`) AS v FROM \`accounting_lines\` WHERE \`account_code\` ${op} ? AND \`entry_date\` < ?`,
      like,
      from,
    );
    const total = Number(
      (await this.db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`accounting_lines\` WHERE \`account_code\` ${op} ? AND \`entry_date\` BETWEEN ? AND ?`, like, from, to))?.[0]?.n ?? 0,
    );
    const rows: any[] = await this.db.$queryRawUnsafe(
      'SELECT l.*, e.`journal`, e.`reference`, e.`label` AS entryLabel, e.`source` FROM `accounting_lines` l INNER JOIN `accounting_entries` e ON e.`id` = l.`entry_id` ' +
        `WHERE l.\`account_code\` ${op} ? AND l.\`entry_date\` BETWEEN ? AND ? ORDER BY l.\`entry_date\`, e.\`created_at\`, l.\`line\` LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      like,
      from,
      to,
    );
    let running = Number(open?.[0]?.v || 0);
    return {
      message: 'Grand livre',
      data: {
        account: q.account,
        label: (await this.labels())[String(q.account)] ?? null,
        period: { from, to },
        currency: this.currency,
        opening: round3(running),
        lines: rows.map((r) => {
          running += Number(r.debit_ref) - Number(r.credit_ref);
          return {
            date: r.entry_date,
            journal: r.journal,
            reference: r.reference,
            label: r.label || r.entryLabel,
            account: r.account_code,
            debit: round3(r.debit_ref),
            credit: round3(r.credit_ref),
            original: { currency: r.currency, debit: round3(r.debit), credit: round3(r.credit) },
            balance: round3(running),
            source: r.source,
          };
        }),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /** Journal (écritures avec leurs lignes) */
  async journal(q: any) {
    const { from, to } = await this.period(q);
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const parts = ['e.`entry_date` BETWEEN ? AND ?'];
    const params: any[] = [from, to];
    if (q.journal) {
      parts.push('e.`journal` = ?');
      params.push(String(q.journal).toUpperCase());
    }
    if (q.source) {
      parts.push('e.`source` = ?');
      params.push(String(q.source).toUpperCase());
    }
    if (q.search) {
      parts.push('(e.`reference` LIKE ? OR e.`label` LIKE ?)');
      params.push(`%${q.search}%`, `%${q.search}%`);
    }
    const where = parts.join(' AND ');
    const total = Number((await this.db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`accounting_entries\` e WHERE ${where}`, ...params))?.[0]?.n ?? 0);
    const entries: any[] = await this.db.$queryRawUnsafe(
      `SELECT e.*, u.\`full_name\` AS createdByName FROM \`accounting_entries\` e LEFT JOIN \`user\` u ON u.\`id\` = e.\`created_by\` WHERE ${where} ORDER BY e.\`entry_date\` DESC, e.\`created_at\` DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      ...params,
    );
    const ids = entries.map((e) => e.id);
    const lines: any[] = ids.length
      ? await this.db.$queryRawUnsafe(`SELECT * FROM \`accounting_lines\` WHERE \`entry_id\` IN (${ids.map(() => '?').join(',')}) ORDER BY \`line\``, ...ids)
      : [];
    const labels = await this.labels();
    return {
      message: 'Journal',
      data: {
        period: { from, to },
        journals: JOURNALS,
        data: entries.map((e) => ({
          id: e.id,
          journal: e.journal,
          date: e.entry_date,
          reference: e.reference,
          label: e.label,
          source: e.source,
          currency: e.currency,
          rateToAccountingCurrency: Number(e.rate_to_ref),
          transactionId: e.transaction_id,
          reversedBy: e.reversed_by,
          createdBy: e.createdByName || e.created_by,
          lines: lines
            .filter((l) => l.entry_id === e.id)
            .map((l) => ({ account: l.account_code, label: l.label || labels[l.account_code] || l.account_code, debit: round3(l.debit), credit: round3(l.credit) })),
        })),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ============================================================
  // PLAN COMPTABLE, ÉCRITURES MANUELLES, COÛTS OPÉRATEUR, CLÔTURE
  // ============================================================
  private async labels(): Promise<Record<string, string>> {
    const out: Record<string, string> = { ...ACCOUNT_LABEL };
    const rows: any[] = await this.db.$queryRawUnsafe('SELECT `code`, `label` FROM `accounting_accounts`').catch(() => []);
    for (const r of rows) out[r.code] = r.label;
    return out;
  }

  async accounts() {
    const rows: any[] = await this.db.$queryRawUnsafe('SELECT * FROM `accounting_accounts` ORDER BY `code`').catch(() => []);
    const list = rows.length ? rows.map((r) => ({ code: r.code, label: r.label, type: r.type, isSystem: !!Number(r.is_system), isActive: !!Number(r.is_active) })) : SYSCOHADA_ACCOUNTS.map((a) => ({ ...a, isSystem: true, isActive: true }));
    return { message: 'Plan comptable SYSCOHADA', data: { accounts: list, journals: JOURNALS, accountingCurrency: this.currency } };
  }

  async createAccount(dto: any, adminId: string) {
    const code = String(dto?.code || '').trim();
    const label = String(dto?.label || '').trim();
    if (!/^[1-8]\d{1,7}$/.test(code)) this.fail(400, 'Numéro de compte SYSCOHADA invalide (classe 1 à 8, 2 à 8 chiffres)');
    if (!label) this.fail(400, 'Libellé obligatoire');
    try {
      await this.db.$executeRawUnsafe(
        'INSERT INTO `accounting_accounts` (`code`, `label`, `type`, `is_system`, `is_active`, `created_at`) VALUES (?, ?, ?, 0, 1, UTC_TIMESTAMP())',
        code,
        label.slice(0, 150),
        accountType(code),
      );
    } catch (e: any) {
      if (/Duplicate|1062/.test(String(e?.message))) this.fail(409, `Le compte ${code} existe déjà`);
      throw e;
    }
    await this.audit(adminId, 'ACCOUNTING_ACCOUNT_CREATE', { code, label });
    return { message: `Compte ${code} créé`, data: { code, label, type: accountType(code) } };
  }

  private async assertOpen(date: string) {
    const rows: any[] = await this.db.$queryRawUnsafe("SELECT `period` FROM `accounting_periods` WHERE `period` = ? AND `status` = 'CLOSED' LIMIT 1", date.slice(0, 7));
    if (rows?.[0]) this.fail(409, `La période ${date.slice(0, 7)} est clôturée : aucune écriture ne peut y être passée`);
  }

  /** Écriture manuelle équilibrée (journal OD par défaut) — ex. facture PawaPay : débit 6318 / crédit 5311 */
  async createManualEntry(dto: any, adminId: string) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dto?.date || '')) ? String(dto.date) : await this.localDate(new Date());
    await this.assertOpen(date);
    const label = String(dto?.label || '').trim();
    if (!label) this.fail(400, 'Libellé obligatoire');
    const currency = String(dto?.currency || this.currency).toUpperCase();
    const rate = convertWithRates(1, currency, this.currency, await this.rates());
    if (rate === null) this.fail(400, `Taux ${currency} → ${this.currency} non configuré`);
    const known = new Set((await this.accounts()).data.accounts.filter((a: any) => a.isActive).map((a: any) => a.code));
    const err = validateManualLines(dto?.lines, known);
    if (err) this.fail(400, err);
    const journal = String(dto?.journal || 'OD').toUpperCase().slice(0, 4);
    const id = crypto.randomUUID();
    await this.prisma.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO `accounting_entries` (`id`, `journal`, `entry_date`, `reference`, `label`, `source`, `transaction_id`, `version`, `currency`, `rate_to_ref`, `branch_id`, `created_by`, `created_at`) ' +
          "VALUES (?, ?, ?, ?, ?, 'MANUAL', NULL, 1, ?, ?, ?, ?, UTC_TIMESTAMP())",
        id,
        journal,
        date,
        dto?.reference ? String(dto.reference).slice(0, 100) : null,
        label.slice(0, 250),
        currency,
        rate,
        dto?.branchId ?? null,
        adminId,
      );
      let i = 0;
      for (const l of dto.lines) {
        const d = round3(l.debit || 0);
        const c = round3(l.credit || 0);
        await tx.$executeRawUnsafe(
          'INSERT INTO `accounting_lines` (`id`, `entry_id`, `line`, `account_code`, `debit`, `credit`, `debit_ref`, `credit_ref`, `currency`, `entry_date`, `branch_id`, `label`) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          crypto.randomUUID(),
          id,
          ++i,
          String(l.account),
          d,
          c,
          round3(d * rate!),
          round3(c * rate!),
          currency,
          date,
          dto?.branchId ?? null,
          l.label ? String(l.label).slice(0, 250) : null,
        );
      }
    });
    await this.audit(adminId, 'ACCOUNTING_MANUAL_ENTRY', { id, date, journal, label, currency, lines: dto.lines });
    return { message: 'Écriture enregistrée', data: { id, date, journal } };
  }

  /** Extourne d'une écriture manuelle (jamais de suppression) */
  async reverseEntry(id: string, adminId: string, reason?: string) {
    const rows: any[] = await this.db.$queryRawUnsafe('SELECT * FROM `accounting_entries` WHERE `id` = ? LIMIT 1', id);
    const e = rows?.[0];
    if (!e) this.fail(404, 'Écriture introuvable');
    if (e.source !== 'MANUAL') this.fail(400, "Seules les écritures manuelles s'extournent ici (les écritures automatiques suivent les transactions)");
    if (e.reversed_by) this.fail(409, 'Écriture déjà extournée');
    const date = await this.localDate(new Date());
    await this.assertOpen(date);
    const lines: any[] = await this.db.$queryRawUnsafe('SELECT * FROM `accounting_lines` WHERE `entry_id` = ? ORDER BY `line`', id);
    const newId = crypto.randomUUID();
    await this.prisma.$transaction(async (tx: any) => {
      const n = Number(await tx.$executeRawUnsafe('UPDATE `accounting_entries` SET `reversed_by` = ? WHERE `id` = ? AND `reversed_by` IS NULL', newId, id));
      if (n !== 1) throw new RpcException({ status: 'error', statusCode: 409, message: 'Écriture déjà extournée' });
      await tx.$executeRawUnsafe(
        'INSERT INTO `accounting_entries` (`id`, `journal`, `entry_date`, `reference`, `label`, `source`, `transaction_id`, `version`, `currency`, `rate_to_ref`, `branch_id`, `created_by`, `created_at`) ' +
          "VALUES (?, ?, ?, ?, ?, 'REVERSAL', NULL, 1, ?, ?, ?, ?, UTC_TIMESTAMP())",
        newId,
        e.journal,
        date,
        e.reference,
        `Extourne : ${e.label}${reason ? ` (${String(reason).slice(0, 100)})` : ''}`.slice(0, 250),
        e.currency,
        e.rate_to_ref,
        e.branch_id,
        adminId,
      );
      for (const l of lines) {
        await tx.$executeRawUnsafe(
          'INSERT INTO `accounting_lines` (`id`, `entry_id`, `line`, `account_code`, `debit`, `credit`, `debit_ref`, `credit_ref`, `currency`, `entry_date`, `branch_id`, `label`) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          crypto.randomUUID(),
          newId,
          l.line,
          l.account_code,
          l.credit,
          l.debit,
          l.credit_ref,
          l.debit_ref,
          l.currency,
          date,
          l.branch_id,
          l.label,
        );
      }
    });
    await this.audit(adminId, 'ACCOUNTING_ENTRY_REVERSED', { id, reversal: newId, reason });
    return { message: 'Écriture extournée', data: { id, reversalId: newId } };
  }

  async providerCosts() {
    const rows: any[] = await this.db.$queryRawUnsafe('SELECT * FROM `accounting_provider_costs` ORDER BY `operation`, `currency`');
    return {
      message: 'Commissions opérateur (estimation des charges)',
      data: rows.map((r) => ({ id: r.id, operation: r.operation, currency: r.currency, percentage: Number(r.percentage), fixedFee: Number(r.fixed_fee), updatedAt: r.updated_at })),
    };
  }

  /** { operation: DEPOSIT | PAYOUT, currency: 'CDF' | '*', percentage, fixedFee } — s'applique aux nouvelles écritures */
  async setProviderCost(dto: any, adminId: string) {
    const op = String(dto?.operation || '').toUpperCase();
    if (!['DEPOSIT', 'PAYOUT'].includes(op)) this.fail(400, 'Opération : DEPOSIT ou PAYOUT');
    const currency = String(dto?.currency || '*').toUpperCase();
    const pct = Number(dto?.percentage || 0);
    const fixed = Number(dto?.fixedFee || 0);
    if (!Number.isFinite(pct) || pct < 0 || pct > 20 || !Number.isFinite(fixed) || fixed < 0) this.fail(400, 'Taux (0 à 20 %) ou frais fixe invalide');
    await this.db.$executeRawUnsafe(
      'INSERT INTO `accounting_provider_costs` (`id`, `operation`, `currency`, `percentage`, `fixed_fee`, `updated_by`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP()) ' +
        'ON DUPLICATE KEY UPDATE `percentage` = VALUES(`percentage`), `fixed_fee` = VALUES(`fixed_fee`), `updated_by` = VALUES(`updated_by`), `updated_at` = UTC_TIMESTAMP()',
      crypto.randomUUID(),
      op,
      currency,
      pct,
      fixed,
      adminId,
    );
    await this.audit(adminId, 'ACCOUNTING_PROVIDER_COST', { op, currency, pct, fixed });
    return { message: 'Commission opérateur enregistrée (appliquée aux prochaines écritures)', data: { operation: op, currency, percentage: pct, fixedFee: fixed } };
  }

  async periods() {
    const rows: any[] = await this.db.$queryRawUnsafe('SELECT p.*, u.`full_name` AS byName FROM `accounting_periods` p LEFT JOIN `user` u ON u.`id` = p.`closed_by` ORDER BY p.`period` DESC LIMIT 60');
    return { message: 'Périodes comptables', data: rows.map((r) => ({ period: r.period, status: r.status, closedBy: r.byName || r.closed_by, closedAt: r.closed_at })) };
  }

  /** Clôture d'un mois (AAAA-MM) : plus aucune écriture manuelle ne peut y être passée. reopen = true pour rouvrir */
  async closePeriod(period: string, adminId: string, reopen = false) {
    if (!/^\d{4}-\d{2}$/.test(String(period))) this.fail(400, 'Période au format AAAA-MM');
    if (reopen) {
      await this.db.$executeRawUnsafe("UPDATE `accounting_periods` SET `status` = 'OPEN', `closed_by` = ?, `closed_at` = UTC_TIMESTAMP() WHERE `period` = ?", adminId, period);
    } else {
      if (period >= (await this.localDate(new Date())).slice(0, 7)) this.fail(400, 'Seul un mois terminé peut être clôturé');
      await this.db.$executeRawUnsafe(
        "INSERT INTO `accounting_periods` (`period`, `status`, `closed_by`, `closed_at`) VALUES (?, 'CLOSED', ?, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE `status` = 'CLOSED', `closed_by` = VALUES(`closed_by`), `closed_at` = UTC_TIMESTAMP()",
        period,
        adminId,
      );
    }
    await this.audit(adminId, reopen ? 'ACCOUNTING_PERIOD_REOPEN' : 'ACCOUNTING_PERIOD_CLOSE', { period });
    return { message: reopen ? `Période ${period} rouverte` : `Période ${period} clôturée`, data: { period, status: reopen ? 'OPEN' : 'CLOSED' } };
  }

  private async audit(userId: string | null, action: string, details: any) {
    await this.db
      .$executeRawUnsafe(
        'INSERT INTO `audit_log` (`id`, `userId`, `action`, `details`, `ipAddress`, `createdAt`) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())',
        crypto.randomUUID(),
        userId,
        action,
        JSON.stringify(details ?? {}),
        'system',
      )
      .catch(() => undefined);
  }
}
