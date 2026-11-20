import { approvalReason, parseThresholds } from './admin-approval.service';

describe('double validation des recharges admin', () => {
  const base = { role: 'SUPER_ADMIN', walletBranchId: null, currency: 'USD', amount: 100, thresholds: {} as Record<string, number> };

  it('défaut : seule la recharge sans caisse (création de monnaie) est soumise à validation', () => {
    expect(approvalReason({ ...base, mode: 'no_counterpart' })).toBe('NO_CASH_COUNTERPART');
    expect(approvalReason({ ...base, mode: 'no_counterpart', walletBranchId: 'b1' })).toBeNull();
    expect(approvalReason({ ...base, mode: 'no_counterpart', role: 'ADMIN' })).toBeNull();
  });

  it('seuils, tout, ou désactivé', () => {
    const thresholds = parseThresholds('USD:500, cdf:1000000, bad');
    expect(thresholds).toEqual({ USD: 500, CDF: 1000000 });
    expect(approvalReason({ ...base, mode: 'threshold', role: 'ADMIN', walletBranchId: 'b', amount: 600, thresholds })).toBe('ABOVE_THRESHOLD');
    expect(approvalReason({ ...base, mode: 'threshold', role: 'ADMIN', walletBranchId: 'b', amount: 400, thresholds })).toBeNull();
    expect(approvalReason({ ...base, mode: 'all', role: 'ADMIN', walletBranchId: 'b' })).toBe('ALL_ADMIN_TOP_UPS');
    expect(approvalReason({ ...base, mode: 'off' })).toBeNull();
  });
});
