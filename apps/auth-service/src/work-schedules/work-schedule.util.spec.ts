import { evaluateSlots, localParts, normalizeSlots, slotRange, WEEK_MINUTES } from './work-schedule.util';

const at = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (day - 1) * 1440 + h * 60 + m;
};

describe('work-schedule.util', () => {
  const weekdays = [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, startTime: '08:00', endTime: '17:00' }));

  it('autorise pendant la plage et calcule le temps restant', () => {
    const r = evaluateSlots(weekdays, at(1, '16:30'));
    expect(r.allowed).toBe(true);
    expect(r.minutesLeft).toBe(30);
  });

  it("refuse à l'heure de fin exacte (borne exclue)", () => {
    const r = evaluateSlots(weekdays, at(1, '17:00'));
    expect(r.allowed).toBe(false);
    expect(r.minutesToNext).toBe(15 * 60); // mardi 08:00
  });

  it('jours de repos : refus et prochaine ouverture le lundi', () => {
    const r = evaluateSlots(weekdays, at(6, '10:00'));
    expect(r.allowed).toBe(false);
    expect(r.minutesToNext).toBe(at(1, '08:00') + WEEK_MINUTES - at(6, '10:00'));
  });

  it('plage de nuit (22:00 → 06:00) et passage dimanche → lundi', () => {
    const night = [{ dayOfWeek: 7, startTime: '22:00', endTime: '06:00' }];
    expect(evaluateSlots(night, at(7, '23:00')).allowed).toBe(true);
    const monday = evaluateSlots(night, at(1, '05:00'));
    expect(monday.allowed).toBe(true);
    expect(monday.minutesLeft).toBe(60);
    expect(evaluateSlots(night, at(1, '06:00')).allowed).toBe(false);
  });

  it('plages contiguës fusionnées pour le temps restant', () => {
    const split = [
      { dayOfWeek: 2, startTime: '08:00', endTime: '12:00' },
      { dayOfWeek: 2, startTime: '12:00', endTime: '17:00' },
    ];
    expect(evaluateSlots(split, at(2, '11:00')).minutesLeft).toBe(6 * 60);
  });

  it('tolérance (grace) avant et après la plage', () => {
    expect(evaluateSlots(weekdays, at(1, '17:05'), 10).allowed).toBe(true);
    expect(evaluateSlots(weekdays, at(1, '07:55'), 10).allowed).toBe(true);
    expect(slotRange(weekdays[0], 10)).toEqual({ start: at(1, '07:50'), end: at(1, '17:10') });
  });

  it('aucune plage = aucun accès', () => {
    expect(evaluateSlots([], at(1, '10:00'))).toEqual({ allowed: false, minutesLeft: null, minutesToNext: null });
  });

  it('normalise : doublons retirés, 24:00 → 00:00, tri', () => {
    const n = normalizeSlots([
      { dayOfWeek: 3, startTime: '09:00', endTime: '24:00' },
      { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
      { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
    ]);
    expect(n).toEqual([
      { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
      { dayOfWeek: 3, startTime: '09:00', endTime: '00:00' },
    ]);
  });

  it('fuseau horaire : 06:30 UTC = 08:30 à Lubumbashi (UTC+2)', () => {
    const lp = localParts(new Date('2026-11-09T06:30:00Z'), 'Africa/Lubumbashi'); // lundi
    expect(lp.day).toBe(1);
    expect(lp.minutes).toBe(8 * 60 + 30);
    expect(evaluateSlots(weekdays, (lp.day - 1) * 1440 + lp.minutes).allowed).toBe(true);
  });
});
