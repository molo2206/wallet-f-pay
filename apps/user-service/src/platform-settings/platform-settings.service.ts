// apps/user-service/src/platform-settings/platform-settings.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { requiredAccountCurrencies } from '@app/common';

/**
 * ✅ PARAMÈTRES DE LA PLATEFORME, POLITIQUES DE SÉCURITÉ, PLAFONDS PAR UTILISATEUR
 *
 *  Ces messages (get/update_general_settings, get/update_security_policies, get/update_user_transaction_limit)
 *  étaient destinés au « settings-service », qui n'est déclaré ni dans nest-cli.json ni dans PM2 : il n'était
 *  jamais compilé ni démarré → les écrans répondaient en erreur 500 / 504.
 *  Ils sont désormais traités par le user-service (déjà en service), sur la file user_queue.
 *  Chaque champ est contrôlé (liste blanche + type) : une donnée inattendue ne provoque plus d'erreur serveur.
 */
@Injectable()
export class PlatformSettingsService {
  private readonly logger = new Logger(PlatformSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private get db(): any {
    return this.prisma as any;
  }

  private fail(statusCode: number, message: string): never {
    throw new RpcException({ status: 'error', statusCode, message });
  }

  // ---------- conversions sûres ----------
  private str(v: any, max: number): string | null {
    if (v === undefined) return undefined as any;
    if (v === null) return null;
    return String(v).trim().slice(0, max);
  }

  private bool(v: any): boolean | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v === 'boolean') return v;
    return ['true', '1', 'on', 'oui', 'yes'].includes(String(v).toLowerCase());
  }

  private int(v: any, min: number, max: number, field: string): number | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || Math.round(n) !== n || n < min || n > max) this.fail(400, `${field} : nombre entier entre ${min} et ${max} attendu`);
    return n;
  }

  private num(v: any, min: number, field: string): number | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) this.fail(400, `${field} : nombre ≥ ${min} attendu`);
    return Math.round(n * 1000) / 1000;
  }

  private clean(o: Record<string, any>) {
    return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  }

  // ============================================================
  // PARAMÈTRES GÉNÉRAUX
  // ============================================================
  private async generalRow(): Promise<any> {
    let row = await this.prisma.general_settings.findFirst({ orderBy: { created_at: 'asc' } });
    if (!row) {
      row = await this.prisma.general_settings.create({
        data: {
          id: '1',
          platform_name: 'F-Pay',
          timezone: 'Africa/Lubumbashi',
          date_format: 'DD/MM/YYYY',
          time_format: '24h',
          maintenance_mode: false,
        },
      });
    }
    return row;
  }

  async getGeneral() {
    return this.generalRow();
  }

  async updateGeneral(dto: any) {
    const d = dto || {};
    if (d.timezone !== undefined && d.timezone !== null) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: String(d.timezone) });
      } catch {
        this.fail(400, `Fuseau horaire invalide : ${d.timezone} (ex. Africa/Lubumbashi)`);
      }
    }
    if (d.time_format !== undefined && !['12h', '24h'].includes(String(d.time_format))) this.fail(400, 'Format horaire : 12h ou 24h');
    for (const k of ['contact_email', 'support_email']) {
      if (d[k] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(d[k]))) this.fail(400, `${k} : adresse e-mail invalide`);
    }
    const data = this.clean({
      platform_name: this.str(d.platform_name, 255),
      platform_logo: this.str(d.platform_logo, 65000),
      platform_favicon: this.str(d.platform_favicon, 65000),
      contact_email: this.str(d.contact_email, 255),
      contact_phone: this.str(d.contact_phone, 50),
      support_email: this.str(d.support_email, 255),
      address: this.str(d.address, 65000),
      timezone: this.str(d.timezone, 100),
      date_format: this.str(d.date_format, 50),
      time_format: this.str(d.time_format, 10),
      maintenance_mode: this.bool(d.maintenance_mode),
      maintenance_message: this.str(d.maintenance_message, 65000),
    });
    const row = await this.generalRow();
    const updated = await this.prisma.general_settings.update({ where: { id: row.id }, data: { ...data, updated_at: new Date() } });
    this.logger.log(`Paramètres généraux mis à jour : ${Object.keys(data).join(', ') || 'aucun champ'}`);
    return updated;
  }

  // ============================================================
  // POLITIQUES DE SÉCURITÉ
  // ============================================================
  private async securityRow(): Promise<any> {
    let row = await this.prisma.security_policies.findFirst({ orderBy: { created_at: 'asc' } });
    if (!row) {
      row = await this.prisma.security_policies.create({
        data: {
          id: '1',
          password_min_length: 8,
          password_require_uppercase: true,
          password_require_lowercase: true,
          password_require_numbers: true,
          password_require_special: true,
          password_expiry_days: 90,
          password_history_count: 5,
          session_timeout_minutes: 30,
          max_concurrent_sessions: 3,
          remember_me_duration_days: 30,
          max_login_attempts: 5,
          lockout_duration_minutes: 30,
          require_captcha_after_attempts: 3,
          enforce_2fa: true,
          enforce_2fa_for_admins: true,
          allowed_2fa_methods: 'sms,email',
          enable_ip_whitelist: false,
          enable_ip_blacklist: true,
        },
      });
    }
    return row;
  }

  private viewSecurity(row: any) {
    return {
      ...row,
      allowed_2fa_methods: String(row?.allowed_2fa_methods || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    };
  }

  async getSecurity() {
    return this.viewSecurity(await this.securityRow());
  }

  async updateSecurity(dto: any) {
    const d = dto || {};
    let methods: string | undefined;
    if (d.allowed_2fa_methods !== undefined && d.allowed_2fa_methods !== null) {
      const list = (Array.isArray(d.allowed_2fa_methods) ? d.allowed_2fa_methods : String(d.allowed_2fa_methods).split(','))
        .map((x: any) => String(x).trim().toLowerCase())
        .filter(Boolean);
      const bad = list.filter((m: string) => !['sms', 'email', 'totp', 'app', 'whatsapp'].includes(m));
      if (bad.length) this.fail(400, `Méthodes 2FA inconnues : ${bad.join(', ')} (sms, email, totp, app, whatsapp)`);
      methods = [...new Set(list)].join(',');
    }
    const data = this.clean({
      password_min_length: this.int(d.password_min_length, 4, 128, 'Longueur minimale du mot de passe'),
      password_require_uppercase: this.bool(d.password_require_uppercase),
      password_require_lowercase: this.bool(d.password_require_lowercase),
      password_require_numbers: this.bool(d.password_require_numbers),
      password_require_special: this.bool(d.password_require_special),
      password_expiry_days: this.int(d.password_expiry_days, 0, 3650, 'Expiration du mot de passe (jours)'),
      password_history_count: this.int(d.password_history_count, 0, 50, 'Historique des mots de passe'),
      session_timeout_minutes: this.int(d.session_timeout_minutes, 1, 43200, 'Expiration de session (minutes)'),
      max_concurrent_sessions: this.int(d.max_concurrent_sessions, 1, 100, 'Sessions simultanées'),
      remember_me_duration_days: this.int(d.remember_me_duration_days, 0, 365, 'Durée « se souvenir de moi » (jours)'),
      max_login_attempts: this.int(d.max_login_attempts, 1, 100, 'Tentatives de connexion'),
      lockout_duration_minutes: this.int(d.lockout_duration_minutes, 1, 43200, 'Durée de blocage (minutes)'),
      require_captcha_after_attempts: this.int(d.require_captcha_after_attempts, 0, 100, 'Captcha après tentatives'),
      enforce_2fa: this.bool(d.enforce_2fa),
      enforce_2fa_for_admins: this.bool(d.enforce_2fa_for_admins),
      allowed_2fa_methods: methods,
      enable_ip_whitelist: this.bool(d.enable_ip_whitelist),
      enable_ip_blacklist: this.bool(d.enable_ip_blacklist),
    });
    const row = await this.securityRow();
    const updated = await this.prisma.security_policies.update({ where: { id: row.id }, data: { ...data, updated_at: new Date() } });
    this.logger.log(`Politiques de sécurité mises à jour : ${Object.keys(data).join(', ') || 'aucun champ'}`);
    return this.viewSecurity(updated);
  }

  // ============================================================
  // PLAFONDS D'UN UTILISATEUR
  // ============================================================
  async getUserLimit(userId: string) {
    if (!userId) this.fail(400, 'userId requis');
    const user = await this.prisma.user.findFirst({ where: { id: userId }, select: { id: true } });
    if (!user) this.fail(404, 'Utilisateur introuvable');
    const row = await this.prisma.user_transaction_limit.findFirst({ where: { user_id: userId } });
    // Pas de création automatique : l'absence de ligne = plafonds du niveau KYC
    return (
      row ?? {
        id: null,
        user_id: userId,
        daily_limit: null,
        monthly_limit: null,
        yearly_limit: null,
        per_transaction_limit: null,
        monthly_transaction_count: null,
        isDefault: true,
      }
    );
  }

  async updateUserLimit(userId: string, dto: any) {
    if (!userId) this.fail(400, 'userId requis');
    const user = await this.prisma.user.findFirst({ where: { id: userId }, select: { id: true } });
    if (!user) this.fail(404, 'Utilisateur introuvable');
    const d = dto || {};
    const data = this.clean({
      daily_limit: this.num(d.daily_limit, 0, 'Plafond journalier'),
      monthly_limit: this.num(d.monthly_limit, 0, 'Plafond mensuel'),
      yearly_limit: this.num(d.yearly_limit, 0, 'Plafond annuel'),
      per_transaction_limit: this.num(d.per_transaction_limit, 0, 'Plafond par opération'),
      monthly_transaction_count: this.int(d.monthly_transaction_count, 0, 1000000, "Nombre d'opérations par mois"),
    });
    const existing = await this.prisma.user_transaction_limit.findFirst({ where: { user_id: userId } });
    if (existing) {
      return this.prisma.user_transaction_limit.update({ where: { id: existing.id }, data: { ...data, updated_at: new Date() } });
    }
    return this.prisma.user_transaction_limit.create({ data: { id: crypto.randomUUID(), user_id: userId, ...data } });
  }

  // ============================================================
  // DEVISES DE CHAQUE COMPTE (rattrapage des comptes existants)
  // ============================================================
  /**
   * Crée les wallets manquants pour que chaque compte fonctionne dans toutes les devises
   * (ACCOUNT_CURRENCIES + devises de son pays) : clients, marchands, caisses d'agence, wallet des frais.
   * Les administrateurs sans caisse sont ignorés sauf includeAdmins. Aucun wallet existant n'est modifié.
   * dryRun = true : compte seulement ce qui serait créé.
   */
  async ensureAccountCurrencies(params: { adminId: string; dryRun?: boolean; includeAdmins?: boolean; userId?: string; batch?: number }) {
    const db = this.db;
    const batch = Math.min(5000, Math.max(100, Number(params.batch) || 2000));
    // Devises par pays (opérateurs Mobile Money + devise par défaut)
    const countryRows: any[] = await db.$queryRawUnsafe(
      'SELECT c.`countryCode`, c.`default_currency`, n.`currency` AS networkCurrencies FROM `country_provider` c LEFT JOIN `network_provider` n ON n.`countryId` = c.`id`',
    );
    const byCountry = new Map<string, Set<string>>();
    for (const r of countryRows) {
      const k = String(r.countryCode || '').toUpperCase();
      if (!k) continue;
      const set = byCountry.get(k) ?? new Set<string>();
      if (r.default_currency) set.add(String(r.default_currency).toUpperCase());
      for (const c of String(r.networkCurrencies || '').split(',')) if (c.trim()) set.add(c.trim().toUpperCase());
      byCountry.set(k, set);
    }

    const stats = { checkedAccounts: 0, accountsUpdated: 0, walletsCreated: 0, byCurrency: {} as Record<string, number>, skippedAdmins: 0 };
    let lastId = '';
    for (let guard = 0; guard < 1000; guard++) {
      const users: any[] = await db.$queryRawUnsafe(
        'SELECT u.`id`, u.`email`, u.`role`, u.`branchId`, u.`countryCode`, ' +
          '(SELECT GROUP_CONCAT(w.`currency`) FROM `wallet` w WHERE w.`userId` = u.`id`) AS currencies, ' +
          '(SELECT COUNT(*) FROM `wallet` w WHERE w.`userId` = u.`id` AND w.`isDefault` = 1) AS hasDefault ' +
          'FROM `user` u WHERE (u.`deleted` = 0 OR u.`deleted` IS NULL) AND u.`id` > ?' +
          (params.userId ? ' AND u.`id` = ?' : '') +
          ' ORDER BY u.`id` LIMIT ' +
          batch,
        lastId,
        ...(params.userId ? [params.userId] : []),
      );
      if (!users.length) break;
      for (const u of users) {
        lastId = u.id;
        stats.checkedAccounts++;
        const email = String(u.email || '').toLowerCase();
        const isSystem = u.id === 'system-fee-account' || email === 'system@fpay.com';
        const isBranchCash = email.startsWith('caisse.') && !!u.branchId;
        const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(String(u.role)) && !isBranchCash && !isSystem;
        if (isAdmin && !params.includeAdmins) {
          stats.skippedAdmins++;
          continue;
        }
        const have = new Set(String(u.currencies || '').split(',').filter(Boolean).map((c) => c.toUpperCase()));
        const wanted = requiredAccountCurrencies([...(byCountry.get(String(u.countryCode || '').toUpperCase()) ?? [])]);
        const missing = wanted.filter((c) => !have.has(c));
        if (!missing.length) continue;
        stats.accountsUpdated++;
        for (const cur of missing) {
          stats.walletsCreated++;
          stats.byCurrency[cur] = (stats.byCurrency[cur] || 0) + 1;
          if (params.dryRun) continue;
          const cashCode = isBranchCash ? `CASH-${String(u.branchId).slice(0, 8)}-${cur}-${Date.now()}` : `CASH${Math.floor(10000000 + Math.random() * 90000000)}`;
          // Sans doublon même en cas d'appel simultané : n'insère que si la devise manque toujours
          await db.$executeRawUnsafe(
            'INSERT INTO `wallet` (`id`, `userId`, `balance`, `currency`, `isActive`, `createdAt`, `updatedAt`, `isDefault`, `cashCode`, `branchId`, `isBranchWallet`) ' +
              'SELECT ?, ?, 0, ?, 1, NOW(), NOW(), ?, ?, ?, ? FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `wallet` WHERE `userId` = ? AND `currency` = ?)',
            crypto.randomUUID(),
            u.id,
            cur,
            !isBranchCash && !isSystem && Number(u.hasDefault) === 0 && have.size === 0 && cur === wanted[0] ? 1 : 0,
            cashCode,
            isBranchCash ? u.branchId : null,
            isBranchCash ? 1 : 0,
            u.id,
            cur,
          );
          have.add(cur);
        }
      }
      if (users.length < batch || params.userId) break;
    }
    if (!params.dryRun) {
      await db
        .$executeRawUnsafe(
          'INSERT INTO `audit_log` (`id`, `userId`, `action`, `details`, `ipAddress`, `createdAt`) VALUES (?, ?, ?, ?, ?, NOW())',
          crypto.randomUUID(),
          params.adminId,
          'ACCOUNT_CURRENCIES_ENSURED',
          JSON.stringify(stats),
          null,
        )
        .catch(() => undefined);
    }
    return {
      message: params.dryRun
        ? `${stats.walletsCreated} wallet(s) seraient créés pour ${stats.accountsUpdated} compte(s)`
        : `${stats.walletsCreated} wallet(s) créés : ${stats.accountsUpdated} compte(s) fonctionnent maintenant dans toutes les devises`,
      data: { ...stats, dryRun: !!params.dryRun },
    };
  }
}
