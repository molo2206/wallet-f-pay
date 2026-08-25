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
  branch_status,
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
import { OAuthAuthorizeDto, OAuthAuthorizeResponseDto, OAuthLinkUserDto, OAuthLinkUserResponseDto } from './dto/oauth';



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

  // private async generateLoyaltyCode(): Promise<string> {
  //   const prefix = ''; // Pas de préfixe, juste 10 chiffres
  //   const digits = '0123456789';
  //   let code = '';

  //   // Générer 10 chiffres aléatoires
  //   for (let i = 0; i < 10; i++) {
  //     code += digits.charAt(Math.floor(Math.random() * digits.length));
  //   }

  //   // Vérifier l'unicité
  //   const existing = await this.prisma.user.findFirst({
  //     where: { loyalty_code: code },
  //   });

  //   if (existing) {
  //     // Si le code existe déjà, en générer un nouveau
  //     return this.generateLoyaltyCode();
  //   }

  //   return code;
  // }

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
      // ✅ Vérifier si l'utilisateur existe déjà avec le téléphone normalisé
      const existingUser = await this.prisma.user.findFirst({
        where: {
          OR: [
            { phone: phone },
            { phone: data.phone },
            { phone: phone.replace(/^\+/, '') },
          ]
        },
      });

      if (existingUser) {
        throw new UnauthorizedException(
          this.i18nService.translate('user_already_exists', lang),
        );
      }

      // Gestion de l'OTP
      const otpProvided = data.otpCode && data.otpCode.trim() !== '';

      if (!otpProvided) {
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

        try {
          const smsText = this.i18nService.translate('otp_sms', lang, {
            otpCode: newOtpCode,
          });
          await this.smsService.sendSms(phone, smsText, data.countryCode);
        } catch (err) {
          console.error('Erreur SMS OTP:', err);
        }

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

      const plainPassword = data.password;
      const hashedPassword = await bcrypt.hash(plainPassword, 10);

      // ✅ Créer l'utilisateur avec le téléphone normalisé
      const user = await this.prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          account_number: data.account_number || null,
          full_name: data.full_name,
          phone: phone,
          password: hashedPassword,
          role: 'USER',
          status: 'ACTIVE',
          passwordStatus: user_passwordStatus.DEFAULT,
          fcmToken: data.fcmToken ?? null,
          email: data.email ?? null,
          countryCode: data.countryCode ?? null,
          profileImage: null,
          branchId: data.branchId ?? null, // ✅ AJOUT DE LA BRANCHE
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
                countryCode: data.countryCode
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
            console.warn(`Aucune devise trouvée pour ${data.countryCode}, utilisation de CDF`);
            currenciesToCreate.push('CDF');
          }
        } catch (err) {
          console.error('Erreur lecture network_provider:', err);
          currenciesToCreate.push('CDF');
        }
      } else {
        console.log('Aucun countryCode fourni, création d\'un wallet par défaut en CDF');
        currenciesToCreate.push('CDF');
      }

      for (const currency of currenciesToCreate) {
        try {
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

      await this.prisma.otp.update({
        where: { id: otpRecord.id },
        data: { isUsed: true },
      });

      await this.logAudit(
        user.id,
        'REGISTER',
        { identifier: user },
        ipAddress ?? null,
      );

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

      const sessionToken = crypto.randomUUID();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      const createdSession = await this.prisma.sessions.create({
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
      const sessionId = createdSession.id;

      const result = this.generateJwt(
        user,
        sessionToken,
        this.i18nService.translate('register_success', lang),
      );

      // ✅ Récupérer les wallets
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

      // ✅ Récupérer les sessions
      const sessions = await this.prisma.sessions.findMany({
        where: {
          user_id: user.id,
          is_valid: true,
          expires_at: { gt: new Date() },
        },
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          device_info: true,
          ip_address: true,
          last_activity: true,
          created_at: true,
          expires_at: true,
        },
      });

      // ✅ Récupérer les informations KYC
      const kycSubmission = await this.prisma.kyc_submission.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          documentType: true,
          documentNumber: true,
          documentFront: true,
          documentBack: true,
          profileImage: true,
          status: true,
          submittedAt: true,
          reviewedAt: true,
          adminNotes: true,
          rejectionReason: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      const kyc = {
        status: user.kycStatus || 'NOT_SUBMITTED',
        submission: kycSubmission ? {
          id: kycSubmission.id,
          documentType: kycSubmission.documentType || null,
          documentNumber: kycSubmission.documentNumber || null,
          documentFront: kycSubmission.documentFront || null,
          documentBack: kycSubmission.documentBack || null,
          profileImage: kycSubmission.profileImage ?? null,
          status: kycSubmission.status,
          submittedAt: kycSubmission.submittedAt || kycSubmission.createdAt,
          reviewedAt: kycSubmission.reviewedAt || null,
          adminNotes: kycSubmission.adminNotes || null,
          rejectionReason: kycSubmission.rejectionReason || null,
        } : null,
      };

      // ✅ Récupérer les ressources de l'utilisateur avec BRANCH
      const userResources = await this.prisma.user_has_resources.findMany({
        where: { userId: user.id },
        include: {
          resources: true,
          branch: {
            select: {
              id: true,
              name: true,
              code: true,
              countryId: true,
              status: true,
            },
          },
        },
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
        branch: ur.branch ? {
          id: ur.branch.id,
          name: ur.branch.name,
          code: ur.branch.code,
          countryId: ur.branch.countryId,
          status: ur.branch.status,
        } : null,
      }));

      // ✅ Récupérer la branche de l'utilisateur
      let userBranch: {
        id: string;
        name: string;
        code: string;
        countryId: string;
        status: string;
      } | null = null;

      if (user.branchId) {
        const branch = await this.prisma.branch.findUnique({
          where: { id: user.branchId },
          select: {
            id: true,
            name: true,
            code: true,
            countryId: true,
            status: true,
          },
        });
        if (branch) {
          userBranch = {
            id: branch.id,
            name: branch.name,
            code: branch.code,
            countryId: branch.countryId,
            status: branch.status || user_status.ACTIVE,
          };
        }
      }

      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        message: result.message,
        sessionId: sessionId,
        data: {
          id: user.id,
          email: user.email,
          phone: user.phone,
          fcmToken: user.fcmToken,
          full_name: user.full_name,
          account_number: user.account_number,
          branchId: user.branchId ?? null,
          branch: userBranch, // ✅ AJOUT DE LA BRANCHE
          role: user.role,
          passwordStatus: user.passwordStatus,
          pinstatus: user.pinstatus,
          merchantCode: user.merchantCode,
          businessName: user.businessName,
          status: user.status,
          deleted: user.deleted ?? false,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          profileImage: null,
          kycStatus: user.kycStatus || 'NOT_SUBMITTED',
          countryCode: user.countryCode || 'CD',
          sessions: sessions,
          wallets: wallets,
          resources: resources,
          kyc: kyc,
        },
      };
    } finally {
      registerLocks.delete(key);
    }
  }

  async oauthAuthorize(
    dto: OAuthAuthorizeDto,
    ipAddress?: string,
  ): Promise<OAuthAuthorizeResponseDto> {
    const lang = dto.lang || 'fr';

    // ✅ 1. Vérifier le client OAuth (nom en minuscule: oauthclient)
    const client = await this.prisma.oauthclient.findUnique({
      where: { clientId: dto.clientId },
    });

    if (!client || !client.isActive) {
      throw new BadRequestException(
        this.i18nService.translate('oauth.client_invalid', lang),
      );
    }

    // 2. Vérifier le redirectUri
    let redirectUris: string[] = [];
    try {
      redirectUris = JSON.parse(client.redirectUris);
    } catch {
      redirectUris = [client.redirectUris];
    }

    if (!redirectUris.includes(dto.redirectUri)) {
      throw new BadRequestException(
        this.i18nService.translate('oauth.redirect_uri_mismatch', lang),
      );
    }

    // 3. Vérifier le response_type
    if (dto.responseType !== 'code') {
      throw new BadRequestException(
        this.i18nService.translate('oauth.unsupported_response_type', lang),
      );
    }

    // 4. Générer le code d'autorisation
    const authCode = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // ✅ 5. Créer le code d'autorisation (nom en minuscule: oauthauthorizationcode)
    const authCodeRecord = await this.prisma.oauthauthorizationcode.create({
      data: {
        id: crypto.randomUUID(),
        code: authCode,
        clientId: client.id,
        userId: '', // Sera mis à jour après login
        redirectUri: dto.redirectUri,
        scope: dto.scope || null,
        expiresAt,
        isUsed: false,
        createdAt: new Date(),
      },
    });

    // 6. Construire l'URL de redirection vers la page de connexion
    const loginPageUrl = new URL('/oauth/authorize', process.env.APP_URL || 'http://localhost:3000');
    loginPageUrl.searchParams.set('client_id', dto.clientId);
    loginPageUrl.searchParams.set('redirect_uri', dto.redirectUri);
    loginPageUrl.searchParams.set('response_type', dto.responseType);
    loginPageUrl.searchParams.set('code', authCode);
    if (dto.scope) {
      loginPageUrl.searchParams.set('scope', dto.scope);
    }
    if (dto.state) {
      loginPageUrl.searchParams.set('state', dto.state);
    }
    if (dto.lang) {
      loginPageUrl.searchParams.set('lang', dto.lang);
    }

    await this.logAudit(
      null,
      'OAUTH_AUTHORIZE',
      { clientId: dto.clientId, code: authCode },
      ipAddress ?? null,
    );

    return {
      redirectUrl: loginPageUrl.toString(),
      authorizationCode: authCode,
      requiresLogin: true,
    };
  }

  async LinkUser(
    dto: {
      phone: string;
      password: string;
      clientId?: string;
      scope?: string;
      lang?: string;
    },
    ipAddress?: string,
  ): Promise<OAuthLinkUserResponseDto> {
    const lang = dto.lang || 'fr';
    const normalizedPhone = this.normalizePhone(dto.phone);
    const clientId = dto.clientId || 'web-client';

    // ✅ 1. Vérifier que l'utilisateur existe
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { phone: normalizedPhone },
          { phone: dto.phone },
          { phone: normalizedPhone.replace(/^\+/, '') },
        ],
      },
    });

    if (!user) {
      throw new BadRequestException(
        this.i18nService.translate('user_not_found', lang),
      );
    }

    // ✅ 2. Vérifier le mot de passe
    if (!user.password) {
      throw new BadRequestException(
        this.i18nService.translate('user_no_password', lang),
      );
    }

    const isValidPassword = await bcrypt.compare(dto.password, user.password);
    if (!isValidPassword) {
      throw new BadRequestException(
        this.i18nService.translate('invalid_password', lang),
      );
    }

    // ✅ 3. Vérifier que l'utilisateur est actif
    if (user.status !== user_status.ACTIVE) {
      throw new BadRequestException(
        this.i18nService.translate('account_inactive', lang),
      );
    }

    // ✅ 4. Générer les tokens OAuth
    const accessToken = crypto.randomBytes(32).toString('hex');
    const refreshToken = crypto.randomBytes(32).toString('hex');

    // ✅ 5. Récupérer ou créer le client OAuth (nom en minuscule: oauthclient)
    let client = await this.prisma.oauthclient.findUnique({
      where: { clientId: clientId },
    });

    if (!client) {
      client = await this.prisma.oauthclient.create({
        data: {
          id: crypto.randomUUID(),
          clientId: clientId,
          clientSecret: crypto.randomBytes(32).toString('hex'),
          clientName: `Client ${clientId}`,
          redirectUris: JSON.stringify([]),
          grantTypes: JSON.stringify(['authorization_code', 'refresh_token']),
          scopes: JSON.stringify(['profile', 'email', 'phone']),
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }

    // ✅ 6. Stocker l'access token (nom en minuscule: oauthaccesstoken)
    const accessTokenRecord = await this.prisma.oauthaccesstoken.create({
      data: {
        id: crypto.randomUUID(),
        token: accessToken,
        clientId: client.id,
        userId: user.id,
        scope: dto.scope || 'profile',
        expiresAt: new Date(Date.now() + 3600 * 1000),
        createdAt: new Date(),
      },
    });

    // ✅ 7. Stocker le refresh token (nom en minuscule: oauthrefreshtoken)
    await this.prisma.oauthrefreshtoken.create({
      data: {
        id: crypto.randomUUID(),
        token: refreshToken,
        accessTokenId: accessTokenRecord.id,
        clientId: client.id,
        userId: user.id,
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        createdAt: new Date(),
      },
    });

    // ✅ 8. Récupérer les ressources de l'utilisateur avec BRANCH
    const userResources = await this.prisma.user_has_resources.findMany({
      where: { userId: user.id },
      include: {
        resources: true,
        branch: {
          select: {
            id: true,
            name: true,
            code: true,
            countryId: true,
            status: true,
          },
        },
      },
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
      branch: ur.branch ? {
        id: ur.branch.id,
        name: ur.branch.name,
        code: ur.branch.code,
        countryId: ur.branch.countryId,
        status: ur.branch.status ?? 'ACTIVE',
      } : null,
    }));

    // ✅ 9. Récupérer la branche de l'utilisateur
    let userBranch: {
      id: string;
      name: string;
      code: string;
      countryId: string;
      status: string;
    } | null = null;

    if (user.branchId) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: user.branchId },
        select: {
          id: true,
          name: true,
          code: true,
          countryId: true,
          status: true,
        },
      });
      if (branch) {
        userBranch = {
          id: branch.id,
          name: branch.name,
          code: branch.code,
          countryId: branch.countryId,
          status: branch.status ?? 'ACTIVE',
        };
      }
    }

    // ✅ 10. Récupérer les wallets
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

    // ✅ 11. Récupérer les informations KYC
    const kycSubmission = await this.prisma.kyc_submission.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        documentType: true,
        documentNumber: true,
        documentFront: true,
        documentBack: true,
        profileImage: true,
        status: true,
        submittedAt: true,
        reviewedAt: true,
        adminNotes: true,
        rejectionReason: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const kyc = {
      status: user.kycStatus ?? 'NOT_SUBMITTED',
      submission: kycSubmission ? {
        id: kycSubmission.id,
        documentType: kycSubmission.documentType || null,
        documentNumber: kycSubmission.documentNumber || null,
        documentFront: kycSubmission.documentFront || null,
        documentBack: kycSubmission.documentBack || null,
        profileImage: kycSubmission.profileImage || null,
        status: kycSubmission.status,
        submittedAt: kycSubmission.submittedAt || kycSubmission.createdAt,
        reviewedAt: kycSubmission.reviewedAt || null,
        adminNotes: kycSubmission.adminNotes || null,
        rejectionReason: kycSubmission.rejectionReason || null,
      } : null,
    };

    // ✅ 12. Créer une session
    const sessionToken = crypto.randomUUID();
    const expiresAtSession = new Date();
    expiresAtSession.setDate(expiresAtSession.getDate() + 30);

    const createdSession = await this.prisma.sessions.create({
      data: {
        id: crypto.randomUUID(),
        user_id: user.id,
        token: sessionToken,
        device_info: 'OAuth Web',
        ip_address: ipAddress || null,
        last_activity: new Date(),
        expires_at: expiresAtSession,
        is_valid: true,
        created_at: new Date(),
      },
    });

    // ✅ 13. Récupérer les sessions
    const sessions = await this.prisma.sessions.findMany({
      where: {
        user_id: user.id,
        is_valid: true,
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        device_info: true,
        ip_address: true,
        last_activity: true,
        created_at: true,
        expires_at: true,
      },
    });

    // ✅ 14. Audit log
    await this.logAudit(
      user.id,
      'OAUTH_LINK_SUCCESS',
      {
        phone: user.phone,
        accessToken: accessToken,
        clientId: clientId,
      },
      ipAddress ?? null,
    );

    // ✅ 15. Retourner la réponse
    return {
      accessToken: accessToken,
      refreshToken: refreshToken,
      message: this.i18nService.translate('login_success', lang),
      sessionId: createdSession.id,
      data: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        fcmToken: user.fcmToken,
        full_name: user.full_name,
        account_number: user.account_number,
        branchId: user.branchId ?? null,
        branch: userBranch,
        role: user.role,
        passwordStatus: user.passwordStatus,
        pinstatus: user.pinstatus,
        merchantCode: user.merchantCode,
        businessName: user.businessName,
        status: user.status,
        deleted: user.deleted ?? false,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        profileImage: user.profileImage ?? null,
        kycStatus: user.kycStatus || 'NOT_SUBMITTED',
        countryCode: user.countryCode || 'CD',
        locked_by_admin: user.locked_by_admin ?? false,
        sessions: sessions,
        resources: resources,
        wallets: wallets,
        kyc: kyc,
        accessToken: accessToken,
        refreshToken: refreshToken,
        tokenType: 'Bearer',
        expiresIn: 3600,
      },
    };
  }

  async login(
    dto: LoginUserDto & { lang?: string; userAgent?: string },
    ipAddress?: string,
  ): Promise<AuthResponseDto> {
    const lang = dto.lang || 'fr';
    const identifier = dto.identifier;

    try {
      // ✅ Normaliser l'identifiant si c'est un téléphone
      let normalizedIdentifier = identifier;
      if (identifier && /^[0-9+\s\-\.\(\)]+$/.test(identifier)) {
        normalizedIdentifier = this.normalizePhone(identifier);
      }

      // ✅ Récupérer l'utilisateur avec toutes les variantes possibles
      const user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { phone: normalizedIdentifier },
            { phone: identifier },
            { phone: normalizedIdentifier.replace(/^\+/, '') },
            { email: identifier.toLowerCase() },
            { email: identifier },
          ],
        },
        select: {
          id: true,
          email: true,
          phone: true,
          password: true,
          full_name: true,
          account_number: true,
          branchId: true,
          role: true,
          status: true,
          deleted: true,
          createdAt: true,
          updatedAt: true,
          fcmToken: true,
          passwordStatus: true,
          pinstatus: true,
          merchantCode: true,
          businessName: true,
          failed_login_attempts: true,
          locked_until: true,
          pin: true,
          kycStatus: true,
          countryCode: true,
          profileImage: true,
          locked_by_admin: true,
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

      // ✅ VÉRIFICATION DU BLOCAGE
      // ========================================

      // 1️⃣ Blocage par ADMIN (ne se débloque pas automatiquement)
      if (user.locked_by_admin === true) {
        await logFailedLoginAttempt(
          this.prisma,
          user.id,
          identifier,
          ipAddress,
          dto.userAgent,
        );
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('account_blocked_by_admin', lang),
          statusCode: 403,
        });
      }

      // 2️⃣ Vérifier si le verrouillage automatique est expiré (déblocage auto)
      if (user.locked_until && user.locked_until <= new Date() && user.status === user_status.SUSPENDED) {
        // ✅ Déblocage automatique
        await this.prisma.user.update({
          where: { id: user.id },
          data: {
            status: user_status.ACTIVE,
            failed_login_attempts: 0,
            locked_until: null,
          },
        });
      }

      // 3️⃣ Blocage automatique actif (tentatives échouées)
      if (user.locked_until && user.locked_until > new Date()) {
        const minutesLeft = Math.ceil(
          (user.locked_until.getTime() - Date.now()) / 60000,
        );
        let message = this.i18nService.translate('account_locked_auto', lang);
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

      // 4️⃣ Vérifier les autres statuts bloquants
      if (user.status === user_status.BLOCKED) {
        await logFailedLoginAttempt(
          this.prisma,
          user.id,
          identifier,
          ipAddress,
          dto.userAgent,
        );
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('account_blocked_permanent', lang),
          statusCode: 403,
        });
      }

      if (user.status === user_status.SUSPENDED && user.locked_until && user.locked_until > new Date()) {
        const minutesLeft = Math.ceil(
          (user.locked_until.getTime() - Date.now()) / 60000,
        );
        let message = this.i18nService.translate('account_suspended_auto', lang);
        message = message.replace('{minutes}', minutesLeft.toString());
        throw new RpcException({ status: 'error', message, statusCode: 403 });
      }

      // ✅ Vérifier le statut ACTIVE
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

      // ✅ Vérifier le mot de passe
      const isValidPassword = await bcrypt.compare(dto.password, user.password);

      if (!isValidPassword) {
        const newAttempts = (user.failed_login_attempts || 0) + 1;
        let lockedUntil = user.locked_until;
        let newStatus: user_status = user.status;

        // ✅ Logique de blocage automatique (se débloque tout seul)
        if (newAttempts >= 10) {
          // 🔒 Blocage de 30 minutes (se débloque automatiquement)
          lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
          newStatus = user_status.SUSPENDED;
        } else if (newAttempts >= 5) {
          // ⚠️ Avertissement à partir de 5 tentatives (pas de blocage)
          lockedUntil = null;
          newStatus = user_status.ACTIVE;
        }

        await this.prisma.user.update({
          where: { id: user.id },
          data: {
            failed_login_attempts: newAttempts,
            locked_until: lockedUntil,
            status: newStatus,
            locked_by_admin: false,
          },
        });

        await logFailedLoginAttempt(
          this.prisma,
          user.id,
          identifier,
          ipAddress,
          dto.userAgent,
          newAttempts,
          lockedUntil,
        );

        let errorMessage: string;
        if (newAttempts >= 10) {
          errorMessage = this.i18nService.translate('account_locked_auto', lang, {
            minutes: 30,
          });
        } else if (newAttempts >= 5) {
          const remaining = 10 - newAttempts;
          errorMessage = this.i18nService.translate('invalid_password_warning', lang, {
            attempts: remaining,
          });
        } else {
          const remaining = 5 - newAttempts;
          errorMessage = this.i18nService.translate('invalid_password', lang, {
            attempts: remaining,
          });
        }

        throw new BadRequestException({
          status: 'error',
          message: errorMessage,
          statusCode: 400,
        });
      }

      // ✅ Succès : réinitialiser les tentatives
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failed_login_attempts: 0,
          locked_until: null,
          status: user_status.ACTIVE,
          locked_by_admin: false,
        },
      });

      // ✅ Récupérer les ressources de l'utilisateur avec BRANCH
      const userResources = await this.prisma.user_has_resources.findMany({
        where: { userId: user.id },
        include: {
          resources: true,
          branch: {
            select: {
              id: true,
              name: true,
              code: true,
              countryId: true,
              status: true,
            },
          },
        },
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
        branch: ur.branch ? {
          id: ur.branch.id,
          name: ur.branch.name,
          code: ur.branch.code,
          countryId: ur.branch.countryId,
          status: ur.branch.status,
        } : null,
      }));

      // ✅ Récupérer la branche de l'utilisateur
      let userBranch: {
        id: string;
        name: string;
        code: string;
        countryId: string;
        status: string;
      } | null = null;

      if (user.branchId) {
        const branch = await this.prisma.branch.findUnique({
          where: { id: user.branchId },
          select: {
            id: true,
            name: true,
            code: true,
            countryId: true,
            status: true,
          },
        });
        if (branch) {
          userBranch = {
            id: branch.id,
            name: branch.name,
            code: branch.code,
            countryId: branch.countryId,
            status: branch.status || branch_status.ACTIVE,
          };
        }
      }

      // ✅ Récupérer les wallets
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

      // ✅ Récupérer les informations KYC
      const kycSubmission = await this.prisma.kyc_submission.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          documentType: true,
          documentNumber: true,
          documentFront: true,
          documentBack: true,
          profileImage: true,
          status: true,
          submittedAt: true,
          reviewedAt: true,
          adminNotes: true,
          rejectionReason: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      const kyc = {
        status: user.kycStatus,
        submission: kycSubmission ? {
          id: kycSubmission.id,
          documentType: kycSubmission.documentType || null,
          documentNumber: kycSubmission.documentNumber || null,
          documentFront: kycSubmission.documentFront || null,
          documentBack: kycSubmission.documentBack || null,
          profileImage: kycSubmission.profileImage || null,
          status: kycSubmission.status,
          submittedAt: kycSubmission.submittedAt || kycSubmission.createdAt,
          reviewedAt: kycSubmission.reviewedAt || null,
          adminNotes: kycSubmission.adminNotes || null,
          rejectionReason: kycSubmission.rejectionReason || null,
        } : null,
      };

      // ✅ Gestion du deviceId
      let deviceId = dto.fcmToken;
      if (!deviceId) {
        const fingerprint = `${dto.deviceInfo || ''}|${dto.platform || ''}|${ipAddress || ''}`;
        deviceId = crypto
          .createHash('sha256')
          .update(fingerprint)
          .digest('hex');
      }

      // ✅ Supprimer les anciennes sessions avec le même deviceId
      await this.prisma.sessions.deleteMany({
        where: {
          user_id: user.id,
          is_valid: true,
          deviceId,
        },
      });

      // ✅ Créer une nouvelle session
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

      // ✅ Enregistrer le token FCM
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

      // ✅ Récupérer toutes les sessions actives
      const sessions = await this.prisma.sessions.findMany({
        where: {
          user_id: user.id,
          is_valid: true,
          expires_at: { gt: new Date() },
        },
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          device_info: true,
          ip_address: true,
          last_activity: true,
          created_at: true,
          expires_at: true,
        },
      });

      // ✅ Générer les tokens JWT
      const result = this.generateJwt(
        user,
        sessionToken,
        this.i18nService.translate('login_success', lang),
      );

      // ✅ Audit log
      await this.logAuditWithDebounce(
        user.id,
        'LOGIN',
        { identifier, deviceId },
        ipAddress ?? null,
      );

      // ✅ Retourner la réponse avec branch
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        message: result.message,
        sessionId: sessionId,
        data: {
          id: user.id,
          email: user.email,
          phone: user.phone,
          fcmToken: user.fcmToken,
          full_name: user.full_name,
          account_number: user.account_number,
          branchId: user.branchId ?? null,
          branch: userBranch, // ✅ AJOUT DE LA BRANCHE
          role: user.role,
          passwordStatus: user.passwordStatus,
          pinstatus: user.pinstatus,
          merchantCode: user.merchantCode,
          businessName: user.businessName,
          status: user.status,
          deleted: user.deleted ?? false,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          profileImage: user.profileImage ?? null,
          kycStatus: user.kycStatus || 'NOT_SUBMITTED',
          countryCode: user.countryCode || 'CD',
          locked_by_admin: user.locked_by_admin ?? false,
          sessions: sessions,
          resources: resources,
          wallets: wallets,
          kyc: kyc,
        },
      };
    } catch (error) {
      if (
        error instanceof RpcException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      console.error('[Login] Error:', error);
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

  async verifyToken(accessToken: string): Promise<{
    valid: boolean;
    data?: {
      id: string;
      email: string | null;
      phone: string | null;
      full_name: string | null;
      role: string;
      status: string;
      kycStatus: string;
      countryCode: string | null;
    };
    message: string;
  }> {
    try {
      console.log('[AuthService] verifyToken - Vérification du token');

      if (!accessToken) {
        throw new BadRequestException('Token manquant');
      }

      // ✅ 1. Vérifier si le token existe dans la table oauthaccesstoken
      const tokenRecord = await this.prisma.oauthaccesstoken.findFirst({
        where: {
          token: accessToken,
          expiresAt: { gt: new Date() },
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              phone: true,
              full_name: true,
              role: true,
              status: true,
              kycStatus: true,
              countryCode: true,
              profileImage: true,
              account_number: true,
              merchantCode: true,
              businessName: true,
            },
          },
        },
      });

      if (!tokenRecord) {
        console.log('[AuthService] verifyToken - Token invalide ou expiré');
        return {
          valid: false,
          message: 'Token invalide ou expiré',
        };
      }

      console.log(`[AuthService] verifyToken - Token valide pour l'utilisateur ${tokenRecord.userId}`);

      // ✅ 2. Retourner les informations de l'utilisateur
      return {
        valid: true,
        data: {
          id: tokenRecord.user.id,
          email: tokenRecord.user.email,
          phone: tokenRecord.user.phone,
          full_name: tokenRecord.user.full_name,
          role: tokenRecord.user.role,
          status: tokenRecord.user.status,
          kycStatus: tokenRecord.user.kycStatus || 'NOT_SUBMITTED',
          countryCode: tokenRecord.user.countryCode || 'CD',
        },
        message: 'Token valide',
      };

    } catch (error) {
      console.error(`[AuthService] verifyToken - Erreur: ${error.message}`);
      return {
        valid: false,
        message: error.message || 'Erreur lors de la vérification du token',
      };
    }
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
      await this.smsService.sendSms(user.phone, smsText, user.countryCode);
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
      branchId?: string | null;
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
      profileImage?: string | null;
      kycStatus?: string;
      countryCode?: string | null;
      locked_by_admin?: boolean | null; // ✅ DÉJÀ PRÉSENT
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
      profileImage: user.profileImage ?? null,
      kycStatus: user.kycStatus || 'NOT_SUBMITTED',
      countryCode: user.countryCode || 'CD',
      locked_by_admin: user.locked_by_admin ?? false, // ✅ AJOUTER
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
        branchId: user.branchId || null,
        role: user.role,
        passwordStatus: user.passwordStatus || null,
        pinstatus: user.pinstatus ?? null,
        merchantCode: user.merchantCode || null,
        businessName: user.businessName || null,
        status: (user.status as any) || 'ACTIVE',
        deleted: user.deleted || false,
        createdAt: user.createdAt || new Date(),
        updatedAt: user.updatedAt || new Date(),
        profileImage: user.profileImage ?? null,
        kycStatus: user.kycStatus || 'NOT_SUBMITTED',
        countryCode: user.countryCode || 'CD',
        locked_by_admin: user.locked_by_admin ?? false, // ✅ AJOUTER ICI
      },
      message,
    };
  }
}
