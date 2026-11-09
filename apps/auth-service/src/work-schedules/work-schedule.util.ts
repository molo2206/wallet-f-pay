// apps/auth-service/src/work-schedules/work-schedule.util.ts
// (même moteur de calcul que FavorHelp)
/**
 * ✅ Calculs horaires des programmes de travail (sans dépendance externe).
 *  Les plages sont converties en « minutes de la semaine » (lundi 00:00 = 0, dimanche 23:59 = 10079),
 *  ce qui gère simplement les plages de nuit (22:00 → 06:00) et le passage dimanche → lundi.
 */

export const WEEK_MINUTES = 7 * 1440;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

export type SlotLike = { dayOfWeek: number; startTime: string; endTime: string };

export function toMinutes(hhmm: string): number {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

/** Fuseau IANA valide ? */
export function isValidTimezone(tz?: string | null): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Jour (1 = lundi … 7 = dimanche), minutes depuis minuit et date AAAA-MM-JJ dans le fuseau donné */
export function localParts(date: Date, timeZone: string): { day: number; minutes: number; ymd: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const days: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const hour = Number(get('hour')) % 24;
  return {
    day: days[get('weekday')] ?? 1,
    minutes: hour * 60 + Number(get('minute')),
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/** Plage → intervalle [début, fin) en minutes de la semaine (fin peut dépasser WEEK_MINUTES) */
export function slotRange(slot: SlotLike, graceMinutes = 0): { start: number; end: number } {
  const s = toMinutes(slot.startTime);
  let e = toMinutes(slot.endTime);
  const duration = e > s ? e - s : e + 1440 - s; // fin <= début : se termine le lendemain (00:00→00:00 = 24 h)
  const start = (slot.dayOfWeek - 1) * 1440 + s - graceMinutes;
  return { start, end: start + duration + 2 * graceMinutes };
}

export type SlotEvaluation = {
  allowed: boolean;
  /** Accès autorisé : minutes restantes avant la fin de la plage en cours */
  minutesLeft: number | null;
  /** Accès refusé : minutes avant la prochaine plage (null = aucune plage) */
  minutesToNext: number | null;
};

/** L'instant (minutes de la semaine) est-il dans une des plages ? */
export function evaluateSlots(slots: SlotLike[], weekMinute: number, graceMinutes = 0): SlotEvaluation {
  if (!slots?.length) return { allowed: false, minutesLeft: null, minutesToNext: null };

  let minutesLeft: number | null = null;
  let minutesToNext: number | null = null;

  for (const slot of slots) {
    const { start, end } = slotRange(slot, graceMinutes);
    if (end - start >= WEEK_MINUTES) return { allowed: true, minutesLeft: null, minutesToNext: null };
    // Comparaison sur la semaine précédente, en cours et suivante (plages qui débordent)
    for (const shift of [-WEEK_MINUTES, 0, WEEK_MINUTES]) {
      const a = start + shift;
      const b = end + shift;
      if (weekMinute >= a && weekMinute < b) {
        const left = b - weekMinute;
        if (minutesLeft === null || left > minutesLeft) minutesLeft = left;
      } else if (a > weekMinute) {
        const wait = a - weekMinute;
        if (minutesToNext === null || wait < minutesToNext) minutesToNext = wait;
      }
    }
  }

  if (minutesLeft !== null) {
    // Plages qui se suivent (ex. 08:00-12:00 puis 12:00-17:00) : on prolonge jusqu'à la vraie fin
    let changed = true;
    let endAt = weekMinute + minutesLeft;
    let guard = 0;
    while (changed && guard++ < 20) {
      changed = false;
      for (const slot of slots) {
        const { start, end } = slotRange(slot, graceMinutes);
        for (const shift of [0, WEEK_MINUTES]) {
          if (start + shift <= endAt && end + shift > endAt) {
            endAt = end + shift;
            changed = true;
          }
        }
      }
    }
    return { allowed: true, minutesLeft: endAt - weekMinute, minutesToNext: null };
  }
  return { allowed: false, minutesLeft: null, minutesToNext };
}

/** Vérifie et normalise une liste de plages (format, jours, doublons) */
export function normalizeSlots(slots: SlotLike[]): SlotLike[] {
  const seen = new Set<string>();
  const out: SlotLike[] = [];
  for (const raw of slots ?? []) {
    const slot = {
      dayOfWeek: Number(raw.dayOfWeek),
      startTime: String(raw.startTime).trim(),
      endTime: String(raw.endTime).trim() === '24:00' ? '00:00' : String(raw.endTime).trim(),
    };
    const key = `${slot.dayOfWeek}|${slot.startTime}|${slot.endTime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(slot);
  }
  return out.sort((a, b) => a.dayOfWeek - b.dayOfWeek || toMinutes(a.startTime) - toMinutes(b.startTime));
}

/** Date AAAA-MM-JJ comprise dans la période (bornes incluses, null = sans limite) */
export function inPeriod(ymd: string, from?: string | null, until?: string | null): boolean {
  const f = from ? String(from).slice(0, 10) : null;
  const u = until ? String(until).slice(0, 10) : null;
  if (f && ymd < f) return false;
  if (u && ymd > u) return false;
  return true;
}

/** Libellé « lundi 08:00 » dans la langue et le fuseau donnés */
export function formatLocal(date: Date, timeZone: string, lang = 'fr'): string {
  try {
    return new Intl.DateTimeFormat(lang, {
      timeZone,
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}
