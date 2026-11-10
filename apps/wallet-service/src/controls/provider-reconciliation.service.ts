// apps/wallet-service/src/controls/provider-reconciliation.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { round3 } from '@app/common';
import { PrismaService } from '../prisma/prisma.service';
import { PawapayService } from '../pawapay/pawapay.service';
import { providerDecision } from './controls.util';

/**
 * ✅ OPÉRATEUR MOBILE MONEY (PawaPay) : rapport de comparaison (CONSULTATION SEULE)
 *
 *  Aucune validation automatique : les opérations en attente sont validées ou annulées MANUELLEMENT
 *  par un administrateur (POST admin/wallet/validate-transfer). Ce rapport aide seulement à décider :
 *  il compare nos transactions Mobile Money avec le statut chez PawaPay et liste les écarts, sans rien modifier.
 */
@Injectable()
export class ProviderReconciliationService {
  private readonly logger = new Logger(ProviderReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pawapay: PawapayService,
  ) {}

  private get db(): any {
    return this.prisma as any;
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
