// Modules lourds remplacés : on teste uniquement la logique de décision du cron
jest.mock('../wallet-service.service', () => ({ WalletServiceService: class {} }));
jest.mock('../pawapay/pawapay.service', () => ({ PawapayService: class {} }));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('apps/notification-service/src/helpers/NotificationHelper', () => ({ NotificationHelper: class {} }));

import { PayoutReconciliationService } from './payout-reconciliation.cron';

const old = new Date(Date.now() - 60 * 60 * 1000); // 1 h
const tx = (payoutId: string, extra: any = {}) => ({
  id: `t-${payoutId}`,
  userId: 'u1',
  walletId: 'w1',
  amount: 10.5,
  currency: 'CDF',
  reference: `REF-${payoutId}`,
  createdAt: old,
  external_reference: JSON.stringify({ kind: 'PAWAPAY_PAYOUT', payoutId, phone: '243', provider: 'VODACOM', netAmount: 10 }),
  ...extra,
});

function setup(rows: any[], statuses: Record<string, any>) {
  const prisma: any = { transaction: { findMany: jest.fn().mockResolvedValue(rows) } };
  const pawapay: any = {
    checkPayoutStatus: jest.fn(async (id: string) => {
      const s = statuses[id];
      if (s instanceof Error) throw s;
      return { data: { status: s } };
    }),
  };
  const wallet: any = {
    completeReservedPayout: jest.fn().mockResolvedValue(true),
    refundReservedPayout: jest.fn().mockResolvedValue({ status: 'FAILED', refunded: true }),
  };
  const notif: any = { notify: jest.fn().mockResolvedValue(undefined) };
  return { svc: new PayoutReconciliationService(prisma, pawapay, wallet, notif), prisma, pawapay, wallet, notif };
}

describe('PayoutReconciliationService', () => {
  it('COMPLETED → transaction confirmée, aucun remboursement', async () => {
    const { svc, wallet } = setup([tx('p1')], { p1: 'COMPLETED' });
    const r = await svc.reconcilePendingPayouts();
    expect(r).toEqual({ checked: 1, completed: 1, refunded: 0 });
    expect(wallet.completeReservedPayout).toHaveBeenCalledWith('t-p1', 'p1', expect.any(String));
    expect(wallet.refundReservedPayout).not.toHaveBeenCalled();
  });

  it('FAILED / REJECTED → remboursement du montant réservé', async () => {
    const { svc, wallet } = setup([tx('p2'), tx('p3')], { p2: 'FAILED', p3: 'REJECTED' });
    const r = await svc.reconcilePendingPayouts();
    expect(r.refunded).toBe(2);
    expect(wallet.refundReservedPayout).toHaveBeenCalledWith('t-p2', 'w1', 10.5, expect.any(String));
  });

  it('statut intermédiaire ou erreur réseau → aucune action (nouvel essai plus tard)', async () => {
    const { svc, wallet } = setup([tx('p4'), tx('p5')], { p4: 'SUBMITTED', p5: new Error('timeout') });
    const r = await svc.reconcilePendingPayouts();
    expect(r).toEqual({ checked: 2, completed: 0, refunded: 0 });
    expect(wallet.completeReservedPayout).not.toHaveBeenCalled();
    expect(wallet.refundReservedPayout).not.toHaveBeenCalled();
  });

  it('introuvable chez PawaPay : remboursé seulement après le délai de sécurité', async () => {
    const recent = tx('p6', { createdAt: new Date(Date.now() - 5 * 60 * 1000) });
    const { svc, wallet } = setup([tx('p7'), recent], { p6: 'NOT_FOUND', p7: 'NOT_FOUND' });
    const r = await svc.reconcilePendingPayouts();
    expect(r.refunded).toBe(1);
    expect(wallet.refundReservedPayout).toHaveBeenCalledWith('t-p7', 'w1', 10.5, expect.any(String));
  });

  it('déjà finalisée ailleurs (remboursement non effectué) → pas compté, pas de notification', async () => {
    const { svc, wallet, notif } = setup([tx('p8')], { p8: 'FAILED' });
    wallet.refundReservedPayout.mockResolvedValue({ status: 'FAILED', refunded: false });
    const r = await svc.reconcilePendingPayouts();
    expect(r.refunded).toBe(0);
    expect(notif.notify).not.toHaveBeenCalled();
  });
});
