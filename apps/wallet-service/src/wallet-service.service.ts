/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable prefer-const */
/* eslint-disable @typescript-eslint/no-misused-promises */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/wallet-service/src/wallet-service.service.ts
import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import * as crypto from 'crypto';
import { PrismaService } from './prisma/prisma.service';
import * as fs from 'fs';
import {
  CreditWalletDto,
  DebitWalletDto,
  TransferDto,
} from './dto/transaction.dto';
import { SendDto, PayDto } from './dto/wallet-operation.dto';
import { ApiResponse } from './interfaces/api-response.interface';
import { user_status, wallet_currency } from '@prisma/client';
import { SmsService } from 'apps/auth-service/src/sms/sms.service';
import { NotificationHelper } from 'apps/notification-service/src/helpers/NotificationHelper';
import { NotificationType } from 'apps/notification-service/src/type/notification-type';
import { I18nService } from '@app/common';
import { BankService } from './bank/bank.service';
import * as path from 'path';
import * as ejs from 'ejs';
import * as puppeteer from 'puppeteer';
import { notifyTransaction } from './utilils/wallet-notification.util';
import { logFailedLoginAttempt } from 'apps/auth-service/src/utility/helpers/login-attempt.util';
import { PawapayService } from './pawapay/pawapay.service';
import { CreateWalletDto, WalletResponseDto } from './dto/create-wallet.dto';
import { AdminCashoutDto, AdminPayDto, AdminSendDto, AdminTopUpDto } from './dto/admin-wallet.dto';
import { ConvertCurrencyDto, ExchangeRateDto } from './dto/currency-convert.dto';

type FormattedTransaction = {
  description: string;
  detail: string;
  reference: string;
  date: string;
  credit: number | null;
  debit: number | null;
  balance: number;
};

@Injectable()
export class WalletServiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly smsService: SmsService,
    private readonly notificationHelper: NotificationHelper,
    private readonly i18nService: I18nService,
    private readonly bankService: BankService,
    private readonly pawapayService: PawapayService,
  ) { }

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

  // ==================== MÉTHODES DE BASE ====================
  async linkAccount(accountNumber: string, requestId?: string): Promise<any> {
    return this.bankService.linkAccount(accountNumber, requestId);
  }

  private async getNetworkProviderFees(provider: string): Promise<{ depositFee: number; payoutFee: number }> {
    const network = await this.prisma.network_provider.findFirst({
      where: { name: provider },
    });
    if (!network) {
      console.warn(`[WalletService] Aucun network_provider trouvé pour ${provider}, frais = 0`);
      return { depositFee: 0, payoutFee: 0 };
    }
    return {
      depositFee: network.pourcentage_deposit || 0,
      payoutFee: network.pourcentage_payout || 0,
    };
  }

  private isNationalPhone(phone: string): boolean {
    // Supprime les espaces, tirets, etc.
    const clean = phone.replace(/[^0-9+]/g, '');
    // Vérifie si le numéro commence par 243 (avec ou sans le +)
    return clean.startsWith('243') || clean.startsWith('+243');
  }
  /**
   * Applique des frais de 1% si le numéro du destinataire est international
   */
  private async applyInternationalFeeIfNeeded(
    toPhone: string,
    amount: number,
  ): Promise<{ fee: number; debitAmount: number; creditAmount: number }> {
    if (!this.isNationalPhone(toPhone)) {
      const fee = amount * 0.01; // 1%
      return { fee, debitAmount: amount + fee, creditAmount: amount };
    }
    return { fee: 0, debitAmount: amount, creditAmount: amount };
  }

  private async getExchangeRate(from: string, to: string, tx?: any): Promise<number> {
    if (from === to) return 1;
    const rateRecord = await (tx || this.prisma).exchange_rate.findUnique({
      where: { from_currency_to_currency: { from_currency: from, to_currency: to } },
    });
    if (!rateRecord) {
      throw new RpcException({
        status: 'error',
        message: `Taux de change ${from} -> ${to} non trouvé`,
        statusCode: 404,
      });
    }
    return rateRecord.rate;
  }

  async createWallet(
    data: CreateWalletDto,
  ): Promise<ApiResponse<WalletResponseDto>> {
    console.log('[WalletService] Creating wallet for user:', data.userId);
    const user = await this.prisma.user.findUnique({
      where: { id: data.userId },
    });
    if (!user) {
      throw new RpcException({
        status: 'error',
        message: 'User not found',
        statusCode: 404,
      });
    }
    // Vérifier si un wallet existe déjà (optionnel, on peut autoriser plusieurs wallets)
    const existing = await this.prisma.wallet.findFirst({
      where: { userId: data.userId },
    });
    if (existing) {
      throw new RpcException({
        status: 'error',
        message: 'Wallet already exists',
        statusCode: 409,
      });
    }
    const currency = (data.currency || 'CDF') as wallet_currency;
    const wallet = await this.prisma.wallet.create({
      data: {
        id: crypto.randomUUID(),
        userId: data.userId,
        currency,
        balance: 0,
        isActive: true,
      },
    });
    return {
      message: 'Wallet created successfully',
      data: this.toResponse(wallet),
    };
  }
  /**
  * Récupère un seul wallet d’un utilisateur
  */
  async getWalletById(
    walletId: string,
    lang: string = 'fr',
  ): Promise<ApiResponse<WalletResponseDto>> {
    console.log('[WalletService] Get wallet by ID:', { walletId, lang });
    const where: any = { id: walletId };

    const wallet = await this.prisma.wallet.findFirst({
      where,
      include: { user: { select: { phone: true, full_name: true } } },
    });
    if (!wallet) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.wallet_not_found', lang),
        statusCode: 404,
      });
    }
    return {
      message: this.i18nService.translate('wallet.wallet_retrieved', lang),
      data: this.toResponse(wallet),
    };
  }
  /**
   * Récupère tous les wallets actifs d’un utilisateur
   */
  async getUserWallets(userId: string): Promise<ApiResponse<WalletResponseDto[]>> {
    console.log('[WalletService] Get user wallets:', userId);
    const wallets = await this.prisma.wallet.findMany({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!wallets.length) {
      // Optionnel : créer un wallet par défaut en CDF si aucun wallet n’existe
      const cashCode = await this.generateUniqueCashCode();
      const newWallet = await this.prisma.wallet.create({
        data: {
          id: crypto.randomUUID(),
          userId,
          currency: 'CDF',
          balance: 0,
          isActive: true,
          cashCode,
        },
      });
      return {
        message: 'Wallet récupéré avec succès',
        data: [this.toResponse(newWallet)],
      };
    }
    return {
      message: 'Wallets récupérés avec succès',
      data: wallets.map(w => this.toResponse(w)),
    };
  }

  async getWalletByPhone(phone: string): Promise<
    ApiResponse<
      Omit<WalletResponseDto, 'balance' | 'currency'> & {
        phone?: string | null;
        full_name?: string | null;
      }
    >
  > {
    try {
      const user = await this.prisma.user.findFirst({
        where: { phone },
        select: { id: true, phone: true, full_name: true },
      });
      if (!user) {
        throw new RpcException({
          status: 'error',
          message: 'Utilisateur introuvable avec ce numéro de téléphone',
          statusCode: 404,
        });
      }
      let wallet = await this.prisma.wallet.findFirst({
        where: { userId: user.id },
        include: { user: { select: { phone: true, full_name: true } } },
      });
      if (!wallet) {
        wallet = await this.prisma.wallet.create({
          data: {
            id: crypto.randomUUID(),
            userId: user.id,
            currency: 'CDF',
            balance: 0,
            isActive: true,
          },
          include: { user: { select: { phone: true, full_name: true } } },
        });
      }
      const { balance, currency, ...walletData } = this.toResponse(wallet);
      return {
        message: 'Wallet récupéré avec succès',
        data: {
          ...walletData,
          phone: wallet.user?.phone || null,
          full_name: wallet.user?.full_name || null,
        },
      };
    } catch (error) {
      if (error.code === 'P2003') {
        throw new RpcException({
          status: 'error',
          message: 'Utilisateur introuvable',
          statusCode: 404,
        });
      }
      throw error;
    }
  }

  async convertCurrency(
    dto: ConvertCurrencyDto,
    lang: string = 'fr',
    ipAddress?: string,
  ): Promise<ApiResponse<{ fromWallet: WalletResponseDto; toWallet: WalletResponseDto; transaction: any }>> {
    const { fromWalletId, toWalletId, amount, pin, description } = dto;
    console.log('[WalletService] Convert currency:', { fromWalletId, toWalletId, amount, lang });

    if (amount <= 0) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.amount_positive', lang),
        statusCode: 400,
      });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Récupérer les wallets
      const fromWallet = await tx.wallet.findUnique({ where: { id: fromWalletId }, include: { user: true } });
      if (!fromWallet) throw new RpcException({ status: 'error', message: this.i18nService.translate('wallet.wallet_not_found', lang), statusCode: 404 });
      if (!fromWallet.isActive) throw new RpcException({ status: 'error', message: this.i18nService.translate('wallet.wallet_inactive', lang), statusCode: 403 });
      if (fromWallet.balance < amount) throw new RpcException({ status: 'error', message: this.i18nService.translate('wallet.insufficient_wallet_balance', lang), statusCode: 400 });

      const toWallet = await tx.wallet.findUnique({ where: { id: toWalletId }, include: { user: true } });
      if (!toWallet) throw new RpcException({ status: 'error', message: this.i18nService.translate('wallet.wallet_not_found', lang), statusCode: 404 });
      if (!toWallet.isActive) throw new RpcException({ status: 'error', message: this.i18nService.translate('wallet.wallet_inactive', lang), statusCode: 403 });

      // Vérifier que les deux wallets appartiennent au même utilisateur
      if (fromWallet.userId !== toWallet.userId) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('wallet.conversion_same_owner', lang),
          statusCode: 400,
        });
      }

      const user = fromWallet.user;

      // 2. Vérifier le PIN
      if (!user.pin) {
        throw new RpcException({ status: 'error', message: this.i18nService.translate('wallet.no_pin_set', lang), statusCode: 400 });
      }
      const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
      if (user.pin !== hashedPin) {
        const newAttempts = (user.failed_pin_attempts || 0) + 1;
        let newStatus = user.status;
        let lockedUntil: Date | null = null;
        if (newAttempts >= 5) {
          newStatus = user_status.BLOCKED;
          lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
        }
        await tx.user.update({
          where: { id: user.id },
          data: { failed_pin_attempts: newAttempts, status: newStatus },
        });
        await logFailedLoginAttempt(
          this.prisma,
          user.id,
          user.phone ?? user.id,
          ipAddress,
          undefined,
          newAttempts,
          lockedUntil,
        );
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('wallet.pin_incorrect', lang),
          statusCode: 401,
        });
      }
      await tx.user.update({ where: { id: user.id }, data: { failed_pin_attempts: 0 } });

      // 3. Récupérer le taux de change
      const rate = await this.getExchangeRate(fromWallet.currency, toWallet.currency, tx);
      const convertedAmount = amount * rate;

      // 4. Mettre à jour les soldes
      const updatedFrom = await tx.wallet.update({
        where: { id: fromWallet.id },
        data: { balance: { decrement: amount }, updatedAt: new Date() },
      });
      const updatedTo = await tx.wallet.update({
        where: { id: toWallet.id },
        data: { balance: { increment: convertedAmount }, updatedAt: new Date() },
      });

      // 5. Créer les transactions
      const senderTx = await tx.transaction.create({
        data: {
          id: crypto.randomUUID(),
          userId: user.id,
          walletId: fromWallet.id,
          amount,
          type: 'TRANSFER',
          status: 'SUCCESS',
          reference: `CONV_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
          description: description || this.i18nService.translate('wallet.conversion_debit', lang, {
            amount,
            fromCurrency: fromWallet.currency,
            toCurrency: toWallet.currency,
            rate,
            convertedAmount,
          }),
          movement: 'DEBIT',
        },
      });
      const receiverTx = await tx.transaction.create({
        data: {
          id: crypto.randomUUID(),
          userId: user.id,
          walletId: toWallet.id,
          amount: convertedAmount,
          type: 'DEPOSIT',
          status: 'SUCCESS',
          reference: `CONV_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
          description: description || this.i18nService.translate('wallet.conversion_credit', lang, {
            amount,
            fromCurrency: fromWallet.currency,
            toCurrency: toWallet.currency,
            rate,
            convertedAmount,
          }),
          movement: 'CREDIT',
        },
      });

      await this.logAudit(user.id, 'convertCurrency', { from: updatedFrom, to: updatedTo }, ipAddress || null);
      return { fromWallet: updatedFrom, toWallet: updatedTo, user, senderTx, receiverTx };
    });

    // Notifications (optionnel)
    try {
      await notifyTransaction(
        this.smsService,
        this.notificationHelper,
        this.i18nService,
        this.shouldSendSms.bind(this),
        this.shouldSendPush.bind(this),
        this.getUserLanguage.bind(this),
        result.senderTx,
        result.user,
        result.fromWallet,
        'convert',
      );
    } catch (err) {
      console.error('[Notifications] convert error:', err);
    }

    return {
      message: this.i18nService.translate('wallet.conversion_success', lang),
      data: {
        fromWallet: this.toResponse(result.fromWallet),
        toWallet: this.toResponse(result.toWallet),
        transaction: result.senderTx,
      },
    };
  }

  async adminTopUp(
    dto: AdminTopUpDto,
  ): Promise<ApiResponse<{ wallet: WalletResponseDto; transaction: any }>> {
    const { adminId, walletId, amount, pin, lang = 'fr', ipAddress } = dto;
    console.log('[WalletService] Admin Top-up:', { adminId, walletId, amount, lang });

    // ========== VALIDATIONS ==========
    if (amount <= 0) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.amount_positive', lang),
        statusCode: 400,
      });
    }

    if (!walletId) {
      throw new RpcException({
        status: 'error',
        message: 'L\'ID du wallet est requis',
        statusCode: 400,
      });
    }

    if (!adminId) {
      throw new RpcException({
        status: 'error',
        message: 'L\'ID de l\'admin est requis',
        statusCode: 400,
      });
    }

    if (!pin || pin.length < 4) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.pin_min_length', lang),
        statusCode: 400,
      });
    }

    if (!/^\d+$/.test(pin)) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.pin_digits_only', lang),
        statusCode: 400,
      });
    }

    // ========== TRANSACTION AVEC TIMEOUT AUGMENTÉ ==========
    const result = await this.prisma.$transaction(
      async (tx) => {
        // 1️⃣ Vérifier le PIN de l'admin
        const admin = await tx.user.findFirst({
          where: { id: adminId },
          select: {
            id: true,
            pin: true,
            status: true,
            failed_pin_attempts: true,
            pin_locked_until: true,
            full_name: true,
            phone: true,
          }
        });

        if (!admin) {
          throw new RpcException({
            status: 'error',
            message: 'Admin non trouvé',
            statusCode: 404,
          });
        }

        // ✅ Vérifier que l'admin a un PIN
        if (!admin.pin) {
          throw new RpcException({
            status: 'error',
            message: 'Admin n\'a pas de PIN défini. Veuillez définir un PIN avant d\'effectuer cette opération.',
            statusCode: 400,
          });
        }

        // Vérifier si le PIN est bloqué
        if (admin.pin_locked_until && admin.pin_locked_until > new Date()) {
          const minutesLeft = Math.ceil(
            (admin.pin_locked_until.getTime() - Date.now()) / 60000,
          );
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.pin_locked', lang).replace('{minutes}', minutesLeft.toString()),
            statusCode: 403,
          });
        }

        // Vérifier le PIN
        const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
        if (admin.pin !== hashedPin) {
          const newAttempts = (admin.failed_pin_attempts || 0) + 1;
          let newStatus = admin.status;
          let lockedUntil: Date | null = null;
          if (newAttempts >= 5) {
            newStatus = user_status.BLOCKED;
            lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
          }
          await tx.user.update({
            where: { id: admin.id },
            data: {
              failed_pin_attempts: newAttempts,
              status: newStatus,
              pin_locked_until: lockedUntil
            },
          });
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.pin_incorrect', lang),
            statusCode: 401,
          });
        }

        // Réinitialiser les tentatives de PIN
        await tx.user.update({
          where: { id: admin.id },
          data: { failed_pin_attempts: 0, pin_locked_until: null },
        });

        // 2️⃣ Récupérer le wallet avec son utilisateur
        const wallet = await tx.wallet.findFirst({
          where: { id: walletId },
          include: { user: true }
        });
        if (!wallet) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_not_found', lang),
            statusCode: 404,
          });
        }
        if (!wallet.isActive) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_inactive', lang),
            statusCode: 403,
          });
        }

        const user = wallet.user;

        // 3️⃣ Mettre à jour le wallet
        const updated = await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: amount }, updatedAt: new Date() },
        });

        // 4️⃣ Créer la transaction
        const transaction = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: user.id,
            walletId: wallet.id,
            amount,
            type: 'DEPOSIT',
            status: 'SUCCESS',
            reference: `ADMIN_TOPUP_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            description: `Alimentation admin (cash)`,
            movement: 'CREDIT',
          },
        });

        // 5️⃣ Audit log
        await tx.audit_log.create({
          data: {
            id: crypto.randomUUID(),
            userId: admin.id,
            action: 'adminTopUp',
            details: JSON.stringify({ transaction, targetUserId: user.id }),
            ipAddress: ipAddress || null,
            createdAt: new Date(),
          },
        });

        return { wallet: updated, transaction, user, admin };
      },
      {
        timeout: 30000,   // ✅ 30 secondes
        maxWait: 30000,   // ✅ 30 secondes
      }
    );

    // ========== ENVOYER LE SMS EN DEHORS DE LA TRANSACTION ==========
    if (result.user.phone) {
      try {
        const cleanPhone = result.user.phone.replace(/[^0-9+]/g, '');
        const smsText = this.i18nService.translate('wallet.top_up_sms', lang, {
          full_name: result.user.full_name || '',
          amount: amount,
          currency: result.wallet.currency || 'CDF',
          balance: result.wallet.balance || 0,
        });
        await this.smsService.sendSms(cleanPhone, smsText);
        console.log(`[AdminTopUp] SMS envoyé à ${cleanPhone}`);
      } catch (err) {
        console.error('[AdminTopUp] Erreur envoi SMS:', err);
      }
    }

    // ========== NOTIFICATION PUSH ==========
    await this.notificationHelper.notify(
      result.user.id,
      NotificationType.TOP_UP_SUCCESS,
      {
        amount,
        currency: result.wallet.currency || 'CDF',
        balance: result.wallet.balance || 0
      },
      'TRANSACTION',
      result.transaction.id,
      lang,
    );

    // ========== RETOUR ==========
    return {
      message: this.i18nService.translate('wallet.top_up_success', lang),
      data: {
        wallet: this.toResponse(result.wallet),
        transaction: result.transaction,
      },
    };
  }
  // adminCashout - CORRIGÉ avec adminId
  async adminCashout(
    dto: AdminCashoutDto,
  ): Promise<ApiResponse<{ wallet: WalletResponseDto; transaction: any }>> {
    const { adminId, walletId, amount, pin, lang = 'fr', ipAddress } = dto;
    console.log('[WalletService] Admin Cashout:', { adminId, walletId, amount, lang });

    // ========== VALIDATIONS ==========
    if (amount <= 0) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.amount_positive', lang),
        statusCode: 400,
      });
    }

    if (!walletId) {
      throw new RpcException({
        status: 'error',
        message: 'L\'ID du wallet est requis',
        statusCode: 400,
      });
    }

    if (!adminId) {
      throw new RpcException({
        status: 'error',
        message: 'L\'ID de l\'admin est requis',
        statusCode: 400,
      });
    }

    if (!pin || pin.length < 4) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.pin_min_length', lang),
        statusCode: 400,
      });
    }

    if (!/^\d+$/.test(pin)) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.pin_digits_only', lang),
        statusCode: 400,
      });
    }

    // ========== TRANSACTION AVEC TIMEOUT ==========
    const result = await this.prisma.$transaction(
      async (tx) => {
        // 1️⃣ Vérifier le PIN de l'admin
        const admin = await tx.user.findFirst({
          where: { id: adminId },
          select: {
            id: true,
            pin: true,
            status: true,
            failed_pin_attempts: true,
            pin_locked_until: true,
            full_name: true,
            phone: true,
          }
        });

        if (!admin) {
          throw new RpcException({
            status: 'error',
            message: 'Admin non trouvé',
            statusCode: 404,
          });
        }

        // ✅ Vérifier que l'admin a un PIN
        if (!admin.pin) {
          throw new RpcException({
            status: 'error',
            message: 'Admin n\'a pas de PIN défini. Veuillez définir un PIN avant d\'effectuer cette opération.',
            statusCode: 400,
          });
        }

        // Vérifier si le PIN est bloqué
        if (admin.pin_locked_until && admin.pin_locked_until > new Date()) {
          const minutesLeft = Math.ceil(
            (admin.pin_locked_until.getTime() - Date.now()) / 60000,
          );
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.pin_locked', lang).replace('{minutes}', minutesLeft.toString()),
            statusCode: 403,
          });
        }

        // Vérifier le PIN
        const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
        if (admin.pin !== hashedPin) {
          const newAttempts = (admin.failed_pin_attempts || 0) + 1;
          let newStatus = admin.status;
          let lockedUntil: Date | null = null;
          if (newAttempts >= 5) {
            newStatus = user_status.BLOCKED;
            lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
          }
          await tx.user.update({
            where: { id: admin.id },
            data: {
              failed_pin_attempts: newAttempts,
              status: newStatus,
              pin_locked_until: lockedUntil
            },
          });
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.pin_incorrect', lang),
            statusCode: 401,
          });
        }

        await tx.user.update({
          where: { id: admin.id },
          data: { failed_pin_attempts: 0, pin_locked_until: null },
        });

        // 2️⃣ Récupérer le wallet
        const wallet = await tx.wallet.findFirst({
          where: { id: walletId },
          include: { user: true }
        });
        if (!wallet) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_not_found', lang),
            statusCode: 404,
          });
        }
        if (!wallet.isActive) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_inactive', lang),
            statusCode: 403,
          });
        }
        if (wallet.balance < amount) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.insufficient_wallet_balance', lang),
            statusCode: 400,
          });
        }

        const user = wallet.user;

        // 3️⃣ Mettre à jour le wallet
        const updated = await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { decrement: amount }, updatedAt: new Date() },
        });

        // 4️⃣ Créer la transaction
        const transaction = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: user.id,
            walletId: wallet.id,
            amount,
            type: 'WITHDRAW',
            status: 'SUCCESS',
            reference: `ADMIN_CASHOUT_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            description: `Retrait admin (cash)`,
            movement: 'DEBIT',
          },
        });

        // 5️⃣ Audit log
        await tx.audit_log.create({
          data: {
            id: crypto.randomUUID(),
            userId: admin.id,
            action: 'adminCashout',
            details: JSON.stringify({ transaction, targetUserId: user.id }),
            ipAddress: ipAddress || null,
            createdAt: new Date(),
          },
        });

        return { wallet: updated, transaction, user, admin };
      },
      {
        timeout: 30000,
        maxWait: 30000,
      }
    );

    // ========== SMS EN DEHORS DE LA TRANSACTION ==========
    if (result.user.phone) {
      try {
        const cleanPhone = result.user.phone.replace(/[^0-9+]/g, '');
        const smsText = this.i18nService.translate('wallet.cashout_sms', lang, {
          full_name: result.user.full_name || '',
          amount: amount,
          currency: result.wallet.currency || 'CDF',
          balance: result.wallet.balance || 0,
        });
        await this.smsService.sendSms(cleanPhone, smsText);
        console.log(`[AdminCashout] SMS envoyé à ${cleanPhone}`);
      } catch (err) {
        console.error('[AdminCashout] Erreur envoi SMS:', err);
      }
    }

    // ========== NOTIFICATION PUSH ==========
    await this.notificationHelper.notify(
      result.user.id,
      NotificationType.CASHOUT_SUCCESS,
      { amount, currency: result.wallet.currency || 'CDF', balance: result.wallet.balance || 0 },
      'TRANSACTION',
      result.transaction.id,
      lang,
    );

    return {
      message: this.i18nService.translate('wallet.cashout_success', lang),
      data: {
        wallet: this.toResponse(result.wallet),
        transaction: result.transaction,
      },
    };
  }

  async adminSend(
    dto: AdminSendDto,
  ): Promise<ApiResponse<{ fromWallet: WalletResponseDto; toWallet: WalletResponseDto; transaction: any }>> {
    const { adminId, fromWalletId, toWalletId, amount, pin, description, lang = 'fr', ipAddress } = dto;
    console.log('[WalletService] Admin Send:', { adminId, fromWalletId, toWalletId, amount, lang });

    // ========== VALIDATIONS ==========
    if (amount <= 0) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.amount_positive', lang),
        statusCode: 400,
      });
    }

    if (!fromWalletId || !toWalletId) {
      throw new RpcException({
        status: 'error',
        message: 'Les IDs des wallets source et destination sont requis',
        statusCode: 400,
      });
    }

    if (!adminId) {
      throw new RpcException({
        status: 'error',
        message: 'L\'ID de l\'admin est requis',
        statusCode: 400,
      });
    }

    if (!pin || pin.length < 4) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.pin_min_length', lang),
        statusCode: 400,
      });
    }

    if (!/^\d+$/.test(pin)) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.pin_digits_only', lang),
        statusCode: 400,
      });
    }

    // ========== TRANSACTION AVEC TIMEOUT ==========
    const result = await this.prisma.$transaction(
      async (tx) => {
        // 1️⃣ Vérifier le PIN de l'admin
        const admin = await tx.user.findFirst({
          where: { id: adminId },
          select: {
            id: true,
            pin: true,
            status: true,
            failed_pin_attempts: true,
            pin_locked_until: true,
            full_name: true,
            phone: true,
          }
        });

        if (!admin) {
          throw new RpcException({
            status: 'error',
            message: 'Admin non trouvé',
            statusCode: 404,
          });
        }

        if (!admin.pin) {
          throw new RpcException({
            status: 'error',
            message: 'Admin n\'a pas de PIN défini.',
            statusCode: 400,
          });
        }

        if (admin.pin_locked_until && admin.pin_locked_until > new Date()) {
          const minutesLeft = Math.ceil(
            (admin.pin_locked_until.getTime() - Date.now()) / 60000,
          );
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.pin_locked', lang).replace('{minutes}', minutesLeft.toString()),
            statusCode: 403,
          });
        }

        const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
        if (admin.pin !== hashedPin) {
          const newAttempts = (admin.failed_pin_attempts || 0) + 1;
          let newStatus = admin.status;
          let lockedUntil: Date | null = null;
          if (newAttempts >= 5) {
            newStatus = user_status.BLOCKED;
            lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
          }
          await tx.user.update({
            where: { id: admin.id },
            data: {
              failed_pin_attempts: newAttempts,
              status: newStatus,
              pin_locked_until: lockedUntil
            },
          });
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.pin_incorrect', lang),
            statusCode: 401,
          });
        }

        await tx.user.update({
          where: { id: admin.id },
          data: { failed_pin_attempts: 0, pin_locked_until: null },
        });

        // 2️⃣ Récupérer les wallets
        const fromWallet = await tx.wallet.findFirst({
          where: { id: fromWalletId },
          include: { user: true }
        });
        if (!fromWallet) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_not_found', lang),
            statusCode: 404
          });
        }
        if (!fromWallet.isActive) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_inactive', lang),
            statusCode: 403
          });
        }
        if (fromWallet.balance < amount) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.insufficient_wallet_balance', lang),
            statusCode: 400
          });
        }

        const toWallet = await tx.wallet.findFirst({
          where: { id: toWalletId },
          include: { user: true }
        });
        if (!toWallet) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_not_found', lang),
            statusCode: 404
          });
        }
        if (!toWallet.isActive) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_inactive', lang),
            statusCode: 403
          });
        }

        if (fromWalletId === toWalletId) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.cannot_transfer_self', lang),
            statusCode: 400
          });
        }

        const fromUser = fromWallet.user;
        const toUser = toWallet.user;

        // 3️⃣ Mettre à jour les soldes
        const updatedFrom = await tx.wallet.update({
          where: { id: fromWallet.id },
          data: { balance: { decrement: amount }, updatedAt: new Date() },
        });
        const updatedTo = await tx.wallet.update({
          where: { id: toWallet.id },
          data: { balance: { increment: amount }, updatedAt: new Date() },
        });

        // 4️⃣ Créer les transactions
        const senderTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: fromUser.id,
            walletId: fromWallet.id,
            amount,
            type: 'TRANSFER',
            status: 'SUCCESS',
            reference: `ADMIN_SEND_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            description: description || `Transfert admin vers ${toUser.full_name}`,
            movement: 'DEBIT',
          },
        });
        const receiverTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: toUser.id,
            walletId: toWallet.id,
            amount,
            type: 'DEPOSIT',
            status: 'SUCCESS',
            reference: `ADMIN_RECV_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            description: description || `Reçu admin de ${fromUser.full_name}`,
            movement: 'CREDIT',
          },
        });

        // 5️⃣ Audit log
        await tx.audit_log.create({
          data: {
            id: crypto.randomUUID(),
            userId: admin.id,
            action: 'adminSend',
            details: JSON.stringify({ from: updatedFrom, to: updatedTo }),
            ipAddress: ipAddress || null,
            createdAt: new Date(),
          },
        });

        return { fromWallet: updatedFrom, toWallet: updatedTo, fromUser, toUser, senderTx, receiverTx, admin };
      },
      {
        timeout: 30000,
        maxWait: 30000,
      }
    );

    // ========== SMS EN DEHORS DE LA TRANSACTION ==========
    if (result.fromUser.phone) {
      try {
        const cleanPhone = result.fromUser.phone.replace(/[^0-9+]/g, '');
        const smsText = this.i18nService.translate('wallet.transfer_sender_sms', lang, {
          full_name: result.fromUser.full_name || '',
          amount: amount,
          currency: result.fromWallet.currency || 'CDF',
          toPhone: result.toUser.phone || '',
          balance: result.fromWallet.balance || 0,
        });
        await this.smsService.sendSms(cleanPhone, smsText);
      } catch (err) {
        console.error('[AdminSend] Erreur envoi SMS:', err);
      }
    }

    if (result.toUser.phone) {
      try {
        const cleanPhone = result.toUser.phone.replace(/[^0-9+]/g, '');
        const smsText = this.i18nService.translate('wallet.transfer_receiver_sms', lang, {
          full_name: result.toUser.full_name || '',
          amount: amount,
          currency: result.toWallet.currency || 'CDF',
          fromPhone: result.fromUser.phone || '',
          balance: result.toWallet.balance || 0,
        });
        await this.smsService.sendSms(cleanPhone, smsText);
      } catch (err) {
        console.error('[AdminSend] Erreur envoi SMS:', err);
      }
    }

    // ========== NOTIFICATIONS PUSH ==========
    try {
      await Promise.all([
        notifyTransaction(
          this.smsService, this.notificationHelper, this.i18nService,
          this.shouldSendSms.bind(this), this.shouldSendPush.bind(this), this.getUserLanguage.bind(this),
          result.senderTx, result.fromUser, result.fromWallet, 'send_sent',
          { name: result.toUser.full_name ?? undefined, phone: result.toUser.phone ?? undefined }
        ),
        notifyTransaction(
          this.smsService, this.notificationHelper, this.i18nService,
          this.shouldSendSms.bind(this), this.shouldSendPush.bind(this), this.getUserLanguage.bind(this),
          result.receiverTx, result.toUser, result.toWallet, 'send_received',
          { name: result.fromUser.full_name ?? undefined, phone: result.fromUser.phone ?? undefined }
        ),
      ]);
    } catch (err) {
      console.error('[Notifications] adminSend error:', err);
    }

    return {
      message: this.i18nService.translate('wallet.transfer_success', lang),
      data: {
        fromWallet: this.toResponse(result.fromWallet),
        toWallet: this.toResponse(result.toWallet),
        transaction: { reference: `ADMIN_SEND_${Date.now()}` },
      },
    };
  }

  async adminPay(
    dto: AdminPayDto,
  ): Promise<ApiResponse<{ wallet: WalletResponseDto; transaction: any }>> {
    const { adminId, fromWalletId, merchantCode, amount, pin, description, lang = 'fr', ipAddress } = dto;
    console.log('[WalletService] Admin Pay:', { adminId, fromWalletId, merchantCode, amount, lang });

    // ========== VALIDATIONS ==========
    if (amount <= 0) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.amount_positive', lang),
        statusCode: 400,
      });
    }

    if (!fromWalletId || !merchantCode) {
      throw new RpcException({
        status: 'error',
        message: 'Le wallet source et le code marchand sont requis',
        statusCode: 400,
      });
    }

    if (!adminId) {
      throw new RpcException({
        status: 'error',
        message: 'L\'ID de l\'admin est requis',
        statusCode: 400,
      });
    }

    if (!pin || pin.length < 4) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.pin_min_length', lang),
        statusCode: 400,
      });
    }

    if (!/^\d+$/.test(pin)) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.pin_digits_only', lang),
        statusCode: 400,
      });
    }

    // ========== TRANSACTION AVEC TIMEOUT ==========
    const result = await this.prisma.$transaction(
      async (tx) => {
        // 1️⃣ Vérifier le PIN de l'admin
        const admin = await tx.user.findFirst({
          where: { id: adminId },
          select: {
            id: true,
            pin: true,
            status: true,
            failed_pin_attempts: true,
            pin_locked_until: true,
            full_name: true,
            phone: true,
          }
        });

        if (!admin) {
          throw new RpcException({
            status: 'error',
            message: 'Admin non trouvé',
            statusCode: 404,
          });
        }

        if (!admin.pin) {
          throw new RpcException({
            status: 'error',
            message: 'Admin n\'a pas de PIN défini.',
            statusCode: 400,
          });
        }

        if (admin.pin_locked_until && admin.pin_locked_until > new Date()) {
          const minutesLeft = Math.ceil(
            (admin.pin_locked_until.getTime() - Date.now()) / 60000,
          );
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.pin_locked', lang).replace('{minutes}', minutesLeft.toString()),
            statusCode: 403,
          });
        }

        const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
        if (admin.pin !== hashedPin) {
          const newAttempts = (admin.failed_pin_attempts || 0) + 1;
          let newStatus = admin.status;
          let lockedUntil: Date | null = null;
          if (newAttempts >= 5) {
            newStatus = user_status.BLOCKED;
            lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
          }
          await tx.user.update({
            where: { id: admin.id },
            data: {
              failed_pin_attempts: newAttempts,
              status: newStatus,
              pin_locked_until: lockedUntil
            },
          });
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.pin_incorrect', lang),
            statusCode: 401,
          });
        }

        await tx.user.update({
          where: { id: admin.id },
          data: { failed_pin_attempts: 0, pin_locked_until: null },
        });

        // 2️⃣ Récupérer le wallet du payeur
        const fromWallet = await tx.wallet.findFirst({
          where: { id: fromWalletId },
          include: { user: true }
        });
        if (!fromWallet) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_not_found', lang),
            statusCode: 404
          });
        }
        if (!fromWallet.isActive) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_inactive', lang),
            statusCode: 403
          });
        }
        if (fromWallet.balance < amount) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.insufficient_wallet_balance', lang),
            statusCode: 400
          });
        }

        const fromUser = fromWallet.user;

        // 3️⃣ Récupérer le commerçant
        const toUser = await tx.user.findFirst({
          where: {
            merchantCode: merchantCode,
            role: 'MERCHANT'
          },
          select: {
            id: true,
            full_name: true,
            phone: true,
            role: true,
            merchantCode: true
          }
        });
        if (!toUser) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.merchant_not_found', lang),
            statusCode: 404
          });
        }

        // 4️⃣ Récupérer ou créer le wallet du commerçant
        let toWallet = await tx.wallet.findFirst({
          where: { userId: toUser.id, isActive: true }
        });
        if (!toWallet) {
          toWallet = await tx.wallet.create({
            data: {
              id: crypto.randomUUID(),
              userId: toUser.id,
              currency: fromWallet.currency || 'CDF',
              balance: 0,
              isActive: true,
            },
          });
        }
        if (!toWallet.isActive) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_inactive', lang),
            statusCode: 403
          });
        }

        // 5️⃣ Mettre à jour les soldes
        const updatedFrom = await tx.wallet.update({
          where: { id: fromWallet.id },
          data: { balance: { decrement: amount }, updatedAt: new Date() },
        });
        const updatedTo = await tx.wallet.update({
          where: { id: toWallet.id },
          data: { balance: { increment: amount }, updatedAt: new Date() },
        });

        // 6️⃣ Créer les transactions
        const payerTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: fromUser.id,
            walletId: fromWallet.id,
            amount,
            type: 'PAYMENT',
            status: 'SUCCESS',
            reference: `ADMIN_PAY_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            description: description || `Paiement admin à ${toUser.full_name}`,
            movement: 'DEBIT',
          },
        });
        const merchantTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: toUser.id,
            walletId: toWallet.id,
            amount,
            type: 'PAYMENT',
            status: 'SUCCESS',
            reference: `ADMIN_PAY_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            description: description || `Reçu admin de ${fromUser.full_name}`,
            movement: 'CREDIT',
          },
        });

        // 7️⃣ Audit log
        await tx.audit_log.create({
          data: {
            id: crypto.randomUUID(),
            userId: admin.id,
            action: 'adminPay',
            details: JSON.stringify({ from: updatedFrom, to: updatedTo }),
            ipAddress: ipAddress || null,
            createdAt: new Date(),
          },
        });

        return { fromWallet: updatedFrom, toWallet: updatedTo, fromUser, toUser, payerTx, merchantTx, admin };
      },
      {
        timeout: 30000,
        maxWait: 30000,
      }
    );

    // ========== SMS EN DEHORS DE LA TRANSACTION ==========
    if (result.fromUser.phone) {
      try {
        const cleanPhone = result.fromUser.phone.replace(/[^0-9+]/g, '');
        const smsText = this.i18nService.translate('wallet.payment_payer_sms', lang, {
          full_name: result.fromUser.full_name || '',
          amount: amount,
          currency: result.fromWallet.currency || 'CDF',
          merchantName: result.toUser.full_name || '',
          balance: result.fromWallet.balance || 0,
        });
        await this.smsService.sendSms(cleanPhone, smsText);
      } catch (err) {
        console.error('[AdminPay] Erreur envoi SMS:', err);
      }
    }

    if (result.toUser.phone) {
      try {
        const cleanPhone = result.toUser.phone.replace(/[^0-9+]/g, '');
        const smsText = this.i18nService.translate('wallet.payment_merchant_sms', lang, {
          full_name: result.toUser.full_name || '',
          amount: amount,
          currency: result.toWallet.currency || 'CDF',
          payerName: result.fromUser.full_name || '',
          balance: result.toWallet.balance || 0,
        });
        await this.smsService.sendSms(cleanPhone, smsText);
      } catch (err) {
        console.error('[AdminPay] Erreur envoi SMS:', err);
      }
    }

    // ========== NOTIFICATIONS PUSH ==========
    try {
      await Promise.all([
        notifyTransaction(
          this.smsService, this.notificationHelper, this.i18nService,
          this.shouldSendSms.bind(this), this.shouldSendPush.bind(this), this.getUserLanguage.bind(this),
          result.payerTx, result.fromUser, result.fromWallet, 'pay_sent',
          { name: result.toUser.full_name ?? undefined, phone: result.toUser.phone ?? undefined }
        ),
        notifyTransaction(
          this.smsService, this.notificationHelper, this.i18nService,
          this.shouldSendSms.bind(this), this.shouldSendPush.bind(this), this.getUserLanguage.bind(this),
          result.merchantTx, result.toUser, result.toWallet, 'pay_received',
          { name: result.fromUser.full_name ?? undefined, phone: result.fromUser.phone ?? undefined }
        ),
      ]);
    } catch (err) {
      console.error('[Notifications] adminPay error:', err);
    }

    return {
      message: this.i18nService.translate('wallet.payment_success', lang),
      data: {
        wallet: this.toResponse(result.fromWallet),
        transaction: result.payerTx,
      },
    };
  }

  async listTransactions(
    userId: string,
    page: number = 1,
    limit: number = 10,
    startDate?: Date,
    endDate?: Date,
  ) {
    const skip = (page - 1) * limit;
    const where: any = { userId };
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) {
        const endOfDay = new Date(endDate);
        endOfDay.setHours(23, 59, 59, 999);
        where.createdAt.lte = endOfDay;
      }
    }
    const [transactions, total, creditSum, debitSum] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.transaction.count({ where }),
      this.prisma.transaction.aggregate({
        where: { ...where, movement: 'CREDIT' },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { ...where, movement: 'DEBIT' },
        _sum: { amount: true },
      }),
    ]);
    const totalCredit = creditSum._sum.amount || 0;
    const totalDebit = debitSum._sum.amount || 0;
    const enrichedTransactions = await Promise.all(
      transactions.map(async (tx) => {
        let full_name: string | null = null;
        let phone: string | null = null;
        if (tx.type === 'TRANSFER' && tx.movement === 'DEBIT') {
          const toMatch = tx.description?.match(/\[TO:([^\]]+)\]/);
          const receiverId = toMatch?.[1];
          if (receiverId) {
            const receiver = await this.prisma.user.findUnique({
              where: { id: receiverId },
              select: { full_name: true, phone: true },
            });
            if (receiver) {
              full_name = receiver.full_name;
              phone = receiver.phone;
            }
          }
        } else if (tx.type === 'TRANSFER' && tx.movement === 'CREDIT') {
          const fromMatch = tx.description?.match(/\[FROM:([^\]]+)\]/);
          const senderId = fromMatch?.[1];
          if (senderId) {
            const sender = await this.prisma.user.findUnique({
              where: { id: senderId },
              select: { full_name: true, phone: true },
            });
            if (sender) {
              full_name = sender.full_name;
              phone = sender.phone;
            }
          }
        } else if (tx.type === 'PAYMENT' && tx.movement === 'DEBIT') {
          const merchantMatch = tx.description?.match(
            /Paiement à (.+?) \(([^)]+)\)/,
          );
          if (merchantMatch) {
            full_name = merchantMatch[1];
            phone = merchantMatch[2];
          }
        } else if (tx.type === 'PAYMENT' && tx.movement === 'CREDIT') {
          const customerMatch = tx.description?.match(
            /Reçu de [A-Z0-9]+ \(([^)]+)\)/,
          );
          if (customerMatch) {
            full_name = customerMatch[1];
          }
        }
        const cleanDescription =
          tx.description?.replace(/\[TO:[^\]]+\]|\[FROM:[^\]]+\]/, '').trim() ||
          tx.description;
        const { description, ...rest } = tx;
        return {
          ...rest,
          description: cleanDescription,
          full_name,
          phone,
        };
      }),
    );
    return {
      message: 'Transactions retrieved successfully',
      data: {
        data: enrichedTransactions,
        total,
        page,
        limit,
        analytics: {
          totalCredit,
          totalDebit,
        },
      },
    };
  }

  async listAllTransactions(
    page: number = 1,
    limit: number = 10,
    userId?: string,
    type?: string,
    status?: string,
    startDate?: Date,
    endDate?: Date,
    search?: string,
  ) {
    const skip = (page - 1) * limit;
    const where: any = {};
    if (userId) where.userId = userId;
    if (type) where.type = type;
    if (status) where.status = status;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) {
        const endOfDay = new Date(endDate);
        endOfDay.setHours(23, 59, 59, 999);
        where.createdAt.lte = endOfDay;
      }
    }
    if (search && search.trim() !== '') {
      const searchTerm = search.trim();
      where.OR = [
        { description: { contains: searchTerm } },
        {
          user: {
            OR: [
              { full_name: { contains: searchTerm } },
              { account_number: { contains: searchTerm } },
              { phone: { contains: searchTerm } },
            ],
          },
        },
      ];
    }
    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: {
            select: { full_name: true, account_number: true, phone: true },
          },
        },
      }),
      this.prisma.transaction.count({ where }),
    ]);
    return {
      message: 'All transactions retrieved successfully',
      data: {
        data: transactions,
        total,
        page,
        limit,
      },
    };
  }

  async listAllTransactionsWithoutPagination(
    userId?: string,
    type?: string,
    status?: string,
    startDate?: Date,
    endDate?: Date,
    search?: string,
  ) {
    const where: any = {};
    if (userId) where.userId = userId;
    if (type) where.type = type;
    if (status) where.status = status;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) {
        const endOfDay = new Date(endDate);
        endOfDay.setHours(23, 59, 59, 999);
        where.createdAt.lte = endOfDay;
      }
    }
    if (search && search.trim() !== '') {
      const searchTerm = search.trim();
      where.OR = [
        { description: { contains: searchTerm } },
        {
          user: {
            OR: [
              { full_name: { contains: searchTerm } },
              { account_number: { contains: searchTerm } },
              { phone: { contains: searchTerm } },
            ],
          },
        },
      ];
    }

    const transactions = await this.prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { full_name: true, account_number: true, phone: true },
        },
      },
    });

    return {
      message: 'All transactions retrieved successfully',
      data: transactions,
      total: transactions.length,
    };
  }

  async listAllTransactionsWithoutPag(
    userId?: string,
    type?: string,
    status?: string,
    startDate?: Date,
    endDate?: Date,
    search?: string,
  ) {
    const where: any = {};
    if (userId) where.userId = userId;
    if (type) where.type = type;
    if (status) where.status = status;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }
    if (search && search.trim() !== '') {
      const searchTerm = search.trim();
      where.OR = [
        { description: { contains: searchTerm } },
        {
          user: {
            OR: [
              { full_name: { contains: searchTerm } },
              { account_number: { contains: searchTerm } },
              { phone: { contains: searchTerm } },
            ],
          },
        },
      ];
    }
    const transactions = await this.prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { full_name: true, account_number: true, phone: true },
        },
      },
    });
    const total = transactions.length;
    return {
      message: 'All transactions retrieved successfully',
      data: {
        data: transactions,
        total,
      },
    };
  }

  // ==================== OPÉRATIONS AVANCÉES (avec langue) ====================
  private async shouldSendSms(userId: string): Promise<boolean> {
    const settings = await this.prisma.user_settings.findFirst({
      where: { user_id: userId },
      select: { sms_notifications: true },
    });
    return settings?.sms_notifications ?? true;
  }

  private async shouldSendPush(userId: string): Promise<boolean> {
    const settings = await this.prisma.user_settings.findFirst({
      where: { user_id: userId },
      select: { push_notifications: true },
    });
    return settings?.push_notifications ?? true;
  }

  async getUserLanguage(userId: string): Promise<string> {
    const settings = await this.prisma.user_settings.findFirst({
      where: { user_id: userId },
      select: { language: true },
    });
    return settings?.language ?? 'fr';
  }

  private async generateUniqueCashCode(): Promise<string> {
    let code: string = '';
    let exists = true;
    while (exists) {
      const randomNum = Math.floor(10000000 + Math.random() * 90000000);
      code = `CASH${randomNum}`;
      const existing = await this.prisma.wallet.findFirst({
        where: { cashCode: code },
      });
      exists = !!existing;
    }
    return code;
  }

  /**
   * Recharge un wallet via virement bancaire ou mobile money (PawaPay)
   */
  async topUp(
    userId: string,
    amount: number,
    pin: string,
    lang: string = 'fr',
    ipAddress?: string,
    walletId?: string,
    provider?: string,
    phone?: string,
  ): Promise<ApiResponse<{ wallet: WalletResponseDto; transaction: any }>> {
    console.log('[WalletService] Top-up request:', { userId, amount, lang, walletId, provider, phone });
    if (amount <= 0)
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.amount_positive', lang),
        statusCode: 400,
      });
    if (!pin || pin.length < 4) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.pin_min_length', lang),
        statusCode: 400,
      });
    }
    if (!/^\d+$/.test(pin)) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.pin_digits_only', lang),
        statusCode: 400,
      });
    }

    // PawaPay est obligatoire
    if (!provider || !phone) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.missing_phone_or_provider', lang),
        statusCode: 400,
      });
    }

    let user: any;
    let wallet: any;

    // 1. Validation utilisateur, PIN et wallet (sans transaction)
    try {
      user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          full_name: true,
          phone: true,
          pin: true,
          status: true,
          failed_pin_attempts: true,
        },
      });
      if (!user)
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('wallet.user_not_found', lang),
          statusCode: 404,
        });

      if (user.status === user_status.BLOCKED) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('account_blocked_admin', lang),
          statusCode: 403,
        });
      }

      const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
      if (user.pin !== hashedPin) {
        const newAttempts = (user.failed_pin_attempts || 0) + 1;
        let newStatus: user_status = user.status;
        let lockedUntil: Date | null = null;
        if (newAttempts >= 5) {
          newStatus = user_status.BLOCKED;
          lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
        }
        await this.prisma.user.update({
          where: { id: userId },
          data: { failed_pin_attempts: newAttempts, status: newStatus },
        });
        await logFailedLoginAttempt(
          this.prisma,
          user.id,
          user.phone ?? user.id,
          ipAddress,
          undefined,
          newAttempts,
          lockedUntil,
        );
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('wallet.pin_incorrect', lang),
          statusCode: 401,
        });
      }

      await this.prisma.user.update({
        where: { id: userId },
        data: { failed_pin_attempts: 0 },
      });

      // Récupérer ou créer le wallet
      if (walletId) {
        wallet = await this.prisma.wallet.findUnique({ where: { id: walletId, userId } });
        if (!wallet)
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_not_found_or_unauthorized', lang),
            statusCode: 404,
          });
      } else {
        wallet = await this.prisma.wallet.findFirst({ where: { userId } });
        if (!wallet) {
          const cashCode = await this.generateUniqueCashCode();
          wallet = await this.prisma.wallet.create({
            data: {
              id: crypto.randomUUID(),
              userId,
              currency: 'CDF',
              balance: 0,
              isActive: true,
              cashCode,
            },
          });
        }
      }
      if (!wallet.isActive)
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('wallet.wallet_inactive', lang),
          statusCode: 403,
        });
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message,
        statusCode: 500,
      });
    }

    // 2. Exécuter le paiement PawaPay
    let paymentSucceeded = false;
    let failureReasonKey: string | null = null;
    let failureReasonParams: any = {};
    let externalReference: string | undefined;

    if (!phone) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.missing_phone_for_payment', lang),
        statusCode: 400,
      });
    }

    // Récupérer les frais de dépôt
    const fees = await this.getNetworkProviderFees(provider);
    const feeAmount = (amount * fees.depositFee) / 100;
    const netAmount = amount - feeAmount; // montant crédité dans le wallet

    const amountStr = amount.toString();
    const pawapayData = {
      amount: amountStr,
      currency: wallet.currency,
      provider,
      phone,
      walletId: wallet.id,
    };

    console.log('[WalletService] Appel PawaPay deposit:', pawapayData);
    try {
      const pawapayResponse = await this.pawapayService.createDepositSimple(pawapayData);
      console.log('[WalletService] Réponse PawaPay:', pawapayResponse);
      const depositStatus = pawapayResponse.finalStatus?.data?.status;
      if (depositStatus === 'COMPLETED') {
        paymentSucceeded = true;
        externalReference = pawapayResponse.deposit?.depositId;
      } else {
        const failureObj = pawapayResponse.finalStatus?.data?.failureReason;
        const failureCode = failureObj?.failureCode;
        const failureMsg = failureObj?.failureMessage;
        switch (failureCode) {
          case 'LIMIT_REACHED':
          case 'WALLET_LIMIT_REACHED':
            failureReasonKey = 'wallet.deposit_limit_reached';
            failureReasonParams = { phone };
            break;
          case 'INVALID_PHONE_NUMBER':
            failureReasonKey = 'wallet.deposit_invalid_phone';
            failureReasonParams = { phone };
            break;
          case 'PROVIDER_UNAVAILABLE':
            failureReasonKey = 'wallet.deposit_provider_unavailable';
            failureReasonParams = { provider };
            break;
          default:
            failureReasonKey = 'wallet.deposit_failed';
            failureReasonParams = { reason: failureMsg || depositStatus };
        }
      }
    } catch (err: any) {
      console.error('[WalletService] Erreur PawaPay:', err);
      failureReasonKey = 'wallet.deposit_technical_error';
      failureReasonParams = { error: err.message };
    }

    // 3. Gérer l'échec
    if (!paymentSucceeded) {
      const failureMessage = failureReasonKey
        ? this.i18nService.translate(failureReasonKey, lang, failureReasonParams)
        : this.i18nService.translate('wallet.payment_failed', lang);
      const failedTransaction = await this.prisma.$transaction(async (tx) => {
        return await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId,
            walletId: wallet.id,
            amount: netAmount,
            type: 'DEPOSIT',
            status: 'FAILED',
            reference: `TOPUP_FAILED_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            description: this.i18nService.translate('wallet.failed_description', lang, {
              reason: failureMessage,
            }),
            movement: 'CREDIT',
          },
        });
      });
      await this.logAudit(user.id, 'topUp_failed', { transaction: failedTransaction, error: failureMessage }, ipAddress || null);
      throw new RpcException({
        status: 'error',
        message: failureMessage,
        statusCode: 400,
      });
    }

    // 4. Succès : créditer le wallet et créer la transaction
    let updatedWallet: any;
    let transaction: any;
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const description = this.i18nService.translate('wallet.transaction_description_deposit', lang)
          .replace('{phone}', phone || '')  // ← Changé de {accountNumber} à {phone}
          + ` (frais ${fees.depositFee}% : ${feeAmount} ${wallet.currency}) - Net crédité: ${netAmount} ${wallet.currency}`
          + ' ' + this.i18nService.translate('wallet.via_pawapay', lang, { provider });

        const upd = await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: netAmount }, updatedAt: new Date() },
        });
        const txRecord = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId,
            walletId: wallet.id,
            amount: netAmount,
            type: 'DEPOSIT',
            status: 'SUCCESS',
            reference: `TOPUP_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            description,
            movement: 'CREDIT',
          },
        });
        return { wallet: upd, transaction: txRecord };
      });
      updatedWallet = result.wallet;
      transaction = result.transaction;
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('wallet.top_up_failed', lang),
        statusCode: 500,
      });
    }

    // 5. Audit et notifications
    await this.logAudit(user.id, 'topUp', transaction, ipAddress || null);
    try {
      await notifyTransaction(
        this.smsService,
        this.notificationHelper,
        this.i18nService,
        this.shouldSendSms.bind(this),
        this.shouldSendPush.bind(this),
        this.getUserLanguage.bind(this),
        transaction,
        user,
        updatedWallet,
        'topup',
      );
    } catch (err) {
      console.error('[Notifications] topUp error:', err);
    }

    return {
      message: this.i18nService.translate('wallet.top_up_success', lang),
      data: {
        wallet: this.toResponse(updatedWallet),
        transaction,
      },
    };
  }

  async cashout(
    userId: string,
    dto: {
      accountNumber?: string;
      amount: number;
      pin: string;
      walletId?: string;
      provider?: string;
      phone?: string;
    },
    lang: string = 'fr',
    ipAddress?: string,
  ): Promise<ApiResponse<{ wallet: WalletResponseDto; transaction: any }>> {
    const { amount, pin, walletId, provider, phone } = dto;
    console.log('[WalletService] Cashout request:', {
      userId,
      amount,
      lang,
      walletId,
      provider,
      phone,
    });
    if (amount <= 0) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.amount_positive', lang),
        statusCode: 400,
      });
    }

    // PawaPay est obligatoire
    if (!provider || !phone) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.missing_phone_or_provider', lang),
        statusCode: 400,
      });
    }

    // ---------- 1. Validation préalable (hors transaction) ----------
    const user = await this.prisma.user.findFirst({  // ← findUnique → findFirst
      where: { id: userId },
      select: {
        id: true,
        full_name: true,
        phone: true,
        pin: true,
        role: true,
        status: true,
        failed_pin_attempts: true,
      },
    });
    if (!user)
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.user_not_found', lang),
        statusCode: 404,
      });
    if (user.status === user_status.BLOCKED) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('account_blocked_admin', lang),
        statusCode: 403,
      });
    }

    // Vérifier le PIN
    const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
    if (user.pin !== hashedPin) {
      const newAttempts = (user.failed_pin_attempts || 0) + 1;
      let newStatus: user_status = user.status;
      let lockedUntil: Date | null = null;
      if (newAttempts >= 5) {
        newStatus = user_status.BLOCKED;
        lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
      }
      await this.prisma.user.update({
        where: { id: userId },
        data: { failed_pin_attempts: newAttempts, status: newStatus },
      });
      await logFailedLoginAttempt(
        this.prisma,
        user.id,
        user.phone ?? user.id,
        ipAddress,
        undefined,
        newAttempts,
        lockedUntil,
      );
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.pin_incorrect', lang),
        statusCode: 401,
      });
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { failed_pin_attempts: 0 },
    });

    // Récupérer le wallet
    let wallet;
    if (walletId) {
      wallet = await this.prisma.wallet.findFirst({ where: { id: walletId, userId } });
      if (!wallet)
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('wallet.wallet_not_found_or_unauthorized', lang),
          statusCode: 404,
        });
    } else {
      wallet = await this.prisma.wallet.findFirst({ where: { userId } });
      if (!wallet)
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('wallet.wallet_not_found', lang),
          statusCode: 404,
        });
    }
    if (!wallet.isActive)
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.wallet_inactive', lang),
        statusCode: 403,
      });
    if (wallet.balance < amount)
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.insufficient_wallet_balance', lang),
        statusCode: 400,
      });

    // ---------- 2. Appel PawaPay payout ----------
    let paymentSucceeded = false;
    let failureReasonKey: string | null = null;
    let failureReasonParams: any = {};
    let externalReference: string | undefined;

    const fees = await this.getNetworkProviderFees(provider);
    const feeAmount = (amount * fees.payoutFee) / 100;
    const netAmount = amount - feeAmount;

    const amountStr = netAmount.toString();
    const pawapayData = { amount: amountStr, currency: wallet.currency, provider, phone };
    console.log('[WalletService] Appel PawaPay payout:', pawapayData);
    try {
      const pawapayResponse = await this.pawapayService.createPayoutSimple(pawapayData);
      console.log('[WalletService] Réponse PawaPay payout:', pawapayResponse);
      const payoutStatus = pawapayResponse.finalStatus?.data?.status;
      if (payoutStatus === 'COMPLETED') {
        paymentSucceeded = true;
        externalReference = pawapayResponse.payout?.payoutId;
      } else {
        const failureObj = pawapayResponse.finalStatus?.data?.failureReason;
        const failureCode = failureObj?.failureCode;
        const failureMsg = failureObj?.failureMessage;
        switch (failureCode) {
          case 'WALLET_LIMIT_REACHED':
            failureReasonKey = 'wallet.payout_limit_reached';
            failureReasonParams = { phone };
            break;
          case 'INSUFFICIENT_FUNDS':
            failureReasonKey = 'wallet.payout_insufficient_funds';
            failureReasonParams = { phone };
            break;
          case 'INVALID_PHONE_NUMBER':
            failureReasonKey = 'wallet.payout_invalid_phone';
            failureReasonParams = { phone };
            break;
          case 'PROVIDER_UNAVAILABLE':
            failureReasonKey = 'wallet.payout_provider_unavailable';
            failureReasonParams = { provider };
            break;
          default:
            failureReasonKey = 'wallet.payout_failed';
            failureReasonParams = { reason: failureMsg || payoutStatus };
        }
      }
    } catch (err: any) {
      console.error('[WalletService] Erreur PawaPay payout:', err);
      failureReasonKey = 'wallet.payout_technical_error';
      failureReasonParams = { error: err.message };
    }

    // ---------- 3. Gestion de l'échec ----------
    if (!paymentSucceeded) {
      const failureMessage = failureReasonKey
        ? this.i18nService.translate(failureReasonKey, lang, failureReasonParams)
        : this.i18nService.translate('wallet.payment_failed', lang);
      let failedTransaction;
      try {
        failedTransaction = await this.prisma.$transaction(async (tx) => {
          return await tx.transaction.create({
            data: {
              id: crypto.randomUUID(),
              userId,
              walletId: wallet.id,
              amount,
              type: 'WITHDRAW',
              status: 'FAILED',
              reference: `CASHOUT_FAILED_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
              description: this.i18nService.translate('wallet.failed_description', lang, {
                reason: failureMessage,
              }),
              movement: 'DEBIT',
            },
          });
        });
        await this.logAudit(user.id, 'cashout_failed', { transaction: failedTransaction, error: failureMessage }, ipAddress || null);
      } catch (err) {
        console.error('Erreur lors de la création de la transaction failed:', err);
      }
      throw new RpcException({
        status: 'error',
        message: failureMessage,
        statusCode: 400,
      });
    }

    // ---------- 4. Succès : débiter le wallet et créer la transaction ----------
    let updatedWallet: any;
    let transaction: any;
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const description = this.i18nService.translate('wallet.transaction_description_withdraw', lang)
          .replace('{phone}', phone || '')
          + ` (frais ${fees.payoutFee}% : ${feeAmount} ${wallet.currency}) - Net envoyé: ${netAmount} ${wallet.currency}`
          + ' ' + this.i18nService.translate('wallet.via_pawapay', lang, { provider });

        const upd = await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { decrement: amount }, updatedAt: new Date() },
        });
        const txRecord = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId,
            walletId: wallet.id,
            amount,
            type: 'WITHDRAW',
            status: 'SUCCESS',
            reference: `CASHOUT_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            description,
            movement: 'DEBIT',
          },
        });
        return { wallet: upd, transaction: txRecord };
      });
      updatedWallet = result.wallet;
      transaction = result.transaction;
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('wallet.cashout_failed', lang),
        statusCode: 500,
      });
    }

    // ---------- 5. Envoyer le SMS de notification ----------
    if (user.phone) {
      try {
        const cleanPhone = user.phone.replace(/[^0-9+]/g, '');
        const smsText = this.i18nService.translate('wallet.cashout_sms', lang, {
          full_name: user.full_name || '',
          amount: amount,
          currency: wallet.currency || 'CDF',
          balance: updatedWallet.balance || 0,
        });
        await this.smsService.sendSms(cleanPhone, smsText);
        console.log(`[Cashout] SMS envoyé à ${cleanPhone}`);
      } catch (err) {
        console.error('[Cashout] Erreur envoi SMS:', err);
      }
    }

    // ---------- 6. Audit et notifications Push ----------
    await this.logAudit(user.id, 'cashout', transaction, ipAddress ?? null);
    try {
      await notifyTransaction(
        this.smsService,
        this.notificationHelper,
        this.i18nService,
        this.shouldSendSms.bind(this),
        this.shouldSendPush.bind(this),
        this.getUserLanguage.bind(this),
        transaction,
        user,
        updatedWallet,
        'cashout',
      );
    } catch (err) {
      console.error('[Notifications] cashout error:', err);
    }

    return {
      message: this.i18nService.translate('wallet.cashout_success', lang),
      data: {
        wallet: this.toResponse(updatedWallet),
        transaction,
      },
    };
  }

  async send(
    dto: SendDto,
    lang: string = 'fr',
    ipAddress: string,
  ): Promise<ApiResponse<{ fromWallet: WalletResponseDto; toWallet: WalletResponseDto; transaction: any }>> {
    const { fromWalletId, toPhone, amount, pin, description } = dto;
    console.log('[WalletService] Send request:', { fromWalletId, toPhone, amount, lang });

    if (amount <= 0) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.amount_positive', lang),
        statusCode: 400,
      });
    }

    if (!fromWalletId) {
      throw new RpcException({
        status: 'error',
        message: 'Le wallet source est requis',
        statusCode: 400,
      });
    }

    const result = await this.prisma.$transaction(
      async (tx) => {
        // 1. Récupérer le wallet source avec son utilisateur
        const fromWallet = await tx.wallet.findFirst({
          where: { id: fromWalletId },
          include: {
            user: {
              select: {
                id: true,
                full_name: true,
                phone: true,
                account_number: true,
                pin: true,
                status: true,
                failed_pin_attempts: true,
              }
            }
          },
        });

        if (!fromWallet) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_not_found', lang),
            statusCode: 404,
          });
        }

        if (!fromWallet.isActive) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_inactive', lang),
            statusCode: 403,
          });
        }

        const fromUser = fromWallet.user;

        if (!fromUser) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.sender_not_found', lang),
            statusCode: 404,
          });
        }

        if (fromUser.status === user_status.BLOCKED) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('account_blocked_admin', lang),
            statusCode: 403,
          });
        }

        // Vérifier le PIN
        if (!fromUser.pin) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.no_pin_set', lang),
            statusCode: 400,
          });
        }

        const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
        if (fromUser.pin !== hashedPin) {
          const newAttempts = (fromUser.failed_pin_attempts || 0) + 1;
          let newStatus: user_status = fromUser.status;
          let lockedUntil: Date | null = null;
          if (newAttempts >= 5) {
            newStatus = user_status.BLOCKED;
            lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
          }
          await tx.user.update({
            where: { id: fromUser.id },
            data: { failed_pin_attempts: newAttempts, status: newStatus },
          });
          await logFailedLoginAttempt(
            this.prisma,
            fromUser.id,
            fromUser.account_number ?? fromUser.phone ?? fromUser.id,
            ipAddress,
            undefined,
            newAttempts,
            lockedUntil,
          );
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.pin_incorrect', lang),
            statusCode: 401,
          });
        }
        await tx.user.update({
          where: { id: fromUser.id },
          data: { failed_pin_attempts: 0 },
        });

        // 2. Récupérer le destinataire
        const toUser = await tx.user.findFirst({
          where: { phone: toPhone },
          select: {
            id: true,
            full_name: true,
            phone: true,
            account_number: true,
          },
        });
        if (!toUser) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.receiver_not_found', lang),
            statusCode: 404,
          });
        }
        if (fromUser.id === toUser.id || fromUser.phone === toPhone) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.cannot_transfer_self', lang),
            statusCode: 400,
          });
        }

        // 3. Récupérer le wallet destination dans la MÊME DEVISE
        let toWallet = await tx.wallet.findFirst({
          where: {
            userId: toUser.id,
            currency: fromWallet.currency,
            isActive: true,
          },
        });

        if (!toWallet) {
          toWallet = await tx.wallet.create({
            data: {
              id: crypto.randomUUID(),
              userId: toUser.id,
              currency: fromWallet.currency,
              balance: 0,
              isActive: true,
            },
          });
          console.log(`[WalletService] 💰 Nouveau wallet créé en ${fromWallet.currency} pour l'utilisateur ${toUser.id}`);
        }

        if (!toWallet.isActive) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_inactive', lang),
            statusCode: 403,
          });
        }

        // 4. Appliquer les frais internationaux si nécessaire
        const { fee, debitAmount, creditAmount } = await this.applyInternationalFeeIfNeeded(toPhone, amount);
        if (fromWallet.balance < debitAmount) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.insufficient_wallet_balance', lang),
            statusCode: 400,
          });
        }

        // 5. Mettre à jour les soldes
        const updatedFrom = await tx.wallet.update({
          where: { id: fromWallet.id },
          data: { balance: { decrement: debitAmount }, updatedAt: new Date() },
        });
        const updatedTo = await tx.wallet.update({
          where: { id: toWallet.id },
          data: { balance: { increment: creditAmount }, updatedAt: new Date() },
        });

        // 6. Construire les descriptions
        let senderDescription = description;
        let receiverDescription = description;

        if (!senderDescription) {
          const template = this.i18nService.translate('wallet.transaction_description_transfer_sent', lang);
          senderDescription = template
            .replace('{fullName}', toUser.full_name || '')
            .replace('{phone}', toPhone);
        } else {
          const recipientInfo = toUser.full_name ? `${toUser.full_name} (${toPhone})` : toPhone;
          const toText = this.i18nService.translate('wallet.to', lang);
          senderDescription = `${senderDescription} (${toText}: ${recipientInfo})`;
        }
        if (fee > 0) {
          senderDescription += ` (frais internationaux 1%: ${fee} ${fromWallet.currency})`;
        }

        if (!receiverDescription) {
          const template = this.i18nService.translate('wallet.transaction_description_transfer_received', lang);
          receiverDescription = template
            .replace('{fullName}', fromUser.full_name || '')
            .replace('{phone}', fromUser.phone || '');
        } else {
          const senderInfo = fromUser.full_name
            ? `${fromUser.full_name} (${fromUser.phone})`
            : fromUser.phone || fromUser.account_number;
          const fromText = this.i18nService.translate('wallet.from', lang);
          receiverDescription = `${receiverDescription} (${fromText}: ${senderInfo})`;
        }

        // 7. Créer les transactions
        const senderTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: fromUser.id,
            walletId: fromWallet.id,
            amount: debitAmount,
            type: 'TRANSFER',
            status: 'SUCCESS',
            reference: `SEND_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            description: senderDescription,
            movement: 'DEBIT',
          },
        });
        const receiverTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: toUser.id,
            walletId: toWallet.id,
            amount: creditAmount,
            type: 'DEPOSIT',
            status: 'SUCCESS',
            reference: `RECV_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            description: receiverDescription,
            movement: 'CREDIT',
          },
        });

        await this.logAudit(toUser.id, 'transfer', updatedTo, ipAddress || null);
        return {
          fromWallet: updatedFrom,
          toWallet: updatedTo,
          fromUser,
          toUser,
          senderTx,
          receiverTx,
        };
      },
      { timeout: 60000, maxWait: 60000 },
    );

    // Notifications
    try {
      await Promise.all([
        notifyTransaction(
          this.smsService,
          this.notificationHelper,
          this.i18nService,
          this.shouldSendSms.bind(this),
          this.shouldSendPush.bind(this),
          this.getUserLanguage.bind(this),
          result.senderTx,
          result.fromUser,
          result.fromWallet,
          'send_sent',
          {
            name: result.toUser.full_name ?? undefined,
            phone: result.toUser.phone ?? undefined,
          },
        ),
        notifyTransaction(
          this.smsService,
          this.notificationHelper,
          this.i18nService,
          this.shouldSendSms.bind(this),
          this.shouldSendPush.bind(this),
          this.getUserLanguage.bind(this),
          result.receiverTx,
          result.toUser,
          result.toWallet,
          'send_received',
          {
            name: result.fromUser.full_name ?? undefined,
            phone: result.fromUser.phone ?? undefined,
          },
        ),
      ]);
    } catch (err) {
      console.error('[Notifications] Send notification error:', err);
    }

    return {
      message: this.i18nService.translate('wallet.transfer_success', lang),
      data: {
        fromWallet: this.toResponse(result.fromWallet),
        toWallet: this.toResponse(result.toWallet),
        transaction: { reference: `SEND_${Date.now()}` },
      },
    };
  }

  async pay(
    dto: PayDto,
    lang: string = 'fr',
    ipAddress: string,
  ): Promise<ApiResponse<{ wallet: WalletResponseDto; transaction: any }>> {
    const { fromAccountNumber, fromWalletId, toPhone, merchantCode, amount, pin, description, skipPinCheck } = dto;
    console.log('[WalletService] Pay request:', { fromAccountNumber, fromWalletId, toPhone, merchantCode, amount, lang });
    if (amount <= 0) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.amount_positive', lang),
        statusCode: 400,
      });
    }

    const result = await this.prisma.$transaction(
      async (tx) => {
        // 1. Récupérer le payeur
        let fromUser;
        if (fromAccountNumber) {
          fromUser = await tx.user.findFirst({
            where: { account_number: fromAccountNumber },
            select: {
              id: true,
              full_name: true,
              phone: true,
              account_number: true,
              pin: true,
              status: true,
              failed_pin_attempts: true,
            },
          });
        } else if (fromWalletId) {
          const wallet = await tx.wallet.findUnique({ where: { id: fromWalletId }, include: { user: true } });
          if (wallet) fromUser = wallet.user;
        }
        if (!fromUser) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.sender_not_found', lang),
            statusCode: 404,
          });
        }

        if (fromUser.status === user_status.BLOCKED) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('account_blocked_admin', lang),
            statusCode: 403,
          });
        }

        // 🔐 Vérification du PIN (sauf si skipPinCheck est true)
        if (!skipPinCheck) {
          if (!fromUser.pin) {
            throw new RpcException({
              status: 'error',
              message: this.i18nService.translate('wallet.no_pin_set', lang),
              statusCode: 400,
            });
          }
          const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
          if (fromUser.pin !== hashedPin) {
            const newAttempts = (fromUser.failed_pin_attempts || 0) + 1;
            let newStatus: user_status = fromUser.status;
            let lockedUntil: Date | null = null;
            if (newAttempts >= 5) {
              newStatus = user_status.BLOCKED;
              lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
            }
            await tx.user.update({
              where: { id: fromUser.id },
              data: { failed_pin_attempts: newAttempts, status: newStatus },
            });
            await logFailedLoginAttempt(
              this.prisma,
              fromUser.id,
              fromUser.account_number ?? fromUser.phone ?? fromUser.id,
              ipAddress,
              undefined,
              newAttempts,
              lockedUntil,
            );
            throw new RpcException({
              status: 'error',
              message: this.i18nService.translate('wallet.pin_incorrect', lang),
              statusCode: 401,
            });
          }
        }

        // Réinitialiser les tentatives échouées (que le PIN ait été vérifié ou non)
        await tx.user.update({
          where: { id: fromUser.id },
          data: { failed_pin_attempts: 0 },
        });

        // 2. Récupérer le commerçant (destinataire)
        let toUser;
        if (toPhone) {
          toUser = await tx.user.findFirst({
            where: { phone: toPhone },
            select: {
              id: true,
              full_name: true,
              phone: true,
              account_number: true,
              role: true,
            },
          });
        } else if (merchantCode) {
          toUser = await tx.user.findFirst({
            where: { merchantCode, role: 'MERCHANT' },
            select: {
              id: true,
              full_name: true,
              phone: true,
              account_number: true,
              role: true,
            },
          });
        } else {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.missing_phone_or_code', lang),
            statusCode: 400,
          });
        }
        if (!toUser) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.receiver_not_found', lang),
            statusCode: 404,
          });
        }
        if (toUser.role !== 'MERCHANT') {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.not_merchant', lang),
            statusCode: 400,
          });
        }
        if (fromUser.id === toUser.id) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.cannot_transfer_self', lang),
            statusCode: 400,
          });
        }

        // 3. Récupérer les wallets
        let userWallet;
        if (fromWalletId) {
          userWallet = await tx.wallet.findUnique({ where: { id: fromWalletId, userId: fromUser.id } });
        } else {
          userWallet = await tx.wallet.findFirst({ where: { userId: fromUser.id } });
        }
        if (!userWallet || !userWallet.isActive) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_inactive', lang),
            statusCode: 403,
          });
        }

        let merchantWallet = await tx.wallet.findFirst({ where: { userId: toUser.id } });
        if (!merchantWallet) {
          merchantWallet = await tx.wallet.create({
            data: {
              id: crypto.randomUUID(),
              userId: toUser.id,
              currency: userWallet.currency,
              balance: 0,
              isActive: true,
            },
          });
        }
        if (!merchantWallet.isActive) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_inactive', lang),
            statusCode: 403,
          });
        }

        // 4. Appliquer les frais internationaux si le numéro du commerçant n'est pas national
        const targetPhone = toUser.phone;
        const { fee, debitAmount, creditAmount } = await this.applyInternationalFeeIfNeeded(targetPhone, amount);
        if (userWallet.balance < debitAmount) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.insufficient_wallet_balance', lang),
            statusCode: 400,
          });
        }

        // 5. Mettre à jour les soldes
        const updatedUser = await tx.wallet.update({
          where: { id: userWallet.id },
          data: { balance: { decrement: debitAmount }, updatedAt: new Date() },
        });
        const updatedMerchant = await tx.wallet.update({
          where: { id: merchantWallet.id },
          data: { balance: { increment: creditAmount }, updatedAt: new Date() },
        });

        // 6. Construire les descriptions
        let payerDescription = description;
        let merchantDescription = description;

        if (!payerDescription) {
          const template = this.i18nService.translate('wallet.transaction_description_payment_sent', lang);
          payerDescription = template
            .replace('{merchantName}', toUser.full_name || '')
            .replace('{merchantPhone}', toUser.phone || '');
        } else {
          const merchantInfo = toUser.full_name
            ? `${toUser.full_name} (${toUser.phone || merchantCode})`
            : toUser.phone || merchantCode;
          const toText = this.i18nService.translate('wallet.to', lang);
          payerDescription = `${payerDescription} (${toText}: ${merchantInfo})`;
        }
        if (fee > 0) {
          payerDescription += ` (frais internationaux 1%: ${fee} ${userWallet.currency})`;
        }

        if (!merchantDescription) {
          const template = this.i18nService.translate('wallet.transaction_description_payment_received', lang);
          merchantDescription = template
            .replace('{phone}', fromUser.phone || '');  // ← Changé de {accountNumber} à {phone}
        } else {
          const payerInfo = fromUser.full_name
            ? `${fromUser.full_name} (${fromUser.phone || fromAccountNumber})`
            : fromUser.phone || fromAccountNumber;
          const fromText = this.i18nService.translate('wallet.from', lang);
          merchantDescription = `${merchantDescription} (${fromText}: ${payerInfo})`;
        }

        // 7. Créer les transactions
        const payerTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: fromUser.id,
            walletId: userWallet.id,
            amount: debitAmount,
            type: 'PAYMENT',
            status: 'SUCCESS',
            reference: `PAY_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            description: payerDescription,
            movement: 'DEBIT',
          },
        });
        const merchantTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: toUser.id,
            walletId: merchantWallet.id,
            amount: creditAmount,
            type: 'PAYMENT',
            status: 'SUCCESS',
            reference: `PAY_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            description: merchantDescription,
            movement: 'CREDIT',
          },
        });

        await this.logAudit(fromUser.id, 'payment', updatedUser, ipAddress ?? null);
        return {
          fromUser,
          toUser,
          userWallet,
          merchantWallet,
          updatedUser,
          updatedMerchant,
          payerTx,
          merchantTx,
        };
      },
      { timeout: 60000, maxWait: 60000 },
    );

    // Notifications
    try {
      await Promise.all([
        notifyTransaction(
          this.smsService,
          this.notificationHelper,
          this.i18nService,
          this.shouldSendSms.bind(this),
          this.shouldSendPush.bind(this),
          this.getUserLanguage.bind(this),
          result.payerTx,
          result.fromUser,
          result.userWallet,
          'pay_sent',
          {
            name: result.toUser.full_name ?? undefined,
            phone: result.toUser.phone ?? undefined,
          },
        ),
        notifyTransaction(
          this.smsService,
          this.notificationHelper,
          this.i18nService,
          this.shouldSendSms.bind(this),
          this.shouldSendPush.bind(this),
          this.getUserLanguage.bind(this),
          result.merchantTx,
          result.toUser,
          result.merchantWallet,
          'pay_received',
          {
            name: result.fromUser.full_name ?? undefined,
            accountNumber: fromAccountNumber,
          },
        ),
      ]);
    } catch (err) {
      console.error('[Notifications] Pay notification error:', err);
    }

    return {
      message: this.i18nService.translate('wallet.payment_success', lang),
      data: {
        wallet: this.toResponse(result.updatedUser),
        transaction: result.payerTx,
      },
    };
  }

  // ==================== ADMIN OPERATIONS (sans PIN) ====================
  async getMerchantByCode(
    merchantCode: string,
  ): Promise<{ message: string; data: any }> {
    console.log('[UserService] getMerchantByCode:', merchantCode);
    const merchant = await this.prisma.user.findFirst({
      where: { merchantCode, role: 'MERCHANT' },
      select: {
        id: true,
        full_name: true,
        phone: true,
        account_number: true,
        branch: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        merchantCode: true,
      },
    });
    if (!merchant) {
      throw new RpcException({
        status: 'error',
        message: 'Commerçant introuvable avec ce code',
        statusCode: 404,
      });
    }
    return {
      message: 'Commerçant récupéré avec succès',
      data: merchant,
    };
  }

  async getTransactionById(transactionId: string): Promise<ApiResponse<any>> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: {
        user: {
          select: {
            id: true,
            full_name: true,
            phone: true,
          },
        },
      },
    });
    if (!transaction) {
      throw new RpcException({
        status: 'error',
        message: 'Transaction non trouvée',
        statusCode: 404,
      });
    }
    return {
      message: 'Transaction récupérée avec succès',
      data: transaction,
    };
  }

  private async logFailedTransaction(
    transactionData: Partial<any>,
    error: Error | any,
    context?: { ip?: string; userAgent?: string; originalTransaction?: any },
  ) {
    try {
      let failureCode = error.code || error.name || 'UNKNOWN_ERROR';
      let canRetry = true;
      const nonRetryableErrors = [
        'INSUFFICIENT_BALANCE',
        'PIN_INCORRECT',
        'ACCOUNT_NOT_FOUND',
        'USER_NOT_FOUND',
      ];
      if (nonRetryableErrors.includes(failureCode)) {
        canRetry = false;
      }
      const failureDetails = {
        message: error.message,
        stack: error.stack,
        context: context,
        timestamp: new Date().toISOString(),
      };
      await this.prisma.failed_transaction_log.create({
        data: {
          id: crypto.randomUUID(),
          transactionId: transactionData.id || `pending_${Date.now()}`,
          userId:
            transactionData.userId || context?.originalTransaction?.userId,
          walletId:
            transactionData.walletId || context?.originalTransaction?.walletId,
          amount: transactionData.amount || 0,
          type: transactionData.type || 'TRANSFER',
          movement: transactionData.movement || 'DEBIT',
          reference: transactionData.reference || `FAILED_${Date.now()}`,
          description: transactionData.description,
          failure_reason: error.message || 'Unknown error occurred',
          failure_code: failureCode,
          failure_details: JSON.stringify(failureDetails),
          ip_address: context?.ip,
          user_agent: context?.userAgent,
          original_created_at:
            context?.originalTransaction?.createdAt || new Date(),
          created_at: new Date(),
          can_retry: canRetry,
          retry_count: 0,
        },
      });
    } catch (logError) {
      console.error(
        '[FailedTransactionLog] Error logging failed transaction:',
        logError,
      );
    }
  }

  async generateStatement(
    userId: string,
    startDate?: Date,
    endDate?: Date,
    lang: string = 'fr',
  ): Promise<{ pdfBase64: string; message: string }> {
    console.log('[WalletService] Generate statement:', {
      userId,
      startDate,
      endDate,
      lang,
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        full_name: true,
        phone: true,
        email: true,
        account_number: true,
      },
    });
    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.user_not_found', lang),
        statusCode: 404,
      });
    }

    const dateFilter: any = {};
    if (startDate && endDate) {
      dateFilter.gte = startDate;
      const endOfDay = new Date(endDate);
      endOfDay.setHours(23, 59, 59, 999);
      dateFilter.lte = endOfDay;
    } else if (startDate) {
      dateFilter.gte = startDate;
    } else if (endDate) {
      const endOfDay = new Date(endDate);
      endOfDay.setHours(23, 59, 59, 999);
      dateFilter.lte = endOfDay;
    }

    const where: any = { userId, status: 'SUCCESS' };
    if (Object.keys(dateFilter).length > 0) {
      where.createdAt = dateFilter;
    }

    const transactionsDb = await this.prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });
    console.log(
      `[WalletService] Found ${transactionsDb.length} transactions for period`,
    );

    // ===== LOCALE PAR LANGUE =====
    let localeStr = 'fr-FR';
    if (lang === 'en') localeStr = 'en-US';
    else if (lang === 'sw') localeStr = 'sw-TZ';
    else if (lang === 'ar') localeStr = 'ar-SA';
    else if (lang === 'es') localeStr = 'es-ES';

    let periodStartFormatted: string = '';
    let periodEndFormatted: string = '';
    let hasDateRange = false;

    if (startDate) {
      periodStartFormatted = startDate.toLocaleDateString(localeStr);
      hasDateRange = true;
    } else {
      periodStartFormatted = this.i18nService.translate(
        'statement.all_time_start',
        lang,
      );
    }

    if (endDate) {
      periodEndFormatted = endDate.toLocaleDateString(localeStr);
      hasDateRange = true;
    } else {
      periodEndFormatted = this.i18nService.translate(
        'statement.all_time_end',
        lang,
      );
    }

    const generatedDateFormatted = new Date().toLocaleString(localeStr);

    let balance = 0;
    const formattedTransactions: FormattedTransaction[] = [];

    for (const tx of transactionsDb) {
      if (tx.movement === 'CREDIT') balance += tx.amount;
      else if (tx.movement === 'DEBIT') balance -= tx.amount;

      let description = '';
      switch (tx.type) {
        case 'DEPOSIT':
          description = this.i18nService.translate('transaction.deposit', lang);
          break;
        case 'WITHDRAW':
          description = this.i18nService.translate('transaction.withdraw', lang);
          break;
        case 'TRANSFER':
          description = this.i18nService.translate('transaction.transfer', lang);
          break;
        case 'PAYMENT':
          description = this.i18nService.translate('transaction.payment', lang);
          break;
        default:
          description = tx.type || 'UNKNOWN';
      }

      formattedTransactions.push({
        description,
        detail: tx.description || '',
        reference: tx.reference || tx.id.slice(0, 8),
        date: tx.createdAt.toLocaleDateString(localeStr),
        credit: tx.movement === 'CREDIT' ? tx.amount : null,
        debit: tx.movement === 'DEBIT' ? tx.amount : null,
        balance,
      });
    }

    const totalCredits = transactionsDb
      .filter((tx) => tx.movement === 'CREDIT')
      .reduce((sum, tx) => sum + tx.amount, 0);
    const totalDebits = transactionsDb
      .filter((tx) => tx.movement === 'DEBIT')
      .reduce((sum, tx) => sum + tx.amount, 0);

    const wallet = await this.prisma.wallet.findFirst({ where: { userId } });
    const currency = wallet?.currency || 'CDF';

    // ===== TRADUCTIONS AVEC FALLBACKS =====
    const t = (key: string): string => {
      const translated = this.i18nService.translate(key, lang);
      if (translated === key) {
        const fallbacks: Record<string, Record<string, string>> = {
          'statement.title': {
            fr: 'RELEVÉ DE COMPTE',
            en: 'ACCOUNT STATEMENT',
            sw: 'TAARIFA YA AKAUUNTI',
            ar: 'كشف الحساب',
            es: 'ESTADO DE CUENTA',
          },
          'statement.client_info': {
            fr: 'INFORMATIONS CLIENT',
            en: 'CLIENT INFORMATION',
            sw: 'TAARIFA ZA MTUMIAJI',
            ar: 'معلومات العميل',
            es: 'INFORMACIÓN DEL CLIENTE',
          },
          'statement.summary': {
            fr: 'RÉCAPITULATIF',
            en: 'SUMMARY',
            sw: 'MUHTASARI',
            ar: 'الملخص',
            es: 'RESUMEN',
          },
          'statement.details': {
            fr: 'Détails',
            en: 'Details',
            sw: 'Maelezo',
            ar: 'التفاصيل',
            es: 'Detalles',
          },
          'statement.reference': {
            fr: 'Référence',
            en: 'Reference',
            sw: 'Kumbukumbu',
            ar: 'المرجع',
            es: 'Referencia',
          },
          'statement.date': {
            fr: 'Date',
            en: 'Date',
            sw: 'Tarehe',
            ar: 'التاريخ',
            es: 'Fecha',
          },
          'statement.credit': {
            fr: 'Crédit (Entrée)',
            en: 'Credit (In)',
            sw: 'Mkopo (Kuingia)',
            ar: 'إيداع (داخل)',
            es: 'Crédito (Entrada)',
          },
          'statement.debit': {
            fr: 'Débit (Sortie)',
            en: 'Debit (Out)',
            sw: 'Deni (Kutoka)',
            ar: 'سحب (خارج)',
            es: 'Débito (Salida)',
          },
          'statement.balance': {
            fr: 'Solde',
            en: 'Balance',
            sw: 'Salio',
            ar: 'الرصيد',
            es: 'Saldo',
          },
          'statement.totals': {
            fr: 'TOTAUX',
            en: 'TOTALS',
            sw: 'JUMLA',
            ar: 'الإجماليات',
            es: 'TOTALES',
          },
          'statement.no_transactions': {
            fr: 'Aucune transaction sur cette période',
            en: 'No transactions in this period',
            sw: 'Hakuna miamala katika kipindi hiki',
            ar: 'لا توجد معاملات في هذه الفترة',
            es: 'No hay transacciones en este período',
          },
          'statement.footer_text': {
            fr: 'Ce document est un relevé de compte officiel des transactions F-Pay',
            en: 'This is an official statement of F-Pay transactions',
            sw: 'Hii ni taarifa rasmi ya miamala ya F-Pay',
            ar: 'هذا كشف حساب رسمي لمعاملات F-Pay',
            es: 'Este es un estado de cuenta oficial de las transacciones de F-Pay',
          },
          'statement.generated_on': {
            fr: 'Relevé généré le',
            en: 'Generated on',
            sw: 'Imetolewa tarehe',
            ar: 'تم الإنشاء في',
            es: 'Generado el',
          },
          'statement.full_name': {
            fr: 'Nom complet',
            en: 'Full name',
            sw: 'Jina kamili',
            ar: 'الاسم الكامل',
            es: 'Nombre completo',
          },
          'statement.account_number': {
            fr: 'N° Compte',
            en: 'Account number',
            sw: 'Nambari ya akaunti',
            ar: 'رقم الحساب',
            es: 'Número de cuenta',
          },
          'statement.phone': {
            fr: 'Téléphone',
            en: 'Phone',
            sw: 'Simu',
            ar: 'الهاتف',
            es: 'Teléfono',
          },
          'statement.email': {
            fr: 'Email',
            en: 'Email',
            sw: 'Barua pepe',
            ar: 'البريد الإلكتروني',
            es: 'Correo electrónico',
          },
          'statement.address': {
            fr: 'Adresse',
            en: 'Address',
            sw: 'Anwani',
            ar: 'العنوان',
            es: 'Dirección',
          },
          'statement.total_credits': {
            fr: 'Total Crédits (Entrées)',
            en: 'Total Credits (In)',
            sw: 'Jumla ya Mikopo (Kuingia)',
            ar: 'إجمالي الإيداعات (داخل)',
            es: 'Total Créditos (Entradas)',
          },
          'statement.total_debits': {
            fr: 'Total Débits (Sorties)',
            en: 'Total Debits (Out)',
            sw: 'Jumla ya Madeni (Kutoka)',
            ar: 'إجمالي السحوبات (خارج)',
            es: 'Total Débitos (Salidas)',
          },
          'statement.final_balance': {
            fr: 'Solde final',
            en: 'Final balance',
            sw: 'Salio la mwisho',
            ar: 'الرصيد النهائي',
            es: 'Saldo final',
          },
          'statement.all_time_start': {
            fr: 'Début',
            en: 'Beginning',
            sw: 'Mwanzo',
            ar: 'البداية',
            es: 'Inicio',
          },
          'statement.all_time_end': {
            fr: "Aujourd'hui",
            en: 'Today',
            sw: 'Leo',
            ar: 'اليوم',
            es: 'Hoy',
          },
        };
        return fallbacks[key]?.[lang] || fallbacks[key]?.['fr'] || key;
      }
      return translated;
    };

    let logoBase64 = '';
    try {
      const logoPath = path.join(process.cwd(), 'public', 'uploads', 'icon.png');
      if (fs.existsSync(logoPath)) {
        const logoBuffer = fs.readFileSync(logoPath);
        logoBase64 = `data:image/png;base64,${logoBuffer.toString('base64')}`;
      } else {
        console.warn('[WalletService] Logo not found at', logoPath);
      }
    } catch (err) {
      console.error('[WalletService] Error reading logo:', err);
    }

    const context = {
      lang,
      logoBase64,
      periodStart: periodStartFormatted,
      periodEnd: periodEndFormatted,
      hasDateRange,
      generatedDate: generatedDateFormatted,
      client: {
        fullName: user.full_name || 'N/A',
        accountNumber: user.account_number || 'N/A',
        phone: user.phone || 'N/A',
        email: user.email || 'N/A',
      },
      currency,
      totals: {
        credits: totalCredits.toFixed(2),
        debits: totalDebits.toFixed(2),
        balance: balance.toFixed(2),
      },
      transactions: formattedTransactions,
      labels: {
        title: t('statement.title'),
        clientInfo: t('statement.client_info'),
        summary: t('statement.summary'),
        details: t('statement.details'),
        reference: t('statement.reference'),
        date: t('statement.date'),
        credit: t('statement.credit'),
        debit: t('statement.debit'),
        balance: t('statement.balance'),
        totals: t('statement.totals'),
        noTransactions: t('statement.no_transactions'),
        footerText: t('statement.footer_text'),
        generatedOn: t('statement.generated_on'),
        fullName: t('statement.full_name'),
        accountNumber: t('statement.account_number'),
        phone: t('statement.phone'),
        email: t('statement.email'),
        address: t('statement.address'),
        totalCredits: t('statement.total_credits'),
        totalDebits: t('statement.total_debits'),
        finalBalance: t('statement.final_balance'),
      },
    };

    let templatePath: string;
    if (process.env.NODE_ENV === 'production') {
      templatePath = path.join(__dirname, '..', 'templates', 'wallet', 'statement.ejs');
      if (!fs.existsSync(templatePath)) {
        templatePath = path.join(
          process.cwd(),
          'dist',
          'apps',
          'wallet-service',
          'templates',
          'wallet',
          'statement.ejs',
        );
      }
    } else {
      templatePath = path.join(
        process.cwd(),
        'apps',
        'wallet-service',
        'src',
        'templates',
        'wallet',
        'statement.ejs',
      );
    }
    console.log('[WalletService] Template path:', templatePath);
    if (!fs.existsSync(templatePath)) {
      console.error(`[WalletService] Template not found at ${templatePath}`);
      throw new RpcException({
        status: 'error',
        message: 'Template file missing',
        statusCode: 500,
      });
    }

    try {
      const htmlContent = await ejs.renderFile(templatePath, context, { async: true });

      // ===== FIND CHROME DYNAMICALLY (Windows, Linux, macOS) =====
      const findChromePath = (): string | undefined => {
        // 1. Variable d'environnement
        if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
          return process.env.CHROME_PATH;
        }

        const platform = process.platform;

        if (platform === 'win32') {
          // ===== WINDOWS =====
          const windowsPaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
            process.env.ProgramW6432 + '\\Google\\Chrome\\Application\\chrome.exe',
            process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
          ];
          for (const path of windowsPaths) {
            if (path && fs.existsSync(path)) {
              console.log(`[WalletService] ✅ Browser found: ${path}`);
              return path;
            }
          }
        } else if (platform === 'linux') {
          // ===== LINUX =====
          const linuxPaths = [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/snap/bin/chromium',
            '/usr/bin/chrome',
            '/opt/google/chrome/chrome',
          ];
          for (const path of linuxPaths) {
            if (fs.existsSync(path)) {
              console.log(`[WalletService] ✅ Browser found: ${path}`);
              return path;
            }
          }
          // Essayer avec which
          try {
            const { execSync } = require('child_process');
            const result = execSync('which google-chrome || which chromium-browser || which chromium', {
              encoding: 'utf8',
              shell: '/bin/bash',
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            const path = result.trim();
            if (path && fs.existsSync(path)) {
              console.log(`[WalletService] ✅ Browser found via which: ${path}`);
              return path;
            }
          } catch (e) { }
        } else if (platform === 'darwin') {
          // ===== macOS =====
          const macPaths = [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            process.env.HOME + '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          ];
          for (const path of macPaths) {
            if (fs.existsSync(path)) {
              console.log(`[WalletService] ✅ Browser found: ${path}`);
              return path;
            }
          }
        }

        console.warn('[WalletService] ⚠️ No browser found, using puppeteer default');
        return undefined;
      };

      const chromePath = findChromePath();

      // ===== LAUNCH PUPPETEER =====
      const browser = await puppeteer.launch({
        headless: true,
        executablePath: chromePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });

      const page = await browser.newPage();
      await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 120000 });

      const pdfUint8Array = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '20px', bottom: '30px', left: '20px', right: '20px' },
        timeout: 120000,
      });
      await browser.close();

      let pdfBuffer: Buffer;
      if (Buffer.isBuffer(pdfUint8Array)) {
        pdfBuffer = pdfUint8Array;
      } else {
        pdfBuffer = Buffer.from(pdfUint8Array);
      }
      if (pdfBuffer.length === 0) throw new Error('Generated PDF is empty');

      const pdfBase64 = pdfBuffer.toString('base64');
      return {
        pdfBase64,
        message: this.i18nService.translate('wallet.statement_generated', lang),
      };
    } catch (error) {
      console.error('[WalletService] PDF generation error:', error);
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.statement_error', lang),
        statusCode: 500,
      });
    }
  }

  async setExchangeRate(dto: ExchangeRateDto): Promise<any> {
    console.log('[WalletService] Set exchange rate:', dto);
    const existing = await this.prisma.exchange_rate.findFirst({
      where: {
        from_currency: dto.from_currency,
        to_currency: dto.to_currency,
      },
    });

    let result;
    if (existing) {
      result = await this.prisma.exchange_rate.update({
        where: { id: existing.id },
        data: { rate: dto.rate, updated_at: new Date() },
      });
    } else {
      result = await this.prisma.exchange_rate.create({
        data: {
          id: crypto.randomUUID(),
          from_currency: dto.from_currency,
          to_currency: dto.to_currency,
          rate: dto.rate,
        },
      });
    }
    return { message: 'Exchange rate saved successfully', data: result };
  }

  async getExchangeRates(): Promise<any> {
    console.log('[WalletService] Get all exchange rates');
    const rates = await this.prisma.exchange_rate.findMany({
      orderBy: { from_currency: 'asc' },
    });
    return { message: 'Exchange rates retrieved successfully', data: rates };
  }



  // eslint-disable-next-line @typescript-eslint/require-await
  async healthCheck() {
    return { status: 'ok', service: 'wallet-service' };
  }



  private toResponse(wallet: any): WalletResponseDto {
    return {
      id: wallet.id,
      userId: wallet.userId,
      balance: wallet.balance,
      currency: wallet.currency,
      isActive: wallet.isActive,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }
}