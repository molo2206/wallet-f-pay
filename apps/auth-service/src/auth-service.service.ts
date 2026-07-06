/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/auth-service/src/auth-service.service.ts
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  PrismaClient,
  user_role as PrismaUserRole,
  user_passwordStatus,
  user_status,
  wallet_currency,
} from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { LoginUserDto } from './dto/login-user.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { SmsService } from './sms/sms.service';
import { RegisterUserDto } from './dto/register-user.dto';
import { MailService } from './email/email.service';
import { I18nService } from '@app/common';
import { RpcException } from '@nestjs/microservices';
import * as crypto from 'crypto';
import { BankService } from 'apps/wallet-service/src/bank/bank.service';
import { logFailedLoginAttempt } from './utility/helpers/login-attempt.util';
import { AccountInfo } from './dto/account.dto';

const registerLocks: Map<string, boolean> = new Map();

@Injectable()
export class AuthServiceService {
  private prisma = new PrismaClient();
  private readonly SALT_ROUNDS = 10;
  private loginLocks: Map<string, boolean> = new Map();

  constructor(
    private readonly jwtService: JwtService,
    private readonly smsService: SmsService,
    private readonly mailService: MailService,
    private readonly i18nService: I18nService,
    private readonly bankService: BankService,
  ) { }

  private normalizePhone(phone: string): string {
    return phone.replace(/[^0-9]/g, '');
  }
  private async logAudit(
    userId: string | null,
    action: string,
    details: any,
    ipAddress: string | null,
  ) {
    try {
      await this.prisma.audit_log.create({
        data: {
          id: crypto.randomUUID(), // ✅ AJOUTER CETTE LIGNE
          userId,
          action,
          details: details ? JSON.stringify(details) : null,
          ipAddress,
          createdAt: new Date(),
        },
      });
    } catch (err) {
      console.error('Audit log failed:', err);
    }
  }

  private async logAuditWithDebounce(
    userId: string | null,
    action: string,
    details: any,
    ipAddress: string | null,
    debounceMs: number = 2000,
  ) {
    const lastAudit = await this.prisma.audit_log.findFirst({
      where: {
        userId: userId ?? null,
        action,
        createdAt: { gte: new Date(Date.now() - debounceMs) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (lastAudit) {
      console.log(`[Audit] Ignored duplicate ${action} for user ${userId}`);
      return;
    }
    await this.logAudit(userId, action, details, ipAddress);
  }

  async register(data: RegisterUserDto, ipAddress?: string) {
    const phone = this.normalizePhone(data.phone);
    const lang = data.lang || 'fr';

    console.log('[AuthService] Register received:', {
      phone,
      hasOtpCode: !!data.otpCode,
      email: data.email,
      hasPassword: !!data.password,
    });

    // ✅ Vérifier que le mot de passe est fourni
    if (!data.password || data.password.trim().length < 8) {
      throw new BadRequestException(
        this.i18nService.translate('password_too_short', lang),
      );
    }

    const key = `${data.account_number}-${phone}`;
    if (registerLocks.get(key)) {
      throw new BadRequestException(
        this.i18nService.translate('request_in_progress', lang),
      );
    }
    registerLocks.set(key, true);

    try {
      // Vérifier si l'utilisateur existe déjà
      const existingUser = await this.prisma.user.findFirst({
        where: { phone: data.phone }
      });

      if (existingUser) {
        throw new UnauthorizedException(
          this.i18nService.translate('user_already_exists', lang),
        );
      }

      // Gestion de l'OTP
      const otpProvided = data.otpCode && data.otpCode.trim() !== '';

      if (!otpProvided) {
        // Désactiver les anciens OTP
        await this.prisma.otp.updateMany({
          where: {
            email: phone,
            isUsed: false,
            expiresAt: { gt: new Date() },
          },
          data: { isUsed: true },
        });

        const newOtpCode = Math.floor(100000 + Math.random() * 900000).toString();

        await this.prisma.otp.create({
          data: {
            id: crypto.randomUUID(),
            email: phone,
            otpCode: newOtpCode,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            isUsed: false,
          },
        });

        // Envoyer l'OTP par SMS
        try {
          const smsText = this.i18nService.translate('otp_sms', lang, {
            otpCode: newOtpCode,
          });
          await this.smsService.sendSms(phone, smsText);
        } catch (err) {
          console.error('Erreur SMS OTP:', err);
        }

        // Envoyer l'OTP par email si l'adresse est fournie
        const emailTarget = data.email;
        if (emailTarget) {
          try {
            await this.mailService.sendHtmlEmail(
              emailTarget,
              this.i18nService.translate('email_otp_title', lang),
              'otp-email.html',
              {
                title: this.i18nService.translate('email_otp_title', lang),
                greeting: this.i18nService.translate('email_otp_greeting', lang),
                message: this.i18nService.translate('email_otp_message', lang),
                otpCode: newOtpCode,
                expiry: this.i18nService.translate('email_otp_expiry', lang),
                ignore: this.i18nService.translate('email_otp_ignore', lang),
                thanks: this.i18nService.translate('email_otp_thanks', lang),
                team: this.i18nService.translate('email_otp_team', lang),
                footer: this.i18nService.translate('email_otp_footer', lang),
                sent_to: this.i18nService.translate('email_otp_sent_to', lang),
                copyright: this.i18nService.translate('email_otp_copyright', lang, { year: new Date().getFullYear() }),
                email: emailTarget,
              },
            );
          } catch (err) {
            console.error(`Erreur email OTP à ${emailTarget}:`, err);
          }
        }

        return {
          requiresOtp: true,
          message: this.i18nService.translate('otp_sent', lang),
        };
      }

      // Vérifier l'OTP saisi
      const otpRecord = await this.prisma.otp.findFirst({
        where: {
          email: phone,
          otpCode: data.otpCode,
          isUsed: false,
        },
      });

      if (!otpRecord) {
        throw new BadRequestException(
          this.i18nService.translate('otp_invalid', lang),
        );
      }

      if (!otpRecord.expiresAt || new Date() > otpRecord.expiresAt) {
        throw new BadRequestException(
          this.i18nService.translate('otp_expired', lang),
        );
      }

      // ✅ Utiliser le mot de passe fourni (obligatoire)
      const plainPassword = data.password;
      const hashedPassword = await bcrypt.hash(plainPassword, 10);

      // Créer l'utilisateur
      const user = await this.prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          account_number: data.account_number || null,
          full_name: data.full_name,
          phone: data.phone,
          password: hashedPassword,
          role: 'USER',
          status: 'ACTIVE',
          passwordStatus: user_passwordStatus.DEFAULT,
          fcmToken: data.fcmToken ?? null,
          email: data.email ?? null,
          countryCode: data.countryCode ?? null,
        },
      });

      // ---------- Création directe des wallets via Prisma ----------
      let walletsCreated = 0;
      let currenciesToCreate: string[] = [];

      if (data.countryCode) {
        try {
          const networks = await this.prisma.network_provider.findMany({
            where: {
              country_provider: {
                countryCode: data.countryCode  // ✅ Utiliser 'countryCode' car c'est le nom du champ dans votre schéma
              }
            }
          });
          const currenciesSet = new Set<string>();
          for (const network of networks) {
            if (network.currency && typeof network.currency === 'string') {
              const currencies = network.currency.split(',').map(c => c.trim());
              currencies.forEach(c => currenciesSet.add(c));
            }
          }
          currenciesToCreate = Array.from(currenciesSet);
          if (currenciesToCreate.length === 0) {
            console.warn(` Aucune devise trouvée pour ${data.countryCode}, utilisation de CDF`);
            currenciesToCreate.push('CDF');
          }
        } catch (err) {
          console.error(' Erreur lecture network_provider:', err);
          currenciesToCreate.push('CDF');
        }
      } else {
        console.log(' Aucun countryCode fourni, création d’un wallet par défaut en CDF');
        currenciesToCreate.push('CDF');
      }

      // Création directe via Prisma
      for (const currency of currenciesToCreate) {
        try {
          // Vérifier si un wallet avec cette devise existe déjà
          const existing = await this.prisma.wallet.findFirst({
            where: { userId: user.id, currency: currency as wallet_currency },
          });
          if (!existing) {
            const randomNum = Math.floor(10000000 + Math.random() * 90000000);
            const cashCode = `CASH${randomNum}`;
            await this.prisma.wallet.create({
              data: {
                id: crypto.randomUUID(),
                userId: user.id,
                currency: currency as wallet_currency,
                balance: 0,
                isActive: true,
                cashCode,
              },
            });
            console.log(`✅ Wallet créé pour user ${user.id}, devise ${currency}`);
            walletsCreated++;
          } else {
            console.log(`ℹ️ Wallet ${currency} existe déjà pour user ${user.id}`);
          }
        } catch (err) {
          console.error(`❌ Échec création wallet (${currency}):`, err);
        }
      }

      console.log(`📊 ${walletsCreated} wallet(s) créé(s) pour l’utilisateur ${user.id}`);

      // Marquer l'OTP comme utilisé
      await this.prisma.otp.update({
        where: { id: otpRecord.id },
        data: { isUsed: true },
      });

      // Journal d'audit
      await this.logAudit(
        user.id,
        'REGISTER',
        { identifier: user },
        ipAddress ?? null,
      );

      // Enregistrer le token FCM
      if (data.fcmToken && data.fcmToken.trim()) {
        await this.prisma.device_tokens.upsert({
          where: { token: data.fcmToken },
          update: {
            user_id: user.id,
            platform: data.platform || 'unknown',
            updated_at: new Date(),
          },
          create: {
            id: crypto.randomUUID(),
            user_id: user.id,
            token: data.fcmToken,
            platform: data.platform || 'unknown',
            created_at: new Date(),
            updated_at: new Date(),
          },
        });
      }

      // SMS de bienvenue
      try {
        const welcomeSms = this.i18nService.translate('welcome_sms', lang, {
          full_name: user.full_name,
          account_number: user.account_number,
          phone: phone,
          password: plainPassword,
        });
        await this.smsService.sendSms(phone, welcomeSms);
      } catch (err) {
        console.error('Erreur SMS bienvenue:', err);
      }

      // Email de bienvenue
      if (user.email) {
        try {
          await this.mailService.sendHtmlEmail(
            user.email,
            this.i18nService.translate('email_welcome_title', lang),
            'welcome-email.html',
            {
              title: this.i18nService.translate('email_welcome_title', lang),
              greeting: this.i18nService.translate('email_welcome_greeting', lang, { full_name: user.full_name }),
              message: this.i18nService.translate('email_welcome_message', lang),
              credentials_label: this.i18nService.translate('email_welcome_credentials', lang),
              phone_label: this.i18nService.translate('email_welcome_phone', lang, { phone: user.phone }),
              account_label: this.i18nService.translate('email_welcome_account', lang, { account_number: user.account_number }),
              password_label: this.i18nService.translate('email_welcome_password', lang, { defaultPassword: plainPassword }),
              footer: this.i18nService.translate('email_otp_footer', lang),
              sent_to: this.i18nService.translate('email_otp_sent_to', lang),
              copyright: this.i18nService.translate('email_otp_copyright', lang, { year: new Date().getFullYear() }),
              email: user.email,
            },
          );
        } catch (err) {
          console.error('Erreur email bienvenue:', err);
        }
      }

      // Créer une session
      const sessionToken = crypto.randomUUID();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      await this.prisma.sessions.create({
        data: {
          id: crypto.randomUUID(),
          user_id: user.id,
          token: sessionToken,
          device_info: data.deviceInfo || null,
          ip_address: ipAddress || null,
          last_activity: new Date(),
          expires_at: expiresAt,
          is_valid: true,
          created_at: new Date(),
        },
      });

      // Générer le JWT
      const result = this.generateJwt(
        user,
        sessionToken,
        this.i18nService.translate('register_success', lang),
      );

      // Récupérer les sessions actives
      const sessions = await this.prisma.sessions.findMany({
        where: {
          user_id: user.id,
          is_valid: true,
          expires_at: { gt: new Date() },
        },
        orderBy: { created_at: 'desc' },
      });

      return {
        ...result,
        sessions,
      };
    } finally {
      registerLocks.delete(key);
    }
  }

  async login(
    dto: LoginUserDto & { lang?: string; userAgent?: string },
    ipAddress?: string,
  ): Promise<AuthResponseDto & { wallets?: any[] }> {
    const lang = dto.lang || 'fr';
    const identifier = dto.identifier;

    try {
      const user = await this.prisma.user.findFirst({
        where: {
          OR: [{ phone: identifier }, { email: identifier.toLowerCase() }],
        },
      });

      if (!user) {
        await logFailedLoginAttempt(
          this.prisma,
          null,
          identifier,
          ipAddress,
          dto.userAgent,
        );
        throw new BadRequestException({
          status: 'error',
          message: this.i18nService.translate('user_not_found', lang),
          statusCode: 400,
        });
      }

      if (user.locked_until && user.locked_until > new Date()) {
        const minutesLeft = Math.ceil(
          (user.locked_until.getTime() - Date.now()) / 60000,
        );
        let message = this.i18nService.translate('account_locked', lang);
        message = message.replace('{minutes}', minutesLeft.toString());
        await logFailedLoginAttempt(
          this.prisma,
          user.id,
          identifier,
          ipAddress,
          dto.userAgent,
        );
        throw new RpcException({ status: 'error', message, statusCode: 403 });
      }

      if (user.status !== user_status.ACTIVE) {
        await logFailedLoginAttempt(
          this.prisma,
          user.id,
          identifier,
          ipAddress,
          dto.userAgent,
        );
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('account_inactive', lang),
          statusCode: 400,
        });
      }

      if (!user.password) {
        await logFailedLoginAttempt(
          this.prisma,
          user.id,
          identifier,
          ipAddress,
          dto.userAgent,
        );
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('user_no_password', lang),
          statusCode: 400,
        });
      }

      const isValidPassword = await bcrypt.compare(dto.password, user.password);
      if (!isValidPassword) {
        const newAttempts = (user.failed_login_attempts || 0) + 1;
        let lockedUntil = user.locked_until;
        let newStatus: user_status = user.status;

        if (newAttempts >= 5) {
          // lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
          // newStatus = user_status.BLOCKED;
          lockedUntil = new Date(Date.now() + 1 * 60 * 1000); // 1 minute
          newStatus = user_status.BLOCKED;
        }

        await this.prisma.user.update({
          where: { id: user.id },
          data: {
            failed_login_attempts: newAttempts,
            locked_until: lockedUntil,
            status: newStatus,
          },
        });

        await logFailedLoginAttempt(
          this.prisma,
          user.id,
          identifier,
          ipAddress,
          dto.userAgent,
        );

        throw new BadRequestException({
          status: 'error',
          message: this.i18nService.translate('invalid_password', lang),
          statusCode: 400,
        });
      }

      // Succès
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failed_login_attempts: 0,
          locked_until: null,
          status: user_status.ACTIVE,
        },
      });

      // Récupération des ressources
      const userResources = await this.prisma.user_has_resources.findMany({
        where: { userId: user.id },
        include: { resources: true },
      });
      const resources = userResources.map((ur) => ({
        id: ur.resources.id,
        name: ur.resources.name,
        label: ur.resources.label,
        permissions: {
          canCreate: ur.canCreate,
          canRead: ur.canRead,
          canUpdate: ur.canUpdate,
          canDelete: ur.canDelete,
          canManage: ur.canManage,
        },
        grantedAt: ur.grantedAt,
        expiresAt: ur.expiresAt,
      }));

      // ✅ Récupération des wallets de l'utilisateur
      const wallets = await this.prisma.wallet.findMany({
        where: { userId: user.id, isActive: true },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          currency: true,
          balance: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // Gestion deviceId
      let deviceId = dto.fcmToken;
      if (!deviceId) {
        const fingerprint = `${dto.deviceInfo || ''}|${dto.platform || ''}|${ipAddress || ''}`;
        deviceId = crypto
          .createHash('sha256')
          .update(fingerprint)
          .digest('hex');
      }

      await this.prisma.sessions.deleteMany({
        where: {
          user_id: user.id,
          is_valid: true,
          deviceId,
        },
      });

      const sessionToken = crypto.randomUUID();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      const createdSession = await this.prisma.sessions.create({
        data: {
          id: crypto.randomUUID(),
          user_id: user.id,
          token: sessionToken,
          deviceId,
          device_info: dto.deviceInfo || null,
          ip_address: ipAddress || null,
          last_activity: new Date(),
          expires_at: expiresAt,
          is_valid: true,
          created_at: new Date(),
        },
      });
      const sessionId = createdSession.id;

      if (dto.fcmToken && dto.fcmToken.trim()) {
        await this.prisma.device_tokens.upsert({
          where: { token: dto.fcmToken },
          update: {
            user_id: user.id,
            platform: dto.platform || 'unknown',
            updated_at: new Date(),
          },
          create: {
            id: crypto.randomUUID(),
            user_id: user.id,
            token: dto.fcmToken,
            platform: dto.platform || 'unknown',
            created_at: new Date(),
            updated_at: new Date(),
          },
        });
      }

      const result = this.generateJwt(
        user,
        sessionToken,
        this.i18nService.translate('login_success', lang),
      );

      await this.logAuditWithDebounce(
        user.id,
        'LOGIN',
        { identifier, deviceId },
        ipAddress ?? null,
      );

      // ✅ Retour avec les wallets
      return { ...result, sessionId, resources, wallets };
    } catch (error) {
      if (
        error instanceof RpcException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new RpcException({
        status: 'error',
        message: error.message || 'Login failed',
        statusCode: 500,
      });
    }
  }

  async validateSession(
    userId: string,
    sessionToken: string,
  ): Promise<{ valid: boolean }> {
    const session = await this.prisma.sessions.findFirst({
      where: {
        user_id: userId,
        token: sessionToken,
        is_valid: true,
        expires_at: { gt: new Date() },
      },
    });
    if (!session) return { valid: false };
    await this.prisma.sessions.update({
      where: { id: session.id },
      data: { last_activity: new Date() },
    });
    return { valid: true };
  }

  async revokeSessionByToken(
    userId: string,
    sessionToken: string,
  ): Promise<{ message: string }> {
    console.log(
      `[revokeSessionByToken] userId=${userId}, sessionToken=${sessionToken}`,
    );
    const session = await this.prisma.sessions.findFirst({
      where: {
        user_id: userId,
        token: sessionToken,
        is_valid: true,
      },
    });
    if (!session) {
      return { message: 'Session déjà terminée' };
    }
    await this.prisma.sessions.delete({ where: { id: session.id } });
    console.log(`[revokeSessionByToken] Session supprimée : ${session.id}`);
    return { message: 'Déconnexion réussie' };
  }

  async revokeSessionById(
    userId: string,
    sessionId: string,
    lang: string = 'fr',
  ): Promise<{ message: string }> {
    console.log(`[revokeSessionById] userId=${userId}, sessionId=${sessionId}`);
    let session = await this.prisma.sessions.findFirst({
      where: { id: sessionId, user_id: userId },
    });
    if (!session) {
      session = await this.prisma.sessions.findFirst({
        where: { token: sessionId, user_id: userId },
      });
    }
    if (session) {
      await this.prisma.sessions.delete({ where: { id: session.id } });
    }
    return { message: this.i18nService.translate('logout_success', lang) };
  }

  async verifyOtp(
    email: string,
    code: string,
    lang: string = 'fr',
  ): Promise<{ message: string }> {
    const otpEntry = await this.prisma.otp.findFirst({
      where: {
        email: email,
        otpCode: code,
        isUsed: false,
        expiresAt: { gt: new Date() },
      },
    });
    if (!otpEntry) {
      throw new BadRequestException(
        this.i18nService.translate('otp_invalid', lang),
      );
    }
    return {
      message: this.i18nService.translate('otp_validated', lang),
    };
  }

  async sendResetPasswordOtp(
    identifier: string,
    ipAddress?: string,
    lang: string = 'fr',
  ) {
    const isEmail = identifier.includes('@');
    const cleanIdentifier = identifier.trim();

    let user;
    if (isEmail) {
      user = await this.prisma.user.findFirst({
        where: { email: cleanIdentifier.toLowerCase() },
      });
      if (!user)
        throw new BadRequestException(
          this.i18nService.translate('user_not_found', lang),
        );
      if (!user.email)
        throw new BadRequestException(
          this.i18nService.translate('no_email', lang),
        );
    } else {
      const normalizedPhone = this.normalizePhone(cleanIdentifier);
      user = await this.prisma.user.findFirst({
        where: { phone: normalizedPhone },
      });
      if (!user)
        throw new BadRequestException(
          this.i18nService.translate('user_not_found', lang),
        );
      if (!user.phone)
        throw new BadRequestException(
          this.i18nService.translate('no_phone', lang),
        );
    }

    await this.prisma.otp.updateMany({
      where: { userId: user.id, isUsed: false, expiresAt: { gt: new Date() } },
      data: { isUsed: true },
    });

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    await this.prisma.otp.create({
      data: {
        id: crypto.randomUUID(),  // AJOUTER
        userId: user.id,
        email: isEmail ? user.email : user.phone,
        otpCode,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        isUsed: false,
      },
    });

    if (isEmail) {
      try {
        await this.mailService.sendHtmlEmail(
          user.email,
          this.i18nService.translate('email_otp_title', lang),
          'otp-email.html',
          {
            title: this.i18nService.translate('email_otp_title', lang),
            greeting: this.i18nService.translate('email_otp_greeting', lang),
            message: this.i18nService.translate('email_otp_message', lang),
            otpCode,
            expiry: this.i18nService.translate('email_otp_expiry', lang),
            ignore: this.i18nService.translate('email_otp_ignore', lang),
            thanks: this.i18nService.translate('email_otp_thanks', lang),
            team: this.i18nService.translate('email_otp_team', lang),
            footer: this.i18nService.translate('email_otp_footer', lang),
            sent_to: this.i18nService.translate('email_otp_sent_to', lang),
            copyright: this.i18nService.translate('email_otp_copyright', lang, {
              year: new Date().getFullYear(),
            }),
            email: user.email,
          },
        );
      } catch (err) {
        console.error(`Erreur envoi email OTP à ${user.email}:`, err);
      }
    } else {
      const smsText = this.i18nService.translate('reset_password_sms', lang, {
        otpCode,
      });
      await this.smsService.sendSms(user.phone, smsText);
    }

    await this.logAudit(
      user.id,
      'SEND_RESET_OTP',
      { identifier },
      ipAddress ?? null,
    );
    return { message: this.i18nService.translate('otp_sent', lang) };
  }

  async resetPassword(resetPasswordDto: {
    identifier: string;
    code: string;
    password: string;
    lang?: string;
  }): Promise<{ message: string }> {
    const { identifier, code, password, lang = 'fr' } = resetPasswordDto;
    const cleanIdentifier = identifier.trim();

    if (!password || password.trim().length < 8) {
      throw new BadRequestException(
        this.i18nService.translate('password_too_short', lang),
      );
    }

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { phone: cleanIdentifier },
          { email: cleanIdentifier.toLowerCase() },
        ],
      },
    });
    if (!user)
      throw new BadRequestException(
        this.i18nService.translate('user_not_found', lang),
      );

    const otpEntry = await this.prisma.otp.findFirst({
      where: {
        otpCode: code.toString(),
        isUsed: false,
        expiresAt: { gt: new Date() },
      },
    });
    if (!otpEntry)
      throw new BadRequestException(
        this.i18nService.translate('otp_invalid', lang),
      );

    const hashedPassword = await bcrypt.hash(password, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    });
    await this.prisma.otp.update({
      where: { id: otpEntry.id },
      data: { isUsed: true },
    });
    return {
      message: this.i18nService.translate('password_reset_success', lang),
    };
  }

  async changePassword(
    userId: string,
    changePasswordDto: {
      currentPassword: string;
      newPassword: string;
      lang?: string;
    },
    ipAddress?: string,
  ): Promise<{ message: string; data: any }> {
    const { currentPassword, newPassword, lang = 'fr' } = changePasswordDto;
    if (!currentPassword || currentPassword.trim() === '') {
      throw new BadRequestException(
        this.i18nService.translate('current_password_required', lang),
      );
    }
    if (!newPassword || newPassword.trim() === '') {
      throw new BadRequestException(
        this.i18nService.translate('new_password_required', lang),
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user)
      throw new NotFoundException(
        this.i18nService.translate('user_not_found', lang),
      );
    if (!user.password)
      throw new BadRequestException(
        this.i18nService.translate('no_password_set', lang),
      );

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch)
      throw new BadRequestException(
        this.i18nService.translate('current_password_incorrect', lang),
      );

    const hashedNewPassword = await bcrypt.hash(newPassword, 10);
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedNewPassword,
        passwordStatus: user_passwordStatus.CHANGED,
      },
    });

    const { password, pin: _, ...safeUser } = updatedUser;
    await this.logAudit(
      user.id,
      'CHANGE_PASSWORD',
      { identifier: user.phone },
      ipAddress ?? null,
    );
    return {
      message: this.i18nService.translate('password_changed_success', lang),
      data: safeUser,
    };
  }

  async setPassword(userId: string, newPassword: string): Promise<void> {
    const hashedPassword = await bcrypt.hash(newPassword, this.SALT_ROUNDS);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });
  }

  async getAccountByNumber(
    accountNumber: string,
    lang?: string,
  ): Promise<AccountInfo> {
    const bankResponse = await this.bankService.linkAccount(
      accountNumber,
      undefined,
      lang || 'fr',
    );

    if (bankResponse.error) {
      throw new NotFoundException(
        `Compte bancaire ${accountNumber} non trouvé: ${bankResponse.message}`,
      );
    }

    const accountInfo: AccountInfo = {
      id: bankResponse.id || crypto.randomUUID(),
      full_name: bankResponse.customerName,
      account_number: bankResponse.accountNumber,
      phone: bankResponse.phone,
      branch: bankResponse.branchName || null,
      email: bankResponse.email || null,
      status: 'ACTIVE',
      kyc_status: 'NOT_VERIFIED',
      balance: parseFloat(bankResponse.balance || '0'),
      currency: bankResponse.currency || 'CDF',
      address: null,
      city: null,
      country: null,
      account_type: 'STANDARD',
      account_tier: 'TIER_1',
      opening_date: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      fcmToken: null,
      pin: null,
      passwordStatus: null,
      pinstatus: null,
      merchantCode: null,
      businessName: null,
    };

    return accountInfo;
  }

  async listAllSessions(
    page: number = 1,
    limit: number = 10,
    lang: string = 'fr',
  ) {
    const skip = (page - 1) * limit;
    const [sessions, total] = await Promise.all([
      this.prisma.sessions.findMany({
        where: { is_valid: true, expires_at: { gt: new Date() } },
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        include: {
          user: {
            select: {
              id: true,
              full_name: true,
              phone: true,
              account_number: true,
            },
          },
        },
      }),
      this.prisma.sessions.count({
        where: { is_valid: true, expires_at: { gt: new Date() } },
      }),
    ]);
    return {
      message: this.i18nService.translate('sessions_retrieved', lang),
      data: sessions,
      total,
      page,
      limit,
    };
  }

  async listUserSessions(
    userId: string,
    page: number = 1,
    limit: number = 10,
    lang: string = 'fr',
  ) {
    const skip = (page - 1) * limit;
    const [sessions, total] = await Promise.all([
      this.prisma.sessions.findMany({
        where: {
          user_id: userId,
          is_valid: true,
          expires_at: { gt: new Date() },
        },
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          device_info: true,
          ip_address: true,
          last_activity: true,
          created_at: true,
          expires_at: true,
        },
      }),
      this.prisma.sessions.count({
        where: {
          user_id: userId,
          is_valid: true,
          expires_at: { gt: new Date() },
        },
      }),
    ]);
    return {
      message: this.i18nService.translate('sessions_retrieved', lang),
      data: sessions,
      total,
      page,
      limit,
    };
  }

  async getSessionById(
    sessionId: string,
    lang: string = 'fr',
  ): Promise<{ message: string; data: any }> {
    const session = await this.prisma.sessions.findUnique({
      where: { id: sessionId },
      include: {
        user: {
          select: {
            id: true,
            full_name: true,
            phone: true,
            account_number: true,
          },
        },
      },
    });
    if (!session) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('session_not_found', lang),
        statusCode: 404,
      });
    }
    return {
      message: this.i18nService.translate('session_retrieved', lang),
      data: session,
    };
  }

  async registerDeviceToken(userId: string, fcmToken: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('Utilisateur non trouvé');
    if (!fcmToken || !fcmToken.trim())
      throw new BadRequestException('Token FCM requis');
    return this.prisma.device_tokens.upsert({
      where: { token: fcmToken.trim() },
      update: { user_id: userId, updated_at: new Date() },
      create: {
        id: crypto.randomUUID(),
        user_id: userId,
        token: fcmToken.trim(),
        platform: 'unknown',
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
  }

  async getUserStatus(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    if (!user)
      throw new RpcException({
        status: 'error',
        message: 'User not found',
        statusCode: 404,
      });
    return user.status;
  }

  async getLoginAttempts(
    userId: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<{
    message: string;
    data: { data: any[]; total: number; page: number; limit: number };
  }> {
    const skip = (page - 1) * limit;
    const [attempts, total] = await Promise.all([
      this.prisma.login_attempt.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.login_attempt.count({ where: { userId } }),
    ]);
    return {
      message: 'Login attempts retrieved successfully',
      data: {
        data: attempts,
        total,
        page,
        limit,
      },
    };
  }

  async checkPhoneExists(
    phone: string,
    lang: string = 'fr',
  ): Promise<{ status: string; exists: boolean; message: string }> {
    const normalizedPhone = this.normalizePhone(phone);

    console.log(`[AuthService] Checking if phone exists: ${normalizedPhone}`);

    if (!normalizedPhone || normalizedPhone.length === 0) {
      throw new BadRequestException(
        this.i18nService.translate('wallet.phone_required', lang),
      );
    }

    try {
      const user = await this.prisma.user.findFirst({
        where: {
          phone: normalizedPhone,
          deleted: false,
        },
        select: { id: true },
      });

      if (user) {
        return {
          status: 'success',
          exists: true,
          message: this.i18nService.translate('wallet.phone_exists', lang),
        };
      }

      // Retourner 404 si le téléphone n'existe pas
      throw new NotFoundException(
        this.i18nService.translate('wallet.phone_not_found', lang),
      );

    } catch (error) {
      // Si c'est déjà une exception NotFoundException ou BadRequestException, la relancer
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      // Gérer les autres erreurs (base de données, etc.)
      console.error(`[AuthService] Error checking phone: ${error.message}`);
      throw new InternalServerErrorException(
        this.i18nService.translate('wallet.error_checking_phone', lang) || 'Error checking phone number'
      );
    }
  }

  private generateJwt(
    user: {
      id: string;
      email: string | null;
      role: PrismaUserRole;
      account_number?: string | null;
      phone?: string | null;
      full_name?: string | null;
      branch?: string | null;
      status?: string;
      deleted?: boolean | null;
      createdAt?: Date;
      updatedAt?: Date;
      fcmToken?: string | null;
      pin?: string | null;
      passwordStatus?: string | null;
      pinstatus?: boolean | null;
      merchantCode: string | null;
      businessName: string | null;
    },
    sessionToken: string,
    message?: string,
  ): AuthResponseDto {
    const payload = {
      id: user.id,
      email: user.email || null,
      phone: user.phone || null,
      full_name: user.full_name || null,
      role: user.role,
      status: user.status || 'ACTIVE',
      account_number: user.account_number ?? null,
      sessionToken,
      pin: user.pin || null,
      passwordStatus: user.passwordStatus,
    };

    const accessToken = this.jwtService.sign(payload, {
      secret: process.env.JWT_SECRET || 'secret',
      expiresIn: '30d',
    });
    const refreshToken = this.jwtService.sign(payload, {
      secret: process.env.JWT_SECRET || 'secret',
      expiresIn: '30d',
    });

    return {
      accessToken,
      refreshToken,
      data: {
        id: user.id,
        email: user.email,
        phone: user.phone || null,
        fcmToken: user.fcmToken || null,
        full_name: user.full_name || null,
        account_number: user.account_number || null,
        branch: user.branch || null,
        role: user.role,
        passwordStatus: user.passwordStatus || null,
        pinstatus: user.pinstatus ?? null,
        merchantCode: user.merchantCode || null,
        businessName: user.businessName || null,
        status: (user.status as any) || 'ACTIVE',
        deleted: user.deleted || false,
        createdAt: user.createdAt || new Date(),
        updatedAt: user.updatedAt || new Date(),
      },
      message,
    };
  }
}
