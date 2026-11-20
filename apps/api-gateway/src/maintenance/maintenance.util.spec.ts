import { MaintenanceWindow, blockingDecision, isActive, modulesOfRoute, pickMessage, retryAfterSeconds } from './maintenance.util';

const now = new Date('2026-11-10T10:00:00Z');
const win = (over: Partial<MaintenanceWindow> = {}): MaintenanceWindow => ({
  id: 'w',
  title: 'Mise à jour',
  messages: {},
  scope: 'FULL',
  modules: [],
  startsAt: new Date('2026-11-10T09:00:00Z'),
  endsAt: new Date('2026-11-10T11:00:00Z'),
  status: 'ACTIVE',
  allowRoles: ['SUPER_ADMIN', 'ADMIN'],
  allowUserIds: [],
  allowIps: [],
  ...over,
});

describe('maintenance.util', () => {
  it('fenêtre active selon les dates et le statut', () => {
    expect(isActive(win(), now)).toBe(true);
    expect(isActive(win({ startsAt: new Date('2026-11-10T10:30:00Z'), status: 'SCHEDULED' }), now)).toBe(false);
    expect(isActive(win({ endsAt: new Date('2026-11-10T10:00:00Z') }), now)).toBe(false);
    expect(isActive(win({ endsAt: null }), now)).toBe(true);
    expect(isActive(win({ status: 'CANCELLED' }), now)).toBe(false);
  });

  it('associe les routes aux modules', () => {
    expect(modulesOfRoute('POST', '/wallet/cashout')).toEqual(['WITHDRAWALS']);
    expect(modulesOfRoute('POST', '/api/external/pay/mobile_money')).toEqual(['DEPOSITS', 'EXTERNAL_API']);
    expect(modulesOfRoute('POST', '/api/external/pay')).toEqual(['PAYMENTS', 'EXTERNAL_API']);
    expect(modulesOfRoute('GET', '/wallet/cashout')).toEqual([]);
    expect(modulesOfRoute('POST', '/auth/login')).toEqual(['LOGIN']);
  });

  it('FULL : tout bloqué sauf personnes exemptées et routes toujours permises', () => {
    expect(blockingDecision(win(), { method: 'GET', path: '/wallet/balance', role: 'USER' })).not.toBeNull();
    expect(blockingDecision(win(), { method: 'POST', path: '/wallet/send', role: 'ADMIN' })).toBeNull();
    expect(blockingDecision(win(), { method: 'GET', path: '/maintenance/status' })).toBeNull();
    expect(blockingDecision(win(), { method: 'POST', path: '/auth/logout', role: 'USER' })).toBeNull();
    expect(blockingDecision(win({ allowIps: ['10.0.0.5'] }), { method: 'GET', path: '/x', ip: '::ffff:10.0.0.5' })).toBeNull();
    expect(blockingDecision(win({ allowUserIds: ['u9'] }), { method: 'POST', path: '/wallet/send', userId: 'u9', role: 'USER' })).toBeNull();
  });

  it('READ_ONLY : consultation et connexion permises, écritures bloquées', () => {
    const w = win({ scope: 'READ_ONLY' });
    expect(blockingDecision(w, { method: 'GET', path: '/wallet/transactions', role: 'USER' })).toBeNull();
    expect(blockingDecision(w, { method: 'POST', path: '/auth/login' })).toBeNull();
    expect(blockingDecision(w, { method: 'POST', path: '/wallet/send', role: 'USER' })).not.toBeNull();
  });

  it('MODULES : seuls les modules choisis sont bloqués', () => {
    const w = win({ scope: 'MODULES', modules: ['WITHDRAWALS', 'DEPOSITS'] });
    expect(blockingDecision(w, { method: 'POST', path: '/wallet/cashout', role: 'USER' })).toEqual({ blocked: true, modules: ['WITHDRAWALS'] });
    expect(blockingDecision(w, { method: 'POST', path: '/wallet/send', role: 'USER' })).toBeNull();
    expect(blockingDecision(w, { method: 'GET', path: '/wallet/balance', role: 'USER' })).toBeNull();
  });

  it('messages par langue et Retry-After', () => {
    expect(pickMessage({ fr: 'Bonjour', en: 'Hello' }, 'en-US')).toBe('Hello');
    expect(pickMessage({ fr: 'Bonjour' }, 'sw')).toBe('Bonjour');
    expect(pickMessage({}, 'fr')).toBeNull();
    expect(retryAfterSeconds(win(), now)).toBe(3600);
    expect(retryAfterSeconds(win({ endsAt: null }), now)).toBe(600);
  });
});
