// apps/wallet-service/src/cron/payout-reconciliation.cron.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PawapayService } from '../pawapay/pawapay.service';
import { WalletServiceService } from '../wallet-service.service';
import { NotificationHelper } from 'apps/notification-service/src/helpers/NotificationHelper';
import { NotificationType } from 'apps/notification-service/src/type/notification-type';

const FINAL_FAILED = ['FAILED', 'REJECTED', 'CANCELED', 'CANCELLED', 'EXPIRED'];

/**
 * ✅ RÉCONCILIATION AUTOMATIQUE DES RETRAITS MOBILE MONEY EN ATTENTE
 *
 * Un retrait réserve le montant (solde débité) et crée une transaction PENDING avec l'identifiant du payout.
 * Quand PawaPay n'a pas donné de résultat final pendant la requête (lenteur, coupure réseau, timeout),
 * ce cron interroge PawaPay et finalise :
 *   - COMPLETED                         → transaction SUCCESS (le solde était déjà débité : rien à refaire)
 *   - FAILED / REJECTED / EXPIRED…      → transaction FAILED + remboursement du montant réservé
 *   - introuvable chez PawaPay après PAYOUT_NOT_FOUND_REFUND_MINUTES → payout jamais créé → remboursement
 *   - autre statut                      → on réessaie au prochain passage
 * Chaque finalisation est conditionnelle (status = PENDING) : jamais de double remboursement ni de double débit.
 */
@Injectable()
export class PayoutReconciliationService {
  private readonly logger = new Logger(PayoutReconciliationService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pawapay: PawapayService,
    private readonly wallet: WalletServiceService,
    private readonly notificationHelper: NotificationHelper,
  ) {}

  private num(name: string, def: number): number {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : def;
  }

  @Cron('0 */2 * * * *')
  async reconcilePendingPayouts(): Promise<{ checked: number; completed: number; refunded: number }> {
    const stats = { checked: 0, completed: 0, refunded: 0 };
    if (this.running || String(process.env.PAYOUT_RECONCILIATION_ENABLED ?? 'true') === 'false') return stats;
    this.running = true;
    try {
      // Laisser le temps à la requête de retrait de finir son propre suivi (≈ 80 s)
      const minAge = new Date(Date.now() - this.num('PAYOUT_RECONCILIATION_MIN_AGE_SECONDS', 180) * 1000);
      const pending = await (this.prisma as any).transaction.findMany({
        where: {
          status: 'PENDING',
          type: 'WITHDRAW',
          movement: 'DEBIT',
          paymentMethod: 'MOBILE_MONEY',
          createdAt: { lte: minAge },
          external_reference: { contains: '"kind":"PAWAPAY_PAYOUT"' },
        },
        orderBy: { createdAt: 'asc' },
        take: this.num('PAYOUT_RECONCILIATION_BATCH', 50),
      });

      for (const t of pending) {
        stats.checked++;
        let meta: any = {};
        try {
          meta = JSON.parse(t.external_reference || '{}');
        } catch {
          continue;
        }
        if (!meta.payoutId) continue;

        let status: string | null = null;
        let notFound = false;
        try {
          const res: any = await this.pawapay.checkPayoutStatus(meta.payoutId);
          status = res?.data?.status ?? res?.status ?? null;
          if (status === 'NOT_FOUND' || res?.status === 'NOT_FOUND') notFound = true;
        } catch (err: any) {
          if (err?.response?.status === 404) notFound = true;
          else {
            this.logger.warn(`Payout ${meta.payoutId} : suivi indisponible (${err?.message}) — nouvel essai plus tard`);
            continue;
          }
        }

        const ageMinutes = (Date.now() - new Date(t.createdAt).getTime()) / 60000;
        const amount = Number(t.amount);

        if (status === 'COMPLETED') {
          const done = await this.wallet.completeReservedPayout(
            t.id,
            meta.payoutId,
            `Retrait Mobile Money vers ${meta.phone || ''} (${meta.provider || ''}) confirmé — Net reçu: ${Number(meta.netAmount ?? amount).toFixed(3)} ${t.currency} Ref: ${meta.payoutId}`,
          );
          if (done) {
            stats.completed++;
            this.logger.log(`✅ Retrait ${t.reference} confirmé par PawaPay (réconciliation)`);
            await this.notify(t, NotificationType.WITHDRAWAL_CONFIRMED, meta);
          }
        } else if (
          (status && FINAL_FAILED.includes(status)) ||
          (notFound && ageMinutes >= this.num('PAYOUT_NOT_FOUND_REFUND_MINUTES', 30))
        ) {
          const reason = notFound ? 'Payout introuvable chez PawaPay' : `PawaPay : ${status}`;
          const after = await this.wallet.refundReservedPayout(t.id, t.walletId, amount, `Retrait échoué (${reason}) — montant remboursé`);
          if (after?.refunded) {
            stats.refunded++;
            this.logger.warn(`↩️ Retrait ${t.reference} échoué (${reason}) : ${amount} ${t.currency} remboursés`);
            await this.notify(t, NotificationType.CASHOUT_FAILED, meta);
          }
        }
      }
      if (stats.completed || stats.refunded) {
        this.logger.log(`Réconciliation payouts : ${stats.checked} vérifié(s), ${stats.completed} confirmé(s), ${stats.refunded} remboursé(s)`);
      }
    } catch (e: any) {
      this.logger.error(`Réconciliation des payouts : ${e?.message}`);
    } finally {
      this.running = false;
    }
    return stats;
  }

  private async notify(t: any, type: NotificationType, meta: any) {
    try {
      await this.notificationHelper.notify(
        t.userId,
        type,
        { amount: Number(meta.netAmount ?? t.amount).toFixed(3), currency: t.currency, reference: t.reference },
        'transaction',
        t.id,
        meta.lang || 'fr',
      );
    } catch {
      /* notification facultative */
    }
  }
}
