// apps/auth-service/src/work-schedules/work-schedules.service.ts
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RpcException } from '@nestjs/microservices';
import { ClientProxy, ClientProxyFactory, Transport } from '@nestjs/microservices';
import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';
import { I18nService } from '@app/common';
import {
  SlotLike,
  TIME_RE,
  WEEK_MINUTES,
  evaluateSlots,
  formatLocal,
  isValidTimezone,
  localParts,
  normalizeSlots,
} from './work-schedule.util';

export type ScheduleTargetType = 'USER' | 'BRANCH' | 'ROLE';

export type AccessDecision = {
  allowed: boolean;
  /** EXEMPT (rôle exempté) | NONE (aucun programme) | EXCEPTION_ALLOW | EXCEPTION_DENY | SCHEDULE */
  source: 'EXEMPT' | 'NONE' | 'EXCEPTION_ALLOW' | 'EXCEPTION_DENY' | 'SCHEDULE' | 'DISABLED';
  scheduleId: string | null;
  scheduleName: string | null;
  assignedBy: ScheduleTargetType | null;
  timezone: string | null;
  /** Fin de l'accès autorisé (ISO) */
  endsAt: string | null;
  /** Prochaine ouverture (ISO) quand l'accès est refusé */
  nextStartAt: string | null;
  minutesLeft: number | null;
  exceptionId: string | null;
  warnMinutes: number;
};

type CachedDecision = { decision: AccessDecision; until: number };

const ROLES = ['USER', 'ADMIN', 'MERCHANT', 'SUPER_ADMIN'];

/**
 * ✅ PROGRAMMES DE TRAVAIL (horaires d'accès à la plateforme)
 *
 *  Priorité : rôle exempté (SUPER_ADMIN) > dérogation (ALLOW / DENY) > programme individuel > programme de l'agence (branch)
 *             > programme du rôle > aucun programme (accès libre).
 *  - Plages par jour (plusieurs par jour, plages de nuit 22:00 → 06:00), jours sans plage = repos.
 *  - Fuseau horaire du programme (défaut : general_settings.timezone, sinon WORK_SCHEDULE_DEFAULT_TIMEZONE).
 *  - Dérogations datées : ALLOW (accès hors horaires) / DENY (congé, suspension temporaire).
 *  - Contrôle côté serveur : à la connexion, à CHAQUE requête (validate_session) et par un cron chaque minute qui
 *    ferme les sessions (sessions.is_valid = 0, raison OUTSIDE_WORK_HOURS), supprime les jetons OAuth
 *    et envoie une notification FORCE_LOGOUT aux applications.
 *  Tables : work_schedules, work_schedule_slots, work_schedule_assignments, work_schedule_exceptions (SQL fourni).
 */
@Injectable()
export class WorkSchedulesService implements OnModuleDestroy {
  private readonly logger = new Logger(WorkSchedulesService.name);
  private readonly prisma = new PrismaClient();
  private readonly cache = new Map<string, CachedDecision>();
  private readonly warned = new Set<string>();
  private notificationClient: ClientProxy | null = null;
  private enforcing = false;
  private tableMissingLogged = false;
  private defaultTzCache: { tz: string; at: number } | null = null;

  constructor(private readonly i18n: I18nService) {}

  async onModuleDestroy() {
    await this.prisma.$disconnect().catch(() => undefined);
    this.notificationClient?.close();
  }

  // ============================================================
  // CONFIGURATION
  // ============================================================
  private get enabled(): boolean {
    return String(process.env.WORK_SCHEDULE_ENABLED ?? 'true').toLowerCase() !== 'false';
  }

  private get exemptRoles(): string[] {
    return String(process.env.WORK_SCHEDULE_EXEMPT_ROLES || 'SUPER_ADMIN')
      .split(',')
      .map((r) => r.trim().toUpperCase())
      .filter(Boolean);
  }

  private get cacheMs(): number {
    const n = Number(process.env.WORK_SCHEDULE_CACHE_SECONDS ?? 30);
    return (Number.isFinite(n) && n >= 0 ? n : 30) * 1000;
  }

  private t(key: string, lang = 'fr', params?: Record<string, any>): string {
    try {
      return this.i18n.translate(key, lang, params);
    } catch {
      return key;
    }
  }

  private db(): any {
    return this.prisma as any;
  }

  private isMissingTable(e: any): boolean {
    return /doesn't exist|1146|ER_NO_SUCH_TABLE/i.test(String(e?.message || ''));
  }

  private async defaultTimezone(): Promise<string> {
    if (this.defaultTzCache && Date.now() - this.defaultTzCache.at < 10 * 60 * 1000) return this.defaultTzCache.tz;
    let tz = process.env.WORK_SCHEDULE_DEFAULT_TIMEZONE || 'Africa/Lubumbashi';
    try {
      const rows: any[] = await this.db().$queryRawUnsafe('SELECT `timezone` FROM `general_settings` WHERE `timezone` IS NOT NULL LIMIT 1');
      if (rows?.[0]?.timezone && isValidTimezone(rows[0].timezone)) tz = rows[0].timezone;
    } catch {
      /* table absente */
    }
    this.defaultTzCache = { tz, at: Date.now() };
    return tz;
  }

  private fail(statusCode: number, message: string, extra: Record<string, any> = {}): never {
    throw new RpcException({ status: 'error', statusCode, message, ...extra });
  }

  // ============================================================
  // ÉVALUATION D'ACCÈS
  // ============================================================
  invalidate(userId?: string) {
    if (userId) this.cache.delete(userId);
    else this.cache.clear();
  }

  private open(source: AccessDecision['source'], extra: Partial<AccessDecision> = {}): AccessDecision {
    return {
      allowed: true,
      source,
      scheduleId: null,
      scheduleName: null,
      assignedBy: null,
      timezone: null,
      endsAt: null,
      nextStartAt: null,
      minutesLeft: null,
      exceptionId: null,
      warnMinutes: 0,
      ...extra,
    };
  }

  /** Décision d'accès d'un utilisateur à l'instant donné (avec cache court) */
  async evaluate(userId: string, now: Date = new Date(), useCache = true): Promise<AccessDecision> {
    if (!this.enabled) return this.open('DISABLED');
    const cached = useCache ? this.cache.get(userId) : undefined;
    if (cached && cached.until > now.getTime()) return cached.decision;

    let decision: AccessDecision;
    try {
      decision = await this.compute(userId, now);
    } catch (e: any) {
      if (this.isMissingTable(e)) {
        if (!this.tableMissingLogged) this.logger.warn('Tables work_schedule* absentes : programmes de travail désactivés (exécutez le SQL)');
        this.tableMissingLogged = true;
        return this.open('DISABLED');
      }
      // Ne jamais bloquer toute la plateforme sur une erreur technique
      this.logger.error(`Évaluation du programme impossible (${userId}) : ${e?.message}`);
      return this.open('NONE');
    }

    // Cache borné par la prochaine bascule (fin de plage ou ouverture) pour rester exact à la minute
    let until = now.getTime() + this.cacheMs;
    const edge = decision.allowed ? decision.endsAt : decision.nextStartAt;
    if (edge) until = Math.min(until, new Date(edge).getTime());
    this.cache.set(userId, { decision, until });
    return decision;
  }

  private async compute(userId: string, now: Date): Promise<AccessDecision> {
    const db = this.db();
    const users: any[] = await db.$queryRawUnsafe('SELECT `id`, `role`, `branchId` FROM `user` WHERE `id` = ? LIMIT 1', userId);
    const user = users?.[0];
    if (!user) return this.open('NONE');
    if (this.exemptRoles.includes(String(user.role).toUpperCase())) return this.open('EXEMPT');

    // 1) Dérogations en cours (DENY l'emporte sur ALLOW)
    const exceptions: any[] = await db.$queryRawUnsafe(
      'SELECT `id`, `type`, `starts_at`, `ends_at`, `reason` FROM `work_schedule_exceptions` ' +
        'WHERE `user_id` = ? AND `revoked_at` IS NULL AND `starts_at` <= ? AND `ends_at` > ? ORDER BY `type` DESC',
      userId,
      now,
      now,
    );
    const deny = exceptions.find((e) => e.type === 'DENY');
    if (deny) {
      return {
        ...this.open('EXCEPTION_DENY'),
        allowed: false,
        nextStartAt: new Date(deny.ends_at).toISOString(),
        exceptionId: deny.id,
      };
    }
    const allow = exceptions.find((e) => e.type === 'ALLOW');
    if (allow) {
      const ends = new Date(allow.ends_at);
      return this.open('EXCEPTION_ALLOW', {
        endsAt: ends.toISOString(),
        minutesLeft: Math.max(0, Math.round((ends.getTime() - now.getTime()) / 60000)),
        exceptionId: allow.id,
        warnMinutes: 10,
      });
    }

    // 2) Programme : individuel > agence > rôle
    const targets: [ScheduleTargetType, string | null][] = [
      ['USER', user.id],
      ['BRANCH', user.branchId ?? null],
      ['ROLE', String(user.role)],
    ];
    let schedule: any = null;
    let assignedBy: ScheduleTargetType | null = null;
    for (const [type, id] of targets) {
      if (!id) continue;
      const rows: any[] = await db.$queryRawUnsafe(
        'SELECT s.* FROM `work_schedule_assignments` a INNER JOIN `work_schedules` s ON s.`id` = a.`schedule_id` ' +
          'WHERE a.`target_type` = ? AND a.`target_id` = ? LIMIT 1',
        type,
        id,
      );
      if (rows?.[0]) {
        schedule = rows[0];
        assignedBy = type;
        break;
      }
    }
    if (!schedule || !Number(schedule.is_active)) return this.open('NONE');

    const slots: SlotLike[] = (
      await db.$queryRawUnsafe(
        'SELECT `day_of_week` AS dayOfWeek, `start_time` AS startTime, `end_time` AS endTime FROM `work_schedule_slots` WHERE `schedule_id` = ?',
        schedule.id,
      )
    ).map((r: any) => ({ dayOfWeek: Number(r.dayOfWeek), startTime: r.startTime, endTime: r.endTime }));

    const tz = isValidTimezone(schedule.timezone) ? schedule.timezone : await this.defaultTimezone();
    const lp = localParts(now, tz);
    const weekMinute = (lp.day - 1) * 1440 + lp.minutes;
    const ev = evaluateSlots(slots, weekMinute, Number(schedule.grace_minutes) || 0);
    const base = {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      assignedBy,
      timezone: tz,
      exceptionId: null,
      warnMinutes: Number(schedule.warn_minutes ?? 10) || 0,
    };
    // Secondes déjà écoulées dans la minute courante : fin exacte à la minute près
    const minuteStart = now.getTime() - (now.getSeconds() * 1000 + now.getMilliseconds());
    if (ev.allowed) {
      const endsAt = ev.minutesLeft === null ? null : new Date(minuteStart + ev.minutesLeft * 60000).toISOString();
      return { ...base, allowed: true, source: 'SCHEDULE', endsAt, nextStartAt: null, minutesLeft: ev.minutesLeft };
    }
    const nextStartAt =
      ev.minutesToNext === null || ev.minutesToNext > WEEK_MINUTES ? null : new Date(minuteStart + ev.minutesToNext * 60000).toISOString();
    return { ...base, allowed: false, source: 'SCHEDULE', endsAt: null, nextStartAt, minutesLeft: null };
  }

  /** Message clair pour l'utilisateur refusé */
  denialMessage(decision: AccessDecision, lang = 'fr'): string {
    const tz = decision.timezone || 'Africa/Lubumbashi';
    const next = decision.nextStartAt ? formatLocal(new Date(decision.nextStartAt), tz, lang) : null;
    if (decision.source === 'EXCEPTION_DENY') {
      return this.t('work_schedule.denied_exception', lang, { until: next ?? '' });
    }
    return next
      ? this.t('work_schedule.outside_hours_next', lang, { next })
      : this.t('work_schedule.outside_hours', lang);
  }

  /** Connexion : refusée hors horaires */
  async assertCanLogin(userId: string, lang = 'fr'): Promise<void> {
    const d = await this.evaluate(userId, new Date(), false);
    if (!d.allowed) {
      this.fail(403, this.denialMessage(d, lang), { code: 'OUTSIDE_WORK_HOURS', nextStartAt: d.nextStartAt });
    }
  }

  // ============================================================
  // GESTION DES PROGRAMMES (SUPER_ADMIN, ou ADMIN avec la ressource WORK_SCHEDULES)
  // ============================================================
  private cleanSlots(raw: any): SlotLike[] {
    if (!Array.isArray(raw)) this.fail(400, this.t('work_schedule.slots_required'));
    for (const s of raw) {
      const d = Number(s?.dayOfWeek);
      if (!Number.isInteger(d) || d < 1 || d > 7) this.fail(400, this.t('work_schedule.invalid_day'));
      if (!TIME_RE.test(String(s?.startTime ?? '')) || !TIME_RE.test(String(s?.endTime ?? ''))) {
        this.fail(400, this.t('work_schedule.invalid_time'));
      }
      if (String(s.startTime) === String(s.endTime) && String(s.startTime) !== '00:00') this.fail(400, this.t('work_schedule.invalid_time'));
    }
    return normalizeSlots(raw);
  }

  private async scheduleView(id: string) {
    const db = this.db();
    const rows: any[] = await db.$queryRawUnsafe('SELECT * FROM `work_schedules` WHERE `id` = ? LIMIT 1', id);
    if (!rows?.[0]) this.fail(404, this.t('work_schedule.not_found'));
    const s = rows[0];
    const slots: any[] = await db.$queryRawUnsafe(
      'SELECT `id`, `day_of_week` AS dayOfWeek, `start_time` AS startTime, `end_time` AS endTime FROM `work_schedule_slots` WHERE `schedule_id` = ? ORDER BY `day_of_week`, `start_time`',
      id,
    );
    const assignments: any[] = await db.$queryRawUnsafe(
      'SELECT a.`id`, a.`target_type` AS targetType, a.`target_id` AS targetId, a.`created_at` AS createdAt, ' +
        'u.`full_name` AS userName, u.`email` AS userEmail, b.`name` AS branchName ' +
        'FROM `work_schedule_assignments` a ' +
        "LEFT JOIN `user` u ON a.`target_type` = 'USER' AND u.`id` = a.`target_id` " +
        "LEFT JOIN `branch` b ON a.`target_type` = 'BRANCH' AND b.`id` = a.`target_id` " +
        'WHERE a.`schedule_id` = ? ORDER BY a.`created_at` DESC',
      id,
    );
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      timezone: s.timezone,
      graceMinutes: Number(s.grace_minutes) || 0,
      warnMinutes: Number(s.warn_minutes) || 0,
      isActive: !!Number(s.is_active),
      createdBy: s.created_by,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      slots: slots.map((x) => ({ ...x, dayOfWeek: Number(x.dayOfWeek) })),
      restDays: [1, 2, 3, 4, 5, 6, 7].filter((d) => !slots.some((x) => Number(x.dayOfWeek) === d)),
      assignments: assignments.map((a) => ({
        id: a.id,
        targetType: a.targetType,
        targetId: a.targetId,
        label: a.targetType === 'USER' ? a.userName || a.userEmail || a.targetId : a.targetType === 'BRANCH' ? a.branchName || a.targetId : a.targetId,
        createdAt: a.createdAt,
      })),
    };
  }

  async listSchedules(q: { search?: string; page?: number; limit?: number } = {}) {
    const db = this.db();
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    const where = q.search ? 'WHERE `name` LIKE ?' : '';
    const params = q.search ? [`%${q.search}%`] : [];
    const total = Number((await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`work_schedules\` ${where}`, ...params))?.[0]?.n ?? 0);
    const rows: any[] = await db.$queryRawUnsafe(
      `SELECT s.*, (SELECT COUNT(*) FROM \`work_schedule_assignments\` a WHERE a.\`schedule_id\` = s.\`id\`) AS assignments_count ` +
        `FROM \`work_schedules\` s ${where.replace('`name`', 's.`name`')} ORDER BY s.\`name\` ASC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      ...params,
    );
    const data: any[] = [];
    for (const r of rows) data.push({ ...(await this.scheduleView(r.id)), assignmentsCount: Number(r.assignments_count) || 0 });
    return { message: this.t('work_schedule.list'), data: { data, total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async getSchedule(id: string) {
    return { message: this.t('work_schedule.detail'), data: await this.scheduleView(id) };
  }

  async saveSchedule(payload: { id?: string; dto: any; adminId: string }) {
    const db = this.db();
    const dto = payload.dto || {};
    const name = String(dto.name ?? '').trim();
    if (!payload.id && !name) this.fail(400, this.t('work_schedule.name_required'));
    if (dto.timezone && !isValidTimezone(dto.timezone)) this.fail(400, this.t('work_schedule.invalid_timezone'));
    const slots = dto.slots !== undefined ? this.cleanSlots(dto.slots) : null;
    const grace = dto.graceMinutes !== undefined ? Math.min(120, Math.max(0, Math.round(Number(dto.graceMinutes) || 0))) : null;
    const warn = dto.warnMinutes !== undefined ? Math.min(120, Math.max(0, Math.round(Number(dto.warnMinutes) || 0))) : null;

    const id = payload.id || crypto.randomUUID();
    await this.prisma.$transaction(async (tx: any) => {
      if (payload.id) {
        const exists: any[] = await tx.$queryRawUnsafe('SELECT `id` FROM `work_schedules` WHERE `id` = ? FOR UPDATE', id);
        if (!exists?.[0]) this.fail(404, this.t('work_schedule.not_found'));
        await tx.$executeRawUnsafe(
          'UPDATE `work_schedules` SET `name` = COALESCE(?, `name`), `description` = ?, `timezone` = COALESCE(?, `timezone`), ' +
            '`grace_minutes` = COALESCE(?, `grace_minutes`), `warn_minutes` = COALESCE(?, `warn_minutes`), `is_active` = COALESCE(?, `is_active`), `updated_at` = UTC_TIMESTAMP() WHERE `id` = ?',
          name || null,
          dto.description !== undefined ? String(dto.description || '').slice(0, 500) || null : null,
          dto.timezone || null,
          grace,
          warn,
          dto.isActive === undefined ? null : dto.isActive ? 1 : 0,
          id,
        );
      } else {
        await tx.$executeRawUnsafe(
          'INSERT INTO `work_schedules` (`id`, `name`, `description`, `timezone`, `grace_minutes`, `warn_minutes`, `is_active`, `created_by`, `created_at`, `updated_at`) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
          id,
          name.slice(0, 120),
          dto.description ? String(dto.description).slice(0, 500) : null,
          dto.timezone || (await this.defaultTimezone()),
          grace ?? 0,
          warn ?? 10,
          dto.isActive === false ? 0 : 1,
          payload.adminId || null,
        );
      }
      if (slots) {
        await tx.$executeRawUnsafe('DELETE FROM `work_schedule_slots` WHERE `schedule_id` = ?', id);
        for (const s of slots) {
          await tx.$executeRawUnsafe(
            'INSERT INTO `work_schedule_slots` (`id`, `schedule_id`, `day_of_week`, `start_time`, `end_time`) VALUES (?, ?, ?, ?, ?)',
            crypto.randomUUID(),
            id,
            s.dayOfWeek,
            s.startTime,
            s.endTime,
          );
        }
      }
    });
    this.invalidate();
    await this.audit(payload.adminId, payload.id ? 'WORK_SCHEDULE_UPDATE' : 'WORK_SCHEDULE_CREATE', { scheduleId: id, dto });
    return { message: this.t(payload.id ? 'work_schedule.updated' : 'work_schedule.created'), data: await this.scheduleView(id) };
  }

  async deleteSchedule(payload: { id: string; adminId: string }) {
    await this.scheduleView(payload.id);
    await this.prisma.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe('DELETE FROM `work_schedule_assignments` WHERE `schedule_id` = ?', payload.id);
      await tx.$executeRawUnsafe('DELETE FROM `work_schedule_slots` WHERE `schedule_id` = ?', payload.id);
      await tx.$executeRawUnsafe('DELETE FROM `work_schedules` WHERE `id` = ?', payload.id);
    });
    this.invalidate();
    await this.audit(payload.adminId, 'WORK_SCHEDULE_DELETE', { scheduleId: payload.id });
    return { message: this.t('work_schedule.deleted'), data: { id: payload.id } };
  }

  /** Affecte un programme à un utilisateur, une agence ou un rôle (scheduleId null = retirer) */
  async assign(payload: { targetType: ScheduleTargetType; targetId: string; scheduleId?: string | null; adminId: string }) {
    const db = this.db();
    const type = String(payload.targetType || '').toUpperCase() as ScheduleTargetType;
    if (!['USER', 'BRANCH', 'ROLE'].includes(type)) this.fail(400, this.t('work_schedule.invalid_target'));
    const targetId = type === 'ROLE' ? String(payload.targetId || '').toUpperCase() : String(payload.targetId || '');
    if (!targetId) this.fail(400, this.t('work_schedule.invalid_target'));
    if (type === 'ROLE' && !ROLES.includes(targetId)) this.fail(400, this.t('work_schedule.invalid_target'));
    if (type === 'USER') {
      const u: any[] = await db.$queryRawUnsafe('SELECT `id` FROM `user` WHERE `id` = ? LIMIT 1', targetId);
      if (!u?.[0]) this.fail(404, this.t('work_schedule.user_not_found'));
    }
    if (type === 'BRANCH') {
      const b: any[] = await db.$queryRawUnsafe('SELECT `id` FROM `branch` WHERE `id` = ? LIMIT 1', targetId);
      if (!b?.[0]) this.fail(404, this.t('work_schedule.branch_not_found'));
    }
    if (!payload.scheduleId) {
      await db.$executeRawUnsafe('DELETE FROM `work_schedule_assignments` WHERE `target_type` = ? AND `target_id` = ?', type, targetId);
    } else {
      await this.scheduleView(payload.scheduleId);
      await db.$executeRawUnsafe(
        'INSERT INTO `work_schedule_assignments` (`id`, `schedule_id`, `target_type`, `target_id`, `created_by`, `created_at`) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP()) ' +
          'ON DUPLICATE KEY UPDATE `schedule_id` = VALUES(`schedule_id`), `created_by` = VALUES(`created_by`), `created_at` = UTC_TIMESTAMP()',
        crypto.randomUUID(),
        payload.scheduleId,
        type,
        targetId,
        payload.adminId || null,
      );
    }
    this.invalidate();
    await this.audit(payload.adminId, 'WORK_SCHEDULE_ASSIGN', { targetType: type, targetId, scheduleId: payload.scheduleId ?? null });
    return {
      message: this.t(payload.scheduleId ? 'work_schedule.assigned' : 'work_schedule.unassigned'),
      data: { targetType: type, targetId, scheduleId: payload.scheduleId ?? null },
    };
  }

  // ============================================================
  // DÉROGATIONS
  // ============================================================
  async createException(payload: { dto: any; adminId: string }) {
    const db = this.db();
    const dto = payload.dto || {};
    const type = String(dto.type || 'ALLOW').toUpperCase();
    if (!['ALLOW', 'DENY'].includes(type)) this.fail(400, this.t('work_schedule.invalid_exception_type'));
    const userIds: string[] = Array.isArray(dto.userIds) ? dto.userIds : dto.userId ? [dto.userId] : [];
    if (!userIds.length) this.fail(400, this.t('work_schedule.user_required'));
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime()) || endsAt <= startsAt) this.fail(400, this.t('work_schedule.invalid_period'));
    const maxDays = Number(process.env.WORK_SCHEDULE_EXCEPTION_MAX_DAYS || 31);
    if ((endsAt.getTime() - startsAt.getTime()) / 86400000 > maxDays) this.fail(400, this.t('work_schedule.period_too_long', 'fr', { days: maxDays }));
    const reason = String(dto.reason ?? '').trim();
    if (!reason) this.fail(400, this.t('work_schedule.reason_required'));

    const created: string[] = [];
    for (const userId of userIds.slice(0, 200)) {
      const u: any[] = await db.$queryRawUnsafe('SELECT `id` FROM `user` WHERE `id` = ? LIMIT 1', userId);
      if (!u?.[0]) continue;
      const id = crypto.randomUUID();
      await db.$executeRawUnsafe(
        'INSERT INTO `work_schedule_exceptions` (`id`, `user_id`, `type`, `starts_at`, `ends_at`, `reason`, `created_by`, `created_at`) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
        id,
        userId,
        type,
        startsAt,
        endsAt,
        reason.slice(0, 500),
        payload.adminId || null,
      );
      created.push(id);
      this.invalidate(userId);
    }
    await this.audit(payload.adminId, 'WORK_SCHEDULE_EXCEPTION_CREATE', { type, userIds, startsAt, endsAt, reason });
    return { message: this.t('work_schedule.exception_created', 'fr', { count: created.length }), data: { ids: created } };
  }

  async listExceptions(q: { userId?: string; status?: string; page?: number; limit?: number } = {}) {
    const db = this.db();
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    const parts: string[] = ['1 = 1'];
    const params: any[] = [];
    if (q.userId) {
      parts.push('e.`user_id` = ?');
      params.push(q.userId);
    }
    const now = new Date();
    switch (q.status) {
      case 'active':
        parts.push('e.`revoked_at` IS NULL AND e.`starts_at` <= ? AND e.`ends_at` > ?');
        params.push(now, now);
        break;
      case 'upcoming':
        parts.push('e.`revoked_at` IS NULL AND e.`starts_at` > ?');
        params.push(now);
        break;
      case 'expired':
        parts.push('e.`revoked_at` IS NULL AND e.`ends_at` <= ?');
        params.push(now);
        break;
      case 'revoked':
        parts.push('e.`revoked_at` IS NOT NULL');
        break;
    }
    const where = parts.join(' AND ');
    const total = Number((await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`work_schedule_exceptions\` e WHERE ${where}`, ...params))?.[0]?.n ?? 0);
    const rows: any[] = await db.$queryRawUnsafe(
      `SELECT e.*, u.\`full_name\` AS userName, u.\`email\` AS userEmail, c.\`full_name\` AS createdByName FROM \`work_schedule_exceptions\` e ` +
        `LEFT JOIN \`user\` u ON u.\`id\` = e.\`user_id\` LEFT JOIN \`user\` c ON c.\`id\` = e.\`created_by\` ` +
        `WHERE ${where} ORDER BY e.\`starts_at\` DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      ...params,
    );
    const data = rows.map((e) => ({
      id: e.id,
      userId: e.user_id,
      userName: e.userName || e.userEmail,
      type: e.type,
      startsAt: e.starts_at,
      endsAt: e.ends_at,
      reason: e.reason,
      createdBy: e.created_by,
      createdByName: e.createdByName,
      createdAt: e.created_at,
      revokedAt: e.revoked_at,
      status: e.revoked_at ? 'REVOKED' : new Date(e.starts_at) > now ? 'UPCOMING' : new Date(e.ends_at) <= now ? 'EXPIRED' : 'ACTIVE',
    }));
    return { message: this.t('work_schedule.exceptions'), data: { data, total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async revokeException(payload: { id: string; adminId: string }) {
    const db = this.db();
    const rows: any[] = await db.$queryRawUnsafe('SELECT `user_id` FROM `work_schedule_exceptions` WHERE `id` = ? LIMIT 1', payload.id);
    if (!rows?.[0]) this.fail(404, this.t('work_schedule.exception_not_found'));
    await db.$executeRawUnsafe('UPDATE `work_schedule_exceptions` SET `revoked_at` = UTC_TIMESTAMP() WHERE `id` = ? AND `revoked_at` IS NULL', payload.id);
    this.invalidate(rows[0].user_id);
    await this.audit(payload.adminId, 'WORK_SCHEDULE_EXCEPTION_REVOKE', { exceptionId: payload.id });
    return { message: this.t('work_schedule.exception_revoked'), data: { id: payload.id } };
  }

  /** Programme et état d'accès de l'utilisateur connecté (ou d'un utilisateur, pour l'admin) */
  async me(payload: { userId: string; lang?: string }) {
    const lang = payload.lang || 'fr';
    const decision = await this.evaluate(payload.userId, new Date(), false);
    let schedule: any = null;
    if (decision.scheduleId) schedule = await this.scheduleView(decision.scheduleId).catch(() => null);
    if (schedule) delete schedule.assignments;
    return {
      message: this.t('work_schedule.me', lang),
      data: { access: decision, message: decision.allowed ? null : this.denialMessage(decision, lang), schedule },
    };
  }

  // ============================================================
  // DÉCONNEXION AUTOMATIQUE (chaque minute)
  // ============================================================
  /** Ferme toutes les sessions et jetons d'un utilisateur hors horaires */
  async forceLogout(userId: string, decision: AccessDecision, lang = 'fr'): Promise<number> {
    const db = this.db();
    const closed = Number(
      await db.$executeRawUnsafe(
        "UPDATE `sessions` SET `is_valid` = 0, `revoked_reason` = 'OUTSIDE_WORK_HOURS', `revoked_at` = UTC_TIMESTAMP() WHERE `user_id` = ? AND `is_valid` = 1",
        userId,
      ),
    );
    if (String(process.env.WORK_SCHEDULE_REVOKE_OAUTH ?? 'true') !== 'false') {
      // Jetons OAuth de l'utilisateur (refresh d'abord à cause de la clé étrangère)
      await db
        .$executeRawUnsafe('DELETE FROM `oauthrefreshtoken` WHERE `userId` = ?', userId)
        .catch(() => undefined);
      await db.$executeRawUnsafe('DELETE FROM `oauthaccesstoken` WHERE `userId` = ?', userId).catch(() => undefined);
    }
    if (closed > 0) {
      const message = this.t('work_schedule.session_closed', lang);
      this.notify(userId, this.t('work_schedule.session_closed_title', lang), message, {
        action: 'FORCE_LOGOUT',
        reason: 'OUTSIDE_WORK_HOURS',
        nextStartAt: decision.nextStartAt ?? '',
      });
      await this.audit(null, 'WORK_SCHEDULE_FORCE_LOGOUT', { userId, sessions: closed, source: decision.source, scheduleId: decision.scheduleId });
    }
    this.invalidate(userId);
    return closed;
  }

  @Cron('5 * * * * *')
  async enforce(): Promise<void> {
    if (!this.enabled || this.enforcing) return;
    this.enforcing = true;
    try {
      const db = this.db();
      // Seulement les utilisateurs connectés concernés par un programme ou une dérogation DENY
      const rows: any[] = await db.$queryRawUnsafe(
        'SELECT DISTINCT s.`user_id` AS userId FROM `sessions` s INNER JOIN `user` u ON u.`id` = s.`user_id` ' +
          'WHERE s.`is_valid` = 1 AND s.`expires_at` > UTC_TIMESTAMP() AND s.`deleted_at` IS NULL AND (' +
          "  EXISTS (SELECT 1 FROM `work_schedule_assignments` a WHERE a.`target_type` = 'USER' AND a.`target_id` = u.`id`)" +
          " OR (u.`branchId` IS NOT NULL AND EXISTS (SELECT 1 FROM `work_schedule_assignments` a WHERE a.`target_type` = 'BRANCH' AND a.`target_id` = u.`branchId`))" +
          " OR EXISTS (SELECT 1 FROM `work_schedule_assignments` a WHERE a.`target_type` = 'ROLE' AND a.`target_id` = u.`role`)" +
          " OR EXISTS (SELECT 1 FROM `work_schedule_exceptions` e WHERE e.`user_id` = u.`id` AND e.`type` = 'DENY' AND e.`revoked_at` IS NULL AND e.`starts_at` <= UTC_TIMESTAMP() AND e.`ends_at` > UTC_TIMESTAMP())" +
          ') LIMIT 5000',
      );
      const now = new Date();
      let closed = 0;
      for (const r of rows) {
        const d = await this.evaluate(r.userId, now, false);
        if (!d.allowed) {
          closed += await this.forceLogout(r.userId, d);
          continue;
        }
        // Avertissement avant la fin
        if (d.endsAt && d.warnMinutes > 0 && d.minutesLeft !== null && d.minutesLeft <= d.warnMinutes) {
          const key = `${r.userId}|${d.endsAt}`;
          if (!this.warned.has(key)) {
            this.warned.add(key);
            this.notify(r.userId, this.t('work_schedule.ending_soon_title'), this.t('work_schedule.ending_soon', 'fr', { minutes: d.minutesLeft }), {
              action: 'WORK_HOURS_ENDING',
              endsAt: d.endsAt,
            });
          }
        }
      }
      if (this.warned.size > 20000) this.warned.clear();
      if (closed) this.logger.log(`⏰ Fin d'horaire : ${closed} session(s) fermée(s)`);
    } catch (e: any) {
      if (this.isMissingTable(e)) {
        if (!this.tableMissingLogged) this.logger.warn('Tables work_schedule* absentes : déconnexion automatique désactivée');
        this.tableMissingLogged = true;
      } else {
        this.logger.error(`Contrôle des horaires : ${e?.message}`);
      }
    } finally {
      this.enforcing = false;
    }
  }

  // ============================================================
  // OUTILS
  // ============================================================
  private notify(userId: string, title: string, body: string, data: Record<string, string>) {
    try {
      if (!this.notificationClient) {
        this.notificationClient = ClientProxyFactory.create({
          transport: Transport.RMQ,
          options: {
            urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
            queue: process.env.NOTIFICATION_QUEUE || 'notification_queue',
            queueOptions: { durable: false },
          },
        });
      }
      this.notificationClient.emit('send_notification', { userId, title, body, type: 'security', data }).subscribe({ error: () => undefined });
    } catch {
      /* notification facultative */
    }
  }

  private async audit(userId: string | null, action: string, details: any) {
    try {
      await this.db().$executeRawUnsafe(
        'INSERT INTO `audit_log` (`id`, `userId`, `action`, `details`, `ipAddress`, `createdAt`) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())',
        crypto.randomUUID(),
        userId,
        action,
        JSON.stringify(details ?? {}),
        'system',
      );
    } catch {
      /* audit facultatif */
    }
  }
}
