// apps/wallet-service/src/controls/ledger.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RpcException } from '@nestjs/microservices';
import * as crypto from 'crypto';
import { round3 } from '@app/common';
import { PrismaService } from '../prisma/prisma.service';
import { WALLET_KIND_SQL, WalletKind, effectiveAmount, ledgerLines, walletLedgerBalance } from './controls.util';

/**
 * ✅ GRAND LIVRE EN PARTIE DOUBLE (tenu EN PARALLÈLE, sans rien changer aux traitements existants)
 *
 *  Chaque transaction RÉUSSIE produit deux écritures équilibrées (wallet ↔ compte de passage).
 *  Une transaction qui change ensuite (annulée, montant corrigé) produit des écritures de correction :
 *  le journal n'est JAMAIS modifié ni supprimé (append-only), il garde tout l'historique.
 *
 *  Projection : toutes les 5 minutes (transactions modifiées depuis le dernier passage) + balayage complet la nuit.
 *  Utilisations : balance générale par compte et devise, solde de chaque wallet prouvé par ses écritures,
 *  écarts wallet ↔ grand livre, comptes de passage non soldés (flux externes ou anomalies).
 *  Tables : ledger_entries, ledger_tx_state, ledger_meta (SQL fourni).
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);
  private running = false;
  private missingLogged = false;

  constructor(private readonly prisma: PrismaService) {}

  private get db(): any {
    return this.prisma as any;
  }

  private get enabled(): boolean {
    return String(process.env.LEDGER_ENABLED ?? 'true').toLowerCase() !== 'false';
  }

  private isMissing(e: any): boolean {
    return /doesn't exist|1146|ER_NO_SUCH_TABLE/i.test(String(e?.message || ''));
  }

  private async meta(key: string): Promise<string | null> {
    const rows: any[] = await this.db.$queryRawUnsafe('SELECT `v` FROM `ledger_meta` WHERE `k` = ? LIMIT 1', key);
    return rows?.[0]?.v ?? null;
  }

  private async setMeta(key: string, value: string) {
    await this.db.$executeRawUnsafe(
      'INSERT INTO `ledger_meta` (`k`, `v`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `v` = VALUES(`v`)',
      key,
      value,
    );
  }

  @Cron('30 */5 * * * *')
  async incremental() {
    await this.project('incremental');
  }

  @Cron('0 30 2 * * *')
  async nightly() {
    await this.project('full', 2000);
  }

  /** Projette les transactions dans le journal. mode full = toutes les transactions (par lots) */
  async project(mode: 'incremental' | 'full' = 'incremental', maxBatches = 200): Promise<{ processed: number; lines: number }> {
    const stats = { processed: 0, lines: 0 };
    if (!this.enabled || this.running) return stats;
    this.running = true;
    try {
      const batch = Math.min(2000, Math.max(50, Number(process.env.LEDGER_BATCH) || 500));
      const startedAt = new Date();
      // Curseur (updatedAt, id) : reprise exacte, 2 min de recouvrement pour les écritures concurrentes
      let since: Date = new Date(0);
      if (mode === 'incremental') {
        const c = await this.meta('cursor_updated_at');
        if (c) since = new Date(new Date(c).getTime() - 2 * 60 * 1000);
      }
      let lastUpdated: Date = since;
      let lastId = '';
      for (let i = 0; i < maxBatches; i++) {
        const rows: any[] = await this.db.$queryRawUnsafe(
          'SELECT t.`id`, t.`walletId`, t.`amount`, t.`status`, t.`movement`, t.`paymentMethod`, t.`currency`, t.`type`, t.`reference`, ' +
            't.`createdAt`, t.`updatedAt`, w.`currency` AS walletCurrency, ' +
            `${WALLET_KIND_SQL} AS walletKind, ` +
            'st.`projected_amount` AS stAmount, st.`projected_status` AS stStatus, st.`version` AS stVersion, ' +
            // Conversion de devises : deux transactions du même utilisateur, même référence, devises différentes
            '(SELECT COUNT(*) FROM `transaction` t2 WHERE t2.`reference` = t.`reference` AND t2.`userId` = t.`userId` AND t2.`id` <> t.`id` AND t2.`currency` <> t.`currency`) AS fxPeers ' +
            'FROM `transaction` t INNER JOIN `wallet` w ON w.`id` = t.`walletId` LEFT JOIN `user` u ON u.`id` = w.`userId` ' +
            'LEFT JOIN `ledger_tx_state` st ON st.`transaction_id` = t.`id` ' +
            'WHERE (t.`updatedAt` > ? OR (t.`updatedAt` = ? AND t.`id` > ?)) ' +
            'ORDER BY t.`updatedAt` ASC, t.`id` ASC LIMIT ' +
            batch,
          lastUpdated,
          lastUpdated,
          lastId,
        );
        if (!rows.length) break;
        for (const t of rows) {
          stats.processed++;
          stats.lines += await this.projectOne(t);
        }
        const last = rows[rows.length - 1];
        lastUpdated = new Date(last.updatedAt);
        lastId = last.id;
        if (rows.length < batch) break;
      }
      if (mode === 'incremental' || stats.processed > 0) {
        await this.setMeta('cursor_updated_at', (lastUpdated > since ? lastUpdated : startedAt).toISOString());
      }
      await this.setMeta(`last_${mode}_run`, startedAt.toISOString());
      if (stats.lines) this.logger.log(`📒 Grand livre (${mode}) : ${stats.processed} transaction(s), ${stats.lines} écriture(s)`);
    } catch (e: any) {
      if (this.isMissing(e)) {
        if (!this.missingLogged) this.logger.warn('Tables ledger_* absentes : grand livre désactivé (exécutez le SQL)');
        this.missingLogged = true;
      } else this.logger.error(`Grand livre : ${e?.message}`);
    } finally {
      this.running = false;
    }
    return stats;
  }

  /** Écritures manquantes pour une transaction (différence entre l'état projeté et l'état réel) */
  private async projectOne(t: any): Promise<number> {
    const target = effectiveAmount(t.status, t.amount);
    const current = t.stStatus ? effectiveAmount(t.stStatus, t.stAmount) : 0;
    const delta = round3(target - current);
    const sameState = t.stStatus !== null && t.stStatus !== undefined && String(t.stStatus) === String(t.status) && round3(t.stAmount) === round3(t.amount);
    if (delta === 0 && sameState) return 0;

    const version = (Number(t.stVersion) || 0) + 1;
    const currency = String(t.currency || t.walletCurrency || 'N/A').toUpperCase();
    const lines = ledgerLines({
      walletId: t.walletId,
      walletKind: (t.walletKind || 'CUSTOMER') as WalletKind,
      movement: t.movement === 'DEBIT' ? 'DEBIT' : 'CREDIT',
      // Les conversions sont enregistrées « MOBILE_MONEY » par l'ancien code : comptées à part (FX)
      paymentMethod: Number(t.fxPeers) > 0 ? 'FX' : t.paymentMethod,
      currency,
      delta,
    });
    await this.prisma.$transaction(async (tx: any) => {
      // Verrou optimiste : une seule projection par version
      if (t.stStatus === null || t.stStatus === undefined) {
        await tx.$executeRawUnsafe(
          'INSERT INTO `ledger_tx_state` (`transaction_id`, `projected_amount`, `projected_status`, `version`, `updated_at`) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())',
          t.id,
          round3(t.amount),
          String(t.status),
          lines.length ? version : 0,
        );
      } else {
        const n = Number(
          await tx.$executeRawUnsafe(
            'UPDATE `ledger_tx_state` SET `projected_amount` = ?, `projected_status` = ?, `version` = ?, `updated_at` = UTC_TIMESTAMP() WHERE `transaction_id` = ? AND `version` = ?',
            round3(t.amount),
            String(t.status),
            lines.length ? version : Number(t.stVersion) || 0,
            t.id,
            Number(t.stVersion) || 0,
          ),
        );
        if (n !== 1) throw new Error('concurrent');
      }
      for (const l of lines) {
        await tx.$executeRawUnsafe(
          'INSERT INTO `ledger_entries` (`id`, `transaction_id`, `version`, `line`, `account`, `account_kind`, `wallet_id`, `currency`, `debit`, `credit`, ' +
            '`tx_type`, `payment_method`, `tx_reference`, `occurred_at`, `created_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
          crypto.randomUUID(),
          t.id,
          version,
          l.line,
          l.account,
          l.accountKind,
          l.walletId,
          currency,
          l.debit,
          l.credit,
          t.type ?? null,
          t.paymentMethod ?? null,
          t.reference ?? null,
          version === 1 ? t.createdAt : t.updatedAt,
        );
      }
    }).catch((e: any) => {
      if (String(e?.message) === 'concurrent' || /Duplicate|1062/.test(String(e?.message))) return; // déjà projetée ailleurs
      throw e;
    });
    return lines.length;
  }

  // ============================================================
  // RAPPORTS
  // ============================================================

  /** Balance générale : total débit / crédit par groupe de comptes et devise (doit être équilibrée) */
  async trialBalance(q: { currency?: string; to?: string } = {}) {
    const params: any[] = [];
    let where = '1 = 1';
    if (q.currency) {
      where += ' AND `currency` = ?';
      params.push(String(q.currency).toUpperCase());
    }
    if (q.to && !isNaN(new Date(q.to).getTime())) {
      where += ' AND `occurred_at` < ?';
      params.push(new Date(q.to));
    }
    const groups: any[] = await this.db.$queryRawUnsafe(
      "SELECT `currency`, `account_kind` AS kind, CASE WHEN `account_kind` = 'CLEARING' THEN `account` ELSE `account_kind` END AS grp, " +
        'COUNT(*) AS lines, SUM(`debit`) AS debit, SUM(`credit`) AS credit FROM `ledger_entries` ' +
        `WHERE ${where} GROUP BY \`currency\`, \`account_kind\`, grp ORDER BY \`currency\`, grp`,
      ...params,
    );
    const byCurrency: Record<string, any> = {};
    for (const g of groups) {
      const c = (byCurrency[g.currency] ??= { currency: g.currency, debit: 0, credit: 0, accounts: [] as any[] });
      const debit = round3(g.debit);
      const credit = round3(g.credit);
      c.debit += debit;
      c.credit += credit;
      c.accounts.push({
        account: g.grp,
        kind: g.kind,
        lines: Number(g.lines) || 0,
        debit,
        credit,
        // Passif (wallets clients / frais) : crédit − débit ; actif (caisses) et passage : débit − crédit
        balance: g.kind === 'WALLET_LIABILITY' ? round3(credit - debit) : round3(debit - credit),
      });
    }
    const currencies = Object.values(byCurrency).map((c: any) => ({
      ...c,
      debit: round3(c.debit),
      credit: round3(c.credit),
      balanced: Math.abs(round3(c.debit - c.credit)) < 0.001,
    }));
    return {
      message: 'Balance générale du grand livre',
      data: {
        lastRun: await this.meta('last_incremental_run').catch(() => null),
        currencies,
        help:
          "WALLET_LIABILITY = argent dû aux clients et frais encaissés ; WALLET_ASSET = cash des caisses ; CLEARING:<moyen>:<devise> = comptes de passage. " +
          'CLEARING:INTERNAL ≈ 0 attendu (virements internes) ; CLEARING:MOBILE_MONEY = flux nets avec les opérateurs ; CLEARING:CASH = cash entré/sorti hors caisse suivie.',
      },
    };
  }

  /** Wallets dont le solde diffère du grand livre (hors retraits réservés en attente) */
  async walletCheck(q: { currency?: string; limit?: number } = {}) {
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const params: any[] = [];
    let where = 'w.`isActive` = 1';
    if (q.currency) {
      where += ' AND w.`currency` = ?';
      params.push(String(q.currency).toUpperCase());
    }
    const rows: any[] = await this.db.$queryRawUnsafe(
      'SELECT x.* FROM (SELECT w.`id`, w.`userId`, w.`currency`, w.`balance`, u.`full_name` AS userName, ' +
        `${WALLET_KIND_SQL} AS kind, ` +
        '(SELECT COALESCE(SUM(le.`debit`), 0) FROM `ledger_entries` le WHERE le.`wallet_id` = w.`id`) AS debit, ' +
        '(SELECT COALESCE(SUM(le.`credit`), 0) FROM `ledger_entries` le WHERE le.`wallet_id` = w.`id`) AS credit, ' +
        "(SELECT COALESCE(SUM(t.`amount`), 0) FROM `transaction` t WHERE t.`walletId` = w.`id` AND t.`status` = 'PENDING' AND t.`movement` = 'DEBIT' " +
        "AND t.`external_reference` LIKE '%\"kind\":\"PAWAPAY_PAYOUT\"%') AS reserved " +
        `FROM \`wallet\` w LEFT JOIN \`user\` u ON u.\`id\` = w.\`userId\` WHERE ${where}) x ` +
        'ORDER BY x.`id` LIMIT 20000',
      ...params,
    );
    const gaps: any[] = [];
    for (const r of rows) {
      const ledger = walletLedgerBalance(r.kind, Number(r.debit), Number(r.credit));
      const expected = round3(ledger - (r.kind === 'BRANCH_CASH' ? 0 : Number(r.reserved)));
      const gap = round3(Number(r.balance) - expected);
      if (Math.abs(gap) >= 0.001) {
        gaps.push({
          walletId: r.id,
          userId: r.userId,
          userName: r.userName,
          kind: r.kind,
          currency: r.currency,
          balance: round3(r.balance),
          ledgerBalance: ledger,
          reservedPending: round3(r.reserved),
          gap,
        });
      }
    }
    gaps.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
    return {
      message:
        "Wallets dont le solde ne correspond pas au grand livre. Cause fréquente : solde initial ou ancienne opération enregistrée sans transaction ; à analyser avant toute correction.",
      data: { checked: rows.length, count: gaps.length, gaps: gaps.slice(0, limit) },
    };
  }

  /** Écritures d'un compte, d'un wallet ou d'une transaction */
  async entries(q: { account?: string; walletId?: string; transactionId?: string; page?: number; limit?: number }) {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const parts: string[] = [];
    const params: any[] = [];
    if (q.account) {
      parts.push('`account` = ?');
      params.push(String(q.account));
    }
    if (q.walletId) {
      parts.push('`wallet_id` = ?');
      params.push(String(q.walletId));
    }
    if (q.transactionId) {
      parts.push('`transaction_id` = ?');
      params.push(String(q.transactionId));
    }
    if (!parts.length) throw new RpcException({ status: 'error', statusCode: 400, message: 'Indiquez account, walletId ou transactionId' });
    const where = parts.join(' AND ');
    const total = Number((await this.db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`ledger_entries\` WHERE ${where}`, ...params))?.[0]?.n ?? 0);
    const rows: any[] = await this.db.$queryRawUnsafe(
      `SELECT * FROM \`ledger_entries\` WHERE ${where} ORDER BY \`occurred_at\` DESC, \`transaction_id\`, \`version\`, \`line\` LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      ...params,
    );
    return {
      message: 'Écritures du grand livre',
      data: {
        data: rows.map((r) => ({
          id: r.id,
          transactionId: r.transaction_id,
          version: Number(r.version),
          line: Number(r.line),
          account: r.account,
          kind: r.account_kind,
          walletId: r.wallet_id,
          currency: r.currency,
          debit: round3(r.debit),
          credit: round3(r.credit),
          type: r.tx_type,
          paymentMethod: r.payment_method,
          reference: r.tx_reference,
          occurredAt: r.occurred_at,
          correction: Number(r.version) > 1,
        })),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
