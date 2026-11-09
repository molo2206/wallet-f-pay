// apps/wallet-service/src/controls/provider-reconciliation.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as crypto from 'crypto';
import { round3 } from '@app/common';
import { NotificationHelper } from 'apps/notification-service/src/helpers/NotificationHelper';
import { NotificationType } from 'apps/notification-service/src/type/notification-type';
import { PrismaService } from '../prisma/prisma.service';
import { PawapayService } from '../pawapay/pawapay.service';
import { WalletServiceService } from '../wallet-service.service';
import { providerDecision } from './controls.util';

/**
 * ✅ OPÉRATEUR MOBILE MONEY (PawaPay) : webhooks, dépôts en attente, rapport de réconciliation
 *
 *  - Webhook : PawaPay prévient dès qu'un dépôt / retrait est final. Le contenu du webhook n'est JAMAIS cru :
 *    on relit le statut auprès de l'API PawaPay avant toute action (impossible de créditer avec un faux appel).
 *  - Dépôts en attente (réponse perdue, client lent à valider) : vérifiés toutes les 2 min, crédités une seule fois.
 *  - Rapport : compare nos transactions Mobile Money avec le statut réel chez PawaPay et liste les écarts.
 */
@Injectable()
export class ProviderReconciliationService {
  private readonly logger = new Logger(ProviderReconciliationService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pawapay: PawapayService,
    private readonly wallet: WalletServiceService,
    private readonly notificationHelper: NotificationHelper,
  ) {}

  private get db(): any {
    return this.prisma as any;
  }

  private num(name: string, def: number): number {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : def;
  }

  private meta(t: any): any {
    try {
      return JSON.parse(t.external_reference || '{}');
    } catch {
      return {};
    }
  }

  private async providerStatus(kind: 'DEPOSIT' | 'PAYOUT', id: string): Promise<{ status: string | null; notFound: boolean; error?: string }> {
    try {
      const res: any = kind === 'DEPOSIT' ? await this.pawapay.checkDepositStatus(id) : await this.pawapay.checkPayoutStatus(id);
      const status = res?.data?.status ?? res?.status ?? null;
      return { status, notFound: status === 'NOT_FOUND' || res?.status === 'NOT_FOUND' };
    } catch (err: any) {
      if (err?.response?.status === 404) return { status: null, notFound: true };
      return { status: null, notFound: false, error: err?.message || 'indisponible' };
    }
  }

  // ============================================================
  // DÉPÔTS
  // ============================================================
  /** Crédite (ou clôt en échec) un dépôt Mobile Money en attente, selon le statut réel chez PawaPay */
  async finalizeDeposit(t: any): Promise<'CREDITED' | 'FAILED' | 'WAIT'> {
    const m = this.meta(t);
    if (m.kind !== 'PAWAPAY_DEPOSIT' || !m.depositId) return 'WAIT';
    const ps = await this.providerStatus('DEPOSIT', m.depositId);
    if (ps.error) return 'WAIT';
    const ageMinutes = (Date.now() - new Date(t.createdAt).getTime()) / 60000;
    const decision = providerDecision(ps.status);

    if (decision === 'COMPLETED') {
      const credited = await this.prisma.$transaction(async (tx: any) => {
        const claim = await tx.transaction.updateMany({
          where: { id: t.id, status: 'PENDING' },
          data: {
            status: 'SUCCESS',
            description: `Dépôt Mobile Money ${m.provider || ''} ${m.phone || ''} confirmé — Net crédité: ${round3(t.amount).toFixed(3)} ${t.currency} Ref: ${m.depositId}`,
            updatedAt: new Date(),
          },
        });
        if (claim.count !== 1) return false;
        await tx.wallet.update({ where: { id: t.walletId }, data: { balance: { increment: Number(t.amount) }, updatedAt: new Date() } });
        await tx.audit_log.create({
          data: {
            id: crypto.randomUUID(),
            userId: t.userId,
            action: 'PAWAPAY_DEPOSIT_RECONCILED',
            details: JSON.stringify({ transactionId: t.id, depositId: m.depositId, amount: t.amount, currency: t.currency }),
            ipAddress: 'system',
            createdAt: new Date(),
          },
        });
        return true;
      });
      if (credited) {
        this.logger.log(`✅ Dépôt ${t.reference} confirmé par PawaPay : ${t.amount} ${t.currency} crédités`);
        await this.notificationHelper
          .notify(t.userId, NotificationType.TOP_UP_SUCCESS, { amount: round3(t.amount).toFixed(3), currency: t.currency, reference: t.reference }, 'transaction', t.id, m.lang || 'fr')
          .catch(() => undefined);
        return 'CREDITED';
      }
      return 'WAIT';
    }

    if (decision === 'FAILED' || (ps.notFound && ageMinutes >= this.num('DEPOSIT_NOT_FOUND_FAIL_MINUTES', 60))) {
      const n = await this.db.transaction.updateMany({
        where: { id: t.id, status: 'PENDING' },
        data: {
          status: 'FAILED',
          description: `Dépôt Mobile Money non abouti (${ps.notFound ? 'introuvable chez l’opérateur' : ps.status}) — aucun montant débité côté opérateur`,
          updatedAt: new Date(),
        },
      });
      if (n.count === 1) {
        this.logger.warn(`Dépôt ${t.reference} échoué (${ps.status ?? 'NOT_FOUND'})`);
        return 'FAILED';
      }
    }
    return 'WAIT';
  }

  @Cron('20 */2 * * * *')
  async reconcilePendingDeposits() {
    const stats = { checked: 0, credited: 0, failed: 0 };
    if (this.running || String(process.env.DEPOSIT_RECONCILIATION_ENABLED ?? 'true') === 'false') return stats;
    this.running = true;
    try {
      const minAge = new Date(Date.now() - this.num('DEPOSIT_RECONCILIATION_MIN_AGE_SECONDS', 120) * 1000);
      const pending: any[] = await this.db.transaction.findMany({
        where: {
          status: 'PENDING',
          type: 'DEPOSIT',
          movement: 'CREDIT',
          paymentMethod: 'MOBILE_MONEY',
          createdAt: { lte: minAge },
          external_reference: { contains: '"kind":"PAWAPAY_DEPOSIT"' },
        },
        orderBy: { createdAt: 'asc' },
        take: this.num('DEPOSIT_RECONCILIATION_BATCH', 50),
      });
      for (const t of pending) {
        stats.checked++;
        const r = await this.finalizeDeposit(t);
        if (r === 'CREDITED') stats.credited++;
        if (r === 'FAILED') stats.failed++;
      }
    } catch (e: any) {
      this.logger.error(`Réconciliation des dépôts : ${e?.message}`);
    } finally {
      this.running = false;
    }
    return stats;
  }

  // ============================================================
  // WEBHOOK (appelé par l'api-gateway)
  // ============================================================
  /** { kind: 'deposit' | 'payout', id } — le statut est relu chez PawaPay, le contenu du webhook est ignoré */
  async handleCallback(payload: { kind: string; id: string }) {
    const kind = String(payload?.kind || '').toLowerCase();
    const id = String(payload?.id || '').trim();
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return { message: 'ignored' };
    const marker = kind === 'deposit' ? '"kind":"PAWAPAY_DEPOSIT"' : '"kind":"PAWAPAY_PAYOUT"';
    const t: any = await this.db.transaction.findFirst({
      where: { status: 'PENDING', AND: [{ external_reference: { contains: marker } }, { external_reference: { contains: id } }] },
    });
    if (!t) return { message: 'no pending transaction' };

    if (kind === 'deposit') {
      const r = await this.finalizeDeposit(t);
      return { message: 'ok', result: r };
    }
    // Retrait : même logique que la réconciliation périodique
    const m = this.meta(t);
    const ps = await this.providerStatus('PAYOUT', m.payoutId || id);
    const decision = providerDecision(ps.status);
    if (decision === 'COMPLETED') {
      const done = await this.wallet.completeReservedPayout(
        t.id,
        m.payoutId || id,
        `Retrait Mobile Money vers ${m.phone || ''} (${m.provider || ''}) confirmé — Net reçu: ${Number(m.netAmount ?? t.amount).toFixed(3)} ${t.currency} Ref: ${m.payoutId || id}`,
      );
      if (done) {
        await this.notificationHelper
          .notify(t.userId, NotificationType.WITHDRAWAL_CONFIRMED, { amount: Number(m.netAmount ?? t.amount).toFixed(3), currency: t.currency, reference: t.reference }, 'transaction', t.id, m.lang || 'fr')
          .catch(() => undefined);
      }
      return { message: 'ok', result: done ? 'COMPLETED' : 'ALREADY_DONE' };
    }
    if (decision === 'FAILED') {
      const after = await this.wallet.refundReservedPayout(t.id, t.walletId, Number(t.amount), `Retrait échoué (PawaPay : ${ps.status}) — montant remboursé`);
      if (after?.refunded) {
        await this.notificationHelper
          .notify(t.userId, NotificationType.CASHOUT_FAILED, { amount: Number(m.netAmount ?? t.amount).toFixed(3), currency: t.currency, reference: t.reference }, 'transaction', t.id, m.lang || 'fr')
          .catch(() => undefined);
      }
      return { message: 'ok', result: after?.refunded ? 'REFUNDED' : 'ALREADY_DONE' };
    }
    return { message: 'ok', result: 'WAIT' };
  }

  // ============================================================
  // RAPPORT DE RÉCONCILIATION OPÉRATEUR
  // ============================================================
  /**
   * Compare nos transactions Mobile Money (ayant un identifiant PawaPay) avec le statut chez PawaPay.
   * Écarts critiques : succès chez nous mais échec chez l'opérateur (argent donné sans être reçu / envoyé),
   * ou échec chez nous mais succès chez l'opérateur (client payé ou débité sans contrepartie).
   */
  async report(q: { from?: string; to?: string; limit?: number; onlyIssues?: boolean | string }) {
    const to = q.to && !isNaN(new Date(q.to).getTime()) ? new Date(q.to) : new Date();
    const from = q.from && !isNaN(new Date(q.from).getTime()) ? new Date(q.from) : new Date(to.getTime() - 86400000);
    const limit = Math.min(300, Math.max(1, Number(q.limit) || 100));
    const rows: any[] = await this.db.$queryRawUnsafe(
      "SELECT `id`, `reference`, `userId`, `walletId`, `type`, `status`, `amount`, `currency`, `external_reference`, `createdAt` FROM `transaction` " +
        "WHERE `paymentMethod` = 'MOBILE_MONEY' AND `createdAt` >= ? AND `createdAt` < ? AND `type` IN ('DEPOSIT', 'WITHDRAW') " +
        "AND (`external_reference` LIKE '%\"kind\":\"PAWAPAY_%' OR `external_reference` REGEXP '^[0-9a-fA-F-]{36}$') ORDER BY `createdAt` ASC LIMIT " +
        limit,
      from,
      to,
    );
    const lines: any[] = [];
    const summary = { checked: 0, ok: 0, pending: 0, issues: 0, unavailable: 0 };
    for (const t of rows) {
      summary.checked++;
      const m = this.meta(t);
      const providerId: string = m.depositId || m.payoutId || (/^[0-9a-fA-F-]{36}$/.test(String(t.external_reference)) ? t.external_reference : '');
      const kind: 'DEPOSIT' | 'PAYOUT' = t.type === 'DEPOSIT' ? 'DEPOSIT' : 'PAYOUT';
      const ps = await this.providerStatus(kind, providerId);
      let verdict = 'OK';
      let severity: 'info' | 'warning' | 'critical' = 'info';
      if (ps.error) {
        verdict = 'PROVIDER_UNAVAILABLE';
        summary.unavailable++;
      } else {
        const d = providerDecision(ps.status);
        if (t.status === 'SUCCESS' && (d === 'FAILED' || ps.notFound)) {
          verdict = kind === 'DEPOSIT' ? 'CREDITED_WITHOUT_PROVIDER_PAYMENT' : 'DEBITED_BUT_NOT_PAID_BY_PROVIDER';
          severity = 'critical';
        } else if ((t.status === 'FAILED' || t.status === 'CANCELLED') && d === 'COMPLETED') {
          verdict = kind === 'DEPOSIT' ? 'PROVIDER_PAID_BUT_NOT_CREDITED' : 'PROVIDER_PAID_BUT_REFUNDED';
          severity = 'critical';
        } else if (t.status === 'PENDING' || d === 'WAIT') {
          verdict = 'PENDING';
          summary.pending++;
        }
        if (severity === 'critical') summary.issues++;
        else if (verdict === 'OK') summary.ok++;
      }
      if (q.onlyIssues === true || q.onlyIssues === 'true') {
        if (severity !== 'critical') continue;
      }
      lines.push({
        transactionId: t.id,
        reference: t.reference,
        type: t.type,
        amount: round3(t.amount),
        currency: t.currency,
        ourStatus: t.status,
        providerId,
        providerStatus: ps.notFound ? 'NOT_FOUND' : ps.status,
        verdict,
        severity,
        createdAt: t.createdAt,
      });
    }
    return {
      message: 'Réconciliation PawaPay',
      data: {
        from,
        to,
        summary,
        lines,
        note: 'Seules les opérations enregistrées avec leur identifiant PawaPay (nouveaux dépôts et retraits) peuvent être comparées.',
      },
    };
  }
}
