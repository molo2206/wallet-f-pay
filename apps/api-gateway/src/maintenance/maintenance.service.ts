// apps/api-gateway/src/maintenance/maintenance.service.ts
import { HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import * as crypto from 'crypto';
import { PrismaService } from 'apps/user-service/src/prisma/prisma.service';
import { createRmqClient } from '../work-schedules/rpc-client.util';
import { MAINTENANCE_MODULES, MaintenanceScope, MaintenanceWindow, isActive, pickMessage } from './maintenance.util';

const SCOPES: MaintenanceScope[] = ['FULL', 'READ_ONLY', 'MODULES'];

const DEFAULT_MESSAGES: Record<string, Record<string, string>> = {
  fr: {
    FULL: 'F-Pay est en maintenance pour améliorer nos services. Merci de réessayer plus tard.',
    READ_ONLY: 'Maintenance en cours : vous pouvez consulter vos soldes et votre historique, mais les opérations sont momentanément suspendues.',
    MODULES: 'Ce service est momentanément en maintenance. Les autres fonctionnalités restent disponibles.',
    until: 'Retour prévu : {{until}}.',
    upcoming: 'Maintenance prévue le {{start}}{{until}}.',
  },
  en: {
    FULL: 'F-Pay is under maintenance to improve our services. Please try again later.',
    READ_ONLY: 'Maintenance in progress: you can view your balances and history, but operations are temporarily suspended.',
    MODULES: 'This service is temporarily under maintenance. Other features remain available.',
    until: 'Expected back: {{until}}.',
    upcoming: 'Scheduled maintenance on {{start}}{{until}}.',
  },
  sw: {
    FULL: 'F-Pay iko katika matengenezo ili kuboresha huduma zetu. Tafadhali jaribu tena baadaye.',
    READ_ONLY: 'Matengenezo yanaendelea: unaweza kuona salio na historia yako, lakini miamala imesitishwa kwa muda.',
    MODULES: 'Huduma hii iko katika matengenezo kwa muda. Huduma nyingine zinaendelea kupatikana.',
    until: 'Tunatarajia kurudi: {{until}}.',
    upcoming: 'Matengenezo yamepangwa {{start}}{{until}}.',
  },
};

/**
 * ✅ MODE MAINTENANCE PROFESSIONNEL (appliqué par l'api-gateway, point d'entrée unique)
 *
 *  Fenêtres de maintenance (table maintenance_windows) :
 *   - planifiées (début / fin) ou immédiates, fin prévue ou « jusqu'à nouvel ordre » ;
 *   - périmètre : FULL (tout), READ_ONLY (consultation seule), MODULES (dépôts, retraits, transferts…) ;
 *   - exemptions : rôles (SUPER_ADMIN / ADMIN par défaut), comptes précis, adresses IP (équipe technique) ;
 *   - messages par langue (fr / en / sw), affichés aux applications via GET /maintenance/status
 *     et dans chaque réponse 503 (code MAINTENANCE, en-tête Retry-After) ;
 *   - notifications push facultatives : X minutes avant, au début et à la fin ;
 *   - historique complet (qui a créé / démarré / terminé, quand, pourquoi) + journal d'audit.
 *  Compatibilité : l'ancien interrupteur app_settings.maintenance_mode reste pris en compte (maintenance FULL)
 *  et il est synchronisé automatiquement, pour les applications qui le lisent déjà.
 */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceService.name);
  private readonly notifications: ClientProxy = createRmqClient('NOTIFICATION_QUEUE', 'notification_queue');
  private cache: { windows: MaintenanceWindow[]; at: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private tableMissingLogged = false;
  private tz: { value: string; at: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  private get db(): any {
    return this.prisma as any;
  }

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 30 * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private http(status: number, message: string, code?: string): never {
    throw new HttpException({ statusCode: status, message, ...(code ? { code } : {}) }, status);
  }

  private isMissing(e: any) {
    return /doesn't exist|1146|ER_NO_SUCH_TABLE/i.test(String(e?.message || ''));
  }

  private json<T>(v: any, def: T): T {
    if (v === null || v === undefined || v === '') return def;
    if (typeof v === 'object') return v as T;
    try {
      return JSON.parse(String(v)) as T;
    } catch {
      return def;
    }
  }

  private toWindow(r: any): MaintenanceWindow & Record<string, any> {
    return {
      id: r.id,
      title: r.title,
      messages: this.json<Record<string, string>>(r.messages, {}),
      scope: r.scope,
      modules: this.json<string[]>(r.modules, []),
      startsAt: new Date(r.starts_at),
      endsAt: r.ends_at ? new Date(r.ends_at) : null,
      status: r.status,
      allowRoles: this.json<string[]>(r.allow_roles, ['SUPER_ADMIN', 'ADMIN']),
      allowUserIds: this.json<string[]>(r.allow_user_ids, []),
      allowIps: this.json<string[]>(r.allow_ips, []),
      notifyUsers: !!Number(r.notify_users),
      notifyBeforeMinutes: Number(r.notify_before_minutes) || 0,
      createdBy: r.created_by,
      createdAt: r.created_at,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      endedBy: r.ended_by,
      endReason: r.end_reason,
    };
  }

  private async timezone(): Promise<string> {
    if (this.tz && Date.now() - this.tz.at < 10 * 60 * 1000) return this.tz.value;
    let value = process.env.WORK_SCHEDULE_DEFAULT_TIMEZONE || 'Africa/Lubumbashi';
    try {
      const rows: any[] = await this.db.$queryRawUnsafe('SELECT `timezone` FROM `general_settings` WHERE `timezone` IS NOT NULL LIMIT 1');
      if (rows?.[0]?.timezone) {
        new Intl.DateTimeFormat('en-US', { timeZone: rows[0].timezone });
        value = rows[0].timezone;
      }
    } catch {
      /* défaut */
    }
    this.tz = { value, at: Date.now() };
    return value;
  }

  async formatDate(d: Date | null, lang: string): Promise<string | null> {
    if (!d) return null;
    try {
      return new Intl.DateTimeFormat(lang === 'sw' ? 'sw' : lang === 'en' ? 'en-GB' : 'fr-FR', {
        timeZone: await this.timezone(),
        weekday: 'long',
        day: '2-digit',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(d);
    } catch {
      return d.toISOString();
    }
  }

  // ============================================================
  // LECTURE (avec cache court, utilisée à chaque requête)
  // ============================================================
  invalidate() {
    this.cache = null;
  }

  /** Fenêtres en cours ou à venir (48 h) + interrupteur historique */
  async windows(): Promise<MaintenanceWindow[]> {
    const ttl = Math.max(2, Number(process.env.MAINTENANCE_CACHE_SECONDS) || 10) * 1000;
    if (this.cache && Date.now() - this.cache.at < ttl) return this.cache.windows;
    const list: MaintenanceWindow[] = [];
    try {
      const rows: any[] = await this.db.$queryRawUnsafe(
        "SELECT * FROM `maintenance_windows` WHERE `status` IN ('SCHEDULED', 'ACTIVE') AND (`ends_at` IS NULL OR `ends_at` > UTC_TIMESTAMP()) " +
          'AND `starts_at` <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL 2 DAY) ORDER BY `starts_at` ASC LIMIT 20',
      );
      for (const r of rows) list.push(this.toWindow(r));
    } catch (e: any) {
      if (this.isMissing(e)) {
        if (!this.tableMissingLogged) this.logger.warn('Table maintenance_windows absente : seul l’ancien interrupteur maintenance_mode est pris en compte');
        this.tableMissingLogged = true;
      } else this.logger.warn(`Maintenance : lecture impossible (${e?.message})`);
    }
    // Ancien interrupteur (paramètres de l'application) → maintenance complète
    if (!list.some((w) => isActive(w))) {
      try {
        const s: any[] = await this.db.$queryRawUnsafe('SELECT `maintenance_mode`, `maintenance_message` FROM `app_settings` LIMIT 1');
        if (s?.[0] && Number(s[0].maintenance_mode) === 1) {
          list.unshift({
            id: 'legacy',
            title: 'Maintenance',
            messages: s[0].maintenance_message ? { fr: String(s[0].maintenance_message) } : {},
            scope: 'FULL',
            modules: [],
            startsAt: new Date(0),
            endsAt: null,
            status: 'ACTIVE',
            allowRoles: (process.env.MAINTENANCE_EXEMPT_ROLES || 'SUPER_ADMIN,ADMIN').split(',').map((x) => x.trim()),
            allowUserIds: [],
            allowIps: (process.env.MAINTENANCE_ALLOW_IPS || '').split(',').map((x) => x.trim()).filter(Boolean),
            legacy: true,
          });
        }
      } catch {
        /* table absente */
      }
    }
    this.cache = { windows: list, at: Date.now() };
    return list;
  }

  async active(now = new Date()): Promise<MaintenanceWindow | null> {
    const list = (await this.windows()).filter((w) => isActive(w, now));
    // FULL > READ_ONLY > MODULES
    const rank: Record<string, number> = { FULL: 0, READ_ONLY: 1, MODULES: 2 };
    list.sort((a, b) => rank[a.scope] - rank[b.scope]);
    return list[0] ?? null;
  }

  /** Toutes les fenêtres actives (plusieurs fenêtres MODULES peuvent se cumuler) */
  async allActive(now = new Date()): Promise<MaintenanceWindow[]> {
    return (await this.windows()).filter((w) => isActive(w, now));
  }

  async message(w: MaintenanceWindow, lang: string): Promise<string> {
    const l = ['fr', 'en', 'sw'].includes(lang) ? lang : 'fr';
    const custom = pickMessage(w.messages, l);
    const base = custom || DEFAULT_MESSAGES[l][w.scope];
    if (!w.endsAt) return base;
    const until = await this.formatDate(w.endsAt, l);
    return `${base} ${DEFAULT_MESSAGES[l].until.replace('{{until}}', until || '')}`;
  }

  /** Statut public (applications mobiles / web : bannière ou écran de maintenance) */
  async status(lang: string) {
    const l = ['fr', 'en', 'sw'].includes(lang) ? lang : 'fr';
    const now = new Date();
    const actives = await this.allActive(now);
    const upcoming = (await this.windows()).filter((w) => w.startsAt.getTime() > now.getTime()).slice(0, 3);
    const view = async (w: MaintenanceWindow) => ({
      id: w.legacy ? null : w.id,
      title: w.title,
      scope: w.scope,
      modules: w.modules,
      startsAt: w.legacy ? null : w.startsAt,
      endsAt: w.endsAt,
      endsAtLabel: await this.formatDate(w.endsAt, l),
      message: await this.message(w, l),
    });
    const main = await this.active(now);
    return {
      message: main ? 'Maintenance en cours' : 'Service disponible',
      data: {
        maintenance: !!main,
        scope: main?.scope ?? null,
        blockedModules: [...new Set(actives.flatMap((w) => (w.scope === 'MODULES' ? w.modules : [])))],
        current: main ? await view(main) : null,
        active: await Promise.all(actives.map(view)),
        upcoming: await Promise.all(
          upcoming.map(async (w) => ({
            ...(await view(w)),
            startsAtLabel: await this.formatDate(w.startsAt, l),
            message:
              pickMessage(w.messages, l) ||
              DEFAULT_MESSAGES[l].upcoming
                .replace('{{start}}', (await this.formatDate(w.startsAt, l)) || '')
                .replace('{{until}}', w.endsAt ? ` → ${await this.formatDate(w.endsAt, l)}` : ''),
          })),
        ),
        modulesCatalog: MAINTENANCE_MODULES,
        serverTime: now,
      },
    };
  }

  // ============================================================
  // ADMINISTRATION
  // ============================================================
  private validate(dto: any, partial = false) {
    const out: any = {};
    if (!partial || dto.title !== undefined) {
      const title = String(dto.title ?? '').trim();
      if (!title) this.http(400, 'Le titre est obligatoire (ex. « Mise à jour des serveurs »)');
      out.title = title.slice(0, 150);
    }
    if (!partial || dto.scope !== undefined) {
      const scope = String(dto.scope ?? 'FULL').toUpperCase() as MaintenanceScope;
      if (!SCOPES.includes(scope)) this.http(400, `Périmètre invalide : ${SCOPES.join(', ')}`);
      out.scope = scope;
    }
    if (!partial || dto.modules !== undefined) {
      const mods = Array.isArray(dto.modules) ? dto.modules.map((m: any) => String(m).toUpperCase()) : [];
      const bad = mods.filter((m: string) => !(MAINTENANCE_MODULES as readonly string[]).includes(m));
      if (bad.length) this.http(400, `Modules inconnus : ${bad.join(', ')}. Disponibles : ${MAINTENANCE_MODULES.join(', ')}`);
      out.modules = [...new Set(mods)];
    }
    if ((out.scope ?? dto.scope) === 'MODULES' && out.modules !== undefined && !out.modules.length) {
      this.http(400, 'Choisissez au moins un module pour une maintenance partielle');
    }
    if (dto.messages !== undefined) {
      const msgs: Record<string, string> = {};
      for (const [k, v] of Object.entries(dto.messages || {})) {
        if (['fr', 'en', 'sw', 'es', 'ar'].includes(k) && String(v ?? '').trim()) msgs[k] = String(v).trim().slice(0, 1000);
      }
      out.messages = msgs;
    }
    if (dto.startsAt !== undefined) {
      const d = new Date(dto.startsAt);
      if (isNaN(d.getTime())) this.http(400, 'Date de début invalide');
      out.startsAt = d;
    }
    if (dto.endsAt !== undefined) {
      if (dto.endsAt === null || dto.endsAt === '') out.endsAt = null;
      else {
        const d = new Date(dto.endsAt);
        if (isNaN(d.getTime())) this.http(400, 'Date de fin invalide');
        out.endsAt = d;
      }
    }
    if (dto.durationMinutes !== undefined && dto.endsAt === undefined) {
      const m = Number(dto.durationMinutes);
      if (!Number.isFinite(m) || m <= 0 || m > 7 * 1440) this.http(400, 'Durée invalide (1 minute à 7 jours)');
      out.durationMinutes = m;
    }
    for (const k of ['allowRoles', 'allowUserIds', 'allowIps']) {
      if (dto[k] !== undefined) out[k] = Array.isArray(dto[k]) ? dto[k].map((x: any) => String(x).trim()).filter(Boolean).slice(0, 200) : [];
    }
    if (out.allowRoles) out.allowRoles = out.allowRoles.map((r: string) => r.toUpperCase());
    if (dto.notifyUsers !== undefined) out.notifyUsers = !!dto.notifyUsers;
    if (dto.notifyBeforeMinutes !== undefined) out.notifyBeforeMinutes = Math.min(1440, Math.max(0, Math.round(Number(dto.notifyBeforeMinutes) || 0)));
    return out;
  }

  private async audit(userId: string | null, action: string, details: any) {
    await this.db
      .$executeRawUnsafe(
        'INSERT INTO `audit_log` (`id`, `userId`, `action`, `details`, `ipAddress`, `createdAt`) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())',
        crypto.randomUUID(),
        userId,
        action,
        JSON.stringify(details ?? {}),
        null,
      )
      .catch(() => undefined);
  }

  async list(q: any) {
    const page = Math.max(1, Number(q?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q?.limit) || 20));
    const params: any[] = [];
    let where = '1 = 1';
    if (q?.status) {
      where += ' AND w.`status` = ?';
      params.push(String(q.status).toUpperCase());
    }
    const total = Number((await this.db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`maintenance_windows\` w WHERE ${where}`, ...params))?.[0]?.n ?? 0);
    const rows: any[] = await this.db.$queryRawUnsafe(
      'SELECT w.*, c.`full_name` AS createdByName, e.`full_name` AS endedByName FROM `maintenance_windows` w ' +
        'LEFT JOIN `user` c ON c.`id` = w.`created_by` LEFT JOIN `user` e ON e.`id` = w.`ended_by` ' +
        `WHERE ${where} ORDER BY FIELD(w.\`status\`, 'ACTIVE', 'SCHEDULED') DESC, w.\`starts_at\` DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      ...params,
    );
    const now = new Date();
    return {
      message: 'Fenêtres de maintenance',
      data: {
        data: rows.map((r) => {
          const w = this.toWindow(r);
          return { ...w, createdByName: r.createdByName, endedByName: r.endedByName, running: isActive(w, now) };
        }),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async get(id: string) {
    const rows: any[] = await this.db.$queryRawUnsafe('SELECT * FROM `maintenance_windows` WHERE `id` = ? LIMIT 1', id);
    if (!rows?.[0]) this.http(404, 'Fenêtre de maintenance introuvable');
    return this.toWindow(rows[0]);
  }

  /** Création : startsAt absent = immédiate ; endsAt ou durationMinutes absents = jusqu'à nouvel ordre */
  async create(dto: any, admin: any) {
    const v = this.validate(dto || {});
    const startsAt: Date = v.startsAt ?? new Date();
    const endsAt: Date | null = v.endsAt !== undefined ? v.endsAt : v.durationMinutes ? new Date(startsAt.getTime() + v.durationMinutes * 60000) : null;
    if (endsAt && endsAt <= startsAt) this.http(400, 'La fin doit être après le début');
    if (endsAt && endsAt <= new Date()) this.http(400, 'Cette fenêtre est déjà terminée');
    const immediate = startsAt.getTime() <= Date.now() + 5000;
    const id = crypto.randomUUID();
    try {
      await this.db.$executeRawUnsafe(
        'INSERT INTO `maintenance_windows` (`id`, `title`, `messages`, `scope`, `modules`, `starts_at`, `ends_at`, `status`, `allow_roles`, `allow_user_ids`, `allow_ips`, ' +
          '`notify_users`, `notify_before_minutes`, `created_by`, `created_at`, `updated_at`, `started_at`) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?)',
        id,
        v.title,
        JSON.stringify(v.messages ?? {}),
        v.scope,
        JSON.stringify(v.scope === 'MODULES' ? v.modules : []),
        startsAt,
        endsAt,
        immediate ? 'ACTIVE' : 'SCHEDULED',
        JSON.stringify(v.allowRoles ?? (process.env.MAINTENANCE_EXEMPT_ROLES || 'SUPER_ADMIN,ADMIN').split(',').map((x) => x.trim().toUpperCase())),
        JSON.stringify(v.allowUserIds ?? []),
        JSON.stringify(v.allowIps ?? (process.env.MAINTENANCE_ALLOW_IPS || '').split(',').map((x) => x.trim()).filter(Boolean)),
        v.notifyUsers ? 1 : 0,
        v.notifyBeforeMinutes ?? 30,
        admin.id,
        immediate ? new Date() : null,
      );
    } catch (e: any) {
      if (this.isMissing(e)) this.http(503, "Le mode maintenance avancé n'est pas encore installé (exécutez le SQL maintenance_windows).");
      throw e;
    }
    this.invalidate();
    await this.audit(admin.id, immediate ? 'MAINTENANCE_STARTED' : 'MAINTENANCE_SCHEDULED', { id, ...v, startsAt, endsAt });
    await this.syncLegacyFlag();
    if (immediate) void this.tick();
    return { message: immediate ? 'Maintenance démarrée' : 'Maintenance planifiée', data: await this.get(id) };
  }

  async update(id: string, dto: any, admin: any) {
    const cur = await this.get(id);
    if (['ENDED', 'CANCELLED'].includes(cur.status)) this.http(409, 'Cette fenêtre est terminée : créez-en une nouvelle');
    const v = this.validate(dto || {}, true);
    const startsAt: Date = v.startsAt ?? cur.startsAt;
    let endsAt: Date | null = v.endsAt !== undefined ? v.endsAt : cur.endsAt;
    if (v.durationMinutes) endsAt = new Date(Math.max(Date.now(), startsAt.getTime()) + v.durationMinutes * 60000);
    if (endsAt && endsAt <= startsAt) this.http(400, 'La fin doit être après le début');
    const scope = v.scope ?? cur.scope;
    const modules = v.modules ?? cur.modules;
    if (scope === 'MODULES' && !modules.length) this.http(400, 'Choisissez au moins un module pour une maintenance partielle');
    await this.db.$executeRawUnsafe(
      'UPDATE `maintenance_windows` SET `title` = ?, `messages` = ?, `scope` = ?, `modules` = ?, `starts_at` = ?, `ends_at` = ?, `allow_roles` = ?, `allow_user_ids` = ?, ' +
        '`allow_ips` = ?, `notify_users` = ?, `notify_before_minutes` = ?, `updated_at` = UTC_TIMESTAMP() WHERE `id` = ?',
      v.title ?? cur.title,
      JSON.stringify(v.messages ?? cur.messages),
      scope,
      JSON.stringify(scope === 'MODULES' ? modules : []),
      startsAt,
      endsAt,
      JSON.stringify(v.allowRoles ?? cur.allowRoles),
      JSON.stringify(v.allowUserIds ?? cur.allowUserIds),
      JSON.stringify(v.allowIps ?? cur.allowIps),
      (v.notifyUsers ?? (cur as any).notifyUsers) ? 1 : 0,
      v.notifyBeforeMinutes ?? (cur as any).notifyBeforeMinutes,
      id,
    );
    this.invalidate();
    await this.audit(admin.id, 'MAINTENANCE_UPDATED', { id, changes: v });
    void this.tick();
    return { message: 'Fenêtre de maintenance mise à jour', data: await this.get(id) };
  }

  async startNow(id: string, admin: any) {
    const n = Number(
      await this.db.$executeRawUnsafe(
        "UPDATE `maintenance_windows` SET `status` = 'ACTIVE', `starts_at` = UTC_TIMESTAMP(), `started_at` = UTC_TIMESTAMP(), `updated_at` = UTC_TIMESTAMP() " +
          "WHERE `id` = ? AND `status` = 'SCHEDULED'",
        id,
      ),
    );
    if (n !== 1) this.http(409, 'Seule une maintenance planifiée peut être démarrée');
    this.invalidate();
    await this.audit(admin.id, 'MAINTENANCE_STARTED', { id, manual: true });
    await this.syncLegacyFlag();
    void this.tick();
    return { message: 'Maintenance démarrée', data: await this.get(id) };
  }

  /** Prolonge une maintenance en cours de N minutes (à partir de sa fin prévue, ou de maintenant) */
  async extend(id: string, minutes: number, admin: any) {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m <= 0 || m > 2880) this.http(400, 'Prolongation invalide (1 minute à 48 heures)');
    const cur = await this.get(id);
    if (!['ACTIVE', 'SCHEDULED'].includes(cur.status)) this.http(409, 'Cette maintenance est terminée');
    const base = cur.endsAt && cur.endsAt.getTime() > Date.now() ? cur.endsAt : new Date();
    const endsAt = new Date(base.getTime() + m * 60000);
    await this.db.$executeRawUnsafe(
      'UPDATE `maintenance_windows` SET `ends_at` = ?, `notified_end_at` = NULL, `updated_at` = UTC_TIMESTAMP() WHERE `id` = ?',
      endsAt,
      id,
    );
    this.invalidate();
    await this.audit(admin.id, 'MAINTENANCE_EXTENDED', { id, minutes: m, endsAt });
    return { message: `Maintenance prolongée jusqu'au ${await this.formatDate(endsAt, 'fr')}`, data: await this.get(id) };
  }

  async end(id: string, admin: any, reason?: string, cancel = false) {
    if (id === 'legacy') {
      await this.db.$executeRawUnsafe('UPDATE `app_settings` SET `maintenance_mode` = 0, `updatedAt` = UTC_TIMESTAMP()').catch(() => undefined);
      this.invalidate();
      await this.audit(admin.id, 'MAINTENANCE_LEGACY_OFF', {});
      return { message: 'Maintenance (ancien interrupteur) désactivée', data: null };
    }
    const n = Number(
      await this.db.$executeRawUnsafe(
        'UPDATE `maintenance_windows` SET `status` = ?, `ended_at` = UTC_TIMESTAMP(), `ended_by` = ?, `end_reason` = ?, `updated_at` = UTC_TIMESTAMP(), ' +
          "`ends_at` = CASE WHEN `ends_at` IS NULL OR `ends_at` > UTC_TIMESTAMP() THEN UTC_TIMESTAMP() ELSE `ends_at` END WHERE `id` = ? AND `status` IN ('SCHEDULED', 'ACTIVE')",
        cancel ? 'CANCELLED' : 'ENDED',
        admin.id,
        reason ? String(reason).slice(0, 500) : null,
        id,
      ),
    );
    if (n !== 1) this.http(409, 'Cette maintenance est déjà terminée ou annulée');
    this.invalidate();
    await this.audit(admin.id, cancel ? 'MAINTENANCE_CANCELLED' : 'MAINTENANCE_ENDED', { id, reason });
    await this.syncLegacyFlag();
    void this.tick();
    return { message: cancel ? 'Maintenance annulée' : 'Maintenance terminée : service rétabli', data: await this.get(id) };
  }

  /** app_settings.maintenance_mode = 1 tant qu'une maintenance FULL est en cours (applications existantes) */
  private async syncLegacyFlag() {
    if (String(process.env.MAINTENANCE_SYNC_APP_SETTINGS ?? 'true').toLowerCase() === 'false') return;
    try {
      const rows: any[] = await this.db.$queryRawUnsafe(
        "SELECT `id`, `title`, `messages` FROM `maintenance_windows` WHERE `status` = 'ACTIVE' AND `scope` = 'FULL' AND `starts_at` <= UTC_TIMESTAMP() " +
          'AND (`ends_at` IS NULL OR `ends_at` > UTC_TIMESTAMP()) ORDER BY `starts_at` DESC LIMIT 1',
      );
      const w = rows?.[0];
      if (w) {
        const msg = pickMessage(this.json(w.messages, {}), 'fr') || DEFAULT_MESSAGES.fr.FULL;
        await this.db.$executeRawUnsafe('UPDATE `app_settings` SET `maintenance_mode` = 1, `maintenance_message` = ?, `updatedAt` = UTC_TIMESTAMP()', msg);
        // Marqueur : c'est la gestion avancée qui a activé l'interrupteur
        await this.db.$executeRawUnsafe('UPDATE `maintenance_windows` SET `synced_legacy` = 1 WHERE `id` = ?', w.id);
      } else {
        // On ne coupe l'interrupteur que si c'est la gestion avancée qui l'avait activé
        // (un administrateur qui l'a activé à la main dans les paramètres garde la main)
        const marked = Number(await this.db.$executeRawUnsafe('UPDATE `maintenance_windows` SET `synced_legacy` = 0 WHERE `synced_legacy` = 1'));
        if (marked > 0) {
          await this.db.$executeRawUnsafe('UPDATE `app_settings` SET `maintenance_mode` = 0, `updatedAt` = UTC_TIMESTAMP() WHERE `maintenance_mode` = 1');
        }
      }
      this.invalidate();
    } catch {
      /* tables absentes */
    }
  }

  // ============================================================
  // TÂCHE PÉRIODIQUE : transitions de statut + notifications
  // ============================================================
  private ticking = false;

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const db = this.db;
      // Planifiée → active
      const started = Number(
        await db.$executeRawUnsafe(
          "UPDATE `maintenance_windows` SET `status` = 'ACTIVE', `started_at` = COALESCE(`started_at`, UTC_TIMESTAMP()), `updated_at` = UTC_TIMESTAMP() " +
            "WHERE `status` = 'SCHEDULED' AND `starts_at` <= UTC_TIMESTAMP()",
        ),
      );
      // Active → terminée (fin prévue atteinte)
      const ended = Number(
        await db.$executeRawUnsafe(
          "UPDATE `maintenance_windows` SET `status` = 'ENDED', `ended_at` = UTC_TIMESTAMP(), `end_reason` = COALESCE(`end_reason`, 'Fin prévue atteinte'), `updated_at` = UTC_TIMESTAMP() " +
            "WHERE `status` = 'ACTIVE' AND `ends_at` IS NOT NULL AND `ends_at` <= UTC_TIMESTAMP()",
        ),
      );
      if (started || ended) {
        this.invalidate();
        await this.syncLegacyFlag();
        this.logger.log(`🛠️ Maintenance : ${started} démarrée(s), ${ended} terminée(s)`);
      }
      await this.notifications_();
    } catch (e: any) {
      if (!this.isMissing(e)) this.logger.warn(`Maintenance (tâche périodique) : ${e?.message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Notifications push : avant, au début, à la fin (une seule fois chacune, même avec plusieurs gateways) */
  private async notifications_() {
    const db = this.db;
    const rows: any[] = await db.$queryRawUnsafe(
      'SELECT * FROM `maintenance_windows` WHERE `notify_users` = 1 AND (' +
        "(`status` = 'SCHEDULED' AND `notified_before_at` IS NULL AND `notify_before_minutes` > 0 AND `starts_at` <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL `notify_before_minutes` MINUTE)) " +
        "OR (`status` = 'ACTIVE' AND `notified_start_at` IS NULL) " +
        "OR (`status` IN ('ENDED') AND `notified_start_at` IS NOT NULL AND `notified_end_at` IS NULL AND `ended_at` > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR))) LIMIT 5",
    );
    for (const r of rows) {
      const w = this.toWindow(r);
      let column: string;
      let kind: 'BEFORE' | 'START' | 'END';
      if (r.status === 'SCHEDULED') {
        column = 'notified_before_at';
        kind = 'BEFORE';
      } else if (r.status === 'ACTIVE') {
        column = 'notified_start_at';
        kind = 'START';
      } else {
        column = 'notified_end_at';
        kind = 'END';
      }
      const claimed = Number(
        await db.$executeRawUnsafe(`UPDATE \`maintenance_windows\` SET \`${column}\` = UTC_TIMESTAMP() WHERE \`id\` = ? AND \`${column}\` IS NULL`, w.id),
      );
      if (claimed !== 1) continue;
      void this.broadcast(w, kind);
    }
  }

  /** Envoi progressif aux utilisateurs qui ont l'application (jetons d'appareil), par lots */
  private async broadcast(w: MaintenanceWindow, kind: 'BEFORE' | 'START' | 'END') {
    try {
      const users: any[] = await this.db.$queryRawUnsafe(
        'SELECT DISTINCT d.`user_id` AS id FROM `device_tokens` d INNER JOIN `user` u ON u.`id` = d.`user_id` WHERE (u.`deleted` = 0 OR u.`deleted` IS NULL) LIMIT ' +
          Math.min(200000, Math.max(1, Number(process.env.MAINTENANCE_NOTIFY_MAX_USERS) || 50000)),
      );
      const title =
        kind === 'END' ? 'Service rétabli' : kind === 'BEFORE' ? `Maintenance prévue : ${w.title}` : `Maintenance en cours : ${w.title}`;
      const startLabel = await this.formatDate(w.startsAt, 'fr');
      const body =
        kind === 'END'
          ? 'La maintenance est terminée : tous les services F-Pay sont de nouveau disponibles. Merci pour votre patience.'
          : kind === 'BEFORE'
            ? pickMessage(w.messages, 'fr') ||
              DEFAULT_MESSAGES.fr.upcoming.replace('{{start}}', startLabel || '').replace('{{until}}', w.endsAt ? ` → ${await this.formatDate(w.endsAt, 'fr')}` : '')
            : await this.message(w, 'fr');
      const batch = 50;
      for (let i = 0; i < users.length; i += batch) {
        for (const u of users.slice(i, i + batch)) {
          this.notifications
            .emit('send_notification', {
              userId: u.id,
              title,
              body,
              type: 'maintenance',
              data: { action: `MAINTENANCE_${kind}`, maintenanceId: w.id, scope: w.scope, endsAt: w.endsAt ? w.endsAt.toISOString() : '' },
            })
            .subscribe({ error: () => undefined });
        }
        await new Promise((r) => setTimeout(r, 1000)); // ~50 notifications / seconde
      }
      this.logger.log(`📣 Maintenance « ${w.title} » (${kind}) : ${users.length} utilisateur(s) notifié(s)`);
    } catch (e: any) {
      this.logger.warn(`Maintenance : notifications non envoyées (${e?.message})`);
    }
  }
}
