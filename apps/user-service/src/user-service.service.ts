/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/user-service/src/user-service.service.ts
import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import * as bcrypt from 'bcrypt';
import { PrismaService } from './prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { ApiResponse } from './interfaces/api-response.interface';
import { SmsService } from 'apps/auth-service/src/sms/sms.service';
import { user_merchantType, user_passwordStatus, user_role, user_status, wallet_currency, branch_status, Prisma, country_provider_status } from '@prisma/client';
import { MailService } from 'apps/auth-service/src/email/email.service';
import { CreateUserFromAccountDto } from './dto/create-user-from-account.dto';
import { I18nService } from '../../../libs/common/src/i18n/i18n.service';
import { UpdateUserSettingsDto } from './dto/user-settings.dto';
import { CreateResourceDto } from './resources/dto/create-resource.dto';
import { UpdateResourceDto } from './resources/dto/update-resource.dto';
import { AssignMultipleResourcesDto } from './dto/assign-resource.dto';
import { UpsertAppSettingsDto } from './dto/app-settings.dto';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import type { Multer } from 'multer';
import { uploadFile } from 'apps/wallet-service/src/utilils/uploadFile.utils';
import { NotificationType } from 'apps/notification-service/src/type/notification-type';
import { NotificationHelper } from 'apps/notification-service/src/helpers/NotificationHelper';


@Injectable()
export class UserServiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly smsService: SmsService,
    private readonly mailService: MailService,
    private readonly i18nService: I18nService,
    private readonly notificationHelper: NotificationHelper,
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
          id: crypto.randomUUID(), // ✅ AJOUTÉ
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
  // ========================= CREATE USER =========================
  // apps/user-service/src/user-service.service.ts

  async createUser(
    data: CreateUserDto,
    ipAddress?: string,
  ): Promise<ApiResponse<UserResponseDto>> {
    const lang = data.lang || 'fr';
    console.log(
      `[createUser] Langue utilisée : ${lang} pour ${data.email || data.phone}`,
    );

    // 1. Vérifier les doublons d'email
    if (data.email) {
      const existing = await this.prisma.user.findFirst({
        where: { email: data.email.toLowerCase() },
      });
      if (existing)
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('email_already_exists', lang),
          statusCode: 409,
        });
    }

    // 2. Vérifier les doublons de téléphone
    if (data.phone) {
      const existing = await this.prisma.user.findFirst({
        where: { phone: data.phone },
      });
      if (existing)
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('phone_already_exists', lang),
          statusCode: 409,
        });
    }

    // 3. Vérifier que la branche existe si fournie
    let branchId: string | null = null;
    if (data.branchId) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: data.branchId },
      });
      if (!branch) {
        throw new RpcException({
          status: 'error',
          message: 'Branch not found',
          statusCode: 404,
        });
      }
      branchId = data.branchId;
    }

    // 4. Génération du code marchand si rôle MERCHANT
    const roleStr = data.role as string | undefined;
    let merchantCode: string | undefined = undefined;
    const isMerchant = roleStr === 'MERCHANT';

    if (isMerchant) {
      let isUnique = false;
      while (!isUnique) {
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const existing = await this.prisma.user.findFirst({
          where: { merchantCode: code },
        });
        if (!existing) {
          merchantCode = code;
          isUnique = true;
        }
      }
    }

    // 5. Convertir le rôle en enum Prisma
    let roleEnum: user_role = user_role.USER;
    if (isMerchant) roleEnum = user_role.MERCHANT;
    else if (roleStr === 'ADMIN') roleEnum = user_role.ADMIN;
    else if (roleStr === 'SUPER_ADMIN') roleEnum = user_role.SUPER_ADMIN;

    // 6. Création de l'utilisateur
    const defaultPassword = 'Fpay!026';
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

    // ✅ PIN par défaut : 1234
    const defaultPin = '1234';
    const hashedPin = crypto.createHash('sha256').update(defaultPin).digest('hex');

    const user = await this.prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: data.email?.toLowerCase(),
        phone: data.phone,
        full_name: data.full_name,
        account_number: data.account_number || null,
        branchId: branchId,
        password: hashedPassword,
        pin: hashedPin,
        pinstatus: true,
        role: roleEnum,
        status: user_status.ACTIVE,
        deleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        passwordStatus: user_passwordStatus.DEFAULT,
        merchantCode: merchantCode,
        businessName: data.businessName,
        merchantType: data.merchantType as user_merchantType || null,
        businessCategory: data.businessCategory || null,
        businessAddress: data.businessAddress || null,
        countryCode: data.countryCode || 'CD',
      },
    });

    // 7. Création des wallets basée sur le countryCode
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

    // 8. Récupérer la branche pour la réponse
    // ✅ CORRECTION 1: Définir le type explicite
    let branchData: {
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
        branchData = {
          id: branch.id,
          name: branch.name,
          code: branch.code,
          countryId: branch.countryId,
          status: branch.status || 'UNKNOWN',
        };
      }
    }

    // 9. SMS de bienvenue avec PIN
    if (data.phone) {
      const cleanPhone = data.phone.replace(/[^0-9+]/g, '');
      let smsText = this.i18nService.translate('welcome_sms', lang, {
        full_name: user.full_name || '',
        phone: cleanPhone,
        password: defaultPassword,
        pin: defaultPin,
      });
      if (isMerchant && merchantCode) {
        smsText += ' ' + this.i18nService.translate('merchant_code_sms', lang, {
          merchantCode: merchantCode,
        });
      }
      try {
        await this.smsService.sendSms(cleanPhone, smsText);
        console.log(`✅ SMS envoyé à ${cleanPhone}`);
      } catch (smsErr) {
        console.error(`SMS non envoyé à ${cleanPhone}:`, smsErr.message);
      }
    }

    // 10. Email de bienvenue
    if (user.email) {
      try {
        const template = 'welcome-email.html';
        const emailTitle = this.i18nService.translate('welcome_email_title', lang);

        const emailData: any = {
          title: emailTitle,
          greeting: this.i18nService.translate(
            'welcome_email_greeting',
            lang,
            { name: user.full_name || '' }
          ),
          message: this.i18nService.translate('welcome_email_message', lang),
          credentials_label: this.i18nService.translate('welcome_email_credentials', lang),
          phone_label: `${this.i18nService.translate('phone', lang)}: ${user.phone || ''}`,
          account_label: `${this.i18nService.translate('account', lang)}: ${user.account_number || ''}`,
          password_label: `${this.i18nService.translate('password', lang)}: ${defaultPassword}`,
          recommend: this.i18nService.translate('welcome_email_recommend', lang),
          support: this.i18nService.translate('welcome_email_support', lang),
          footer: this.i18nService.translate('welcome_email_footer', lang),
          sent_to: this.i18nService.translate('email_sent_to', lang),
          email: user.email,
          copyright: `© ${new Date().getFullYear()} F-Pay. Tous droits réservés.`,
          login_url: process.env.FRONTEND_URL || 'https://fpay.com/login',
          button_text: 'Se connecter',
          isMerchant: isMerchant || false,
        };

        if (isMerchant) {
          emailData.business_name = data.businessName || 'N/A';
          emailData.merchant_code = merchantCode || 'N/A';
          emailData.merchant_type = data.merchantType || 'N/A';
          emailData.business_address = data.businessAddress || 'N/A';
          emailData.business_category = data.businessCategory || 'N/A';
          emailData.business_label = 'Entreprise';
          emailData.category_label = 'Catégorie';
          emailData.address_label = 'Adresse';
          emailData.merchant_code_label = 'Code Marchand';
          emailData.merchant_type_label = 'Type de commerce';
        }

        // ✅ CORRECTION 2: Utiliser l'objet branchData correctement
        if (branchData) {
          emailData.branch_name = branchData.name;
          emailData.branch_code = branchData.code;
          emailData.branch_label = 'Agence';
        }

        await this.mailService.sendHtmlEmail(
          user.email,
          emailTitle,
          template,
          emailData,
        );
        console.log(`✅ Email envoyé à ${user.email}`);
      } catch (emailError) {
        console.error(`Erreur envoi email à ${user.email}:`, emailError);
      }
    }

    // 11. Audit
    await this.logAudit(
      user.id,
      isMerchant ? 'CREATE_MERCHANT_COTE_ADMIN' : 'CREATE_USER_COTE_ADMIN',
      { identifier: user, isMerchant, merchantCode, branchId },
      ipAddress ?? null,
    );

    // 12. Retour avec la branche
    const responseData = this.toResponse(user);

    // ✅ CORRECTION 3: Ajouter branch dans le retour
    return {
      message: this.i18nService.translate(
        isMerchant ? 'merchant_created_success' : 'user_created_success',
        lang
      ),
      data: {
        ...responseData,
        branch: branchData, // ✅ AJOUT DE LA BRANCHE
      } as any, // ✅ Utiliser 'as any' pour éviter l'erreur de type
    };
  }

  async createUserFromAccount(
    data: CreateUserFromAccountDto,
    ipAddress?: string,
  ): Promise<ApiResponse<UserResponseDto>> {
    const lang =
      data.lang && ['fr', 'en', 'sw'].includes(data.lang) ? data.lang : 'fr';
    console.log(
      `[createUserFromAccount] Langue utilisée : ${lang} pour ${data.full_name}`,
    );

    // 1️⃣ Vérification doublon téléphone
    if (data.phone) {
      const existing = await this.prisma.user.findFirst({
        where: { phone: data.phone },
      });
      if (existing) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('phone_already_exists', lang),
          statusCode: 409,
        });
      }
    }

    // 3️⃣ Génération code marchand si rôle MERCHANT
    const roleStr = data.role as string | undefined;
    let merchantCode: string | undefined;

    if (roleStr === 'MERCHANT') {
      let isUnique = false;
      while (!isUnique) {
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const existing = await this.prisma.user.findFirst({
          where: { merchantCode: code },
        });
        if (!existing) {
          merchantCode = code;
          isUnique = true;
        }
      }
    }

    // 4️⃣ Convertir le rôle en enum Prisma
    let roleEnum: user_role = user_role.USER;
    if (roleStr === 'MERCHANT') roleEnum = user_role.MERCHANT;
    else if (roleStr === 'ADMIN') roleEnum = user_role.ADMIN;
    else if (roleStr === 'SUPER_ADMIN') roleEnum = user_role.SUPER_ADMIN;

    // 5️⃣ Création de l’utilisateur
    const defaultPassword = 'Accespay!26';
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

    const user = await this.prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: data.email?.toLowerCase(),
        phone: data.phone,
        full_name: data.full_name,
        account_number: data.account_number,

        password: hashedPassword,
        role: roleEnum,
        status: user_status.ACTIVE,
        deleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        passwordStatus: user_passwordStatus.DEFAULT,
        merchantCode,
      },
    });

    // 6️⃣ Envoi du SMS de bienvenue (traduit)
    if (data.phone) {
      const cleanPhone = data.phone.replace(/[^0-9+]/g, '');
      let smsText = this.i18nService.translate('welcome_sms', lang, {
        full_name: user.full_name!,
        account_number: user.account_number!,
        phone: cleanPhone,
        password: defaultPassword,
      });

      if (merchantCode) {
        smsText +=
          ' ' +
          this.i18nService.translate('merchant_code_sms', lang, {
            merchantCode,
          });
      }

      await this.smsService.sendSms(cleanPhone, smsText);
    }

    // 7️⃣ Email de bienvenue (traduit)
    if (user.email) {
      try {
        await this.mailService.sendHtmlEmail(
          user.email,
          this.i18nService.translate('welcome_email_title', lang),
          'welcome-email.html',
          {
            title: this.i18nService.translate('welcome_email_title', lang),
            greeting: this.i18nService.translate(
              'welcome_email_greeting',
              lang,
              { name: user.full_name },
            ),
            message: this.i18nService.translate('welcome_email_message', lang),
            credentials_label: this.i18nService.translate(
              'welcome_email_credentials',
              lang,
            ),
            phone_label: `${this.i18nService.translate('phone', lang)}: ${user.phone || ''}`,
            account_label: `${this.i18nService.translate('account', lang)}: ${user.account_number || ''}`,
            password_label: `${this.i18nService.translate('password', lang)}: ${defaultPassword}`,
            recommend: this.i18nService.translate(
              'welcome_email_recommend',
              lang,
            ),
            support: this.i18nService.translate('welcome_email_support', lang),
            footer: this.i18nService.translate('welcome_email_footer', lang),
            sent_to: this.i18nService.translate('email_sent_to', lang),
            copyright: `© ${new Date().getFullYear()} ACCESPAY`,
            email: user.email,
          },
        );
      } catch (emailError) {
        console.error(`Erreur envoi email à ${user.email}:`, emailError);
      }
    }

    // Audit – liaison par admin
    await this.logAudit(
      user.id,
      'LINK_USER_TO_ACCOUNT_COTE_ADMIN',
      { identifier: user },
      ipAddress ?? null,
    );

    return {
      message: this.i18nService.translate('user_created_success', lang),
      data: this.toResponse(user),
    };
  }

  // apps/user-service/src/user-service.service.ts

  async getUser(
    id: string,
    lang: string = 'fr',
  ): Promise<{
    message: string;
    data: {
      id: string;
      email: string | null;
      phone: string | null;
      fcmToken: string | null;
      full_name: string | null;
      account_number: string | null;
      branchId: string | null;
      branch: {
        id: string;
        name: string;
        code: string;
        countryId: string;
        status: string;
      } | null;
      role: string;
      passwordStatus: string | null;
      pinstatus: boolean | null;
      merchantCode: string | null;
      businessName: string | null;
      status: string;
      deleted: boolean;
      createdAt: Date;
      updatedAt: Date;
      profileImage: string | null;
      kycStatus: string;
      countryCode: string | null;
      sessions: any[];
      resources: any[];
      wallets: any[];
      kyc: any;
    };
  }> {
    console.log(`[getUser] Langue utilisée : ${lang} pour l'utilisateur ${id}`);

    // ✅ Récupérer l'utilisateur avec tous les champs
    const user = await this.prisma.user.findFirst({
      where: { id },
      select: {
        id: true,
        email: true,
        phone: true,
        full_name: true,
        account_number: true,
        branchId: true,
        profileImage: true,
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
        merchantType: true,
        businessCategory: true,
        businessAddress: true,
        failed_login_attempts: true,
        locked_until: true,
        kycStatus: true,
        countryCode: true,
      },
    });

    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

    // ✅ Récupérer les sessions actives
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

    // ✅ Récupérer les ressources (permissions)
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
          status: branch.status || 'INACTIVE',
        };
      }
    }

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

    return {
      message: this.i18nService.translate('user_retrieved_success', lang),
      data: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        fcmToken: user.fcmToken,
        full_name: user.full_name,
        account_number: user.account_number,
        branchId: user.branchId,
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
        profileImage: user.profileImage,
        kycStatus: user.kycStatus || 'NOT_SUBMITTED',
        countryCode: user.countryCode || 'CD',
        sessions: sessions,
        resources: resources,
        wallets: wallets,
        kyc: kyc,
      },
    };
  }

  // ================================================================
  // GET USER BY EMAIL
  // ================================================================

  async getUserByEmail(
    email: string,
    lang: string = 'fr',
  ): Promise<{
    message: string;
    data: {
      id: string;
      email: string | null;
      phone: string | null;
      fcmToken: string | null;
      full_name: string | null;
      account_number: string | null;
      branchId: string | null;
      branch: {
        id: string;
        name: string;
        code: string;
        countryId: string;
        status: string;
      } | null;
      role: string;
      passwordStatus: string | null;
      pinstatus: boolean | null;
      merchantCode: string | null;
      businessName: string | null;
      status: string;
      deleted: boolean;
      createdAt: Date;
      updatedAt: Date;
      profileImage: string | null;
      kycStatus: string;
      countryCode: string | null;
      wallets: any[];
      kyc: any;
    };
  }> {
    console.log(
      `[getUserByEmail] Langue utilisée : ${lang} pour l'email ${email}`,
    );

    const user = await this.prisma.user.findFirst({
      where: { email: email.toLowerCase() },
      select: {
        id: true,
        email: true,
        phone: true,
        full_name: true,
        account_number: true,
        branchId: true,
        profileImage: true,
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
        merchantType: true,
        businessCategory: true,
        businessAddress: true,
        failed_login_attempts: true,
        locked_until: true,
        kycStatus: true,
        countryCode: true,
      },
    });

    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

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
          status: branch.status || 'INACTIVE',
        };
      }
    }

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

    return {
      message: this.i18nService.translate('user_retrieved_success', lang),
      data: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        fcmToken: user.fcmToken,
        full_name: user.full_name,
        account_number: user.account_number,
        branchId: user.branchId,
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
        profileImage: user.profileImage,
        kycStatus: user.kycStatus || 'NOT_SUBMITTED',
        countryCode: user.countryCode || 'CD',
        wallets: wallets,
        kyc: kyc,
      },
    };
  }

  // ================================================================
  // GET USER BY PHONE
  // ================================================================

  async getUserByPhone(
    phone: string,
    lang: string = 'fr',
  ): Promise<{
    message: string;
    data: {
      id: string;
      email: string | null;
      phone: string | null;
      fcmToken: string | null;
      full_name: string | null;
      account_number: string | null;
      branchId: string | null;
      branch: {
        id: string;
        name: string;
        code: string;
        countryId: string;
        status: string;
      } | null;
      role: string;
      passwordStatus: string | null;
      pinstatus: boolean | null;
      merchantCode: string | null;
      businessName: string | null;
      status: string;
      deleted: boolean;
      createdAt: Date;
      updatedAt: Date;
      profileImage: string | null;
      kycStatus: string;
      countryCode: string | null;
      wallets: any[];
      kyc: any;
    };
  }> {
    console.log(
      `[getUserByPhone] Langue utilisée : ${lang} pour le téléphone ${phone}`,
    );

    const user = await this.prisma.user.findFirst({
      where: { phone },
      select: {
        id: true,
        email: true,
        phone: true,
        full_name: true,
        account_number: true,
        branchId: true,
        profileImage: true,
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
        merchantType: true,
        businessCategory: true,
        businessAddress: true,
        failed_login_attempts: true,
        locked_until: true,
        kycStatus: true,
        countryCode: true,
      },
    });

    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

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
          status: branch.status || 'INACTIVE',
        };
      }
    }

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

    return {
      message: this.i18nService.translate('user_retrieved_success', lang),
      data: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        fcmToken: user.fcmToken,
        full_name: user.full_name,
        account_number: user.account_number,
        branchId: user.branchId,
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
        profileImage: user.profileImage,
        kycStatus: user.kycStatus || 'NOT_SUBMITTED',
        countryCode: user.countryCode || 'CD',
        wallets: wallets,
        kyc: kyc,
      },
    };
  }

  // apps/user-service/src/user-service.service.ts

  async updateUser(
    id: string,
    data: UpdateUserDto,
    lang: string = 'fr',
  ): Promise<ApiResponse<UserResponseDto>> {
    console.log(`[updateUser] Langue utilisée : ${lang} pour l'utilisateur ${id}`);

    // Récupérer l'utilisateur existant
    const existingUser = await this.prisma.user.findUnique({ where: { id } });
    if (!existingUser) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

    // ✅ 1️⃣ Vérifier que la branche existe si fournie
    let branchId = existingUser.branchId;
    if (data.branchId) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: data.branchId },
      });
      if (!branch) {
        throw new RpcException({
          status: 'error',
          message: 'Branch not found',
          statusCode: 404,
        });
      }
      branchId = data.branchId;
    }

    // 2️⃣ Vérification d'unicité du téléphone (si changement)
    if (data.phone && data.phone !== existingUser.phone) {
      const phoneExists = await this.prisma.user.findFirst({
        where: { phone: data.phone, id: { not: id } },
      });
      if (phoneExists) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('user_already_exists_with_phone_and_role', lang),
          statusCode: 409,
        });
      }
    }

    // 3️⃣ Vérification du compte bancaire (si changement d'account_number)
    if (
      data.account_number &&
      data.account_number !== existingUser.account_number
    ) {
      const existingUserWithAccount = await this.prisma.user.findFirst({
        where: {
          account_number: data.account_number,
          id: { not: id },
        },
      });

      if (existingUserWithAccount) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('account_already_used', lang, {
            account: data.account_number,
          }),
          statusCode: 409,
        });
      }
    }

    // 4️⃣ Génération d'un code marchand si le rôle devient MERCHANT et qu'il n'en a pas déjà un
    const newRole = data.role || existingUser.role;
    let merchantCode = existingUser.merchantCode;
    if (newRole === 'MERCHANT' && !merchantCode) {
      let isUnique = false;
      while (!isUnique) {
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const existing = await this.prisma.user.findFirst({
          where: { merchantCode: code, id: { not: id } },
        });
        if (!existing) {
          merchantCode = code;
          isUnique = true;
        }
      }
    } else if (newRole !== 'MERCHANT' && merchantCode) {
      merchantCode = null;
    }

    // 5️⃣ Préparation des données de mise à jour
    const updateData: any = { updatedAt: new Date() };

    if (data.email) updateData.email = data.email.toLowerCase();
    if (data.phone) updateData.phone = data.phone;
    if (data.full_name) updateData.full_name = data.full_name;
    if (data.account_number) updateData.account_number = data.account_number;
    if (branchId !== existingUser.branchId) updateData.branchId = branchId; // ✅ Mise à jour de la branche
    if (data.role) updateData.role = data.role;
    if (data.status) updateData.status = data.status;
    if (data.businessName) updateData.businessName = data.businessName;
    if (merchantCode !== existingUser.merchantCode) updateData.merchantCode = merchantCode;

    // ✅ Nouveaux champs marchands
    if (data.merchantType !== undefined) {
      updateData.merchantType = data.merchantType as user_merchantType || null;
    }
    if (data.businessCategory !== undefined) {
      updateData.businessCategory = data.businessCategory || null;
    }
    if (data.businessAddress !== undefined) {
      updateData.businessAddress = data.businessAddress || null;
    }
    if (data.countryCode !== undefined) {
      updateData.countryCode = data.countryCode || 'CD';
    }

    // Gestion du mot de passe
    if (data.password) {
      updateData.password = await bcrypt.hash(data.password, 10);
      updateData.passwordStatus = user_passwordStatus.CHANGED;
    }

    // Gestion du PIN
    if (data.pin) {
      const hashedPin = crypto
        .createHash('sha256')
        .update(data.pin)
        .digest('hex');
      updateData.pin = hashedPin;
      updateData.pinstatus = true;
    }

    // 6️⃣ Mise à jour
    try {
      const user = await this.prisma.user.update({
        where: { id },
        data: updateData,
      });

      // ✅ 7️⃣ Récupérer la branche pour la réponse
      let branchData: {
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
          branchData = {
            id: branch.id,
            name: branch.name,
            code: branch.code,
            countryId: branch.countryId,
            status: branch.status || 'INACTIVE',
          };
        }
      }

      // SMS de confirmation
      const phoneToUse = data.phone || existingUser.phone;
      if (phoneToUse) {
        const cleanPhone = phoneToUse.replace(/[^0-9+]/g, '');
        let smsText = this.i18nService.translate('profile_update_sms', lang, {
          full_name: user.full_name,
          account_number: user.account_number,
        });
        if (merchantCode && merchantCode !== existingUser.merchantCode) {
          smsText += ' ' + this.i18nService.translate('merchant_code_sms', lang, { merchantCode });
        }
        if (data.password) {
          smsText += ' ' + this.i18nService.translate('password_changed_sms', lang);
        }
        if (data.pin) {
          smsText += ' ' + this.i18nService.translate('pin_changed_sms', lang);
        }
        try {
          await this.smsService.sendSms(cleanPhone, smsText);
          console.log(`SMS de mise à jour envoyé à ${cleanPhone}`);
        } catch (smsErr) {
          console.error(`SMS de mise à jour non envoyé à ${cleanPhone}:`, smsErr.message);
        }
      }

      // ✅ 8️⃣ Retour avec la branche
      const responseData = this.toResponse(user);

      return {
        message: this.i18nService.translate('user_updated_success', lang),
        data: {
          ...responseData,
          branch: branchData,
        } as UserResponseDto,
      };
    } catch (error) {
      if (error.code === 'P2002') {
        const target = error.meta?.target;
        let field = 'champ';
        if (Array.isArray(target)) {
          if (target.includes('phone')) field = 'numéro de téléphone';
          else if (target.includes('email')) field = 'adresse email';
          else if (target.includes('account_number')) field = 'numéro de compte';
        }
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('unique_constraint', lang, {
            field,
          }),
          statusCode: 409,
        });
      }
      throw new RpcException({
        status: 'error',
        message:
          error instanceof Error ? error.message : 'Failed to update user',
        statusCode: 400,
      });
    }
  }

  async updateuser_status(
    id: string,
    status: string,
    requesterId: string,
    lang: string = 'fr',
  ): Promise<ApiResponse<UserResponseDto>> {
    console.log(
      `[updateuser_status] Langue: ${lang}, user: ${id}, requester: ${requesterId}, status: ${status}`,
    );

    // Vérifier que l'utilisateur existe
    const userExist = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, status: true },
    });

    if (!userExist) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

    // Empêcher un administrateur de se modifier lui-même
    if (requesterId === id) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('cannot_change_own_status', lang),
        statusCode: 403,
      });
    }

    // Valider et normaliser le statut
    if (!status || typeof status !== 'string') {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('status_required', lang),
        statusCode: 400,
      });
    }

    const normalized = status.trim().toUpperCase();
    const allowed = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'BLOCKED'];
    if (!allowed.includes(normalized)) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('invalid_status', lang, {
          allowed: allowed.join(', '),
        }),
        statusCode: 400,
      });
    }

    // Mapper vers l'enum Prisma
    let enumStatus: user_status;
    switch (normalized) {
      case 'ACTIVE':
        enumStatus = user_status.ACTIVE;
        break;
      case 'INACTIVE':
        enumStatus = user_status.INACTIVE;
        break;
      case 'SUSPENDED':
        enumStatus = user_status.SUSPENDED;
        break;
      case 'BLOCKED':
        enumStatus = user_status.BLOCKED;
        break;
      default:
        throw new RpcException({
          status: 'error',
          message: 'Statut non reconnu',
          statusCode: 400,
        });
    }

    // ✅ Préparer les données de mise à jour
    const updateData: any = {
      status: enumStatus,
      updatedAt: new Date()
    };

    // ✅ Si le statut est BLOCKED, c'est un blocage par admin
    if (normalized === 'BLOCKED') {
      updateData.locked_by_admin = true;
      updateData.locked_until = null; // Pas de déblocage auto
      updateData.failed_login_attempts = 0;
    }

    // ✅ Si on passe de BLOCKED à un autre statut, réinitialiser locked_by_admin
    if (userExist.status === user_status.BLOCKED && normalized !== 'BLOCKED') {
      updateData.locked_by_admin = false;
      updateData.locked_until = null;
      updateData.failed_login_attempts = 0;
    }

    // ✅ Mise à jour
    const updatedUser = await this.prisma.user.update({
      where: { id },
      data: updateData,
    });

    // ✅ Audit log
    await this.logAudit(
      requesterId,
      `UPDATE_USER_STATUS_TO_${normalized}`,
      {
        targetUserId: id,
        oldStatus: userExist.status,
        newStatus: normalized,
        lockedByAdmin: normalized === 'BLOCKED',
      },
      null,
    );

    return {
      message: this.i18nService.translate('status_updated_success', lang),
      data: this.toResponse(updatedUser),
    };
  }
  // ========================= DELETE USER (SOFT) =========================
  async deleteUser(
    id: string,
    lang: string = 'fr',
  ): Promise<ApiResponse<null>> {
    console.log(
      `[deleteUser] Langue utilisée : ${lang} pour l'utilisateur ${id}`,
    );
    await this.prisma.user.update({
      where: { id },
      data: { deleted: true, updatedAt: new Date() },
    });
    return {
      message: this.i18nService.translate('user_deleted_success', lang),
      data: null,
    };
  }

  // ========================= LIST USERS =========================
  async listUsers(params: {
    page: number;
    limit: number;
    role?: string;
    status?: string;
    lang?: string;
  }) {
    const lang = params.lang || 'fr';
    console.log(`[listUsers] Langue utilisée : ${lang}`);
    const { page = 1, limit = 10, role, status } = params;
    const skip = (page - 1) * limit;
    const where: any = { deleted: false };

    // Si aucun rôle n'est spécifié, on limite aux ADMIN et SUPER_ADMIN
    if (!role) {
      where.role = { in: [user_role.ADMIN, user_role.SUPER_ADMIN] };
    } else {
      where.role = role as user_role;
    }

    if (status) where.status = status;

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      users: users.map((user) => this.toResponse(user)),
      total,
      page,
      limit,
    };
  }

  // ========================= LIST USERS WITH ACCOUNT =========================
  async listUsersLinks(params: {
    page: number;
    limit: number;
    role?: string;
    status?: string;
    lang?: string;
  }) {
    const lang = params.lang || 'fr';
    console.log(`[listUsersLinks] Langue utilisée : ${lang}`);
    const { page = 1, limit = 10, role, status } = params;
    const skip = (page - 1) * limit;
    const where: any = { deleted: false, account_number: { not: null } };
    if (role) where.role = role;
    if (status) where.status = status;

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      users: users.map((user) => this.toResponse(user)),
      total,
      page,
      limit,
    };
  }

  // ========================= CHANGE PIN =========================
  async changePin(
    userId: string,
    pin: string,
    lang: string = 'fr',
  ): Promise<{ message: string; data: any }> {
    console.log(
      `[changePin] Langue utilisée : ${lang} pour l'utilisateur ${userId}`,
    );
    if (!pin || pin.length < 4) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('pin_min_length', lang),
        statusCode: 400,
      });
    }
    if (!/^\d+$/.test(pin)) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('pin_digits_only', lang),
        statusCode: 400,
      });
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user)
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });

    // ✅ Utiliser le mot de passe "Mdp2026@" (comme demandé)
    // const plainPassword = 'Mdp2026@';
    // const hashedPassword = await bcrypt.hash(plainPassword, 10);

    // 🔐 Hasher le nouveau PIN
    const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        pin: hashedPin,
        pinstatus: true,
        passwordStatus: 'CHANGED'
      },
    });

    // 📱 Envoyer le SMS avec le même format que register
    // try {
    //   const welcomeSms = this.i18nService.translate('welcome_sms', lang, {
    //     full_name: updatedUser.full_name,
    //     account_number: updatedUser.account_number,
    //     phone: updatedUser.phone,
    //     password: plainPassword, // ✅ "Mdp2026@"
    //     pin: pin, // ✅ Le nouveau PIN
    //   });

    //   await this.smsService.sendSms(
    //     updatedUser.phone || '',
    //     welcomeSms,
    //     updatedUser.countryCode || ''
    //   );
    //   console.log(`✅ SMS envoyé à ${updatedUser.phone} avec mot de passe: ${plainPassword} et PIN: ${pin}`);
    // } catch (err) {
    //   console.error('❌ Erreur SMS:', err);
    // }

    const { password, pin: _, ...safeUser } = updatedUser;
    return {
      message: this.i18nService.translate('pin_changed_success', lang),
      data: safeUser,
    };
  }

  // ========================= UPDATE PIN =========================
  async updatePin(
    userId: string,
    oldPin: string,
    newPin: string,
    lang: string = 'fr',
  ): Promise<{ message: string; data: any }> {
    console.log(
      `[updatePin] Langue utilisée : ${lang} pour l'utilisateur ${userId}`,
    );
    if (!oldPin || oldPin.length < 4)
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('old_pin_min_length', lang),
        statusCode: 400,
      });
    if (!/^\d+$/.test(oldPin))
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('pin_digits_only', lang),
        statusCode: 400,
      });
    if (!newPin || newPin.length < 4)
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('new_pin_min_length', lang),
        statusCode: 400,
      });
    if (!/^\d+$/.test(newPin))
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('pin_digits_only', lang),
        statusCode: 400,
      });

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user)
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    if (!user.pin)
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('no_pin_set', lang),
        statusCode: 400,
      });

    const hashedOldPin = crypto
      .createHash('sha256')
      .update(oldPin)
      .digest('hex');
    if (user.pin !== hashedOldPin)
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('old_pin_incorrect', lang),
        statusCode: 401,
      });

    const hashedNewPin = crypto
      .createHash('sha256')
      .update(newPin)
      .digest('hex');
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { pin: hashedNewPin, pinstatus: true },
    });
    const { password, pin: _, ...safeUser } = updatedUser;
    return {
      message: this.i18nService.translate('pin_changed_success', lang),
      data: safeUser,
    };
  }
  // ========================= VERIFY PIN =========================
  async verifyPin(
    userId: string,
    pin: string,
    lang: string = 'fr',
  ): Promise<{ valid: boolean; message: string }> {
    console.log(
      `[verifyPin] Langue utilisée : ${lang} pour l'utilisateur ${userId}`,
    );

    // 1. Validation du format
    if (!pin || pin.length < 4) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('pin_min_length', lang),
        statusCode: 400,
      });
    }
    if (!/^\d+$/.test(pin)) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('pin_digits_only', lang),
        statusCode: 400,
      });
    }

    // 2. Récupérer l'utilisateur
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        pin: true,
        status: true,
        failed_pin_attempts: true,
        pin_locked_until: true,
      },
    });

    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

    // 3. Vérifier blocage permanent
    if (user.status === user_status.BLOCKED) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('account_blocked_admin', lang),
        statusCode: 403,
      });
    }

    // 4. Vérifier blocage temporaire PIN
    if (user.pin_locked_until && user.pin_locked_until > new Date()) {
      const minutesLeft = Math.ceil(
        (user.pin_locked_until.getTime() - Date.now()) / 60000,
      );
      let message = this.i18nService.translate('wallet.pin_locked', lang);
      message = message.replace('{minutes}', minutesLeft.toString());
      throw new RpcException({ status: 'error', message, statusCode: 403 });
    }

    if (!user.pin) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('no_pin_set', lang),
        statusCode: 400,
      });
    }

    const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
    const isValid = user.pin === hashedPin;

    if (!isValid) {
      const newAttempts = (user.failed_pin_attempts || 0) + 1;
      let newStatus: user_status = user.status;
      let lockedUntil: Date | null = null;
      if (newAttempts >= 5) {
        newStatus = user_status.BLOCKED;
        lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
      }
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          failed_pin_attempts: newAttempts,
          status: newStatus,
          pin_locked_until: lockedUntil,
        },
      });
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('pin_invalid', lang),
        statusCode: 400,
      });
    }

    // ✅ Succès : réinitialiser les tentatives et débloquer
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failed_pin_attempts: 0,
        pin_locked_until: null,
        status: user_status.ACTIVE, // on remet à ACTIVE (le compte ne peut pas être BLOCKED ici)
      },
    });

    return {
      valid: true,
      message: this.i18nService.translate('pin_valid', lang),
    };
  }
  //==============================user_settings====================

  async getUserSettings(
    userId: string,
  ): Promise<{ message: string; data: any }> {
    let settings = await this.prisma.user_settings.findFirst({
      where: { user_id: userId },
    });
    if (!settings) {
      settings = await this.prisma.user_settings.create({
        data: {
          id: crypto.randomUUID(),
          user_id: userId,
        },
      });
    }
    return {
      message: 'Settings retrieved successfully',
      data: settings,
    };
  }

  async updateUserSettings(
    userId: string,
    dto: UpdateUserSettingsDto,
  ): Promise<{ message: string; data: any }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new RpcException({
        status: 'error',
        message: 'User not found',
        statusCode: 404,
      });
    }
    const data: any = { ...dto };
    if (dto.theme) {
      // Convertir en minuscule pour correspondre à l'enum Prisma
      data.theme = dto.theme.toLowerCase();
    }
    let settings = await this.prisma.user_settings.findFirst({
      where: { user_id: userId },
    });

    if (settings) {
      settings = await this.prisma.user_settings.update({
        where: { id: settings.id },
        data: data,
      });
    } else {
      settings = await this.prisma.user_settings.create({
        data: { user_id: userId, ...data },
      });
    }

    return {
      message: 'Settings updated successfully',
      data: settings,
    };
  }
  // ========================= PRIVATE HELPER =========================
  // apps/user-service/src/user-service.service.ts

  private toResponse(user: any): UserResponseDto {
    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      full_name: user.full_name,
      account_number: user.account_number,
      branchId: user.branchId ?? null,
      role: user.role,
      status: user.status,
      deleted: user.deleted ?? false,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      fcmToken: user.fcmToken ?? null,
      passwordStatus: user.passwordStatus ?? null,
      pinstatus: user.pinstatus ?? null,
      merchantCode: user.merchantCode ?? null,
      businessName: user.businessName ?? null,
      countryCode: user.countryCode ?? null,
      merchantType: user.merchantType ?? null,
      businessCategory: user.businessCategory ?? null,
      businessAddress: user.businessAddress ?? null,
      failed_login_attempts: user.failed_login_attempts ?? null,
      locked_until: user.locked_until ?? null,
      profileImage: user.profileImage ?? null,
      kycStatus: user.kycStatus ?? null,
      // ✅ Ajouter branch si disponible
      branch: user.branch ? {
        id: user.branch.id,
        name: user.branch.name,
        code: user.branch.code,
        countryId: user.branch.countryId,
        status: user.branch.status,
      } : null,
    };
  }

  // apps/wallet-service/src/wallet-service.service.ts

  async getAdminDashboard(
    adminId: string,
    filters?: {
      startDate?: Date;
      endDate?: Date;
      countryCode?: string;
      branchId?: string;
    }
  ) {
    try {
      // 1️⃣ Récupérer l'admin et ses permissions
      const admin = await this.prisma.user.findUnique({
        where: { id: adminId },
        select: {
          id: true,
          role: true,
          branchId: true,
          user_has_resources: {
            where: {
              resources: {
                name: 'dashboard'
              }
            },
            select: {
              canManage: true,
              canRead: true,
              branchId: true,
            }
          }
        }
      });

      if (!admin) {
        throw new RpcException({
          status: 'error',
          message: 'Admin not found',
          statusCode: 404,
        });
      }

      // 2️⃣ Déterminer les branches autorisées
      let allowedBranchIds: string[] = [];
      let isSuperAdmin = admin.role === 'SUPER_ADMIN';
      let hasManagePermission = false;
      let hasReadPermission = false;

      for (const resource of admin.user_has_resources || []) {
        if (resource.canManage) {
          hasManagePermission = true;
          break;
        }
        if (resource.canRead) {
          hasReadPermission = true;
        }
      }

      if (isSuperAdmin || hasManagePermission) {
        const allBranches = await this.prisma.branch.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true }
        });
        allowedBranchIds = allBranches.map(b => b.id);
      } else if (hasReadPermission && admin.branchId) {
        allowedBranchIds = [admin.branchId];
      } else if (admin.branchId) {
        allowedBranchIds = [admin.branchId];
      } else {
        allowedBranchIds = [];
      }

      // 3️⃣ Si un branchId est passé en filtre
      let targetBranchId = filters?.branchId;
      if (targetBranchId) {
        if (!allowedBranchIds.includes(targetBranchId)) {
          throw new RpcException({
            status: 'error',
            message: 'You do not have permission to view this branch',
            statusCode: 403,
          });
        }
      }

      // 4️⃣ Récupérer les branches disponibles pour l'admin
      const availableBranches = await this.prisma.branch.findMany({
        where: {
          id: { in: allowedBranchIds },
          status: 'ACTIVE'
        },
        select: {
          id: true,
          name: true,
          code: true,
          countryId: true,
          status: true,
        },
        orderBy: { name: 'asc' }
      });

      // 5️⃣ Construction du filtre des utilisateurs - PAS DE FILTRE BRANCH
      const userWhere: any = { deleted: false };

      if (filters?.countryCode) {
        userWhere.countryCode = filters.countryCode.toUpperCase();
      }

      // 6️⃣ Normalisation des dates
      let { startDate, endDate } = filters || {};
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        startDate = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        endDate = end;
      }

      const now = new Date();
      if (!startDate && !endDate) {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        endDate = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          23,
          59,
          59,
          999,
        );
      }

      const dateFilter: any = {};
      if (startDate && !isNaN(startDate.getTime())) {
        dateFilter.gte = startDate;
      }
      if (endDate && !isNaN(endDate.getTime())) {
        dateFilter.lte = endDate;
      }

      // 7️⃣ Construction du filtre des transactions - AVEC FILTRE BRANCH
      const transactionWhere: any = {};
      if (Object.keys(dateFilter).length > 0) {
        transactionWhere.createdAt = dateFilter;
      }

      // ✅ FILTRE PAR BRANCHE SUR LES TRANSACTIONS SEULEMENT
      if (targetBranchId) {
        transactionWhere.branchId = targetBranchId;
      } else if (allowedBranchIds.length === 1) {
        transactionWhere.branchId = allowedBranchIds[0];
      }

      if (filters?.countryCode) {
        transactionWhere.user = {
          countryCode: filters.countryCode.toUpperCase()
        };
      }

      console.log('[Dashboard] Admin:', {
        role: admin.role,
        branchId: admin.branchId,
        allowedBranchIds,
        targetBranchId,
        hasManagePermission,
        hasReadPermission,
        isSuperAdmin
      });

      // ========== 1. MÉTRIQUES PRINCIPALES ==========
      const [
        totalUsers,
        totalWalletBalance,
        totalTransactions,
        totalTransactionVolume,
        totalMerchantPayments,
        failedTransactions,
        pendingTransactions,
        totalMerchant,
        totalAdmin,
        totalSuperAdmin,
        totalCreditAmount,
        totalDebitAmount,
      ] = await Promise.all([
        this.prisma.user.count({ where: userWhere }),
        this.prisma.wallet.aggregate({
          where: {
            user: userWhere
          },
          _sum: { balance: true }
        }),
        this.prisma.transaction.count({ where: transactionWhere }),
        this.prisma.transaction.aggregate({
          where: transactionWhere,
          _sum: { amount: true },
        }),
        this.prisma.transaction.count({
          where: { ...transactionWhere, type: 'PAYMENT' },
        }),
        this.prisma.transaction.count({
          where: { ...transactionWhere, status: 'FAILED' },
        }),
        this.prisma.transaction.count({
          where: { ...transactionWhere, status: 'PENDING' },
        }),
        this.prisma.user.count({ where: { ...userWhere, role: 'MERCHANT' } }),
        this.prisma.user.count({ where: { ...userWhere, role: 'ADMIN' } }),
        this.prisma.user.count({ where: { ...userWhere, role: 'SUPER_ADMIN' } }),
        this.prisma.transaction.aggregate({
          where: { ...transactionWhere, movement: 'CREDIT' },
          _sum: { amount: true },
        }),
        this.prisma.transaction.aggregate({
          where: { ...transactionWhere, movement: 'DEBIT' },
          _sum: { amount: true },
        }),
      ]);

      // ========== 2. VOLUME PAR CURRENCY ==========
      const volume = await this.prisma.transaction.groupBy({
        by: ['currency'],
        where: transactionWhere,
        _sum: { amount: true },
        _count: { id: true },
      });

      // ========== 3. MERCHANT PAYMENTS PAR CURRENCY ==========
      const merchantPayments = await this.prisma.transaction.groupBy({
        by: ['currency'],
        where: { ...transactionWhere, type: 'PAYMENT' },
        _sum: { amount: true },
        _count: { id: true },
      });

      // ========== 4. CASH PAR CURRENCY ==========
      const cashRaw = await this.prisma.transaction.groupBy({
        by: ['currency'],
        where: {
          ...transactionWhere,
          paymentMethod: 'CASH'
        },
        _sum: { amount: true },
        _count: { id: true },
      });

      const cashCreditRaw = await this.prisma.transaction.groupBy({
        by: ['currency'],
        where: {
          ...transactionWhere,
          paymentMethod: 'CASH',
          movement: 'CREDIT'
        },
        _sum: { amount: true },
      });

      const cashDebitRaw = await this.prisma.transaction.groupBy({
        by: ['currency'],
        where: {
          ...transactionWhere,
          paymentMethod: 'CASH',
          movement: 'DEBIT'
        },
        _sum: { amount: true },
      });

      const cashMap = new Map();
      for (const item of cashRaw) {
        const currency = item.currency || 'N/A';
        cashMap.set(currency, {
          currency,
          count: item._count.id || 0,
          credit: 0,
          debit: 0,
          balance: 0,
        });
      }
      for (const item of cashCreditRaw) {
        const currency = item.currency || 'N/A';
        if (cashMap.has(currency)) {
          cashMap.get(currency).credit = item._sum.amount || 0;
        }
      }
      for (const item of cashDebitRaw) {
        const currency = item.currency || 'N/A';
        if (cashMap.has(currency)) {
          cashMap.get(currency).debit = item._sum.amount || 0;
        }
      }
      for (const [, value] of cashMap) {
        value.balance = (value.credit || 0) - (value.debit || 0);
      }
      const cash = Array.from(cashMap.values());

      // ========== 5. MOBILE PAR CURRENCY ==========
      const mobileRaw = await this.prisma.transaction.groupBy({
        by: ['currency'],
        where: {
          ...transactionWhere,
          paymentMethod: 'MOBILE_MONEY'
        },
        _sum: { amount: true },
        _count: { id: true },
      });

      const mobileCreditRaw = await this.prisma.transaction.groupBy({
        by: ['currency'],
        where: {
          ...transactionWhere,
          paymentMethod: 'MOBILE_MONEY',
          movement: 'CREDIT'
        },
        _sum: { amount: true },
      });

      const mobileDebitRaw = await this.prisma.transaction.groupBy({
        by: ['currency'],
        where: {
          ...transactionWhere,
          paymentMethod: 'MOBILE_MONEY',
          movement: 'DEBIT'
        },
        _sum: { amount: true },
      });

      const mobileMap = new Map();
      for (const item of mobileRaw) {
        const currency = item.currency || 'N/A';
        mobileMap.set(currency, {
          currency,
          count: item._count.id || 0,
          credit: 0,
          debit: 0,
          balance: 0,
        });
      }
      for (const item of mobileCreditRaw) {
        const currency = item.currency || 'N/A';
        if (mobileMap.has(currency)) {
          mobileMap.get(currency).credit = item._sum.amount || 0;
        }
      }
      for (const item of mobileDebitRaw) {
        const currency = item.currency || 'N/A';
        if (mobileMap.has(currency)) {
          mobileMap.get(currency).debit = item._sum.amount || 0;
        }
      }
      for (const [, value] of mobileMap) {
        value.balance = (value.credit || 0) - (value.debit || 0);
      }
      const mobile = Array.from(mobileMap.values());

      const totalDownloads = 0;
      const totalVolume = totalTransactionVolume._sum.amount || 0;
      const totalCredits = totalCreditAmount._sum.amount || 0;
      const totalDebits = totalDebitAmount._sum.amount || 0;
      const netBalance = totalCredits - totalDebits;

      // ========== 6. GRAPHIQUE VOLUME ==========
      let volumeChart: any[] = [];
      const dailyVolume = await this.prisma.transaction.groupBy({
        by: ['createdAt'],
        where: transactionWhere,
        _sum: { amount: true },
        _count: { id: true },
        orderBy: { createdAt: 'asc' },
      });

      const dailyMap = new Map();
      for (const item of dailyVolume) {
        const date = new Date(item.createdAt);
        const dateKey = date.toISOString().split('T')[0];
        if (!dailyMap.has(dateKey)) {
          dailyMap.set(dateKey, { volume: 0, count: 0 });
        }
        const existing = dailyMap.get(dateKey);
        existing.volume += item._sum.amount || 0;
        existing.count += item._count.id || 0;
      }

      volumeChart = Array.from(dailyMap.entries()).map(([date, data]) => ({
        date: new Date(date),
        volume: data.volume,
        count: data.count,
      }));

      // ========== 7. PAIEMENTS PAR TYPE ==========
      const paymentsByType = await this.prisma.transaction.groupBy({
        by: ['type'],
        where: transactionWhere,
        _sum: { amount: true },
        _count: { type: true },
      });
      const typeMapping: Record<string, string> = {
        PAYMENT: 'Paiement',
        TRANSFER: 'Transfert',
        DEPOSIT: 'Dépôt',
        WITHDRAW: 'Retrait',
      };
      const formattedPayments = paymentsByType.map((p) => ({
        type: (p.type && typeMapping[p.type]) ? typeMapping[p.type] : (p.type || 'unknown'),
        totalAmount: p._sum.amount || 0,
        count: p._count.type || 0,
      }));

      // ========== 8. CROISSANCE DES UTILISATEURS - PAS DE FILTRE BRANCH ==========
      let userGrowth = await this.prisma.$queryRaw`
      SELECT DATE_FORMAT(createdAt, '%Y-%m') as month, COUNT(*) as newUsers
      FROM user
      WHERE createdAt >= ${startDate}
        AND createdAt <= ${endDate}
        ${filters?.countryCode ? Prisma.sql`AND countryCode = ${filters.countryCode.toUpperCase()}` : Prisma.sql``}
      GROUP BY month
      ORDER BY month ASC
    `;
      userGrowth = (userGrowth as any[]).map((u) => ({
        ...u,
        newUsers: Number(u.newUsers),
      }));

      const platformRevenue = 0;
      const quickStatus = {
        successRate: totalTransactions
          ? (
            ((totalTransactions - failedTransactions) / totalTransactions) *
            100
          ).toFixed(1)
          : 0,
        avgTransactionAmount: totalTransactions
          ? totalVolume / totalTransactions
          : 0,
        pendingRate: totalTransactions
          ? ((pendingTransactions / totalTransactions) * 100).toFixed(1)
          : 0,
      };

      // ========== 9. PAYS DISPONIBLES - PAS DE FILTRE BRANCH ==========
      const availableCountries = await this.prisma.user.groupBy({
        by: ['countryCode'],
        where: { deleted: false },
        _count: { id: true },
      });

      // ========== RÉPONSE ==========
      return {
        message: 'Dashboard data retrieved successfully',
        data: {
          filters: {
            startDate,
            endDate,
            countryCode: filters?.countryCode || null,
            branchId: targetBranchId || null,
          },
          availableBranches: availableBranches,
          availableCountries: availableCountries
            .filter(c => c.countryCode)
            .map(c => ({
              code: c.countryCode,
              count: c._count.id,
            }))
            .sort((a, b) => b.count - a.count),
          keyMetrics: {
            totalRegisteredUsers: totalUsers,
            totalApplicationDownloads: totalDownloads,
            totalMarchant: totalMerchant,
            totalAdmin,
            totalSuperAdmin,
            totalWalletBalances: totalWalletBalance._sum.balance || 0,
            totalTransactionsToday: totalTransactions,
            totalTransactionVolume: totalVolume,
            totalMerchantPayments,
            failedTransactions,
            pendingTransactions,
            totalCreditAmount: totalCredits,
            totalDebitAmount: totalDebits,
            netBalance,
          },
          volume: volume.map((v) => ({
            currency: v.currency || 'N/A',
            totalAmount: v._sum.amount || 0,
            count: v._count.id || 0,
          })),
          merchantPayments: merchantPayments.map((v) => ({
            currency: v.currency || 'N/A',
            totalAmount: v._sum.amount || 0,
            count: v._count.id || 0,
          })),
          cash: cash,
          mobile: mobile,
          charts: {
            transactionVolume: volumeChart,
            paymentsByType: formattedPayments,
            userGrowth,
            platformRevenue,
          },
          quickStatus,
        },
      };
    } catch (error) {
      console.error('[Dashboard] Error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to fetch dashboard data',
        statusCode: 500,
      });
    }
  }
  // ========================= RESOURCES MANAGEMENT =========================
  async createResource(data: CreateResourceDto) {
    try {
      const resource = await this.prisma.resources.create({
        data: {
          id: crypto.randomUUID(),
          name: data.name,
          label: data.label,
          description: data.description,
        },
      });
      return {
        message: 'Resource created successfully',
        data: resource,
      };
    } catch (error) {
      if (error.code === 'P2002') {
        throw new RpcException({
          status: 'error',
          message: `Resource with name "${data.name}" already exists.`,
          statusCode: 409,
        });
      }
      throw error;
    }
  }

  async updateResource(id: string, data: UpdateResourceDto) {
    const exists = await this.prisma.resources.findUnique({ where: { id } });
    if (!exists) {
      throw new RpcException({
        status: 'error',
        message: 'Resource not found',
        statusCode: 404,
      });
    }
    try {
      const resource = await this.prisma.resources.update({
        where: { id },
        data: {
          name: data.name,
          label: data.label,
          description: data.description,
        },
      });
      return {
        message: 'Resource updated successfully',
        data: resource,
      };
    } catch (error) {
      if (error.code === 'P2002') {
        throw new RpcException({
          status: 'error',
          message: `Resource name "${data.name}" already taken.`,
          statusCode: 409,
        });
      }
      throw error;
    }
  }

  async getAllResources(page: number = 1, limit: number = 10) {
    const skip = (page - 1) * limit;
    const [resources, total] = await Promise.all([
      this.prisma.resources.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.resources.count(),
    ]);
    const totalPages = Math.ceil(total / limit);
    return {
      message: 'Resources retrieved successfully',
      data: {
        data: resources,
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  async getOneResource(id: string) {
    const resource = await this.prisma.resources.findUnique({ where: { id } });
    if (!resource) {
      throw new RpcException({
        status: 'error',
        message: 'Resource not found',
        statusCode: 404,
      });
    }
    return {
      message: 'Resource retrieved successfully',
      data: resource,
    };
  }

  // ---------- User Has Resources ----------
  async assignMultipleResourcesToUser(data: AssignMultipleResourcesDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: data.userId },
    });
    if (!user)
      throw new RpcException({
        status: 'error',
        message: 'User not found',
        statusCode: 404,
      });

    // ✅ Vérifier que la branche existe si fournie
    if (data.branchId) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: data.branchId },
      });
      if (!branch) {
        throw new RpcException({
          status: 'error',
          message: `Branch with id ${data.branchId} not found`,
          statusCode: 404,
        });
      }
    }

    // 1️⃣ Supprimer TOUTES les assignations existantes de l'utilisateur
    await this.prisma.user_has_resources.deleteMany({
      where: { userId: data.userId },
    });

    // 2️⃣ Créer les nouvelles assignations
    for (const item of data.resources) {
      const resource = await this.prisma.resources.findUnique({
        where: { id: item.resourceId },
      });
      if (!resource) {
        throw new RpcException({
          status: 'error',
          message: `Resource with id ${item.resourceId} not found`,
          statusCode: 404,
        });
      }

      await this.prisma.user_has_resources.create({
        data: {
          id: crypto.randomUUID(),
          userId: data.userId,
          resourceId: item.resourceId,
          branchId: data.branchId || null, // ✅ Utiliser le branchId du DTO
          canCreate: item.canCreate ?? false,
          canRead: item.canRead ?? false,
          canUpdate: item.canUpdate ?? false,
          canDelete: item.canDelete ?? false,
          canManage: item.canManage ?? false,
          grantedBy: data.grantedBy,
          expiresAt: item.expiresAt,
        },
      });
    }

    return { message: 'Resource assignments processed successfully' };
  }

  async getUserResources(userId: string) {
    const userResources = await this.prisma.user_has_resources.findMany({
      where: { userId },
      include: {
        resources: true,
        branch: {
          include: {
            country_provider: true,
          },
        },
      },
    });

    const data = userResources.map((ur) => ({
      resource: ur.resources,
      branch: ur.branch ? {
        id: ur.branch.id,
        name: ur.branch.name,
        code: ur.branch.code,
        address: ur.branch.address,
        country: ur.branch.country_provider?.name || null,
        countryCode: ur.branch.country_provider?.countryCode || null,
      } : null,
      canCreate: ur.canCreate,
      canRead: ur.canRead,
      canUpdate: ur.canUpdate,
      canDelete: ur.canDelete,
      canManage: ur.canManage,
      grantedAt: ur.grantedAt,
      grantedBy: ur.grantedBy,
      expiresAt: ur.expiresAt,
    }));

    return {
      message: 'User resources retrieved successfully',
      data,
    };
  }

  async revokeResource(userId: string, resourceId: string) {
    const assignment = await this.prisma.user_has_resources.findFirst({
      where: {
        userId: userId,
        resourceId: resourceId,
      },
    });
    if (!assignment) {
      throw new RpcException({
        status: 'error',
        message: 'Resource assignment not found',
        statusCode: 404,
      });
    }
    await this.prisma.user_has_resources.delete({
      where: { id: assignment.id },
    });
    return { message: 'Resource revoked successfully' };
  }

  async upsertAppSettings(data: UpsertAppSettingsDto) {
    // Vérifier si une configuration existe déjà
    const existing = await this.prisma.app_settings.findFirst();

    if (existing) {
      // Mise à jour : on conserve l'ID existant
      const settings = await this.prisma.app_settings.update({
        where: { id: existing.id },
        data: {
          ...data,
          updatedAt: new Date(),
        },
      });
      return {
        message: 'Application settings saved successfully',
        data: settings,
      };
    } else {
      // Création : l'ID est généré dynamiquement
      const settings = await this.prisma.app_settings.create({
        data: {
          id: crypto.randomUUID(), // génération dynamique d'un UUID
          app_name: data.app_name ?? '',
          slogan: data.slogan,
          description: data.description,
          email: data.email,
          phone: data.phone,
          address: data.address,
          default_language: data.default_language,
          default_currency: data.default_currency,
          timezone: data.timezone,
          logo: data.logo,
          favicon: data.favicon,
          primary_color: data.primary_color,
          secondary_color: data.secondary_color,
          maintenance_mode: data.maintenance_mode ?? false,
          maintenance_message: data.maintenance_message,
          allow_registration: data.allow_registration ?? true,
          transfer_fee: data.transfer_fee ?? 0,
          withdraw_fee: data.withdraw_fee ?? 0,
          facebook: data.facebook,
          instagram: data.instagram,
          twitter: data.twitter,
          stripe_enabled: data.stripe_enabled ?? false,
          paypal_enabled: data.paypal_enabled ?? false,
          mobile_money_enabled: data.mobile_money_enabled ?? false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      return {
        message: 'Application settings saved successfully',
        data: settings,
      };
    }
  }

  async getAppSettings() {
    try {
      // Récupérer le premier enregistrement au lieu d'un ID fixe
      const settings = await this.prisma.app_settings.findFirst();

      if (!settings) {
        return {
          success: false,
          message: 'Application settings not found',
          data: null,
          error: 'SETTINGS_NOT_FOUND'
        };
      }

      return {
        success: true,
        message: 'Application settings retrieved successfully',
        data: settings,
      };
    } catch (error) {
      console.error(`[getAppSettings] Error:`, error.message);
      return {
        success: false,
        message: 'Failed to retrieve application settings',
        data: null,
        error: 'UNKNOWN_ERROR',
      };
    }
  }

  // ========================= KYC MANAGEMENT =========================
  async submitKyc(
    userId: string,
    data: {
      documentType: string;
      documentNumber: string;
      documentFront: string;
      documentBack?: string;
      profileImage?: string;
    },
    lang: string = 'fr',
  ): Promise<{
    message: string;
    data: {
      id: string;
      email: string | null;
      phone: string | null;
      fcmToken: string | null;
      full_name: string | null;
      account_number: string | null;
      role: string;
      passwordStatus: string;
      pinstatus: boolean | null;
      merchantCode: string | null;
      businessName: string | null;
      status: string;
      deleted: boolean;
      createdAt: Date;
      updatedAt: Date;
      profileImage: string | null;
      wallets: any[];
      kyc: any;
    };
  }> {
    console.log(`[submitKyc] Utilisateur ${userId} soumet une demande KYC`);
    console.log(`[submitKyc] documentFront:`, data.documentFront);
    console.log(`[submitKyc] documentBack:`, data.documentBack);
    console.log(`[submitKyc] profileImage:`, data.profileImage);

    try {
      // 1. Vérifier que l'utilisateur existe
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });
      if (!user) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('user_not_found', lang),
          statusCode: 404,
        });
      }

      // 2. Vérifier les types de documents autorisés
      const allowedTypes = ['NATIONAL_ID', 'PASSPORT', 'DRIVING_LICENSE', 'RESIDENCE_PERMIT', 'VOTER_CARD', 'HEALTH_CARD', 'STUDENT_ID', 'PROFESSIONAL_ID', 'OTHER'];
      if (!allowedTypes.includes(data.documentType)) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('kyc_invalid_document_type', lang, {
            types: allowedTypes.join(', '),
          }),
          statusCode: 400,
        });
      }

      // 3. Vérifier que le numéro de document est fourni
      if (!data.documentNumber || data.documentNumber.trim() === '') {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('kyc_document_number_required', lang),
          statusCode: 400,
        });
      }

      // 4. Vérifier que l'URL du recto est fournie
      if (!data.documentFront || data.documentFront.trim() === '') {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('kyc_document_front_required', lang),
          statusCode: 400,
        });
      }

      // ✅ 5. Vérifier si une soumission KYC existe déjà
      const existingKyc = await this.prisma.kyc_submission.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });

      let kyc;

      // ✅ 6. Si une soumission existe, la mettre à jour (même si déjà VERIFIED)
      if (existingKyc) {
        console.log(`[submitKyc] 📝 Mise à jour de la soumission KYC existante: ${existingKyc.id}`);
        console.log(`[submitKyc] Status actuel: ${existingKyc.status}`);

        kyc = await this.prisma.kyc_submission.update({
          where: { id: existingKyc.id },
          data: {
            documentType: data.documentType,
            documentNumber: data.documentNumber,
            documentFront: data.documentFront,
            documentBack: data.documentBack || null,
            profileImage: data.profileImage || null,
            status: 'PENDING',
            submittedAt: new Date(),
            updatedAt: new Date(),
            reviewedAt: null,
            adminNotes: null,
            rejectionReason: null,
          },
        });

        await this.prisma.user.update({
          where: { id: userId },
          data: { kycStatus: 'PENDING' },
        });

      } else {
        // ✅ 7. Créer une nouvelle soumission KYC
        console.log(`[submitKyc] 📝 Création d'une nouvelle soumission KYC`);
        kyc = await this.prisma.kyc_submission.create({
          data: {
            id: crypto.randomUUID(),
            userId,
            documentType: data.documentType,
            documentNumber: data.documentNumber,
            documentFront: data.documentFront,
            documentBack: data.documentBack || null,
            profileImage: data.profileImage || null,
            status: 'PENDING',
            submittedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });

        await this.prisma.user.update({
          where: { id: userId },
          data: { kycStatus: 'PENDING' },
        });
      }

      // 8. Audit
      await this.logAudit(
        userId,
        existingKyc ? 'KYC_UPDATED' : 'KYC_SUBMITTED',
        {
          kycId: kyc.id,
          documentType: data.documentType,
          documentNumber: data.documentNumber,
          documentFront: data.documentFront,
          documentBack: data.documentBack,
          profileImage: data.profileImage,
          isUpdate: !!existingKyc,
          previousStatus: existingKyc?.status || null,
        },
        null,
      );

      // ✅ 9. Récupérer les informations complètes de l'utilisateur
      const updatedUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          phone: true,
          fcmToken: true,
          full_name: true,
          account_number: true,
          role: true,
          passwordStatus: true,
          pinstatus: true,
          merchantCode: true,
          businessName: true,
          status: true,
          deleted: true,
          createdAt: true,
          updatedAt: true,
          profileImage: true,
          kycStatus: true,
        },
      });

      // ✅ 10. S'assurer que updatedUser existe (il devrait, car on l'a créé ou mis à jour)
      if (!updatedUser) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('user_not_found', lang),
          statusCode: 404,
        });
      }

      // ✅ 11. Récupérer les wallets de l'utilisateur
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

      // ✅ 12. Récupérer les informations KYC formatées comme dans login
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

      // ✅ 13. Formater les informations KYC comme dans login
      const kycData = {
        status: updatedUser.kycStatus || 'NOT_SUBMITTED',
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

      // ✅ 14. Retourner les données formatées comme login
      return {
        message: existingKyc
          ? this.i18nService.translate('kyc_updated_success', lang)
          : this.i18nService.translate('kyc_submitted_success', lang),
        data: {
          id: updatedUser.id,
          email: updatedUser.email,
          phone: updatedUser.phone,
          fcmToken: updatedUser.fcmToken,
          full_name: updatedUser.full_name,
          account_number: updatedUser.account_number,
          role: updatedUser.role,
          passwordStatus: updatedUser.passwordStatus,
          pinstatus: updatedUser.pinstatus,
          merchantCode: updatedUser.merchantCode,
          businessName: updatedUser.businessName,
          status: updatedUser.status,
          deleted: updatedUser.deleted ?? false,
          createdAt: updatedUser.createdAt,
          updatedAt: updatedUser.updatedAt,
          profileImage: updatedUser.profileImage,
          wallets: wallets,
          kyc: kycData,
        },
      };
    } catch (error) {
      console.error('[KYC] ❌ Erreur submitKyc:', error);

      if (error instanceof RpcException) {
        throw error;
      }

      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('kyc_submit_error', lang),
        statusCode: 500,
      });
    }
  }

  async getKycStatus(
    userId: string,
    lang: string = 'fr',
  ): Promise<{ message: string; data: any }> {
    console.log(`[getKycStatus] Utilisateur ${userId}`);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        kycStatus: true,
        full_name: true,
        phone: true,
        email: true,
      },
    });

    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

    // ✅ Utiliser select explicite avec tous les champs
    const kyc = await this.prisma.kyc_submission.findFirst({
      where: { userId },
      select: {
        id: true,
        documentType: true,
        documentNumber: true,
        documentFront: true,
        documentBack: true,
        status: true,
        submittedAt: true,
        reviewedAt: true,
        adminNotes: true,
        rejectionReason: true,
        createdAt: true,
        updatedAt: true,
        profileImage: true,  // ✅ Inclure profileImage ici
      },
      orderBy: { createdAt: 'desc' },
    });

    // ✅ Vérifier et formater les données KYC avec fallback
    const submissionData = kyc ? {
      id: kyc.id,
      documentType: kyc.documentType || 'NATIONAL_ID',
      documentNumber: kyc.documentNumber || null,
      documentFront: kyc.documentFront || null,
      documentBack: kyc.documentBack || null,
      status: kyc.status,
      submittedAt: kyc.submittedAt || kyc.createdAt,
      reviewedAt: kyc.reviewedAt || null,
      adminNotes: kyc.adminNotes || null,
      rejectionReason: kyc.rejectionReason || null,
      profileImage: kyc.profileImage || null,
    } : null;

    return {
      message: this.i18nService.translate('kyc_status_retrieved', lang),
      data: {
        status: user.kycStatus,
        submission: submissionData,
      },
    };
  }

  async getAllKycSubmissions(
    params: {
      page: number;
      limit: number;
      status?: string;
      documentType?: string;
      lang?: string;
    },
  ): Promise<{ message: string; data: any }> {
    const lang = params.lang || 'fr';
    const { page = 1, limit = 10, status, documentType } = params;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status) where.status = status;
    if (documentType) where.documentType = documentType;

    const [submissions, total] = await Promise.all([
      this.prisma.kyc_submission.findMany({
        where,
        skip,
        take: limit,
        select: {
          id: true,
          userId: true,
          documentType: true,
          documentNumber: true,
          documentFront: true,
          documentBack: true,
          documentUrl: true,
          status: true,
          adminNotes: true,
          rejectionReason: true,
          submittedAt: true,
          reviewedAt: true,
          createdAt: true,
          updatedAt: true,
          user: {
            select: {
              id: true,
              full_name: true,
              phone: true,
              email: true,
              account_number: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.kyc_submission.count({ where }),
    ]);

    // ✅ Formater les données
    const formattedData = submissions.map((submission) => ({
      ...submission,
      documentType: submission.documentType || 'NATIONAL_ID',
      documentNumber: submission.documentNumber || null,
      documentFront: submission.documentFront || null,
      documentBack: submission.documentBack || null,
      rejectionReason: submission.rejectionReason || null,
      submittedAt: submission.submittedAt || submission.createdAt,
    }));

    return {
      message: this.i18nService.translate('kyc_submissions_retrieved', lang),
      data: {
        data: formattedData,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getKycSubmissionById(
    id: string,
    lang: string = 'fr',
  ): Promise<{ message: string; data: any }> {
    console.log('[KYC Service] Get KYC submission by ID:', { id, lang });

    if (!id) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('kyc_submission_id_required', lang),
        statusCode: 400,
      });
    }

    const submission = await this.prisma.kyc_submission.findFirst({
      where: { id },
      select: {
        id: true,
        userId: true,
        documentType: true,
        documentNumber: true,
        documentFront: true,
        documentBack: true,
        profileImage: true,
        documentUrl: true,
        status: true,
        adminNotes: true,
        rejectionReason: true,
        submittedAt: true,
        reviewedAt: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            id: true,
            full_name: true,
            phone: true,
            email: true,
            account_number: true,
            countryCode: true,
            profileImage: true,
          },
        },
      },
    });

    if (!submission) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('kyc_submission_not_found', lang),
        statusCode: 404,
      });
    }

    // ✅ Formater les données
    const formattedData = {
      ...submission,
      documentType: submission.documentType || 'NATIONAL_ID',
      documentNumber: submission.documentNumber || null,
      documentFront: submission.documentFront || null,
      documentBack: submission.documentBack || null,
      documentUrl: submission.documentUrl || null,
      rejectionReason: submission.rejectionReason || null,
      submittedAt: submission.submittedAt || submission.createdAt,
    };

    return {
      message: this.i18nService.translate('kyc_submission_retrieved', lang),
      data: formattedData,
    };
  }

  async verifyKyc(
    kycId: string,
    data: {
      status: 'VERIFIED' | 'REJECTED';
      adminNotes?: string;
      rejectionReason?: string;
    },
    adminId: string,
    lang: string = 'fr',
  ): Promise<{ message: string; data: any }> {
    console.log(`[verifyKyc] Admin ${adminId} vérifie KYC ${kycId}`);

    // ✅ 1. Récupérer le KYC avec profileImage et l'utilisateur
    const kyc = await this.prisma.kyc_submission.findUnique({
      where: { id: kycId },
      select: {
        id: true,
        userId: true,
        documentType: true,
        documentNumber: true,
        documentFront: true,
        documentBack: true,
        profileImage: true,
        status: true,
        adminNotes: true,
        rejectionReason: true,
        submittedAt: true,
        reviewedAt: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            id: true,
            full_name: true,
            phone: true,
            email: true,
            profileImage: true,
            kycStatus: true,
          },
        },
      },
    });

    if (!kyc) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('kyc_not_found', lang),
        statusCode: 404,
      });
    }

    // 2. Vérifier que le statut est valide
    if (!['VERIFIED', 'REJECTED'].includes(data.status)) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('kyc_invalid_status', lang),
        statusCode: 400,
      });
    }

    // 3. Vérifier que la soumission est en attente
    if (kyc.status !== 'PENDING') {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('kyc_not_pending', lang, {
          status: kyc.status,
        }),
        statusCode: 400,
      });
    }

    // 4. Récupérer profileImage du KYC
    const profileImageUrl = kyc.profileImage || null;
    console.log(`[verifyKyc] ProfileImage du KYC: ${profileImageUrl}`);

    // 5. Mettre à jour la soumission KYC
    const updatedKyc = await this.prisma.kyc_submission.update({
      where: { id: kycId },
      data: {
        status: data.status,
        adminNotes: data.adminNotes || null,
        rejectionReason: data.status === 'REJECTED' ? (data.rejectionReason || 'Document non conforme') : null,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // 6. Mettre à jour le statut KYC de l'utilisateur
    const userKycStatus = data.status === 'VERIFIED' ? 'VERIFIED' : 'REJECTED';

    // 7. Mettre à jour le profileImage de l'utilisateur
    let userUpdateData: any = { kycStatus: userKycStatus };

    if (data.status === 'VERIFIED' && profileImageUrl) {
      userUpdateData.profileImage = profileImageUrl;
      console.log(`[verifyKyc] ProfileImage mis à jour pour l'utilisateur ${kyc.userId}: ${profileImageUrl}`);
    }

    await this.prisma.user.update({
      where: { id: kyc.userId },
      data: userUpdateData,
    });

    // 8. Audit
    await this.logAudit(
      adminId,
      `KYC_${data.status}`,
      {
        kycId,
        userId: kyc.userId,
        adminNotes: data.adminNotes,
        rejectionReason: data.rejectionReason,
        profileImageUpdated: data.status === 'VERIFIED' && !!profileImageUrl,
      },
      null,
    );

    // ============================================
    // 9. NOTIFICATION PUSH (CORRIGÉE)
    // ============================================
    try {
      const userFullName = kyc.user.full_name || 'Cher client';

      if (data.status === 'VERIFIED') {
        // ✅ Notification KYC VERIFIED
        await this.notificationHelper.notify(
          kyc.userId,
          NotificationType.KYC_VERIFIED,
          {
            name: userFullName,
            status: 'VERIFIED',
          },
          'KYC',
          kycId,
          lang,
        );
        console.log(`[verifyKyc] Notification KYC_VERIFIED envoyée à ${kyc.userId}`);
      } else {
        // ✅ Notification KYC REJECTED
        await this.notificationHelper.notify(
          kyc.userId,
          NotificationType.KYC_REJECTED,
          {
            name: userFullName,
            status: 'REJECTED',
            reason: data.rejectionReason || 'Document non conforme',
          },
          'KYC',
          kycId,
          lang,
        );
        console.log(`[verifyKyc] Notification KYC_REJECTED envoyée à ${kyc.userId}`);
      }
    } catch (err) {
      console.error('[KYC] Erreur envoi notification push:', err);
    }

    // ============================================
    // 10. EMAIL DE NOTIFICATION
    // ============================================
    if (kyc.user.email) {
      try {
        const userFullName = kyc.user.full_name || 'Cher client';

        const emailData = {
          title: data.status === 'VERIFIED'
            ? this.i18nService.translate('kyc_verified_email_title', lang)
            : this.i18nService.translate('kyc_rejected_email_title', lang),
          greeting: this.i18nService.translate('kyc_email_greeting', lang, {
            name: userFullName,
          }),
          message: data.status === 'VERIFIED'
            ? this.i18nService.translate('kyc_verified_email_message', lang)
            : this.i18nService.translate('kyc_rejected_email_message', lang, {
              reason: data.rejectionReason || 'Document non conforme',
            }),
          footer: this.i18nService.translate('kyc_email_footer', lang),
          copyright: `© ${new Date().getFullYear()} F-Pay`,
          email: kyc.user.email,
        };
        await this.mailService.sendHtmlEmail(
          kyc.user.email,
          emailData.title,
          'kyc-status.html',
          emailData,
        );
      } catch (err) {
        console.error('[KYC] Erreur envoi email:', err);
      }
    }

    return {
      message: this.i18nService.translate(
        data.status === 'VERIFIED' ? 'kyc_verified_success' : 'kyc_rejected_success',
        lang,
      ),
      data: updatedKyc,
    };
  }

  async uploadFileOnly(
    userId: string,
    file: Express.Multer.File,
    folder: string,
    lang: string = 'fr',
  ): Promise<{ message: string; data: { url: string } }> {
    console.log(`[uploadFileOnly] Utilisateur ${userId} upload un fichier dans ${folder}`);

    try {
      // 1. Vérifier que l'utilisateur existe
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });
      if (!user) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('user_not_found', lang),
          statusCode: 404,
        });
      }

      // 2. Vérifier que le fichier est fourni
      if (!file) {
        throw new RpcException({
          status: 'error',
          message: 'Aucun fichier fourni',
          statusCode: 400,
        });
      }

      // 3. Vérifier que le dossier est fourni
      if (!folder || folder.trim() === '') {
        throw new RpcException({
          status: 'error',
          message: 'Le nom du dossier est requis',
          statusCode: 400,
        });
      }

      // 4. Upload du fichier vers le dossier spécifié
      console.log(`[uploadFileOnly] Upload du fichier: ${file.originalname} vers ${folder}`);
      const fileUrl = await uploadFile(file, { folder: folder.trim() });
      console.log(`[uploadFileOnly] ✅ Fichier uploadé: ${fileUrl}`);

      // 5. Audit
      await this.logAudit(
        userId,
        'FILE_UPLOAD',
        {
          fileName: file.originalname,
          fileSize: file.size,
          folder: folder,
          url: fileUrl,
        },
        null,
      );

      return {
        message: `Fichier uploadé avec succès dans ${folder}`,
        data: { url: fileUrl },
      };
    } catch (error) {
      console.error('[uploadFileOnly] ❌ Erreur:', error);

      if (error instanceof RpcException) {
        throw error;
      }

      throw new RpcException({
        status: 'error',
        message: error.message || 'Erreur lors de l\'upload du fichier',
        statusCode: 500,
      });
    }
  }

  async createApiKey(data: { name: string; userId: string; permissions: string[]; expiresInDays?: number }) {
    // Vérifier que l'utilisateur existe
    const user = await this.prisma.user.findUnique({
      where: { id: data.userId },
      include: {
        wallets: {
          where: { isActive: true },
          select: {
            id: true,
            currency: true,
            balance: true,
            isActive: true,
          }
        }
      }
    });

    if (!user) {
      throw new RpcException({ status: 'error', message: 'User not found', statusCode: 404 });
    }


    const expiresInDays = data.expiresInDays || 365;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    // ✅ Ajouter tous les champs manquants de l'utilisateur dans le payload
    const payload = {
      // Identifiants
      sub: user.id,
      userId: user.id,

      // Informations personnelles
      fullName: user.full_name,
      email: user.email,
      phone: user.phone,

      // Rôle et statut
      role: user.role,
      status: user.status,

      // Commerçant
      merchantCode: user.merchantCode,
      merchantType: user.merchantType,
      businessName: user.businessName,
      businessCategory: user.businessCategory,
      businessAddress: user.businessAddress,

      // KYC
      kycStatus: user.kycStatus,

      // Pays
      countryCode: user.countryCode,

      // Compte bancaire
      account_number: user.account_number,


      // Maintenance
      maintenance_fee: user.maintenance_fee,
      is_maintenance_exempt: user.is_maintenance_exempt,

      // API Key
      name: data.name,
      permissions: data.permissions,

      // Métadonnées JWT
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(expiresAt.getTime() / 1000),
      jti: crypto.randomUUID(),
    };

    // Signer le JWT
    const secret = process.env.JWT_API_KEY_SECRET || 'your-secret-key-at-least-32-chars';
    const apiKey = jwt.sign(payload, secret, { algorithm: 'HS256' });

    // Stocker la clé API
    const apiKeyRecord = await this.prisma.api_key.create({
      data: {
        id: crypto.randomUUID(),
        key: apiKey,
        name: data.name,
        userId: data.userId,
        permissions: JSON.stringify(data.permissions),
        expiresAt,
      },
    });

    // ✅ Retourner avec message et data
    return {
      message: 'API Key created successfully',
      data: {
        // Informations de la clé API
        id: apiKeyRecord.id,
        apiKey: apiKey,
        name: data.name,
        permissions: data.permissions,
        expiresAt: expiresAt,
        createdAt: apiKeyRecord.createdAt,
        isActive: apiKeyRecord.isActive,

        // Informations de l'utilisateur
        user: {
          id: user.id,
          full_name: user.full_name,
          email: user.email,
          phone: user.phone,
          role: user.role,
          status: user.status,
          merchantCode: user.merchantCode,
          merchantType: user.merchantType,
          kycStatus: user.kycStatus,
          countryCode: user.countryCode,
          // Wallets actifs
          wallets: user.wallets.map(w => ({
            id: w.id,
            currency: w.currency,
            balance: w.balance,
            isActive: w.isActive,
          })),
        },

        // Informations du token JWT
        token: {
          sub: payload.sub,
          iat: payload.iat,
          exp: payload.exp,
          jti: payload.jti,
        }
      }
    };
  }

  async listApiKeys(userId: string, page: number = 1, limit: number = 10) {
    // Vérifier que l'utilisateur existe
    const user = await this.prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      throw new RpcException({ status: 'error', message: 'User not found', statusCode: 404 });
    }

    const skip = (page - 1) * limit;

    const [apiKeys, total] = await Promise.all([
      this.prisma.api_key.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          permissions: true,
          isActive: true,
          expiresAt: true,
          lastUsedAt: true,
          createdAt: true,
          updatedAt: true,
        }
      }),
      this.prisma.api_key.count({
        where: { userId }
      })
    ]);

    // ✅ Décoder les permissions pour chaque clé
    const formattedKeys = apiKeys.map(key => ({
      ...key,
      permissions: key.permissions ? JSON.parse(key.permissions) : [],
      isExpired: key.expiresAt ? new Date() > key.expiresAt : false,
    }));

    return {
      message: 'API Keys retrieved successfully',
      data: {
        data: formattedKeys,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      }
    };
  }

  async updateApiKey(data: {
    id: string;
    userId: string;
    name?: string;
    permissions?: string[];
    isActive?: boolean;
    expiresInDays?: number;
  }) {
    // ✅ 1. Vérifier que la clé API existe et appartient à l'utilisateur
    const existingKey = await this.prisma.api_key.findFirst({
      where: {
        id: data.id,
        userId: data.userId,
      },
      include: {
        user: true,
      }
    });

    if (!existingKey) {
      throw new RpcException({
        status: 'error',
        message: 'API Key not found or does not belong to this user',
        statusCode: 404
      });
    }

    // ✅ 2. VÉRIFICATION CRUCIALE: user doit exister
    if (!existingKey.user) {
      throw new RpcException({
        status: 'error',
        message: 'User associated with this API key not found',
        statusCode: 404
      });
    }

    // ✅ 3. Maintenant on peut utiliser existingKey.user en toute sécurité
    const user = existingKey.user;

    // ✅ 4. Préparer les données de mise à jour
    const updateData: any = {};
    if (data.name) updateData.name = data.name;
    if (data.permissions) updateData.permissions = JSON.stringify(data.permissions);
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.expiresInDays) {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + data.expiresInDays);
      updateData.expiresAt = expiresAt;
    }

    // ✅ 5. Mettre à jour la clé API
    const updatedKey = await this.prisma.api_key.update({
      where: { id: data.id },
      data: updateData,
      select: {
        id: true,
        name: true,
        permissions: true,
        isActive: true,
        expiresAt: true,
        lastUsedAt: true,
        createdAt: true,
        updatedAt: true,
      }
    });

    // ✅ 6. Régénérer le JWT si nécessaire
    if (data.name || data.permissions) {
      const permissions = data.permissions || JSON.parse(existingKey.permissions || '[]');
      const expiresAt = updateData.expiresAt || existingKey.expiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

      const payload = {
        sub: user.id,
        userId: user.id,
        fullName: user.full_name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status,
        merchantCode: user.merchantCode,
        merchantType: user.merchantType,
        businessName: user.businessName,
        businessCategory: user.businessCategory,
        businessAddress: user.businessAddress,
        kycStatus: user.kycStatus,
        countryCode: user.countryCode,
        account_number: user.account_number,

        maintenance_fee: user.maintenance_fee,
        is_maintenance_exempt: user.is_maintenance_exempt,
        name: data.name || existingKey.name,
        permissions: permissions,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(expiresAt.getTime() / 1000),
        jti: crypto.randomUUID(),
      };

      const secret = process.env.JWT_API_KEY_SECRET || 'your-secret-key-at-least-32-chars';
      const newApiKey = jwt.sign(payload, secret, { algorithm: 'HS256' });

      await this.prisma.api_key.update({
        where: { id: data.id },
        data: { key: newApiKey },
      });

      return {
        message: 'API Key updated successfully - New key generated',
        data: {
          ...updatedKey,
          permissions: permissions,
          apiKey: newApiKey,
          isExpired: updatedKey.expiresAt ? new Date() > updatedKey.expiresAt : false,
        }
      };
    }

    return {
      message: 'API Key updated successfully',
      data: {
        ...updatedKey,
        permissions: updatedKey.permissions ? JSON.parse(updatedKey.permissions) : [],
        isExpired: updatedKey.expiresAt ? new Date() > updatedKey.expiresAt : false,
      }
    };
  }

  async deleteApiKey(id: string) {
    // ✅ 1. Vérifier que la clé API existe et appartient à l'utilisateur
    const existingKey = await this.prisma.api_key.findFirst({
      where: {
        id: id,
      },
      select: {
        id: true,
        name: true,
        isActive: true,
      }
    });

    if (!existingKey) {
      throw new RpcException({
        status: 'error',
        message: 'API Key not found or does not belong to this user',
        statusCode: 404
      });
    }

    // ✅ 2. Supprimer la clé API
    await this.prisma.api_key.delete({
      where: { id: id },
    });

    return {
      message: `API Key "${existingKey.name}" deleted successfully`,
      data: {
        id: existingKey.id,
        name: existingKey.name,
        deleted: true,
      }
    };
  }

  async revokeApiKey(id: string, userId: string) {
    // ✅ 1. Vérifier que la clé API existe et appartient à l'utilisateur
    const existingKey = await this.prisma.api_key.findFirst({
      where: {
        id: id,
        userId: userId,
      },
      select: {
        id: true,
        name: true,
        isActive: true,
      }
    });

    if (!existingKey) {
      throw new RpcException({
        status: 'error',
        message: 'API Key not found or does not belong to this user',
        statusCode: 404
      });
    }

    if (!existingKey.isActive) {
      throw new RpcException({
        status: 'error',
        message: 'API Key is already revoked',
        statusCode: 400
      });
    }

    // ✅ 2. Désactiver la clé API
    await this.prisma.api_key.update({
      where: { id: id },
      data: { isActive: false },
    });

    return {
      message: `API Key "${existingKey.name}" revoked successfully`,
      data: {
        id: existingKey.id,
        name: existingKey.name,
        isActive: false,
        revokedAt: new Date().toISOString(),
      }
    };
  }

  async reactivateApiKey(id: string, userId: string) {
    // ✅ 1. Vérifier que la clé API existe et appartient à l'utilisateur
    const existingKey = await this.prisma.api_key.findFirst({
      where: {
        id: id,
        userId: userId,
      },
      select: {
        id: true,
        name: true,
        isActive: true,
        expiresAt: true,
      }
    });

    if (!existingKey) {
      throw new RpcException({
        status: 'error',
        message: 'API Key not found or does not belong to this user',
        statusCode: 404
      });
    }

    if (existingKey.isActive) {
      throw new RpcException({
        status: 'error',
        message: 'API Key is already active',
        statusCode: 400
      });
    }

    // Vérifier si la clé a expiré
    if (existingKey.expiresAt && new Date() > existingKey.expiresAt) {
      throw new RpcException({
        status: 'error',
        message: 'Cannot reactivate an expired API Key. Please create a new one.',
        statusCode: 400
      });
    }

    // ✅ 2. Réactiver la clé API
    await this.prisma.api_key.update({
      where: { id: id },
      data: { isActive: true },
    });

    return {
      message: `API Key "${existingKey.name}" reactivated successfully`,
      data: {
        id: existingKey.id,
        name: existingKey.name,
        isActive: true,
        reactivatedAt: new Date().toISOString(),
      }
    };
  }

  async createBranch(data: {
    name: string;
    address?: string;
    phone?: string;
    email?: string;
    countryId: string;
    status?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  }): Promise<{ message: string; data: any }> {
    // 1️⃣ Vérifier que le pays existe
    const country = await this.prisma.country_provider.findUnique({
      where: { id: data.countryId },
      include: {
        country_currency: {
          select: { currency_code: true }
        },
        network_provider: {
          select: { currency: true }
        }
      },
    });

    if (!country) {
      throw new RpcException({
        status: 'error',
        message: 'Country not found',
        statusCode: 404,
      });
    }

    // 2️⃣ Vérifier que le nom n'existe pas déjà
    const existingByName = await this.prisma.branch.findFirst({
      where: {
        name: data.name,
        countryId: data.countryId,
      },
    });
    if (existingByName) {
      throw new RpcException({
        status: 'error',
        message: `Branch with name "${data.name}" already exists in this country`,
        statusCode: 409,
      });
    }

    // 3️⃣ Générer un code unique
    let code: string = '';
    let isUnique = false;
    let attempts = 0;
    const maxAttempts = 10;

    while (!isUnique && attempts < maxAttempts) {
      const lastBranch = await this.prisma.branch.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { code: true },
      });

      let nextNumber = 1;
      if (lastBranch && lastBranch.code) {
        const match = lastBranch.code.match(/BR-(\d+)/);
        if (match) {
          nextNumber = parseInt(match[1], 10) + 1;
        }
      }

      const formattedNumber = String(nextNumber).padStart(4, '0');
      code = `BR-${formattedNumber}`;

      const existing = await this.prisma.branch.findUnique({
        where: { code },
      });
      if (!existing) {
        isUnique = true;
      }
      attempts++;
    }

    if (!isUnique) {
      throw new RpcException({
        status: 'error',
        message: 'Unable to generate a unique branch code. Please try again.',
        statusCode: 500,
      });
    }

    // 4️⃣ Créer l'agence
    const branch = await this.prisma.branch.create({
      data: {
        id: crypto.randomUUID(),
        name: data.name,
        code: code,
        address: data.address || null,
        phone: data.phone || null,
        email: data.email || null,
        countryId: data.countryId,
        status: (data.status || 'ACTIVE') as branch_status,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      include: {
        country_provider: {
          select: {
            id: true,
            name: true,
            code: true,
            countryCode: true,
          },
        },
      },
    });

    // 5️⃣ CRÉER LE COMPTE CAISSE
    const branchAccountNumber = `BR-${branch.code}`;
    const branchEmail = data.email || `caisse.${branch.code.toLowerCase()}@fpay.com`;

    const branchUser = await this.prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: branchEmail,
        full_name: `Caisse ${branch.name}`,
        phone: data.phone || null,
        account_number: branchAccountNumber,
        role: 'ADMIN',
        status: 'ACTIVE',
        branchId: branch.id,
        password: null,
        pinstatus: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // 6️⃣ RÉCUPÉRER LES DEVISES DU PAYS
    const currenciesToCreate: string[] = [];

    // A. Devises depuis country_currency
    if (country.country_currency && country.country_currency.length > 0) {
      for (const cc of country.country_currency) {
        if (cc.currency_code && !currenciesToCreate.includes(cc.currency_code)) {
          currenciesToCreate.push(cc.currency_code);
        }
      }
    }

    // B. Devises depuis network_provider
    if (country.network_provider && country.network_provider.length > 0) {
      for (const network of country.network_provider) {
        if (network.currency) {
          const currencies = network.currency.split(',').map(c => c.trim());
          for (const currency of currencies) {
            if (currency && !currenciesToCreate.includes(currency)) {
              currenciesToCreate.push(currency);
            }
          }
        }
      }
    }

    // C. Devise par défaut du pays
    if (country.default_currency && !currenciesToCreate.includes(country.default_currency)) {
      currenciesToCreate.push(country.default_currency);
    }

    // Si aucune devise trouvée, utiliser CDF
    if (currenciesToCreate.length === 0) {
      currenciesToCreate.push('CDF');
    }

    console.log(`📊 Devises à créer pour l'agence ${branch.name}:`, currenciesToCreate);

    // 7️⃣ CRÉER LES WALLETS POUR CHAQUE DEVISE
    // ✅ SOLUTION CORRECTE: Typer explicitement avec any[]
    const createdWallets: any[] = [];

    for (const currency of currenciesToCreate) {
      const wallet = await this.prisma.wallet.create({
        data: {
          id: crypto.randomUUID(),
          userId: branchUser.id,
          branchId: branch.id,
          currency: currency as wallet_currency,
          balance: 0,
          isActive: true,
          isDefault: false,
          isBranchWallet: true,
          cashCode: `CASH-${branch.code}-${currency}-${Date.now()}`,
        },
      });
      createdWallets.push(wallet);
      console.log(`✅ Wallet créé pour ${branch.name} (${currency})`);
    }

    console.log(`📊 ${createdWallets.length} wallet(s) créé(s) pour l'agence ${branch.name}`);

    // 8️⃣ Compter les utilisateurs
    const userCount = await this.prisma.user.count({
      where: { branchId: branch.id },
    });

    // 9️⃣ Formater la réponse
    const { country_provider, ...branchWithoutCountry } = branch;

    const responseData = {
      ...branchWithoutCountry,
      country: country_provider,
      cashier: {
        id: branchUser.id,
        email: branchUser.email,
        full_name: branchUser.full_name,
        account_number: branchUser.account_number,
        phone: branchUser.phone,
      },
      wallets: createdWallets.map((w: any) => ({
        id: w.id,
        currency: w.currency,
        balance: w.balance,
        isActive: w.isActive,
        isBranchWallet: w.isBranchWallet || false,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
      })),
      _count: {
        users: userCount,
        wallets: createdWallets.length,
      },
    };

    return {
      message: `Branch created successfully with ${createdWallets.length} wallet(s)`,
      data: responseData,
    };
  }

  async updateBranch(id: string, data: {
    name?: string;
    address?: string;
    phone?: string;
    email?: string;
    countryId?: string;
    status?: string;
  }) {
    // 1️⃣ Vérifier que la branche existe
    const branch = await this.prisma.branch.findUnique({
      where: { id },
      include: {
        country_provider: true,
        user: {
          where: {
            role: 'ADMIN',
            email: { contains: 'caisse.' }
          },
          include: {
            wallets: {
              where: { isBranchWallet: true }
            }
          }
        }
      }
    });

    if (!branch) {
      throw new RpcException({
        status: 'error',
        message: 'Branch not found',
        statusCode: 404,
      });
    }

    // 2️⃣ Vérifier le pays si changement
    let newCountry: any = null;
    let countryChanged = false;

    if (data.countryId && data.countryId !== branch.countryId) {
      newCountry = await this.prisma.country_provider.findUnique({
        where: { id: data.countryId },
        include: {
          country_currency: {
            select: { currency_code: true }
          },
          network_provider: {
            select: { currency: true }
          }
        }
      });

      if (!newCountry) {
        throw new RpcException({
          status: 'error',
          message: 'Country not found',
          statusCode: 404,
        });
      }
      countryChanged = true;
    }

    // 3️⃣ Préparer les données de mise à jour
    const updateData: any = {
      updatedAt: new Date(),
    };

    if (data.name !== undefined) updateData.name = data.name;
    if (data.address !== undefined) updateData.address = data.address;
    if (data.phone !== undefined) updateData.phone = data.phone;
    if (data.email !== undefined) updateData.email = data.email;
    if (data.countryId !== undefined) updateData.countryId = data.countryId;
    if (data.status !== undefined) updateData.status = data.status as branch_status;

    // 4️⃣ Exécuter la mise à jour avec transaction si changement de pays
    let updated;

    if (countryChanged && branch.user && branch.user.length > 0) {
      // 🔥 Transaction pour mettre à jour la branche et les wallets
      updated = await this.prisma.$transaction(async (tx) => {
        // 4a. Mettre à jour la branche
        const updatedBranch = await tx.branch.update({
          where: { id },
          data: updateData,
          include: {
            country_provider: {
              select: {
                id: true,
                name: true,
                code: true,
                countryCode: true,
              },
            },
          },
        });

        // 4b. Récupérer l'utilisateur caisse
        const branchUser = branch.user[0];

        if (branchUser) {
          // 4c. Récupérer les devises du nouveau pays
          const currenciesToCreate: string[] = [];

          // Devises depuis country_currency
          if (newCountry.country_currency && newCountry.country_currency.length > 0) {
            for (const cc of newCountry.country_currency) {
              if (cc.currency_code && !currenciesToCreate.includes(cc.currency_code)) {
                currenciesToCreate.push(cc.currency_code);
              }
            }
          }

          // Devises depuis network_provider
          if (newCountry.network_provider && newCountry.network_provider.length > 0) {
            for (const network of newCountry.network_provider) {
              if (network.currency) {
                const currencies = network.currency.split(',').map(c => c.trim());
                for (const currency of currencies) {
                  if (currency && !currenciesToCreate.includes(currency)) {
                    currenciesToCreate.push(currency);
                  }
                }
              }
            }
          }

          // Devise par défaut
          if (newCountry.default_currency && !currenciesToCreate.includes(newCountry.default_currency)) {
            currenciesToCreate.push(newCountry.default_currency);
          }

          if (currenciesToCreate.length === 0) {
            currenciesToCreate.push('CDF');
          }

          // 4d. Désactiver les anciens wallets
          await tx.wallet.updateMany({
            where: {
              userId: branchUser.id,
              branchId: branch.id,
              isBranchWallet: true,
              currency: {
                notIn: currenciesToCreate as wallet_currency[]
              }
            },
            data: {
              isActive: false,
              updatedAt: new Date()
            }
          });

          // 4e. Récupérer les wallets actifs existants
          const existingWallets = await tx.wallet.findMany({
            where: {
              userId: branchUser.id,
              branchId: branch.id,
              isBranchWallet: true,
              isActive: true,
            }
          });

          const existingCurrencies = existingWallets.map(w => w.currency);

          // 4f. Créer les wallets manquants
          for (const currency of currenciesToCreate) {
            if (!existingCurrencies.includes(currency as wallet_currency)) {
              await tx.wallet.create({
                data: {
                  id: crypto.randomUUID(),
                  userId: branchUser.id,
                  branchId: branch.id,
                  currency: currency as wallet_currency,
                  balance: 0,
                  isActive: true,
                  isDefault: false,
                  isBranchWallet: true,
                  cashCode: `CASH-${branch.code}-${currency}-${Date.now()}`,
                }
              });
              console.log(`✅ Wallet créé pour ${branch.name} (${currency})`);
            }
          }

          // 4g. Mettre à jour l'email du compte caisse si le nom change
          if (data.name) {
            const newEmail = `caisse.${branch.code.toLowerCase()}@fpay.com`;
            await tx.user.update({
              where: { id: branchUser.id },
              data: {
                email: newEmail,
                full_name: `Caisse ${data.name}`,
                updatedAt: new Date()
              }
            });
          }
        }

        return updatedBranch;
      }, { timeout: 30000 });
    } else {
      // 🔥 Simple mise à jour
      updated = await this.prisma.branch.update({
        where: { id },
        data: updateData,
        include: {
          country_provider: {
            select: {
              id: true,
              name: true,
              code: true,
              countryCode: true,
            },
          },
        },
      });
    }

    // 5️⃣ Récupérer les wallets mis à jour
    const wallets: any[] = await this.prisma.wallet.findMany({
      where: {
        branchId: id,
        isBranchWallet: true,
        isActive: true,
      },
      include: {
        user: {
          select: {
            id: true,
            full_name: true,
            email: true,
            phone: true,
            account_number: true,
          },
        },
      },
      orderBy: { currency: 'asc' },
    });

    // 6️⃣ Compter les utilisateurs et transactions
    const userCount = await this.prisma.user.count({
      where: { branchId: id },
    });

    const transactionCount = await this.prisma.transaction.count({
      where: { branchId: id },
    });

    // 7️⃣ Formater la réponse
    const { country_provider, ...branchWithoutCountry } = updated;
    const responseData = {
      ...branchWithoutCountry,
      country: country_provider,
      wallets: wallets.map((w: any) => ({
        id: w.id,
        currency: w.currency,
        balance: w.balance,
        isActive: w.isActive,
        isBranchWallet: w.isBranchWallet || false,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
        user: w.user ? {
          id: w.user.id,
          full_name: w.user.full_name,
          email: w.user.email,
          phone: w.user.phone,
          account_number: w.user.account_number,
        } : null,
      })),
      _count: {
        users: userCount,
        transactions: transactionCount,
        wallets: wallets.length,
      },
    };

    return {
      message: countryChanged
        ? 'Branch updated successfully with new wallets'
        : 'Branch updated successfully',
      data: responseData,
    };
  }

  async getBranch(id: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id },
      include: {
        country_provider: {
          select: {
            id: true,
            name: true,
            code: true,
            countryCode: true,
          },
        },
        user_has_resources: {
          include: {
            user: {
              select: {
                id: true,
                full_name: true,
                phone: true,
                email: true,
              },
            },
            resources: true,
          },
        },
        wallet: {  // 👈 INCLURE LES WALLETS
          where: { isActive: true },
          include: {
            user: {
              select: {
                id: true,
                full_name: true,
                email: true,
                phone: true,
                account_number: true,
              },
            },
          },
        },
        user: {
          select: {
            id: true,
          },
        },
        transaction: {
          select: {
            id: true,
          },
        },
      },
    });

    if (!branch) {
      throw new RpcException({
        status: 'error',
        message: 'Branch not found',
        statusCode: 404,
      });
    }

    // ✅ Formater la réponse avec country et wallets
    const { country_provider, wallet, user, transaction, ...branchWithoutCountry } = branch;

    const responseData = {
      ...branchWithoutCountry,
      country: country_provider,
      wallets: wallet.map(w => ({
        id: w.id,
        currency: w.currency,
        balance: w.balance,
        isActive: w.isActive,
        isBranchWallet: w.isBranchWallet || false,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
        user: w.user ? {
          id: w.user.id,
          full_name: w.user.full_name,
          email: w.user.email,
          phone: w.user.phone,
          account_number: w.user.account_number,
        } : null,
      })),
      _count: {
        users: user.length,
        transactions: transaction.length,
        wallets: wallet.length,
      },
    };

    return {
      message: 'Branch retrieved successfully',
      data: responseData,
    };
  }

  async getAllBranches(params: {
    page?: number;
    limit?: number;
    countryId?: string;
    status?: string;
  }) {
    const { page = 1, limit = 10, countryId, status } = params;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (countryId) where.countryId = countryId;
    if (status) where.status = status;

    const [branches, total] = await Promise.all([
      this.prisma.branch.findMany({
        where,
        skip,
        take: limit,
        include: {
          country_provider: {
            select: {
              id: true,
              name: true,
              code: true,
              countryCode: true,
            },
          },
          wallet: {  // 👈 INCLURE LES WALLETS
            where: { isActive: true },
            include: {
              user: {
                select: {
                  id: true,
                  full_name: true,
                  email: true,
                  phone: true,
                  account_number: true,
                },
              },
            },
          },
          user: {
            select: {
              id: true,
            },
          },
          transaction: {
            select: {
              id: true,
            },
          },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.branch.count({ where }),
    ]);

    // ✅ Formater la réponse avec country et wallets
    const formattedBranches = branches.map((branch) => {
      const { country_provider, wallet, user, transaction, ...rest } = branch;

      return {
        ...rest,
        country: country_provider,
        wallets: wallet.map(w => ({
          id: w.id,
          currency: w.currency,
          balance: w.balance,
          isActive: w.isActive,
          isBranchWallet: w.isBranchWallet || false,
          createdAt: w.createdAt,
          updatedAt: w.updatedAt,
          user: w.user ? {
            id: w.user.id,
            full_name: w.user.full_name,
            email: w.user.email,
            phone: w.user.phone,
            account_number: w.user.account_number,
          } : null,
        })),
        _count: {
          users: user.length,
          transactions: transaction.length,
          wallets: wallet.length,
        },
      };
    });

    return {
      message: 'Branches retrieved successfully',
      data: {
        data: formattedBranches,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
  async getBranchesByCountry(countryCode: string) {
    const branches = await this.prisma.branch.findMany({
      where: {
        country_provider: {
          countryCode: countryCode,
        },
        status: 'ACTIVE',
      },
      include: {
        country_provider: {
          select: {
            id: true,
            name: true,
            code: true,
            countryCode: true,
          },
        },
        wallet: {  // 👈 INCLURE LES WALLETS
          where: { isActive: true },
          include: {
            user: {
              select: {
                id: true,
                full_name: true,
                email: true,
                phone: true,
                account_number: true,
              },
            },
          },
        },
        user: {
          select: {
            id: true,
          },
        },
        transaction: {
          select: {
            id: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    // ✅ Formater la réponse avec country et wallets
    const formattedBranches = branches.map((branch) => {
      const { country_provider, wallet, user, transaction, ...rest } = branch;

      return {
        ...rest,
        country: country_provider,
        wallets: wallet.map(w => ({
          id: w.id,
          currency: w.currency,
          balance: w.balance,
          isActive: w.isActive,
          isBranchWallet: w.isBranchWallet || false,
          createdAt: w.createdAt,
          updatedAt: w.updatedAt,
          user: w.user ? {
            id: w.user.id,
            full_name: w.user.full_name,
            email: w.user.email,
            phone: w.user.phone,
            account_number: w.user.account_number,
          } : null,
        })),
        _count: {
          users: user.length,
          transactions: transaction.length,
          wallets: wallet.length,
        },
      };
    });

    return {
      message: 'Branches retrieved successfully',
      data: formattedBranches,
    };
  }

  async deleteBranch(id: string, permanent: boolean = false): Promise<{ message: string; data: any }> {
    const branch = await this.prisma.branch.findUnique({
      where: { id },
      include: {
        country_provider: {
          select: {
            id: true,
            name: true,
            code: true,
            countryCode: true,
          },
        },
      },
    });

    if (!branch) {
      throw new RpcException({
        status: 'error',
        message: 'Branch not found',
        statusCode: 404,
      });
    }

    const [userCount, transactionCount] = await Promise.all([
      this.prisma.user.count({
        where: { branchId: id },
      }),
      this.prisma.transaction.count({
        where: { branchId: id },
      }),
    ]);

    let updatedBranch;

    if (permanent) {
      if (userCount > 0 || transactionCount > 0) {
        throw new RpcException({
          status: 'error',
          message: `Cannot permanently delete branch with ${userCount} users and ${transactionCount} transactions. Use soft delete instead.`,
          statusCode: 400,
        });
      }

      updatedBranch = await this.prisma.branch.delete({
        where: { id },
        include: {
          country_provider: {
            select: {
              id: true,
              name: true,
              code: true,
              countryCode: true,
            },
          },
        },
      });

      // ✅ Formater la réponse avec country
      const { country_provider, ...rest } = updatedBranch;
      return {
        message: 'Branch permanently deleted successfully',
        data: {
          ...rest,
          country: country_provider,
        },
      };
    }

    let newStatus: branch_status;
    if (branch.status === 'INACTIVE') {
      newStatus = 'SUSPENDED';
    } else {
      newStatus = 'INACTIVE';
    }

    updatedBranch = await this.prisma.branch.update({
      where: { id },
      data: {
        status: newStatus,
        updatedAt: new Date(),
      },
      include: {
        country_provider: {
          select: {
            id: true,
            name: true,
            code: true,
            countryCode: true,
          },
        },
      },
    });

    // ✅ Formater la réponse avec country
    const { country_provider, ...branchWithoutCountry } = updatedBranch;
    const responseData = {
      ...branchWithoutCountry,
      country: country_provider,
      _count: {
        users: userCount,
        transactions: transactionCount,
      },
    };

    await this.logAudit(
      null,
      'BRANCH_DELETED',
      {
        branchId: id,
        branchName: branch.name,
        branchCode: branch.code,
        oldStatus: branch.status,
        newStatus: newStatus,
        userCount,
        transactionCount,
        permanent: false,
        timestamp: new Date().toISOString(),
      },
      null,
    );

    return {
      message: `Branch status changed to ${newStatus} successfully`,
      data: responseData,
    };
  }

  // ================================================================
  // RESTORE BRANCH
  // ================================================================

  async restoreBranch(id: string): Promise<{ message: string; data: any }> {
    const branch = await this.prisma.branch.findUnique({
      where: { id },
      include: {
        country_provider: {
          select: {
            id: true,
            name: true,
            code: true,
            countryCode: true,
          },
        },
      },
    });

    if (!branch) {
      throw new RpcException({
        status: 'error',
        message: 'Branch not found',
        statusCode: 404,
      });
    }

    if (branch.status === 'ACTIVE') {
      throw new RpcException({
        status: 'error',
        message: 'Branch is already active',
        statusCode: 400,
      });
    }

    const restoredBranch = await this.prisma.branch.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        updatedAt: new Date(),
      },
      include: {
        country_provider: {
          select: {
            id: true,
            name: true,
            code: true,
            countryCode: true,
          },
        },
      },
    });

    // ✅ Formater la réponse avec country
    const { country_provider, ...branchWithoutCountry } = restoredBranch;
    const responseData = {
      ...branchWithoutCountry,
      country: country_provider,
    };

    await this.logAudit(
      null,
      'BRANCH_RESTORED',
      {
        branchId: id,
        branchName: branch.name,
        branchCode: branch.code,
        oldStatus: branch.status,
        newStatus: 'ACTIVE',
        timestamp: new Date().toISOString(),
      },
      null,
    );

    return {
      message: 'Branch restored successfully',
      data: responseData,
    };
  }
}
