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
import { user_passwordStatus, user_role, user_status } from '@prisma/client';
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


@Injectable()
export class UserServiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly smsService: SmsService,
    private readonly mailService: MailService,
    private readonly i18nService: I18nService,
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

    // 3. Génération du code marchand si rôle MERCHANT
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const roleStr = data.role as string | undefined;
    let merchantCode: string | undefined = undefined;
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

    // 4. Convertir le rôle en enum Prisma
    let roleEnum: user_role = user_role.USER;
    if (roleStr === 'MERCHANT') roleEnum = user_role.MERCHANT;
    else if (roleStr === 'ADMIN') roleEnum = user_role.ADMIN;
    else if (roleStr === 'SUPER_ADMIN') roleEnum = user_role.SUPER_ADMIN;

    // 5. Générer un account_number unique s'il n'est pas fourni
    // let finalAccountNumber = data.account_number;
    // if (!finalAccountNumber) {
    //   finalAccountNumber = `AC_${crypto.randomUUID().slice(0, 8)}`;
    // }

    // 6. Création de l'utilisateur
    const defaultPassword = 'Accespay!26';
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);
    const user = await this.prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: data.email?.toLowerCase(),
        phone: data.phone,
        full_name: data.full_name,
        branch: data.branch,
        password: hashedPassword,
        role: roleEnum,
        status: user_status.ACTIVE,
        deleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        passwordStatus: user_passwordStatus.DEFAULT,
        merchantCode,
        businessName: data.businessName,
      },
    });

    // 7. SMS de bienvenue
    if (data.phone) {
      const cleanPhone = data.phone.replace(/[^0-9+]/g, '');
      let smsText = this.i18nService.translate('welcome_sms', lang, {
        full_name: user.full_name,
        account_number: user.account_number,
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
      try {
        await this.smsService.sendSms(cleanPhone, smsText);
      } catch (smsErr) {
        console.error(`SMS non envoyé à ${cleanPhone}:`, smsErr.message);
      }
    }

    // 8. Email de bienvenue
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

    // 9. Audit – création par admin
    await this.logAudit(
      user.id,
      'CREATE_USER_COTE_ADMIN',
      { identifier: user },
      ipAddress ?? null,
    );

    return {
      message: this.i18nService.translate('user_created_success', lang),
      data: this.toResponse(user),
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
        branch: data.branch,
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

  async getUser(
    id: string,
    lang: string = 'fr',
  ): Promise<{
    message: string;
    data: UserResponseDto & { resources?: any[]; wallets?: any[]; kyc?: any };
  }> {
    console.log(`[getUser] Langue utilisée : ${lang} pour l'utilisateur ${id}`);

    // ✅ Récupérer l'utilisateur avec les champs nécessaires
    const user = await this.prisma.user.findFirst({
      where: { id },
      select: {
        id: true,
        email: true,
        phone: true,
        full_name: true,
        account_number: true,
        profileImage: true,
        branch: true,
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
        kycStatus: true, // ✅ Ajout du statut KYC
      },
    });

    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

    // Récupération des ressources (permissions)
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

    // Récupération des wallets de l'utilisateur
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

    // ✅ Récupération des informations KYC de l'utilisateur
    const kycSubmission = await this.prisma.kyc_submission.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        documentType: true,
        documentNumber: true,
        documentFrontUrl: true,
        documentBackUrl: true,
        status: true,
        submittedAt: true,
        reviewedAt: true,
        adminNotes: true,
        rejectionReason: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // ✅ Formater les informations KYC
    const kyc = {
      status: user.kycStatus,
      submission: kycSubmission ? {
        id: kycSubmission.id,
        documentType: kycSubmission.documentType || null,
        documentNumber: kycSubmission.documentNumber || null,
        documentFrontUrl: kycSubmission.documentFrontUrl || null,
        documentBackUrl: kycSubmission.documentBackUrl || null,
        status: kycSubmission.status,
        submittedAt: kycSubmission.submittedAt || kycSubmission.createdAt,
        reviewedAt: kycSubmission.reviewedAt || null,
        adminNotes: kycSubmission.adminNotes || null,
        rejectionReason: kycSubmission.rejectionReason || null,
      } : null,
    };

    const userDto = this.toResponse(user);

    return {
      message: this.i18nService.translate('user_retrieved_success', lang),
      data: {
        ...userDto,
        resources,
        wallets,
        kyc, // ✅ Ajout des informations KYC
      },
    };
  }

  async getUserByEmail(
    email: string,
    lang: string = 'fr',
  ): Promise<ApiResponse<UserResponseDto>> {
    console.log(
      `[getUserByEmail] Langue utilisée : ${lang} pour l'email ${email}`,
    );
    const user = await this.prisma.user.findFirst({
      where: { email: email.toLowerCase() },
    });
    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }
    return {
      message: this.i18nService.translate('user_retrieved_success', lang),
      data: this.toResponse(user),
    };
  }

  async getUserByPhone(
    phone: string,
    lang: string = 'fr',
  ): Promise<ApiResponse<UserResponseDto>> {
    console.log(
      `[getUserByPhone] Langue utilisée : ${lang} pour le téléphone ${phone}`,
    );
    const user = await this.prisma.user.findFirst({ where: { phone } });
    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }
    return {
      message: this.i18nService.translate('user_retrieved_success', lang),
      data: this.toResponse(user),
    };
  }

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

    // 1️⃣ Vérification d'unicité du téléphone (si changement)
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

    // 2️⃣ Vérification du compte bancaire (si changement d'account_number)
    if (
      data.account_number &&
      data.account_number !== existingUser.account_number
    ) {
      const account = await this.prisma.account.findFirst({
        where: { account_number: data.account_number },
      });
      if (!account) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('account_not_found', lang, {
            account: data.account_number,
          }),
          statusCode: 404,
        });
      }
      // Vérifier que le nom complet correspond
      const fullNameToCheck = data.full_name ?? existingUser.full_name;
      if (account.full_name !== fullNameToCheck) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('name_mismatch', lang),
          statusCode: 400,
        });
      }
      // Vérifier que le téléphone correspond (si fourni)
      const phoneToCheck = data.phone ?? existingUser.phone;
      if (
        phoneToCheck &&
        this.normalizePhone(account.phone) !== this.normalizePhone(phoneToCheck)
      ) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('phone_mismatch', lang),
          statusCode: 400,
        });
      }
    }

    // 3️⃣ Génération d'un code marchand si le rôle devient MERCHANT et qu'il n'en a pas déjà un
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

    // 4️⃣ Préparation des données de mise à jour
    const updateData: any = { updatedAt: new Date() };
    if (data.email) updateData.email = data.email.toLowerCase();
    if (data.phone) updateData.phone = data.phone;
    if (data.full_name) updateData.full_name = data.full_name;
    if (data.account_number) updateData.account_number = data.account_number;
    if (data.branch) updateData.branch = data.branch;
    if (data.role) updateData.role = data.role;
    if (data.status) updateData.status = data.status;
    if (data.businessName) updateData.businessName = data.businessName;
    if (merchantCode !== existingUser.merchantCode)
      updateData.merchantCode = merchantCode;

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

    // 5️⃣ Mise à jour
    try {
      const user = await this.prisma.user.update({
        where: { id },
        data: updateData,
      });

      // ✅ AJOUT : Envoyer un SMS de confirmation de mise à jour (si numéro de téléphone présent)
      const phoneToUse = data.phone || existingUser.phone;
      if (phoneToUse) {
        const cleanPhone = phoneToUse.replace(/[^0-9+]/g, '');
        // let au lieu de const pour pouvoir modifier la variable
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

      return {
        message: this.i18nService.translate('user_updated_success', lang),
        data: this.toResponse(user),
      };
    } catch (error) {
      // Gestion des erreurs de contrainte unique
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
      select: { id: true, role: true },
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

    // Mapper vers l'enum Prisma (vérifier le nom exact de votre enum)
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

    // Mise à jour
    const updatedUser = await this.prisma.user.update({
      where: { id },
      data: { status: enumStatus, updatedAt: new Date() },
    });

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
    const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { pin: hashedPin, pinstatus: true },
    });
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
        data: { user_id: userId },
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
  private toResponse(user: any): UserResponseDto {
    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      full_name: user.full_name,
      account_number: user.account_number,
      branch: user.branch,
      role: user.role,
      status: user.status,
      deleted: user.deleted ?? false,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      fcmToken: user.fcmToken,
      passwordStatus: user.passwordStatus,
      pinstatus: user.pinstatus,
      merchantCode: user.merchantCode ?? null,
      businessName: user.businessName,
      failed_login_attempts: user.failed_login_attempts,
      locked_until: user.locked_until,
    };
  }

  async getAdminDashboard(filters?: { startDate?: Date; endDate?: Date }) {
    try {
      let { startDate, endDate } = filters || {};

      // ✅ Normalisation des dates : début de journée pour startDate, fin de journée pour endDate
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

      // Par défaut, on filtre sur la date actuelle (aujourd'hui)
      const now = new Date();
      if (!startDate && !endDate) {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // 00:00:00
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

      // Construction du filtre de date pour les transactions et autres métriques temporelles
      const dateFilter: any = {};
      if (startDate && !isNaN(startDate.getTime())) {
        dateFilter.gte = startDate;
      }
      if (endDate && !isNaN(endDate.getTime())) {
        dateFilter.lte = endDate;
      }

      // Filtre pour les métriques temporelles (transactions, etc.)
      const transactionWhere: any = {};
      if (Object.keys(dateFilter).length > 0) {
        transactionWhere.createdAt = dateFilter;
      }

      // Filtre pour les métriques permanentes (utilisateurs, commerçants, admins) → PAS de filtre date
      const userWhere: any = { deleted: false };

      // Logs de débogage
      console.log('[Dashboard] Filters reçus:', { startDate, endDate });
      console.log('[Dashboard] dateFilter appliqué:', dateFilter);

      // Exécution parallèle des requêtes
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
        this.prisma.wallet.aggregate({ _sum: { balance: true } }),
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
        this.prisma.user.count({
          where: { ...userWhere, role: 'SUPER_ADMIN' },
        }),
        this.prisma.transaction.aggregate({
          where: { ...transactionWhere, movement: 'CREDIT' },
          _sum: { amount: true },
        }),
        this.prisma.transaction.aggregate({
          where: { ...transactionWhere, movement: 'DEBIT' },
          _sum: { amount: true },
        }),
      ]);

      const totalDownloads = 0;
      const totalVolume = totalTransactionVolume._sum.amount || 0;
      const totalCredits = totalCreditAmount._sum.amount || 0;
      const totalDebits = totalDebitAmount._sum.amount || 0;
      const netBalance = totalCredits - totalDebits;

      // Graphique du volume des transactions
      let volumeChart: any[] = [];
      volumeChart = await this.prisma.$queryRaw`
      SELECT DATE(createdAt) as date, SUM(amount) as volume, COUNT(*) as count
      FROM transaction
      WHERE createdAt >= ${startDate}
        AND createdAt <= ${endDate}
      GROUP BY DATE(createdAt)
      ORDER BY date ASC
    `;
      volumeChart = volumeChart.map((v: any) => ({
        ...v,
        volume: Number(v.volume),
        count: Number(v.count),
      }));

      // Paiements par type
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
      // Croissance des utilisateurs (filtrée par les dates)
      let userGrowth = await this.prisma.$queryRaw`
      SELECT DATE_FORMAT(createdAt, '%Y-%m') as month, COUNT(*) as newUsers
      FROM user
      WHERE createdAt >= ${startDate}
        AND createdAt <= ${endDate}
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

      return {
        message: 'Dashboard data retrieved successfully',
        data: {
          keyMetrics: {
            totalRegisteredUsers: totalUsers,
            totalApplicationDownloads: totalDownloads,
            totalMarchant: totalMerchant,
            totalAdmin,
            totalSuperAdmin,
          },
          wallet: {
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
          userId: data.userId,
          resourceId: item.resourceId,
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const userResources = await this.prisma.user_has_resources.findMany({
      where: { userId },
      include: { resources: true },
    });
    const data = userResources.map((ur) => ({
      resource: ur.resources,
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
    data: any;
    wallets?: any[];
    kyc?: any;
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

      // ✅ 6. Si une soumission existe, la mettre à jour (pas en créer une nouvelle)
      if (existingKyc) {
        console.log(`[submitKyc] 📝 Mise à jour de la soumission KYC existante: ${existingKyc.id}`);

        // Si la soumission est déjà VERIFIED, on ne peut pas la modifier
        if (existingKyc.status === 'VERIFIED') {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('kyc_already_verified', lang),
            statusCode: 400,
          });
        }

        // ✅ Mettre à jour la soumission existante
        kyc = await this.prisma.kyc_submission.update({
          where: { id: existingKyc.id },
          data: {
            documentType: data.documentType,
            documentNumber: data.documentNumber,
            documentFront: data.documentFront,
            documentBack: data.documentBack || null,
            profileImage: data.profileImage || null,
            status: 'PENDING', // Remettre en attente
            submittedAt: new Date(),
            updatedAt: new Date(),
            // Réinitialiser les champs de vérification
            reviewedAt: null,
            adminNotes: null,
            rejectionReason: null,
          },
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
      }

      // 8. Mettre à jour le statut KYC de l'utilisateur
      await this.prisma.user.update({
        where: { id: userId },
        data: { kycStatus: 'PENDING' },
      });

      // 9. Audit
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
        },
        null,
      );

      // ✅ 10. Récupérer les informations complètes de l'utilisateur
      const updatedUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          phone: true,
          fcmToken: true,
          full_name: true,
          account_number: true,
          branch: true,
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
        status: updatedUser?.kycStatus || 'NOT_SUBMITTED',
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
          id: updatedUser?.id,
          email: updatedUser?.email,
          phone: updatedUser?.phone,
          fcmToken: updatedUser?.fcmToken,
          full_name: updatedUser?.full_name,
          account_number: updatedUser?.account_number,
          branch: updatedUser?.branch,
          role: updatedUser?.role,
          passwordStatus: updatedUser?.passwordStatus,
          pinstatus: updatedUser?.pinstatus,
          merchantCode: updatedUser?.merchantCode,
          businessName: updatedUser?.businessName,
          status: updatedUser?.status,
          deleted: updatedUser?.deleted,
          createdAt: updatedUser?.createdAt,
          updatedAt: updatedUser?.updatedAt,
          profileImage: updatedUser?.profileImage,
        },
        wallets: wallets,
        kyc: kycData,
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
        documentFrontUrl: true,
        documentBackUrl: true,
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
      documentFrontUrl: kyc.documentFrontUrl || null,
      documentBackUrl: kyc.documentBackUrl || null,
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
          documentFrontUrl: true,
          documentBackUrl: true,
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
      documentFrontUrl: submission.documentFrontUrl || null,
      documentBackUrl: submission.documentBackUrl || null,
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
        documentFrontUrl: true,
        documentBackUrl: true,
        profileImage: true, // ✅ AJOUTER profileImage ici
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

    // 4. ✅ Récupérer profileImage du KYC (maintenant disponible)
    const profileImageUrl = kyc.profileImage || null;
    console.log(`[verifyKyc] 📷 ProfileImage du KYC: ${profileImageUrl}`);

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

    // 7. Mettre à jour le profileImage de l'utilisateur avec profileImage du KYC
    let userUpdateData: any = { kycStatus: userKycStatus };

    if (data.status === 'VERIFIED' && profileImageUrl) {
      userUpdateData.profileImage = profileImageUrl;
      console.log(`[verifyKyc] ✅ ProfileImage mis à jour pour l'utilisateur ${kyc.userId}: ${profileImageUrl}`);
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

    // 9. Notification par SMS
    if (kyc.user.phone) {
      try {
        const cleanPhone = kyc.user.phone.replace(/[^0-9+]/g, '');
        const userFullName = kyc.user.full_name || 'Cher client';

        const smsText = data.status === 'VERIFIED'
          ? this.i18nService.translate('kyc_verified_sms', lang, {
            full_name: userFullName,
          })
          : this.i18nService.translate('kyc_rejected_sms', lang, {
            full_name: userFullName,
            reason: data.rejectionReason || 'Document non conforme',
          });

        await this.smsService.sendSms(cleanPhone, smsText);
        console.log(`[verifyKyc] ✅ SMS envoyé à ${cleanPhone}`);
      } catch (err) {
        console.error('[KYC] Erreur envoi SMS:', err);
      }
    }

    // 10. Email de notification
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
    const user = await this.prisma.user.findUnique({ where: { id: data.userId } });
    if (!user) {
      throw new RpcException({ status: 'error', message: 'User not found', statusCode: 404 });
    }

    const expiresInDays = data.expiresInDays || 365; // défaut 1 an
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    // Construction du payload JWT
    const payload = {
      sub: user.id,                 // sujet (userId)
      name: data.name,
      permissions: data.permissions,
      iat: Math.floor(Date.now() / 1000),      // émis à
      exp: Math.floor(expiresAt.getTime() / 1000), // expiration
      jti: crypto.randomUUID(),     // identifiant unique du token
    };

    // Signer le JWT avec une clé secrète (stockée dans les variables d'environnement)
    const secret = process.env.JWT_API_KEY_SECRET || 'your-secret-key-at-least-32-chars';
    const apiKey = jwt.sign(payload, secret, { algorithm: 'HS256' });

    // Optionnel : stocker le JWT en base (pour pouvoir le révoquer ultérieurement)
    // Vous pouvez stocker le jti, l'expiration, etc.
    // Ici, on ne stocke que les infos minimales pour traçabilité
    await this.prisma.api_key.create({
      data: {
        id: crypto.randomUUID(),
        key: apiKey,      // le JWT complet
        name: data.name,
        userId: data.userId,
        permissions: JSON.stringify(data.permissions),
        expiresAt,
      },
    });

    return { apiKey };
  }
}
