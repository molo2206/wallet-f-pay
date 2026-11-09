// apps/api-gateway/src/controls/admin-approval.service.ts
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import * as crypto from 'crypto';
import { PrismaService } from 'apps/user-service/src/prisma/prisma.service';
import { round3 } from '@app/common';
import { createRmqClient, rpcSend } from '../work-schedules/rpc-client.util';

/** Seuils « USD:500,CDF:1000000 » */
export function parseThresholds(raw: string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of String(raw || '').split(',')) {
    const [c, v] = part.split(':').map((x) => x?.trim());
    const n = Number(v);
    if (c && Number.isFinite(n) && n > 0) out[c.toUpperCase()] = n;
  }
  return out;
}

/**
 * Une recharge admin doit-elle être validée par un second administrateur ?
 *  off            : jamais (ancien comportement)
 *  no_counterpart : (défaut) quand aucune caisse ne reçoit le cash — SUPER_ADMIN sur un wallet sans agence :
 *                   de l'argent serait créé sans contrepartie
 *  threshold      : no_counterpart + tout montant ≥ seuil de la devise (ADMIN_APPROVAL_THRESHOLDS)
 *  all            : toutes les recharges admin
 */
export function approvalReason(params: {
  mode: string;
  role: string;
  walletBranchId: string | null;
  currency: string;
  amount: number;
  thresholds: Record<string, number>;
}): string | null {
  const mode = String(params.mode || 'no_counterpart').toLowerCase();
  if (mode === 'off') return null;
  if (mode === 'all') return 'ALL_ADMIN_TOP_UPS';
  if (params.role === 'SUPER_ADMIN' && !params.walletBranchId) return 'NO_CASH_COUNTERPART';
  if (mode === 'threshold') {
    const t = params.thresholds[String(params.currency).toUpperCase()];
    if (t !== undefined && params.amount >= t) return 'ABOVE_THRESHOLD';
  }
  return null;
}

const REASON_LABEL: Record<string, string> = {
  NO_CASH_COUNTERPART: "aucune caisse d'agence ne reçoit le cash (création de monnaie sans contrepartie)",
  ABOVE_THRESHOLD: 'montant supérieur au seuil de validation',
  ALL_ADMIN_TOP_UPS: 'toutes les recharges admin sont soumises à validation',
};

/**
 * ✅ DOUBLE VALIDATION (maker-checker) DES RECHARGES ADMIN
 *  1. L'admin demande la recharge avec son PIN (vérifié) → demande PENDING, rien n'est crédité.
 *  2. Un AUTRE SUPER_ADMIN (ou ADMIN ayant la ressource APPROVALS) approuve avec son propre PIN → exécution.
 *  Chaque étape est tracée (audit_log). Une demande expire après ADMIN_APPROVAL_TTL_HOURS (24 h).
 *  Le PIN n'est jamais stocké.
 */
@Injectable()
export class AdminApprovalService {
  private readonly logger = new Logger(AdminApprovalService.name);
  private readonly wallet: ClientProxy = createRmqClient('WALLET_QUEUE', 'wallet_queue');
  private readonly users: ClientProxy = createRmqClient('USER_QUEUE', 'user_queue');

  constructor(private readonly prisma: PrismaService) {}

  private get db(): any {
    return this.prisma as any;
  }

  private http(status: number, message: string, code?: string): never {
    throw new HttpException({ statusCode: status, message, ...(code ? { code } : {}) }, status);
  }

  private async audit(userId: string, action: string, details: any) {
    await this.db
      .$executeRawUnsafe(
        'INSERT INTO `audit_log` (`id`, `userId`, `action`, `details`, `ipAddress`, `createdAt`) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())',
        crypto.randomUUID(),
        userId,
        action,
        JSON.stringify(details ?? {}),
        details?.ipAddress ?? null,
      )
      .catch(() => undefined);
  }

  private async verifyPin(userId: string, pin: string, lang: string) {
    if (!pin || !/^\d{4,}$/.test(String(pin))) this.http(400, 'PIN requis (4 chiffres minimum)');
    await rpcSend(this.users, 'verify_pin', { userId, pin: String(pin), lang });
  }

  /**
   * Appelé par POST admin/wallet/topup. Retourne null si la recharge peut s'exécuter normalement,
   * sinon crée la demande et retourne la réponse « en attente de validation ».
   */
  async interceptAdminTopUp(currentUser: any, body: any, ipAddress: string, lang: string): Promise<any | null> {
    const amount = Number(body?.amount);
    if (!body?.walletId || !Number.isFinite(amount) || amount <= 0) return null; // validations habituelles du wallet-service
    let wallet: any;
    try {
      wallet = (
        await this.db.$queryRawUnsafe(
          'SELECT w.`id`, w.`currency`, w.`branchId`, w.`userId`, u.`full_name` AS userName, u.`phone` AS userPhone FROM `wallet` w LEFT JOIN `user` u ON u.`id` = w.`userId` WHERE w.`id` = ? LIMIT 1',
          body.walletId,
        )
      )?.[0];
    } catch {
      return null;
    }
    if (!wallet) return null;
    const reason = approvalReason({
      mode: process.env.ADMIN_APPROVAL_MODE ?? 'no_counterpart',
      role: String(currentUser?.role),
      walletBranchId: wallet.branchId ?? null,
      currency: wallet.currency,
      amount,
      thresholds: parseThresholds(process.env.ADMIN_APPROVAL_THRESHOLDS),
    });
    if (!reason) return null;

    // Le demandeur prouve son identité tout de suite (son PIN n'est pas conservé)
    await this.verifyPin(currentUser.id, body.pin, lang);

    const id = crypto.randomUUID();
    const ttl = Math.min(168, Math.max(1, Number(process.env.ADMIN_APPROVAL_TTL_HOURS) || 24));
    const payload = {
      walletId: wallet.id,
      amount: round3(amount),
      paymentMethod: body.paymentMethod ?? null,
      lang,
      ipAddress,
    };
    try {
      await this.db.$executeRawUnsafe(
        'INSERT INTO `admin_operation_requests` (`id`, `operation`, `status`, `reason`, `amount`, `currency`, `wallet_id`, `target_user_id`, `payload`, ' +
          "`requested_by`, `requested_at`, `expires_at`, `note`) VALUES (?, 'ADMIN_TOP_UP', 'PENDING', ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), ?)",
        id,
        reason,
        round3(amount),
        wallet.currency,
        wallet.id,
        wallet.userId,
        JSON.stringify(payload),
        currentUser.id,
        ttl,
        body?.note ? String(body.note).slice(0, 500) : null,
      );
    } catch (e: any) {
      if (/doesn't exist|1146/i.test(String(e?.message))) {
        // Table absente : on refuse plutôt que de créer de l'argent sans contrôle
        this.http(503, "La validation des recharges n'est pas encore installée (table admin_operation_requests). Contactez l'administrateur technique.");
      }
      throw e;
    }
    await this.audit(currentUser.id, 'ADMIN_APPROVAL_REQUESTED', { id, reason, ...payload });
    return {
      message: `Recharge de ${round3(amount).toFixed(3)} ${wallet.currency} enregistrée : elle doit être validée par un autre administrateur (${REASON_LABEL[reason]}). Aucun montant n'a encore été crédité.`,
      status: 'PENDING_APPROVAL',
      data: {
        requestId: id,
        status: 'PENDING_APPROVAL',
        reason,
        amount: round3(amount),
        currency: wallet.currency,
        walletId: wallet.id,
        beneficiary: { id: wallet.userId, name: wallet.userName, phone: wallet.userPhone },
        expiresInHours: ttl,
      },
    };
  }

  private view(r: any) {
    return {
      id: r.id,
      operation: r.operation,
      status: r.status,
      reason: r.reason,
      reasonLabel: REASON_LABEL[r.reason] ?? r.reason,
      amount: round3(r.amount),
      currency: r.currency,
      walletId: r.wallet_id,
      beneficiary: { id: r.target_user_id, name: r.targetName, phone: r.targetPhone },
      requestedBy: { id: r.requested_by, name: r.requesterName },
      requestedAt: r.requested_at,
      note: r.note,
      expiresAt: r.expires_at,
      decidedBy: r.decided_by ? { id: r.decided_by, name: r.deciderName } : null,
      decidedAt: r.decided_at,
      decisionNote: r.decision_note,
      error: r.error,
      result: (() => {
        try {
          return r.result ? JSON.parse(r.result) : null;
        } catch {
          return null;
        }
      })(),
    };
  }

  private readonly SELECT =
    'SELECT r.*, t.`full_name` AS targetName, t.`phone` AS targetPhone, q.`full_name` AS requesterName, d.`full_name` AS deciderName ' +
    'FROM `admin_operation_requests` r LEFT JOIN `user` t ON t.`id` = r.`target_user_id` LEFT JOIN `user` q ON q.`id` = r.`requested_by` LEFT JOIN `user` d ON d.`id` = r.`decided_by` ';

  async list(q: any, currentUser: any) {
    // Expiration paresseuse
    await this.db
      .$executeRawUnsafe("UPDATE `admin_operation_requests` SET `status` = 'EXPIRED' WHERE `status` = 'PENDING' AND `expires_at` < UTC_TIMESTAMP()")
      .catch(() => undefined);
    const page = Math.max(1, Number(q?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q?.limit) || 20));
    const parts = ['1 = 1'];
    const params: any[] = [];
    if (q?.status) {
      parts.push('r.`status` = ?');
      params.push(String(q.status).toUpperCase());
    }
    if (q?.mine === 'true') {
      parts.push('r.`requested_by` = ?');
      params.push(currentUser.id);
    }
    const where = parts.join(' AND ');
    const total = Number((await this.db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`admin_operation_requests\` r WHERE ${where}`, ...params))?.[0]?.n ?? 0);
    const rows: any[] = await this.db.$queryRawUnsafe(
      `${this.SELECT} WHERE ${where} ORDER BY (r.\`status\` = 'PENDING') DESC, r.\`requested_at\` DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      ...params,
    );
    return { message: 'Demandes de validation', data: { data: rows.map((r) => this.view(r)), total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async get(id: string) {
    const rows: any[] = await this.db.$queryRawUnsafe(`${this.SELECT} WHERE r.\`id\` = ? LIMIT 1`, id);
    if (!rows?.[0]) this.http(404, 'Demande introuvable');
    return { message: 'Demande de validation', data: this.view(rows[0]) };
  }

  /** Approbation par un second administrateur, puis exécution unique */
  async approve(id: string, approver: any, pin: string, note: string | undefined, lang: string) {
    await this.verifyPin(approver.id, pin, lang);
    const allowSelf = String(process.env.ADMIN_APPROVAL_ALLOW_SELF ?? 'false').toLowerCase() === 'true';
    const claimed = Number(
      await this.db.$executeRawUnsafe(
        "UPDATE `admin_operation_requests` SET `status` = 'APPROVED', `decided_by` = ?, `decided_at` = UTC_TIMESTAMP(), `decision_note` = ? " +
          "WHERE `id` = ? AND `status` = 'PENDING' AND `expires_at` > UTC_TIMESTAMP()" +
          (allowSelf ? '' : ' AND `requested_by` <> ?'),
        approver.id,
        note ? String(note).slice(0, 500) : null,
        id,
        ...(allowSelf ? [] : [approver.id]),
      ),
    );
    if (claimed !== 1) {
      const cur = (await this.get(id)).data;
      if (!allowSelf && cur.requestedBy.id === approver.id && cur.status === 'PENDING') {
        this.http(403, 'Vous ne pouvez pas valider votre propre demande : un autre administrateur doit le faire.', 'SELF_APPROVAL_FORBIDDEN');
      }
      this.http(409, `Demande non validable (statut actuel : ${cur.status}).`, 'APPROVAL_NOT_PENDING');
    }
    const row = (await this.get(id)).data;
    const payload = JSON.parse(
      (await this.db.$queryRawUnsafe('SELECT `payload` FROM `admin_operation_requests` WHERE `id` = ?', id))?.[0]?.payload || '{}',
    );
    await this.audit(approver.id, 'ADMIN_APPROVAL_APPROVED', { id, requestedBy: row.requestedBy.id });

    try {
      const result: any = await rpcSend(
        this.wallet,
        'admin_top_up_approved',
        {
          adminId: row.requestedBy.id, // l'opération reste celle du demandeur (caisse de son agence, audit)
          walletId: payload.walletId,
          amount: payload.amount,
          paymentMethod: payload.paymentMethod ?? undefined,
          lang: payload.lang || lang,
          ipAddress: payload.ipAddress,
          approval: { requestId: id, approvedBy: approver.id },
        },
        120000,
      );
      await this.db.$executeRawUnsafe(
        "UPDATE `admin_operation_requests` SET `status` = 'EXECUTED', `result` = ? WHERE `id` = ? AND `status` = 'APPROVED'",
        JSON.stringify({ message: result?.message, transactionId: result?.data?.transaction?.id, reference: result?.data?.transaction?.reference }),
        id,
      );
      await this.audit(approver.id, 'ADMIN_APPROVAL_EXECUTED', { id, transaction: result?.data?.transaction?.reference });
      return { message: `Recharge validée et exécutée. ${result?.message ?? ''}`.trim(), data: { requestId: id, status: 'EXECUTED', result: result?.data } };
    } catch (e: any) {
      const status = e instanceof HttpException ? e.getStatus() : 500;
      const msg = (e?.getResponse?.() as any)?.message || e?.message || 'Erreur';
      // Refus métier (4xx) : rien n'a été fait → FAILED. Timeout / 5xx : peut-être exécutée → UNCERTAIN (à vérifier)
      const final = status >= 400 && status < 500 ? 'FAILED' : 'UNCERTAIN';
      await this.db
        .$executeRawUnsafe('UPDATE `admin_operation_requests` SET `status` = ?, `error` = ? WHERE `id` = ?', final, String(msg).slice(0, 1000), id)
        .catch(() => undefined);
      await this.audit(approver.id, `ADMIN_APPROVAL_${final}`, { id, error: msg });
      if (final === 'UNCERTAIN') {
        this.http(502, "La recharge a été validée mais le service n'a pas confirmé son exécution. Vérifiez l'historique du wallet avant toute nouvelle action.", 'APPROVAL_UNCERTAIN');
      }
      this.http(status, `Validation enregistrée mais la recharge a été refusée : ${msg}`, 'APPROVAL_EXECUTION_FAILED');
    }
  }

  async reject(id: string, user: any, note: string) {
    if (!String(note ?? '').trim()) this.http(400, 'Motif du rejet obligatoire');
    const n = Number(
      await this.db.$executeRawUnsafe(
        "UPDATE `admin_operation_requests` SET `status` = 'REJECTED', `decided_by` = ?, `decided_at` = UTC_TIMESTAMP(), `decision_note` = ? WHERE `id` = ? AND `status` = 'PENDING'",
        user.id,
        String(note).slice(0, 500),
        id,
      ),
    );
    if (n !== 1) this.http(409, 'Demande déjà traitée ou introuvable', 'APPROVAL_NOT_PENDING');
    await this.audit(user.id, 'ADMIN_APPROVAL_REJECTED', { id, note });
    return { message: 'Demande rejetée : aucun montant crédité', data: { requestId: id, status: 'REJECTED' } };
  }

  async cancel(id: string, user: any) {
    const n = Number(
      await this.db.$executeRawUnsafe(
        "UPDATE `admin_operation_requests` SET `status` = 'CANCELLED', `decided_by` = ?, `decided_at` = UTC_TIMESTAMP() WHERE `id` = ? AND `status` = 'PENDING' AND `requested_by` = ?",
        user.id,
        id,
        user.id,
      ),
    );
    if (n !== 1) this.http(409, 'Seule votre propre demande en attente peut être annulée', 'APPROVAL_NOT_PENDING');
    await this.audit(user.id, 'ADMIN_APPROVAL_CANCELLED', { id });
    return { message: 'Demande annulée', data: { requestId: id, status: 'CANCELLED' } };
  }
}
