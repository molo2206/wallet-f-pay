import { WorkSchedulesService } from './work-schedules.service';

/** Base simulée : répond aux requêtes SQL du service selon leur contenu */
function fakeDb(state: {
  user: any;
  exceptions?: any[];
  assignment?: { type: string; schedule: any } | null;
  slots?: any[];
}) {
  const executed: { sql: string; params: any[] }[] = [];
  const db = {
    executed,
    $queryRawUnsafe: jest.fn(async (sql: string, ...params: any[]) => {
      if (sql.includes('FROM `user` WHERE `id`')) return state.user ? [state.user] : [];
      if (sql.includes('FROM `work_schedule_exceptions`')) return state.exceptions ?? [];
      if (sql.includes('FROM `work_schedule_assignments` a INNER JOIN')) {
        return state.assignment && params[0] === state.assignment.type ? [state.assignment.schedule] : [];
      }
      if (sql.includes('FROM `work_schedule_slots`')) return state.slots ?? [];
      if (sql.includes('general_settings')) return [{ timezone: 'Africa/Lubumbashi' }];
      return [];
    }),
    $executeRawUnsafe: jest.fn(async (sql: string, ...params: any[]) => {
      executed.push({ sql, params });
      return sql.startsWith('UPDATE `sessions`') ? 2 : 1;
    }),
    $disconnect: jest.fn(async () => undefined),
  };
  return db;
}

function makeService(db: any) {
  const i18n = { translate: (k: string, _l?: string, p?: any) => (p ? `${k}:${JSON.stringify(p)}` : k) };
  const service = new WorkSchedulesService(i18n as any);
  (service as any).prisma = db;
  (service as any).notify = jest.fn();
  return service;
}

const schedule = { id: 's1', name: 'Bureau', timezone: 'Africa/Lubumbashi', grace_minutes: 0, warn_minutes: 10, is_active: 1 };
const weekdaySlots = [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, startTime: '08:00', endTime: '17:00' }));
// Lundi 9 novembre 2026
const MONDAY_10H = new Date('2026-11-09T08:00:00Z'); // 10:00 à Lubumbashi
const MONDAY_18H = new Date('2026-11-09T16:00:00Z'); // 18:00 à Lubumbashi

describe('WorkSchedulesService', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('SUPER_ADMIN toujours exempté', async () => {
    const s = makeService(fakeDb({ user: { id: 'u', role: 'SUPER_ADMIN', branchId: null } }));
    const d = await s.evaluate('u', MONDAY_18H, false);
    expect(d.allowed).toBe(true);
    expect(d.source).toBe('EXEMPT');
  });

  it('sans programme : accès libre', async () => {
    const s = makeService(fakeDb({ user: { id: 'u', role: 'ADMIN', branchId: null } }));
    expect((await s.evaluate('u', MONDAY_18H, false)).source).toBe('NONE');
  });

  it("programme individuel : autorisé à 10:00 avec l'heure de fin exacte", async () => {
    const s = makeService(
      fakeDb({ user: { id: 'u', role: 'USER', branchId: 'b' }, assignment: { type: 'USER', schedule }, slots: weekdaySlots }),
    );
    const d = await s.evaluate('u', MONDAY_10H, false);
    expect(d.allowed).toBe(true);
    expect(d.assignedBy).toBe('USER');
    expect(d.endsAt).toBe('2026-11-09T15:00:00.000Z'); // 17:00 locale = 15:00 UTC
    expect(d.minutesLeft).toBe(7 * 60);
  });

  it("programme de l'agence : refusé à 18:00, prochaine ouverture mardi 08:00 locale", async () => {
    const s = makeService(
      fakeDb({ user: { id: 'u', role: 'USER', branchId: 'b' }, assignment: { type: 'BRANCH', schedule }, slots: weekdaySlots }),
    );
    const d = await s.evaluate('u', MONDAY_18H, false);
    expect(d.allowed).toBe(false);
    expect(d.assignedBy).toBe('BRANCH');
    expect(d.nextStartAt).toBe('2026-11-10T06:00:00.000Z');
  });

  it('dérogation DENY prioritaire, ALLOW ouvre hors horaires', async () => {
    const until = new Date('2026-11-12T00:00:00Z');
    const deny = makeService(
      fakeDb({
        user: { id: 'u', role: 'USER', branchId: null },
        exceptions: [{ id: 'e1', type: 'DENY', starts_at: MONDAY_10H, ends_at: until }],
        assignment: { type: 'USER', schedule },
        slots: weekdaySlots,
      }),
    );
    const d1 = await deny.evaluate('u', MONDAY_10H, false);
    expect(d1.allowed).toBe(false);
    expect(d1.source).toBe('EXCEPTION_DENY');

    const allow = makeService(
      fakeDb({
        user: { id: 'u', role: 'USER', branchId: null },
        exceptions: [{ id: 'e2', type: 'ALLOW', starts_at: MONDAY_10H, ends_at: until }],
        assignment: { type: 'USER', schedule },
        slots: weekdaySlots,
      }),
    );
    const d2 = await allow.evaluate('u', MONDAY_18H, false);
    expect(d2.allowed).toBe(true);
    expect(d2.source).toBe('EXCEPTION_ALLOW');
  });

  it('connexion refusée hors horaires (403 OUTSIDE_WORK_HOURS)', async () => {
    jest.useFakeTimers().setSystemTime(MONDAY_18H);
    try {
      const s = makeService(
        fakeDb({ user: { id: 'u', role: 'USER', branchId: null }, assignment: { type: 'ROLE', schedule }, slots: weekdaySlots }),
      );
      await expect(s.assertCanLogin('u')).rejects.toMatchObject({ error: { statusCode: 403, code: 'OUTSIDE_WORK_HOURS' } });
    } finally {
      jest.useRealTimers();
    }
  });

  it('déconnexion forcée : sessions invalidées, jetons OAuth supprimés, notification FORCE_LOGOUT', async () => {
    const db = fakeDb({ user: { id: 'u', role: 'USER', branchId: null } });
    const s = makeService(db);
    const closed = await s.forceLogout('u', { source: 'SCHEDULE', nextStartAt: null, scheduleId: 's1' } as any);
    expect(closed).toBe(2);
    const sqls = db.executed.map((e) => e.sql);
    expect(sqls.some((q) => q.startsWith('UPDATE `sessions` SET `is_valid` = 0'))).toBe(true);
    expect(sqls.some((q) => q.includes('DELETE FROM `oauthaccesstoken`'))).toBe(true);
    expect((s as any).notify).toHaveBeenCalledWith('u', expect.any(String), expect.any(String), expect.objectContaining({ action: 'FORCE_LOGOUT' }));
  });

  it('WORK_SCHEDULE_ENABLED=false désactive tout', async () => {
    process.env.WORK_SCHEDULE_ENABLED = 'false';
    const s = makeService(fakeDb({ user: { id: 'u', role: 'USER', branchId: null }, assignment: { type: 'USER', schedule }, slots: [] }));
    expect((await s.evaluate('u', MONDAY_18H, false)).allowed).toBe(true);
  });

  it('tables absentes : jamais de blocage', async () => {
    const db = fakeDb({ user: { id: 'u', role: 'USER', branchId: null } });
    db.$queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM `user` WHERE')) return [{ id: 'u', role: 'USER', branchId: null }];
      throw new Error("Table 'fpay.work_schedule_exceptions' doesn't exist");
    });
    const s = makeService(db);
    const d = await s.evaluate('u', MONDAY_18H, false);
    expect(d.allowed).toBe(true);
    expect(d.source).toBe('DISABLED');
  });
});
