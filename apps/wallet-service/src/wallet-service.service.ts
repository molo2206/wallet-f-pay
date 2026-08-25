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
import { SendDto, PayDto, SendFidelityDto } from './dto/wallet-operation.dto';
import { ApiResponse } from './interfaces/api-response.interface';
import { transaction_type, user_status, wallet_currency } from '@prisma/client';
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
import { Prisma } from '@prisma/client';
import { MailService } from 'apps/auth-service/src/email/email.service';
type TransactionPaymentMethod = 'CASH' | 'MOBILE_MONEY' | 'CREDIT_DEBIT_CARD' | 'BANK_TRANSFERT' | 'INTERNAL' | 'EXTERNAL_API';

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
    private readonly mailService: MailService,
  ) { }

  private async generateTransactionReference(
    prefix?: string,
    tx?: Prisma.TransactionClient,
    retries: number = 10
  ): Promise<string> {
    // Générer une référence aléatoire de 8 chiffres
    const generateRandom = (): string => {
      return Math.floor(10000000 + Math.random() * 90000000).toString();
    };

    // Générer avec timestamp + aléatoire (plus unique)
    const generateWithTimestamp = (): string => {
      const date = new Date();
      const year = date.getFullYear().toString().slice(-2);
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const random = Math.floor(1000 + Math.random() * 9000);
      return `${year}${month}${day}${random}`; // Ex: 2407124589
    };

    // Générer avec préfixe + 8 chiffres
    const generateWithPrefix = (prefix: string): string => {
      const random = Math.floor(10000000 + Math.random() * 90000000);
      const full = `${prefix}${random}`;
      // Garder exactement 8 caractères (préfixe inclus)
      return full.slice(0, 8);
    };

    // ✅ Initialiser reference avec une valeur par défaut
    let reference: string = generateRandom();
    let isUnique = false;
    let attempts = 0;

    while (!isUnique && attempts < retries) {
      // Générer la référence selon le préfixe
      if (prefix) {
        reference = generateWithPrefix(prefix);
      } else {
        // Alterner entre random et timestamp pour plus de variété
        reference = attempts % 2 === 0 ? generateRandom() : generateWithTimestamp();
      }

      // Vérifier l'unicité si une transaction est fournie
      if (tx) {
        const existing = await tx.transaction.findFirst({
          where: { reference }
        });
        if (!existing) {
          isUnique = true;
        }
      } else {
        // Vérifier avec le prisma direct
        const existing = await this.prisma.transaction.findFirst({
          where: { reference }
        });
        if (!existing) {
          isUnique = true;
        }
      }
      attempts++;
    }

    // Fallback si toutes les tentatives échouen-t
    if (!isUnique) {
      const timestamp = Date.now().toString().slice(-4);
      const random = Math.floor(1000 + Math.random() * 9000);
      reference = `${timestamp}${random}`;

      // Vérification finale
      if (tx) {
        const existing = await tx.transaction.findFirst({
          where: { reference }
        });
        if (existing) {
          // En cas d'extrême rareté, ajouter un caractère aléatoire supplémentaire
          reference = `${timestamp}${random}${Math.floor(Math.random() * 10)}`.slice(0, 8);
        }
      }
    }

    return reference;
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
          id: crypto.randomUUID(),
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

  /**
   * Récupère les frais internationaux pour un pays donné
   * Les frais sont configurés dans network_provider
   */
  private async getInternationalFeesByCountry(
    countryCode: string,
    tx?: any
  ): Promise<{ depositFee: number; payoutFee: number }> {
    // Récupérer le network provider du pays
    const network = await (tx || this.prisma).network_provider.findFirst({
      where: {
        country_provider: {
          countryCode: countryCode,
        }
      },
      select: {
        pourcentage_deposit_intern: true,
        pourcentage_payout_intern: true,
      },
    });

    if (!network) {
      console.warn(`[WalletService] Aucun network provider trouvé pour le pays ${countryCode}, frais internationaux = 0`);
      return { depositFee: 0, payoutFee: 0 };
    }

    return {
      depositFee: network.pourcentage_deposit_intern || 0,
      payoutFee: network.pourcentage_payout_intern || 0,
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
  private async getExchangeRate(
    from: string,
    to: string
  ): Promise<number> {
    if (from === to) return 1;

    // ✅ Récupérer tous les taux nécessaires en une seule requête
    const rates = await this.prisma.exchange_rate.findMany({
      where: {
        OR: [
          { from_currency: from, to_currency: to },
          { from_currency: from, to_currency: 'USD' },
          { from_currency: 'USD', to_currency: to },
          { from_currency: to, to_currency: from },
        ],
      },
    });

    // Créer un map pour un accès rapide
    const rateMap = new Map<string, number>();
    rates.forEach(r => {
      rateMap.set(`${r.from_currency}-${r.to_currency}`, r.rate);
    });

    // Chercher le taux direct
    const directKey = `${from}-${to}`;
    if (rateMap.has(directKey)) {
      return rateMap.get(directKey)!;
    }

    // Chercher via USD
    const fromToUsdKey = `${from}-USD`;
    const usdToTargetKey = `USD-${to}`;
    if (rateMap.has(fromToUsdKey) && rateMap.has(usdToTargetKey)) {
      return rateMap.get(fromToUsdKey)! * rateMap.get(usdToTargetKey)!;
    }

    // Chercher l'inverse
    const inverseKey = `${to}-${from}`;
    if (rateMap.has(inverseKey)) {
      const inverseRate = rateMap.get(inverseKey)!;
      if (inverseRate > 0) {
        return 1 / inverseRate;
      }
    }

    console.warn(`[WalletService] Taux de change non trouvé pour ${from} -> ${to}, utilisation de 1`);
    return 1;
  }

  private async getSystemFeeWallet(currency: string, tx?: any): Promise<any> {
    const systemUserId = 'system-fee-account';

    // ✅ Vérifier si le wallet système existe
    let systemWallet = await (tx || this.prisma).wallet.findFirst({
      where: {
        userId: systemUserId,
        currency: currency as wallet_currency,
        isActive: true,
      },
    });

    // ✅ Créer le wallet système s'il n'existe pas
    if (!systemWallet) {
      systemWallet = await (tx || this.prisma).wallet.create({
        data: {
          id: crypto.randomUUID(),
          userId: systemUserId,
          currency: currency as wallet_currency,
          balance: 0,
          isActive: true,
          cashCode: `SYS_${currency}_${Math.floor(10000 + Math.random() * 90000)}`,
        },
      });
      console.log(`[WalletService] 💰 Wallet système créé automatiquement en ${currency}`);
    }

    return systemWallet;
  }

  private mapPaymentMethod(paymentMethod?: string): TransactionPaymentMethod {
    // Si aucune valeur n'est fournie, retourner INTERNAL
    if (!paymentMethod) {
      return 'INTERNAL';
    }

    // Nettoyer et mettre en majuscules
    const normalized = paymentMethod.toUpperCase().trim().replace(/\s+/g, '_');

    // Vérifier si la valeur existe dans l'énumération
    const validMethods: TransactionPaymentMethod[] = [
      'CASH',
      'MOBILE_MONEY',
      'CREDIT_DEBIT_CARD',
      'BANK_TRANSFERT',
      'INTERNAL',
      'EXTERNAL_API'
    ];

    const found = validMethods.find(m => m === normalized);
    if (found) {
      return found;
    }

    // Valeur par défaut si non reconnue
    console.warn(`[mapPaymentMethod] Valeur non reconnue: ${paymentMethod}, utilisation de INTERNAL par défaut`);
    return 'INTERNAL';
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

    // ✅ Récupérer les wallets en parallèle
    const [fromWallet, toWallet] = await Promise.all([
      this.prisma.wallet.findUnique({
        where: { id: fromWalletId },
        include: { user: true }
      }),
      this.prisma.wallet.findUnique({
        where: { id: toWalletId },
        include: { user: true }
      })
    ]);

    // ✅ Vérifications hors transaction
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

    // Vérifier que les deux wallets appartiennent au même utilisateur
    if (fromWallet.userId !== toWallet.userId) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.conversion_same_owner', lang),
        statusCode: 400,
      });
    }

    const user = fromWallet.user;

    // ✅ Vérification du PIN hors transaction
    if (!user.pin) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.no_pin_set', lang),
        statusCode: 400
      });
    }

    const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
    if (user.pin !== hashedPin) {
      const newAttempts = (user.failed_pin_attempts || 0) + 1;
      let newStatus = user.status;
      let lockedUntil: Date | null = null;
      if (newAttempts >= 10) {
        newStatus = user_status.BLOCKED;
        lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
      }
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failed_pin_attempts: newAttempts,
          status: newStatus,
          pin_locked_until: lockedUntil,
        },
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
      where: { id: user.id },
      data: { failed_pin_attempts: 0, pin_locked_until: null }
    });

    // ✅ Récupérer le taux de change
    const rate = await this.getExchangeRate(fromWallet.currency, toWallet.currency);

    // ✅ Calculer le montant converti avec arrondi
    const rawConvertedAmount = amount * rate;
    const convertedAmount = Math.floor(rawConvertedAmount * 100) / 100;

    console.log('[WalletService] Conversion calculée:', {
      fromCurrency: fromWallet.currency,
      toCurrency: toWallet.currency,
      amount,
      rate,
      rawConvertedAmount,
      convertedAmount,
    });

    if (convertedAmount <= 0) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.conversion_amount_too_small', lang),
        statusCode: 400,
      });
    }

    // ✅ Transaction
    const result = await this.prisma.$transaction(
      async (tx) => {
        // Mettre à jour les soldes
        const updatedFrom = await tx.wallet.update({
          where: { id: fromWallet.id },
          data: { balance: { decrement: amount }, updatedAt: new Date() },
        });
        const updatedTo = await tx.wallet.update({
          where: { id: toWallet.id },
          data: { balance: { increment: convertedAmount }, updatedAt: new Date() },
        });

        // Générer la référence
        const reference = await this.generateTransactionReference('', tx)

        // ✅ Formater les valeurs pour la traduction
        const amountStr = amount.toFixed(2);
        const rateStr = rate.toFixed(4);
        const convertedStr = convertedAmount.toFixed(2);
        const fromCurrency = fromWallet.currency;
        const toCurrency = toWallet.currency;

        // ✅ Construction des descriptions avec traduction
        let debitDescription = description;
        let creditDescription = description;

        if (!debitDescription) {
          debitDescription = this.i18nService.translate('wallet.conversion_debit', lang, {
            amount: amountStr,
            fromCurrency: fromCurrency,
            toCurrency: toCurrency,
            rate: rateStr,
            convertedAmount: convertedStr,
          });
        }

        if (!creditDescription) {
          creditDescription = this.i18nService.translate('wallet.conversion_credit', lang, {
            amount: amountStr,
            fromCurrency: fromCurrency,
            toCurrency: toCurrency,
            rate: rateStr,
            convertedAmount: convertedStr,
          });
        }

        console.log('[WalletService] Debit description:', debitDescription);
        console.log('[WalletService] Credit description:', creditDescription);

        // Créer la transaction de débit (wallet source)
        const senderTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: user.id,
            walletId: fromWallet.id,
            amount: amount,
            type: 'TRANSFER',
            status: 'SUCCESS',
            reference: reference,
            description: debitDescription,
            movement: 'DEBIT',
            currency: fromWallet.currency,
          },
        });

        // Créer la transaction de crédit (wallet destination)
        const receiverTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: user.id,
            walletId: toWallet.id,
            amount: convertedAmount,
            type: 'DEPOSIT',
            status: 'SUCCESS',
            reference: reference,
            description: creditDescription,
            movement: 'CREDIT',
            currency: toWallet.currency,
          },
        });

        // Audit
        await this.logAudit(user.id, 'convertCurrency', {
          from: updatedFrom,
          to: updatedTo,
          rate,
          convertedAmount,
        }, ipAddress || null);

        return {
          fromWallet: updatedFrom,
          toWallet: updatedTo,
          user,
          senderTx,
          receiverTx,
          rate,
          convertedAmount,
        };
      },
      {
        timeout: 30000,
        maxWait: 30000,
      }
    );

    // ✅ Notifications
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

    // ✅ Message de succès avec traduction
    return {
      message: this.i18nService.translate('wallet.conversion_success', lang, {
        fromCurrency: fromWallet.currency,
        toCurrency: toWallet.currency,
        amount: amount.toFixed(2),
        convertedAmount: convertedAmount.toFixed(2),
        rate: rate.toFixed(4),
      }),
      data: {
        fromWallet: this.toResponse(result.fromWallet),
        toWallet: this.toResponse(result.toWallet),
        transaction: result.senderTx,
      },
    };
  }

  async getExchangeRatesForUser(
    userId: string,
    lang: string = 'fr',
  ): Promise<ApiResponse<{ currencies: string[]; exchangeRates: any[] }>> {
    console.log('[WalletService] Get exchange rates for user:', { userId, lang });

    // 1. Récupérer tous les wallets actifs de l'utilisateur
    const wallets = await this.prisma.wallet.findMany({
      where: { userId, isActive: true },
      select: { currency: true },
      distinct: ['currency'],
    });

    if (!wallets || wallets.length === 0) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.no_wallet_found', lang),
        statusCode: 404,
      });
    }

    // 2. Extraire les devises uniques
    const currencies = wallets.map(w => w.currency);

    // 3. Récupérer tous les taux de change pour ces devises
    const exchangeRates = await this.prisma.exchange_rate.findMany({
      where: {
        OR: [
          { from_currency: { in: currencies } },
          { to_currency: { in: currencies } },
        ],
      },
      orderBy: {
        from_currency: 'asc',
      },
    });

    // ✅ 4. Définir le type pour les taux
    interface RateItem {
      from_currency: string;
      to_currency: string;
      rate: number;
      updated_at: Date;
      is_direct: boolean;
      is_default?: boolean;
    }

    const formattedRates: RateItem[] = [];

    // 5. Pour chaque devise source
    for (const fromCurrency of currencies) {
      // Pour chaque devise destination
      for (const toCurrency of currencies) {
        if (fromCurrency === toCurrency) continue;

        // Chercher le taux direct
        const rate = exchangeRates.find(
          r => r.from_currency === fromCurrency && r.to_currency === toCurrency
        );

        // Si pas de taux direct, chercher via USD
        if (!rate) {
          const fromToUsd = exchangeRates.find(
            r => r.from_currency === fromCurrency && r.to_currency === 'USD'
          );
          const usdToTarget = exchangeRates.find(
            r => r.from_currency === 'USD' && r.to_currency === toCurrency
          );

          if (fromToUsd && usdToTarget) {
            const calculatedRate = fromToUsd.rate * usdToTarget.rate;
            formattedRates.push({
              from_currency: fromCurrency,
              to_currency: toCurrency,
              rate: calculatedRate,
              updated_at: new Date(),
              is_direct: false,
            });
            continue;
          }

          // Si toujours pas de taux, utiliser 1:1
          formattedRates.push({
            from_currency: fromCurrency,
            to_currency: toCurrency,
            rate: 1,
            updated_at: new Date(),
            is_direct: false,
            is_default: true,
          });
          continue;
        }

        formattedRates.push({
          from_currency: rate.from_currency,
          to_currency: rate.to_currency,
          rate: rate.rate,
          updated_at: rate.updated_at,
          is_direct: true,
        });
      }
    }

    return {
      message: this.i18nService.translate('wallet.exchange_rates_retrieved', lang),
      data: {
        currencies,
        exchangeRates: formattedRates,
      },
    };
  }

  async listTransactions(params: {
    userId: string;
    page?: number;
    limit?: number;
    startDate?: Date;
    endDate?: Date;
    adminId?: string;
    countryCode?: string;
    branchId?: string;
  }) {
    const {
      userId,
      page = 1,
      limit = 10,
      startDate,
      endDate,
      adminId,
      countryCode,
      branchId: filterBranchId,
    } = params;

    // ✅ LOGIQUE DE FILTRAGE
    let branchFilter: string | null = null;
    let hasManagePermission = false;
    let hasReadPermission = false;
    let isSuperAdmin = false;
    let allowedBranchIds: string[] = [];

    // ✅ Si un branchId est fourni dans les filtres, il a priorité
    if (filterBranchId) {
      branchFilter = filterBranchId;
      allowedBranchIds = [filterBranchId];
    }
    // ✅ Gérer les permissions de l'admin UNIQUEMENT si adminId est fourni
    else if (adminId) {
      const admin = await this.prisma.user.findUnique({
        where: { id: adminId },
        select: {
          id: true,
          role: true,
          branchId: true,
          user_has_resources: {
            where: {
              resources: {
                name: 'transactions'
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

      if (admin) {
        isSuperAdmin = admin.role === 'SUPER_ADMIN';

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
          branchFilter = null;
        }
        else if (hasReadPermission && admin.branchId) {
          allowedBranchIds = [admin.branchId];
          branchFilter = admin.branchId;
        }
        else if (admin.branchId) {
          allowedBranchIds = [admin.branchId];
          branchFilter = admin.branchId;
        }
        else {
          allowedBranchIds = [];
          branchFilter = 'none';
        }
      }
    }

    // ✅ Récupérer les branches disponibles (pour les admins uniquement)
    let availableBranches: any[] = [];
    let availableCountries: any[] = [];

    if (adminId) {
      availableBranches = await this.prisma.branch.findMany({
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

      let availableCountriesWhere: any = { deleted: false };
      if (branchFilter && branchFilter !== 'none') {
        availableCountriesWhere.branchId = branchFilter;
      }
      if (countryCode) {
        availableCountriesWhere.countryCode = countryCode.toUpperCase();
      }

      const users = await this.prisma.user.findMany({
        where: availableCountriesWhere,
        select: {
          countryCode: true,
        },
        distinct: ['countryCode'],
      });

      availableCountries = await Promise.all(
        users
          .filter(u => u.countryCode)
          .map(async (u) => {
            const count = await this.prisma.user.count({
              where: {
                ...availableCountriesWhere,
                countryCode: u.countryCode,
              },
            });
            return {
              code: u.countryCode,
              count,
            };
          })
      );

      availableCountries.sort((a, b) => b.count - a.count);
    }

    const skip = (page - 1) * limit;

    // ✅ FILTRE: Exclure les transactions de caisse
    const where: any = {
      type: {
        notIn: ['CASH_IN', 'CASH_OUT', 'CASH_TRANSFER']
      }
    };

    // ✅ FILTRE PRIORITAIRE : userId (TOUJOURS appliqué)
    if (userId) {
      where.userId = userId;
    }

    // ✅ FILTRE BRANCHE (UNIQUEMENT pour les admins)
    if (adminId && userId !== adminId) {
      if (branchFilter && branchFilter !== 'none') {
        where.branchId = branchFilter;
      } else if (branchFilter === 'none') {
        return {
          message: 'Transactions retrieved successfully',
          data: {
            data: [],
            total: 0,
            page,
            limit,
            analytics: {
              totalCredit: 0,
              totalDebit: 0,
            },
            availableBranches: [],
            availableCountries: [],
          },
        };
      }
    }

    // ✅ FILTRE PAYS (UNIQUEMENT pour les admins)
    if (adminId && countryCode) {
      where.user = {
        countryCode: countryCode.toUpperCase()
      };
    }

    // ✅ FILTRE DATE
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

    // ✅ Enrichir les transactions (uniquement si userId est fourni)
    let enrichedTransactions = transactions;

    if (userId) {
      enrichedTransactions = await Promise.all(
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
    }

    // ✅ FORMATER LA RÉPONSE
    const responseData: any = {
      data: enrichedTransactions,
      total,
      page,
      limit,
      analytics: {
        totalCredit,
        totalDebit,
      },
    };

    if (adminId) {
      responseData.availableBranches = availableBranches;
      responseData.availableCountries = availableCountries;
    }

    return {
      message: 'Transactions retrieved successfully',
      data: responseData,
    };
  }

  async listAllTransactions(params: {
    page?: number;
    limit?: number;
    userId?: string;
    type?: string;
    status?: string;
    startDate?: Date;
    endDate?: Date;
    search?: string;
    adminId?: string;
    branchId?: string;
    countryCode?: string;
  }) {
    const {
      page = 1,
      limit = 10,
      userId,
      type,
      status,
      startDate,
      endDate,
      search,
      adminId,
      branchId: filterBranchId,
      countryCode,
    } = params;

    const skip = (page - 1) * limit;

    // ✅ FILTRE: Exclure les transactions de caisse
    const where: any = {
      type: {
        notIn: ['CASH_IN', 'CASH_OUT', 'CASH_TRANSFER']
      }
    };

    // ✅ LOGIQUE DE FILTRAGE POUR ADMIN
    let branchFilter: string | null = null;
    let isAdminRequest = false;

    if (filterBranchId) {
      branchFilter = filterBranchId;
      isAdminRequest = true;
    }
    else if (adminId) {
      isAdminRequest = true;
      const admin = await this.prisma.user.findUnique({
        where: { id: adminId },
        select: {
          id: true,
          role: true,
          branchId: true,
          user_has_resources: {
            where: {
              resources: {
                name: 'transactions'
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

      if (admin) {
        const isSuperAdmin = admin.role === 'SUPER_ADMIN';
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
          branchFilter = null;
        }
        else if ((hasReadPermission || admin.branchId) && admin.branchId) {
          branchFilter = admin.branchId;
        }
        else {
          branchFilter = 'none';
        }
      }
    }

    // ✅ APPLIQUER LES FILTRES

    // 1️⃣ Filtrer par utilisateur
    if (userId) {
      if (!isAdminRequest || userId !== adminId) {
        where.userId = userId;
      }
    }

    // 2️⃣ Filtrer par branche (pour les admins)
    if (isAdminRequest) {
      if (branchFilter && branchFilter !== 'none') {
        where.branchId = branchFilter;
      } else if (branchFilter === 'none') {
        return {
          message: 'All transactions retrieved successfully',
          data: {
            data: [],
            total: 0,
            page,
            limit,
          },
        };
      }
    }

    // 3️⃣ Filtrer par pays (pour les admins)
    if (isAdminRequest && countryCode) {
      where.user = {
        countryCode: countryCode.toUpperCase()
      };
    }

    // 4️⃣ Filtrer par type (si explicitement demandé et différent des types de caisse)
    if (type) {
      where.type = type;
    }

    // 5️⃣ Filtrer par statut (seulement si explicitement demandé)
    if (status) where.status = status;

    // 6️⃣ Filtrer par date
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) {
        const endOfDay = new Date(endDate);
        endOfDay.setHours(23, 59, 59, 999);
        where.createdAt.lte = endOfDay;
      }
    }

    // 7️⃣ Recherche
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
            select: {
              id: true,
              full_name: true,
              account_number: true,
              phone: true,
              branchId: true,
            },
          },
          wallet: {
            select: {
              id: true,
              currency: true,
            },
          },
          branch: {
            select: {
              id: true,
              name: true,
              code: true,
            },
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
    // ✅ FILTRE: Exclure les transactions de caisse
    const where: any = {
      type: {
        notIn: ['CASH_IN', 'CASH_OUT', 'CASH_TRANSFER']
      }
    };

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
    // ✅ FILTRE: Exclure les transactions de caisse
    const where: any = {
      type: {
        notIn: ['CASH_IN', 'CASH_OUT', 'CASH_TRANSFER']
      }
    };

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
 * Appelle PawaPay pour un dépôt Mobile Money
 * L'utilisateur envoie la devise directement
 */
  async depositWithPawaPay(
    userId: string,
    amount: number,
    pin: string,
    provider: string,
    phone: string,
    currency: string,  // ✅ L'utilisateur envoie la devise
    lang: string = 'fr',
    ipAddress?: string,
  ): Promise<ApiResponse<{ deposit: any }>> {
    console.log('[WalletService] Deposit with PawaPay:', { userId, amount, provider, phone, currency, lang });

    // ========== VALIDATIONS ==========
    if (amount <= 0) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.amount_positive', lang),
        statusCode: 400,
      });
    }

    if (!userId) {
      throw new RpcException({
        status: 'error',
        message: 'L\'ID de l\'utilisateur est requis',
        statusCode: 400,
      });
    }

    if (!provider) {
      throw new RpcException({
        status: 'error',
        message: 'Le provider PawaPay est requis',
        statusCode: 400,
      });
    }

    if (!phone) {
      throw new RpcException({
        status: 'error',
        message: 'Le numéro de téléphone est requis',
        statusCode: 400,
      });
    }

    if (!currency) {
      throw new RpcException({
        status: 'error',
        message: 'La devise est requise (ex: CDF, USD, XOF, etc.)',
        statusCode: 400,
      });
    }

    // ✅ VÉRIFICATION DU PIN
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

    // ========== RÉCUPÉRER L'UTILISATEUR ==========
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        full_name: true,
        phone: true,
        pin: true,
        status: true,
        failed_pin_attempts: true,
        countryCode: true,
      },
    });

    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.user_not_found', lang),
        statusCode: 404,
      });
    }

    if (user.status === user_status.BLOCKED) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('account_blocked_admin', lang),
        statusCode: 403,
      });
    }

    // ✅ VÉRIFIER LE PIN
    if (!user.pin) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.no_pin_set', lang),
        statusCode: 400,
      });
    }

    const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
    if (user.pin !== hashedPin) {
      const newAttempts = (user.failed_pin_attempts || 0) + 1;
      let newStatus: user_status = user.status;
      let lockedUntil: Date | null = null;

      if (newAttempts >= 10) {
        lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
        newStatus = user_status.SUSPENDED;
      } else if (newAttempts >= 5) {
        lockedUntil = null;
        newStatus = user_status.ACTIVE;
      }

      await this.prisma.user.update({
        where: { id: userId },
        data: {
          failed_pin_attempts: newAttempts,
          status: newStatus,
          pin_locked_until: lockedUntil,
        },
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

      let errorMessage: string;
      if (newAttempts >= 10) {
        errorMessage = this.i18nService.translate('wallet.pin_locked_auto', lang, {
          minutes: 30,
        });
      } else if (newAttempts >= 5) {
        const remaining = 10 - newAttempts;
        errorMessage = this.i18nService.translate('wallet.pin_incorrect_warning', lang, {
          attempts: remaining,
        });
      } else {
        const remaining = 5 - newAttempts;
        errorMessage = this.i18nService.translate('wallet.pin_incorrect', lang, {
          attempts: remaining,
        });
      }

      throw new RpcException({
        status: 'error',
        message: errorMessage,
        statusCode: 401,
      });
    }

    // ✅ Réinitialiser les tentatives de PIN
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failed_pin_attempts: 0,
        pin_locked_until: null,
        status: user_status.ACTIVE,
      },
    });

    // ========== APPEL PAWAPAY ==========
    let paymentSucceeded = false;
    let failureReasonKey: string | null = null;
    let failureReasonParams: any = {};
    let externalReference: string | undefined;
    let pawapayResponse: any;

    const amountStr = amount.toString();
    const pawapayData = {
      amount: amountStr,
      currency: currency.toUpperCase(),  // ✅ Devise envoyée par l'utilisateur
      provider,
      phone,
    };

    console.log('[WalletService] Appel PawaPay deposit:', pawapayData);
    try {
      pawapayResponse = await this.pawapayService.createDepositSimple(pawapayData);
      console.log('[WalletService] Réponse PawaPay:', pawapayResponse);

      const depositStatus = pawapayResponse.finalStatus?.data?.status;
      if (depositStatus === 'COMPLETED') {
        paymentSucceeded = true;
        externalReference = pawapayResponse.deposit?.depositId;
      } else {
        const failureObj = pawapayResponse.finalStatus?.data?.failureReason;
        const failureCode = failureObj?.failureCode;
        const failureMsg = failureObj?.failureMessage;

        const amountValue = amount;
        const currencyValue = currency.toUpperCase();

        switch (failureCode) {
          case 'LIMIT_REACHED':
          case 'WALLET_LIMIT_REACHED':
            failureReasonKey = 'wallet.deposit_limit_reached';
            failureReasonParams = { phone, amount: amountValue, currency: currencyValue };
            break;
          case 'INVALID_PHONE_NUMBER':
            failureReasonKey = 'wallet.deposit_invalid_phone';
            failureReasonParams = { phone, amount: amountValue, currency: currencyValue };
            break;
          case 'PROVIDER_UNAVAILABLE':
            failureReasonKey = 'wallet.deposit_provider_unavailable';
            failureReasonParams = { provider, amount: amountValue, currency: currencyValue };
            break;
          default:
            failureReasonKey = 'wallet.deposit_failed';
            failureReasonParams = {
              reason: failureMsg || depositStatus,
              amount: amountValue,
              currency: currencyValue
            };
        }
      }
    } catch (err: any) {
      console.error('[WalletService] Erreur PawaPay:', err);

      const errorData = err?.response?.data;
      const failureReason = errorData?.failureReason;
      const errorMessage = failureReason?.failureMessage ||
        failureReason?.message ||
        errorData?.message ||
        err?.message ||
        'Erreur technique lors du dépôt PawaPay';
      const errorCode = failureReason?.failureCode || errorData?.code || 'UNKNOWN';

      console.error('[WalletService] PawaPay error details:', {
        errorCode,
        errorMessage,
        failureReason,
      });

      failureReasonKey = 'wallet.deposit_technical_error';
      failureReasonParams = {
        error: errorMessage,
        amount: amount,
        currency: currency.toUpperCase()
      };

      throw new RpcException({
        status: 'error',
        message: `PawaPay: ${errorMessage} (Code: ${errorCode})`,
        statusCode: err?.response?.status || 400,
        details: {
          failureReason,
          errorCode,
        },
      });
    }

    // ========== GÉRER L'ÉCHEC ==========
    if (!paymentSucceeded) {
      if (!failureReasonParams.amount) {
        failureReasonParams.amount = amount;
      }
      if (!failureReasonParams.currency) {
        failureReasonParams.currency = currency.toUpperCase();
      }

      const failureMessage = failureReasonKey
        ? this.i18nService.translate(failureReasonKey, lang, failureReasonParams)
        : this.i18nService.translate('wallet.payment_failed', lang, {
          amount: amount,
          currency: currency.toUpperCase(),
        });

      console.log('[WalletService] Failure message:', failureMessage);

      await this.logAudit(user.id, 'deposit_pawapay_failed', {
        error: failureMessage,
        provider,
        phone,
        amount,
        currency: currency.toUpperCase(),
      }, ipAddress || null);

      throw new RpcException({
        status: 'error',
        message: failureMessage,
        statusCode: 400,
      });
    }

    // ========== SUCCÈS ==========
    await this.prisma.audit_log.create({
      data: {
        id: crypto.randomUUID(),
        userId: userId,
        action: 'PAWAPAY_DEPOSIT_SUCCESS',
        details: JSON.stringify({
          amount: amount,
          currency: currency.toUpperCase(),
          provider: provider,
          phone: phone,
          externalReference: externalReference,
          depositId: pawapayResponse?.deposit?.depositId,
          status: pawapayResponse?.finalStatus?.data?.status,
        }),
        ipAddress: ipAddress || null,
        createdAt: new Date(),
      },
    });

    // ========== RETOUR ==========
    return {
      message: `Dépôt PawaPay effectué avec succès: ${amount} ${currency.toUpperCase()} via ${provider} (${phone})`,
      data: {
        deposit: {
          depositId: pawapayResponse?.deposit?.depositId,
          status: pawapayResponse?.finalStatus?.data?.status,
          externalReference: externalReference,
          provider: provider,
          phone: phone,
          amount: amount,
          currency: currency.toUpperCase(),
          createdAt: new Date(),
        },
      },
    };
  }

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
          countryCode: true,
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

        if (newAttempts >= 10) {
          lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
          newStatus = user_status.SUSPENDED;
        } else if (newAttempts >= 5) {
          lockedUntil = null;
          newStatus = user_status.ACTIVE;
        }

        await this.prisma.user.update({
          where: { id: userId },
          data: {
            failed_pin_attempts: newAttempts,
            status: newStatus,
            pin_locked_until: lockedUntil,
          },
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

        let errorMessage: string;
        if (newAttempts >= 10) {
          errorMessage = this.i18nService.translate('wallet.pin_locked_auto', lang, {
            minutes: 30,
          });
        } else if (newAttempts >= 5) {
          const remaining = 10 - newAttempts;
          errorMessage = this.i18nService.translate('wallet.pin_incorrect_warning', lang, {
            attempts: remaining,
          });
        } else {
          const remaining = 5 - newAttempts;
          errorMessage = this.i18nService.translate('wallet.pin_incorrect', lang, {
            attempts: remaining,
          });
        }

        throw new RpcException({
          status: 'error',
          message: errorMessage,
          statusCode: 401,
        });
      }

      await this.prisma.user.update({
        where: { id: userId },
        data: {
          failed_pin_attempts: 0,
          pin_locked_until: null,
          status: user_status.ACTIVE,
        },
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

    // ========== CALCUL DES FRAIS ==========
    const fees = await this.getNetworkProviderFees(provider);
    const feeAmount = (amount * fees.depositFee) / 100;
    const netAmount = Math.round((amount - feeAmount) * 100) / 100;

    console.log('[WalletService] Top-up calcul:', {
      amount,
      feeAmount,
      netAmount,
      depositFee: fees.depositFee,
    });

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
            reference: await this.generateTransactionReference('', tx),
            description: this.i18nService.translate('wallet.failed_description', lang, {
              reason: failureMessage,
            }),
            movement: 'CREDIT',
            paymentMethod: 'MOBILE_MONEY',
            currency: wallet.currency,
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
    let debtsPaid = 0;
    let totalDebtPaid = 0;

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const description = this.i18nService.translate('wallet.transaction_description_deposit', lang)
          .replace('{phone}', phone || '')
          + ` (frais ${fees.depositFee}% : ${feeAmount.toFixed(2)} ${wallet.currency} déduits) - Net crédité: ${netAmount.toFixed(2)} ${wallet.currency}`
          + ' ' + this.i18nService.translate('wallet.via_pawapay', lang, { provider });

        // ✅ Créditer le NET
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
            reference: await this.generateTransactionReference('', tx),
            description,
            movement: 'CREDIT',
            paymentMethod: 'MOBILE_MONEY',
            currency: wallet.currency,
          },
        });

        // ============================================
        // ✅ PAIEMENT AUTOMATIQUE DES DETTES DE MAINTENANCE
        // ============================================
        let currentBalance = upd.balance;
        let debtPaidCount = 0;
        let debtPaidTotal = 0;

        // ✅ Récupérer le préfixe de dette dans la langue de l'utilisateur
        const debtPrefix = this.i18nService.translate('wallet.maintenance.debt_prefix', lang);

        // ✅ Récupérer les dettes en PENDING par description
        const debtTransactions = await tx.transaction.findMany({
          where: {
            userId: userId,
            walletId: wallet.id,
            type: 'WITHDRAW',
            status: 'PENDING',
            description: {
              startsWith: debtPrefix
            },
          },
          orderBy: { createdAt: 'asc' },
        });

        if (debtTransactions.length > 0) {
          console.log(`[TopUp] ${debtTransactions.length} dettes de maintenance trouvées pour l'utilisateur ${userId}`);
        }

        for (const debt of debtTransactions) {
          if (currentBalance >= debt.amount) {
            // ✅ Payer la dette
            await tx.transaction.update({
              where: { id: debt.id },
              data: {
                status: 'SUCCESS',
                description: `${debt.description} (Payée le ${new Date().toLocaleDateString()})`,
                updatedAt: new Date(),
              },
            });

            currentBalance -= debt.amount;
            debtPaidTotal += debt.amount;
            debtPaidCount++;

            // ✅ Audit log
            await tx.audit_log.create({
              data: {
                id: crypto.randomUUID(),
                userId: userId,
                action: 'MAINTENANCE_DEBT_PAID_AUTO',
                details: JSON.stringify({
                  debtId: debt.id,
                  amount: debt.amount,
                  currency: debt.currency,
                  reference: debt.reference,
                  remainingBalance: currentBalance,
                  totalDebts: debtTransactions.length,
                  source: 'TOPUP',
                }),
                createdAt: new Date(),
              },
            });

            console.log(`✅ Dette ${debt.id} (${debt.reference}) payée via TopUp (${debt.amount} ${debt.currency})`);
          }
        }

        // ✅ Mettre à jour le solde si des dettes ont été payées
        if (debtPaidCount > 0) {
          await tx.wallet.update({
            where: { id: wallet.id },
            data: {
              balance: currentBalance,
              updatedAt: new Date(),
            },
          });
          upd.balance = currentBalance;
        }

        // ✅ Vérifier s'il reste des dettes
        const remainingDebts = await tx.transaction.count({
          where: {
            userId: userId,
            type: 'WITHDRAW',
            status: 'PENDING',
            description: {
              startsWith: debtPrefix
            },
          },
        });

        // ✅ Si plus de dettes → débloquer
        if (remainingDebts === 0) {
          const userStatus = await tx.user.findUnique({
            where: { id: userId },
            select: { status: true },
          });

          if (userStatus?.status === 'BLOCKED') {
            await tx.user.update({
              where: { id: userId },
              data: {
                status: 'ACTIVE',
                locked_until: null,
                updatedAt: new Date(),
              },
            });

            await tx.audit_log.create({
              data: {
                id: crypto.randomUUID(),
                userId: userId,
                action: 'ACCOUNT_UNBLOCKED_AUTO_DEBT_PAID',
                details: JSON.stringify({
                  reason: 'Toutes les dettes de maintenance ont été payées via TopUp',
                  totalPaid: debtPaidTotal,
                  debtsCount: debtPaidCount,
                  date: new Date(),
                  source: 'TOPUP',
                }),
                createdAt: new Date(),
              },
            });

            console.log(`🔓 Utilisateur ${userId} débloqué (toutes les dettes payées via TopUp)`);
          }
        }

        return {
          wallet: upd,
          transaction: txRecord,
          debtPaidCount,
          debtPaidTotal,
          remainingDebts,
        };
      }, { timeout: 30000 });

      updatedWallet = result.wallet;
      transaction = result.transaction;
      debtsPaid = result.debtPaidCount;
      totalDebtPaid = result.debtPaidTotal;

      if (debtsPaid > 0) {
        console.log(`💰 ${debtsPaid} dette(s) payée(s) automatiquement (${totalDebtPaid} ${wallet.currency})`);
      }
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('wallet.top_up_failed', lang),
        statusCode: 500,
      });
    }

    // 5. Audit et notifications
    await this.logAudit(user.id, 'topUp', { transaction, debtsPaid, totalDebtPaid }, ipAddress || null);
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

    // ✅ Message avec info sur les dettes payées
    let successMessage = this.i18nService.translate('wallet.top_up_success', lang, {
      amount: netAmount.toFixed(2),
      currency: wallet.currency || 'CDF',
      balance: updatedWallet.balance.toFixed(2),
      reference: transaction.reference || 'N/A',
    });

    if (debtsPaid > 0) {
      successMessage += ` (${debtsPaid} dette(s) de maintenance payée(s): ${totalDebtPaid.toFixed(2)} ${wallet.currency})`;
    }

    return {
      message: successMessage,
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

    // ========== VALIDATIONS ==========
    if (amount <= 0) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.amount_positive', lang),
        statusCode: 400,
      });
    }

    if (!provider || !phone) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.missing_phone_or_provider', lang),
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

    // ---------- 1. Validation préalable (hors transaction) ----------
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: {
        id: true,
        full_name: true,
        phone: true,
        pin: true,
        role: true,
        status: true,
        failed_pin_attempts: true,
        countryCode: true,
      },
    });

    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.user_not_found', lang),
        statusCode: 404,
      });
    }

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

      if (newAttempts >= 10) {
        lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
        newStatus = user_status.SUSPENDED;
      } else if (newAttempts >= 5) {
        lockedUntil = null;
        newStatus = user_status.ACTIVE;
      }

      await this.prisma.user.update({
        where: { id: userId },
        data: {
          failed_pin_attempts: newAttempts,
          status: newStatus,
          pin_locked_until: lockedUntil,
        },
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

      let errorMessage: string;
      if (newAttempts >= 10) {
        errorMessage = this.i18nService.translate('wallet.pin_locked_auto', lang, {
          minutes: 30,
        });
      } else if (newAttempts >= 5) {
        const remaining = 10 - newAttempts;
        errorMessage = this.i18nService.translate('wallet.pin_incorrect_warning', lang, {
          attempts: remaining,
        });
      } else {
        const remaining = 5 - newAttempts;
        errorMessage = this.i18nService.translate('wallet.pin_incorrect', lang, {
          attempts: remaining,
        });
      }

      throw new RpcException({
        status: 'error',
        message: errorMessage,
        statusCode: 401,
      });
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failed_pin_attempts: 0,
        pin_locked_until: null,
        status: user_status.ACTIVE,
      },
    });

    // Récupérer le wallet
    let wallet;
    if (walletId) {
      wallet = await this.prisma.wallet.findFirst({
        where: { id: walletId, userId },
        include: { user: true },
      });
      if (!wallet) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('wallet.wallet_not_found_or_unauthorized', lang),
          statusCode: 404,
        });
      }
    } else {
      wallet = await this.prisma.wallet.findFirst({
        where: { userId },
        include: { user: true },
      });
      if (!wallet) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('wallet.wallet_not_found', lang),
          statusCode: 404,
        });
      }
    }

    if (!wallet.isActive) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.wallet_inactive', lang),
        statusCode: 403,
      });
    }

    // ========== CALCUL DES FRAIS ==========
    const fees = await this.getNetworkProviderFees(provider);
    const feeAmount = (amount * fees.payoutFee) / 100;
    const totalDebit = amount + feeAmount; // ✅ Montant total à débiter (montant + frais)
    const netAmount = Math.round((amount - feeAmount) * 100) / 100;

    console.log('[WalletService] Cashout calcul:', {
      amount,
      feeAmount,
      totalDebit,
      netAmount,
      payoutFee: fees.payoutFee,
    });

    // ✅ Vérifier le solde : le wallet doit avoir le montant total + frais
    if (wallet.balance < totalDebit) {
      const shortfall = (totalDebit - wallet.balance).toFixed(2);
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.insufficient_wallet_balance', lang, {
          balance: wallet.balance.toFixed(2),
          currency: wallet.currency || 'CDF',
          required: totalDebit.toFixed(2),
          fee: feeAmount.toFixed(2),
          feePercent: fees.payoutFee,
          netAmount: netAmount.toFixed(2),
          shortfall: shortfall,
        }),
        statusCode: 400,
      });
    }

    // ---------- 2. Appel PawaPay payout ----------
    let paymentSucceeded = false;
    let pawaPayErrorMessage: string | null = null;
    let pawaPayErrorCode: string | null = null;
    let pawaPayErrorDetails: any = null;
    let externalReference: string | undefined;

    const amountStr = netAmount.toString();
    const pawapayData = {
      amount: amountStr,
      currency: wallet.currency,
      provider,
      phone,
    };

    console.log('[WalletService] Appel PawaPay payout (net):', JSON.stringify(pawapayData, null, 2));

    try {
      const pawapayResponse = await this.pawapayService.createPayoutSimple(pawapayData);
      console.log('[WalletService] Réponse PawaPay payout:', JSON.stringify(pawapayResponse, null, 2));

      const payoutStatus = pawapayResponse.finalStatus?.data?.status;

      if (payoutStatus === 'COMPLETED') {
        paymentSucceeded = true;
        externalReference = pawapayResponse.payout?.payoutId;
      } else {
        const failureObj = pawapayResponse.finalStatus?.data?.failureReason;
        const failureCode = failureObj?.failureCode;
        const failureMsg = failureObj?.failureMessage;

        pawaPayErrorCode = failureCode;
        pawaPayErrorMessage = failureMsg || payoutStatus;
        pawaPayErrorDetails = failureObj;

        console.log('[WalletService] PawaPay failure:', {
          code: failureCode,
          message: failureMsg,
          details: failureObj,
        });
      }
    } catch (err: any) {
      console.error('[WalletService] Erreur PawaPay payout - DETAIL:', err);

      if (err?.response?.data) {
        pawaPayErrorMessage = err.response.data.message || err.response.data.error || err.message;
        pawaPayErrorCode = err.response.data.code || err.response.data.status || 'UNKNOWN_ERROR';
        pawaPayErrorDetails = err.response.data;
      } else if (err?.message) {
        pawaPayErrorMessage = err.message;
        pawaPayErrorCode = err?.code || 'TECHNICAL_ERROR';
      } else {
        pawaPayErrorMessage = 'Unknown PawaPay error';
        pawaPayErrorCode = 'UNKNOWN_ERROR';
      }

      console.error('[WalletService] PawaPay error details:', {
        message: pawaPayErrorMessage,
        code: pawaPayErrorCode,
        details: pawaPayErrorDetails,
      });
    }

    // ---------- 3. Gestion de l'échec ----------
    if (!paymentSucceeded) {
      let failureMessage = this.i18nService.translate('wallet.payout_failed', lang, {
        reason: pawaPayErrorMessage || 'Unknown error',
        code: pawaPayErrorCode || 'UNKNOWN',
      });

      if (pawaPayErrorDetails) {
        failureMessage = `${failureMessage} - Details: ${JSON.stringify(pawaPayErrorDetails)}`;
      }

      console.log('[WalletService] Cashout failure message:', failureMessage);

      let failedTransaction;
      try {
        failedTransaction = await this.prisma.$transaction(async (tx) => {
          return await tx.transaction.create({
            data: {
              id: crypto.randomUUID(),
              userId,
              walletId: wallet.id,
              amount: amount,
              type: 'WITHDRAW',
              status: 'FAILED',
              reference: await this.generateTransactionReference('', tx),
              description: this.i18nService.translate('wallet.failed_description', lang, {
                reason: failureMessage,
              }),
              movement: 'DEBIT',
              paymentMethod: 'MOBILE_MONEY',
              currency: wallet.currency,
            },
          });
        });
        await this.logAudit(
          user.id,
          'cashout_failed',
          {
            transaction: failedTransaction,
            error: failureMessage,
            pawaPay: {
              code: pawaPayErrorCode,
              message: pawaPayErrorMessage,
              details: pawaPayErrorDetails,
            },
          },
          ipAddress || null,
        );
      } catch (err) {
        console.error('Erreur lors de la création de la transaction failed:', err);
      }

      throw new RpcException({
        status: 'error',
        message: failureMessage,
        statusCode: 400,
        pawaPay: {
          code: pawaPayErrorCode,
          message: pawaPayErrorMessage,
          details: pawaPayErrorDetails,
        },
      });
    }

    // ---------- 4. Succès : débiter le wallet et créer la transaction ----------
    let updatedWallet: any;
    let transaction: any;

    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          const description =
            this.i18nService.translate('wallet.transaction_description_withdraw', lang)
              .replace('{phone}', phone || '') +
            ` (frais PawaPay ${fees.payoutFee}%: ${feeAmount.toFixed(2)} ${wallet.currency})` +
            ` - Net reçu: ${netAmount.toFixed(2)} ${wallet.currency}` +
            ' ' +
            this.i18nService.translate('wallet.via_pawapay', lang, { provider }) +
            (externalReference ? ` Ref: ${externalReference}` : '');

          // ✅ DÉBITER LE MONTANT TOTAL (montant + frais)
          const upd = await tx.wallet.update({
            where: { id: wallet.id },
            data: { balance: { decrement: totalDebit }, updatedAt: new Date() },
          });

          const reference = await this.generateTransactionReference('', tx);
          const txRecord = await tx.transaction.create({
            data: {
              id: crypto.randomUUID(),
              userId,
              walletId: wallet.id,
              amount: amount,
              type: 'WITHDRAW',
              status: 'SUCCESS',
              reference: reference,
              description,
              movement: 'DEBIT',
              currency: wallet.currency,
              external_reference: externalReference,
            },
          });

          return { wallet: upd, transaction: txRecord };
        },
        { timeout: 60000, maxWait: 60000 },
      );

      updatedWallet = result.wallet;
      transaction = result.transaction;
    } catch (error) {
      console.error('[WalletService] Cashout transaction error:', error);
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
          amount: amount.toFixed(2),
          feePercent: fees.payoutFee,
          currency: wallet.currency || 'CDF',
          balance: updatedWallet.balance || 0,
          netAmount: netAmount.toFixed(2),
          fee: feeAmount.toFixed(2),
          reference: transaction.reference || 'N/A',
          phone: phone || '',
        });
        const countryCode = user?.countryCode || 'CD';
        await this.smsService.sendSms(cleanPhone, smsText, countryCode);
        console.log(`[Cashout] SMS envoyé à ${cleanPhone} (${countryCode})`);
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

    // ---------- 7. Retour ----------
    return {
      message: this.i18nService.translate('wallet.cashout_success', lang, {
        amount: amount.toFixed(2),
        currency: wallet.currency || 'CDF',
        balance: updatedWallet.balance.toFixed(2),
        reference: transaction.reference || 'N/A',
        fee: feeAmount.toFixed(2),
        feePercent: fees.payoutFee,
        netAmount: netAmount.toFixed(2),
        phone: phone || 'N/A',
      }),
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
  ): Promise<ApiResponse<{ wallet: WalletResponseDto; transaction: any }>> {
    const { fromWalletId, toPhone, amount, pin, description, countryCode, feeIncluded } = dto;
    console.log('[WalletService] Send request:', { fromWalletId, toPhone, amount, lang, countryCode, feeIncluded });

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

    if (!toPhone || toPhone.trim() === '') {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.phone_required', lang),
        statusCode: 400,
      });
    }

    const cleanToPhone = toPhone.replace(/[^0-9+]/g, '');
    console.log('[WalletService] Clean phone:', cleanToPhone);

    const result = await this.prisma.$transaction(
      async (tx) => {
        // 1. Vérifier que le destinataire existe
        const toUser = await tx.user.findFirst({
          where: {
            phone: {
              in: [cleanToPhone, toPhone, `+${cleanToPhone.replace(/^\+/, '')}`]
            }
          },
          select: {
            id: true,
            full_name: true,
            phone: true,
            account_number: true,
            countryCode: true,
          },
        });

        if (!toUser) {
          console.error('[WalletService] ❌ Destinataire non trouvé:', cleanToPhone);
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.receiver_not_found', lang, {
              phone: toPhone,
            }),
            statusCode: 404,
          });
        }

        console.log('[WalletService] ✅ Destinataire trouvé:', {
          id: toUser.id,
          name: toUser.full_name,
          phone: toUser.phone,
          countryCode: toUser.countryCode,
        });

        // 2. Récupérer le wallet source
        const fromWallet = await tx.wallet.findFirst({
          where: { id: fromWalletId, isActive: true },
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
                countryCode: true,
                kycStatus: true,
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

        if (fromUser.id === toUser.id) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.cannot_transfer_self', lang),
            statusCode: 400,
          });
        }

        // 3. Déterminer les pays
        const senderCountryCode = fromUser.countryCode || 'CD';
        let receiverCountryCode = toUser.countryCode || 'CD';

        if (countryCode) {
          receiverCountryCode = countryCode.toUpperCase();
          console.log('[WalletService] 📌 CountryCode fourni par le client:', countryCode);
        }

        const isInternational = senderCountryCode !== receiverCountryCode;

        console.log('[WalletService] Transfer type:', {
          senderCountry: senderCountryCode,
          receiverCountry: receiverCountryCode,
          isInternational,
          fromCurrency: fromWallet.currency,
          countryCodeProvided: countryCode || 'Non fourni',
          feeIncluded: feeIncluded || false,
        });

        // ✅ VÉRIFICATION KYC POUR LES TRANSFERTS INTERNATIONAUX
        if (isInternational) {
          const kycStatus = fromUser.kycStatus || 'NOT_SUBMITTED';

          if (kycStatus !== 'VERIFIED') {
            console.error('[WalletService] ❌ KYC non vérifié pour transfert international:', {
              userId: fromUser.id,
              kycStatus: kycStatus,
            });

            let errorMessage = '';
            switch (kycStatus) {
              case 'NOT_SUBMITTED':
                errorMessage = this.i18nService.translate('wallet.kyc_required_for_international_transfer', lang);
                break;
              case 'PENDING':
                errorMessage = this.i18nService.translate('wallet.kyc_pending_for_international_transfer', lang);
                break;
              case 'REJECTED':
                errorMessage = this.i18nService.translate('wallet.kyc_rejected_for_international_transfer', lang);
                break;
              default:
                errorMessage = this.i18nService.translate('wallet.kyc_required_for_international_transfer', lang);
            }

            throw new RpcException({
              status: 'error',
              message: errorMessage,
              statusCode: 403,
            });
          }

          console.log('[WalletService] ✅ KYC vérifié pour transfert international');
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

          if (newAttempts >= 10) {
            lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
            newStatus = user_status.SUSPENDED;
          } else if (newAttempts >= 5) {
            lockedUntil = null;
            newStatus = user_status.ACTIVE;
          }

          await tx.user.update({
            where: { id: fromUser.id },
            data: {
              failed_pin_attempts: newAttempts,
              status: newStatus,
              pin_locked_until: lockedUntil,
            },
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

          let errorMessage: string;
          if (newAttempts >= 10) {
            errorMessage = this.i18nService.translate('wallet.pin_locked_auto', lang, {
              minutes: 30,
            });
          } else if (newAttempts >= 5) {
            const remaining = 10 - newAttempts;
            errorMessage = this.i18nService.translate('wallet.pin_incorrect_warning', lang, {
              attempts: remaining,
            });
          } else {
            const remaining = 5 - newAttempts;
            errorMessage = this.i18nService.translate('wallet.pin_incorrect', lang, {
              attempts: remaining,
            });
          }

          throw new RpcException({
            status: 'error',
            message: errorMessage,
            statusCode: 401,
          });
        }

        await tx.user.update({
          where: { id: fromUser.id },
          data: {
            failed_pin_attempts: 0,
            pin_locked_until: null,
            status: user_status.ACTIVE,
          },
        });

        // ============================================
        // 4. CALCUL DES FRAIS DE RETRAIT (fee_config)
        // ============================================
        let withdrawalFee = 0;
        let withdrawalFeeCurrency = fromWallet.currency;
        let feeConfigUsed: any = null;
        let debitAmount = amount;

        // ✅ Si c'est international et que feeIncluded = true
        if (isInternational && feeIncluded === true) {
          const receiverCountry = await tx.country_provider.findFirst({
            where: {
              OR: [
                { countryCode: receiverCountryCode },
                { code: receiverCountryCode },
              ]
            },
            select: {
              id: true,
              code: true,
              countryCode: true,
              default_currency: true,
            },
          });

          if (receiverCountry) {
            const feeConfigs = await tx.fee_config.findMany({
              where: {
                countryId: receiverCountry.id,
                isActive: true,
                paymentMethod: 'MOBILE_MONEY' as any,
              },
              orderBy: {
                minAmount: 'asc',
              },
            });

            console.log('[WalletService] 📊 Fee configs trouvées:', feeConfigs.length);

            let amountInLocalCurrency = amount;
            const localCurrency = receiverCountry.default_currency || 'XOF';

            if (fromWallet.currency !== localCurrency) {
              const rate = await this.getExchangeRateViaPivot(fromWallet.currency, localCurrency, tx);
              amountInLocalCurrency = amount * rate;
              console.log('[WalletService] 💱 Conversion:', {
                from: fromWallet.currency,
                to: localCurrency,
                amount: amount,
                converted: amountInLocalCurrency,
                rate: rate,
              });
            }

            for (const config of feeConfigs) {
              const minAmount = config.minAmount ? Number(config.minAmount) : 0;
              const maxAmount = config.maxAmount ? Number(config.maxAmount) : Infinity;

              if (amountInLocalCurrency >= minAmount && amountInLocalCurrency <= maxAmount) {
                withdrawalFee = config.feeAmount ? Number(config.feeAmount) : 0;
                withdrawalFeeCurrency = localCurrency as wallet_currency;
                feeConfigUsed = config;
                console.log('[WalletService] ✅ Frais trouvés:', {
                  minAmount,
                  maxAmount,
                  feeAmount: withdrawalFee,
                  description: config.description,
                  amountInLocalCurrency,
                  feeIncluded: true,
                });
                break;
              }
            }

            if (withdrawalFee === 0 && feeConfigs.length > 0) {
              const defaultConfig = feeConfigs[0];
              withdrawalFee = defaultConfig.feeAmount ? Number(defaultConfig.feeAmount) : 0;
              withdrawalFeeCurrency = localCurrency as wallet_currency;
              feeConfigUsed = defaultConfig;
              console.log('[WalletService] ⚠️ Aucune tranche trouvée, utilisation du frais par défaut:', withdrawalFee);
            }

            if (withdrawalFee > 0 && feeIncluded === true) {
              let feeInWalletCurrency = withdrawalFee;
              if (withdrawalFeeCurrency !== fromWallet.currency) {
                const rate = await this.getExchangeRateViaPivot(withdrawalFeeCurrency, fromWallet.currency, tx);
                feeInWalletCurrency = withdrawalFee * rate;
                console.log('[WalletService] 💱 Conversion des frais:', {
                  from: withdrawalFeeCurrency,
                  to: fromWallet.currency,
                  fee: withdrawalFee,
                  converted: feeInWalletCurrency,
                  rate: rate,
                });
              }
              debitAmount = amount + feeInWalletCurrency;
              console.log('[WalletService] 💰 Frais inclus:', {
                originalAmount: amount,
                fee: feeInWalletCurrency,
                total: debitAmount,
                feeCurrency: withdrawalFeeCurrency,
              });
            }
          }
        }

        // ============================================
        // 5. CALCUL DES FRAIS INTERNATIONAUX EXISTANTS
        // ============================================
        let internationalFeePercentage = 0;
        let withdrawalFeePercentage = 0;
        let fee = 0;
        let netAmount = amount;
        let finalAmount = amount;
        let feeCurrency = fromWallet.currency;
        let selectedReceiverNetwork: any = null;

        if (isInternational) {
          const senderCountry = await tx.country_provider.findFirst({
            where: {
              OR: [
                { countryCode: senderCountryCode },
                { code: senderCountryCode },
              ]
            },
            select: {
              international_transfer_fee: true,
              cash_percentage: true,
              momo_percentage: true,
            },
          });

          if (!senderCountry) {
            console.error('[WalletService] ❌ Pays expéditeur non trouvé:', senderCountryCode);
            throw new RpcException({
              status: 'error',
              message: `Pays expéditeur ${senderCountryCode} non trouvé`,
              statusCode: 404,
            });
          }

          const receiverNetworks = await tx.network_provider.findMany({
            where: {
              country_provider: {
                OR: [
                  { countryCode: receiverCountryCode },
                  { code: receiverCountryCode },
                ],
              },
            },
          });

          if (receiverNetworks.length > 0) {
            selectedReceiverNetwork = receiverNetworks[0];
            for (const network of receiverNetworks) {
              if (network.pourcentage_payout && network.pourcentage_payout > (selectedReceiverNetwork.pourcentage_payout || 0)) {
                selectedReceiverNetwork = network;
              }
            }
          }

          internationalFeePercentage = senderCountry.international_transfer_fee ||
            senderCountry.cash_percentage ||
            senderCountry.momo_percentage ||
            0;

          if (selectedReceiverNetwork && selectedReceiverNetwork.pourcentage_payout) {
            withdrawalFeePercentage = selectedReceiverNetwork.pourcentage_payout;
          } else {
            withdrawalFeePercentage = 0;
          }

          if (internationalFeePercentage > 0) {
            const percentageDecimal = internationalFeePercentage / 100;
            netAmount = amount / (1 + percentageDecimal);
            fee = amount - netAmount;
            const withdrawalDecimal = withdrawalFeePercentage / 100;
            finalAmount = netAmount + (netAmount * withdrawalDecimal);
            feeCurrency = fromWallet.currency;
          } else {
            netAmount = amount;
            fee = 0;
            finalAmount = amount;
          }
        } else {
          internationalFeePercentage = 0;
          withdrawalFeePercentage = 0;
          fee = 0;
          netAmount = amount;
          finalAmount = amount;
        }

        // 6. Récupérer les wallets du destinataire
        const receiverWallets = await tx.wallet.findMany({
          where: {
            userId: toUser.id,
            isActive: true,
          },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            currency: true,
            balance: true,
          },
        });

        if (!receiverWallets || receiverWallets.length === 0) {
          throw new RpcException({
            status: 'error',
            message: 'Le destinataire ne possède aucun wallet actif',
            statusCode: 404,
          });
        }

        let targetCurrency: string = receiverWallets[0].currency;
        let targetWallet: any = receiverWallets[0];

        if (isInternational) {
          const receiverCountry = await tx.country_provider.findFirst({
            where: {
              OR: [
                { countryCode: receiverCountryCode },
                { code: receiverCountryCode },
              ]
            },
            select: {
              default_currency: true,
              country_currency: {
                where: { is_default: true },
                take: 1,
                select: { currency_code: true },
              }
            },
          });

          let preferredCurrency: string | null = null;
          if (receiverCountry?.default_currency) {
            preferredCurrency = receiverCountry.default_currency;
          } else if (receiverCountry?.country_currency && receiverCountry.country_currency.length > 0) {
            preferredCurrency = receiverCountry.country_currency[0].currency_code;
          }

          if (preferredCurrency) {
            const foundWallet = receiverWallets.find(w => w.currency === preferredCurrency);
            if (foundWallet) {
              targetWallet = foundWallet;
              targetCurrency = preferredCurrency;
            }
          }

          if (!targetWallet || targetWallet.currency !== targetCurrency) {
            targetWallet = receiverWallets[0];
            targetCurrency = targetWallet.currency;
          }
        } else {
          targetWallet = receiverWallets[0];
          targetCurrency = targetWallet.currency;
        }

        // 7. Calculer le taux de change
        let exchangeRate = 1;
        let convertedAmount = finalAmount;

        if (fromWallet.currency !== targetCurrency) {
          exchangeRate = await this.getExchangeRateViaPivot(
            fromWallet.currency,
            targetCurrency,
            tx,
          );
          convertedAmount = finalAmount * exchangeRate;
        }

        // 8. Vérifier le solde
        if (fromWallet.balance < debitAmount) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.insufficient_wallet_balance', lang),
            statusCode: 400,
          });
        }

        // 9. Mettre à jour les soldes
        let updatedFrom: any = fromWallet;
        let updatedTo: any = null;

        if (!isInternational) {
          updatedFrom = await tx.wallet.update({
            where: { id: fromWallet.id },
            data: { balance: { decrement: debitAmount }, updatedAt: new Date() },
          });

          updatedTo = await tx.wallet.update({
            where: { id: targetWallet.id },
            data: { balance: { increment: convertedAmount }, updatedAt: new Date() },
          });
          console.log('[WalletService] ✅ Transfert national - Expéditeur débité, destinataire crédité');
        } else {
          updatedTo = targetWallet;
          console.log('[WalletService] 🌍 Transfert international - Balance non modifiée, en attente de validation');
        }

        // 10. COLLECTER LES FRAIS
        let systemTransaction: any = null;
        const totalFee = fee + withdrawalFee;

        if (totalFee > 0 && !isInternational) {
          try {
            const systemUser = await tx.user.findFirst({
              where: { email: 'system@fpay.com' },
              select: { id: true, full_name: true, email: true },
            });

            if (systemUser) {
              const systemWallet = await tx.wallet.findFirst({
                where: {
                  userId: systemUser.id,
                  currency: feeCurrency,
                  isActive: true,
                },
              });

              if (systemWallet) {
                await tx.wallet.update({
                  where: { id: systemWallet.id },
                  data: { balance: { increment: totalFee }, updatedAt: new Date() },
                });

                const feeReference = await this.generateTransactionReference('FEE', tx);
                systemTransaction = await tx.transaction.create({
                  data: {
                    id: crypto.randomUUID(),
                    userId: systemUser.id,
                    walletId: systemWallet.id,
                    amount: totalFee,
                    type: 'DEPOSIT',
                    status: 'SUCCESS',
                    reference: feeReference,
                    description: `Frais de transfert international (${internationalFeePercentage}%)${feeConfigUsed ? ` + frais retrait (${feeConfigUsed.description})` : ''}`,
                    movement: 'CREDIT',
                    currency: feeCurrency,
                    paymentMethod: 'MOBILE_MONEY',
                  },
                });
              }
            }
          } catch (err) {
            console.error('[WalletService] ❌ Erreur collecte frais:', err);
          }
        }

        // 11. Construire les descriptions
        const toUserDisplay = toUser.full_name ? `${toUser.full_name} (${toUser.phone})` : toUser.phone;
        const fromUserDisplay = fromUser.full_name ? `${fromUser.full_name} (${fromUser.phone})` : fromUser.phone;

        let senderDescription = description || `Transfert vers ${toUserDisplay}`;
        if (totalFee > 0) {
          senderDescription += ` (frais: ${totalFee} ${feeCurrency})`;
        }
        if (isInternational && fromWallet.currency !== targetCurrency) {
          senderDescription += ` - Taux: 1 ${fromWallet.currency} = ${exchangeRate} ${targetCurrency}`;
        }

        let receiverDescription = description || `Reçu de ${fromUserDisplay}`;
        if (isInternational && fromWallet.currency !== targetCurrency) {
          receiverDescription += ` - Taux: 1 ${fromWallet.currency} = ${exchangeRate} ${targetCurrency}`;
        }

        // 12. Créer les transactions
        const reference = await this.generateTransactionReference('', tx);

        const senderTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: fromUser.id,
            walletId: fromWallet.id,
            amount: debitAmount,
            type: 'TRANSFER',
            status: isInternational ? 'PENDING' : 'SUCCESS',
            reference: reference,
            description: senderDescription,
            movement: 'DEBIT',
            currency: fromWallet.currency,
            paymentMethod: 'MOBILE_MONEY',
            external_reference: isInternational ? JSON.stringify({
              receiverUserId: toUser.id,
              receiverWalletId: targetWallet.id,
              receiverAmount: convertedAmount,
              receiverCurrency: targetCurrency,
              receiverPhone: toUser.phone,
              receiverName: toUser.full_name,
              isInternational: true,
              originalAmount: amount,
              fee: totalFee,
              netAmount: netAmount,
              finalAmount: finalAmount,
              exchangeRate: exchangeRate,
              feeConfig: feeConfigUsed ? {
                id: feeConfigUsed.id,
                minAmount: Number(feeConfigUsed.minAmount),
                maxAmount: Number(feeConfigUsed.maxAmount),
                feeAmount: Number(feeConfigUsed.feeAmount),
                description: feeConfigUsed.description,
              } : null,
            }) : null,
          },
        });

        let receiverTx: any = null;
        if (!isInternational) {
          receiverTx = await tx.transaction.create({
            data: {
              id: crypto.randomUUID(),
              userId: toUser.id,
              walletId: targetWallet.id,
              amount: convertedAmount,
              type: 'DEPOSIT',
              status: 'SUCCESS',
              reference: reference,
              description: receiverDescription,
              movement: 'CREDIT',
              paymentMethod: 'MOBILE_MONEY',
              currency: targetCurrency,
            },
          });
          console.log('[WalletService] ✅ Transfert national - Transaction destinataire créée');
        } else {
          console.log('[WalletService] 🌍 Transfert international - Transaction destinataire NON créée, en attente de validation');
        }

        await this.logAudit(toUser.id, 'transfer', updatedTo, ipAddress || null);

        return {
          fromWallet: updatedFrom,
          toWallet: updatedTo,
          fromUser,
          toUser,
          senderTx,
          receiverTx,
          isInternational,
          exchangeRate,
          convertedAmount,
          targetCurrency,
          fee: totalFee,
          internationalFeePercentage,
          withdrawalFeePercentage,
          withdrawalFee: withdrawalFee,
          withdrawalFeeCurrency: withdrawalFeeCurrency,
          feeConfigUsed: feeConfigUsed,
          feeIncluded: feeIncluded || false,
          debitAmount: debitAmount,
          netAmount,
          finalAmount,
          receiverCountryCode,
          senderCountryCode,
          systemTransaction: systemTransaction ?? null,
        };
      },
      { timeout: 60000, maxWait: 60000 },
    );

    // ========== NOTIFICATIONS ==========
    try {
      if (!result.isInternational) {
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
      } else {
        await notifyTransaction(
          this.smsService,
          this.notificationHelper,
          this.i18nService,
          this.shouldSendSms.bind(this),
          this.shouldSendPush.bind(this),
          this.getUserLanguage.bind(this),
          result.senderTx,
          result.fromUser,
          result.fromWallet,
          'send_pending',
          {
            name: result.toUser.full_name ?? undefined,
            phone: result.toUser.phone ?? undefined,
          },
        );
        console.log('[WalletService] 🌍 Transfert international en attente - Pas de notification au destinataire');
      }
    } catch (err) {
      console.error('[Notifications] Send notification error:', err);
    }

    return {
      message: this.i18nService.translate(
        result.isInternational ? 'wallet.transfer_international_pending' : 'wallet.transfer_success',
        lang,
        {
          amount: result.convertedAmount.toFixed(2),
          currency: result.targetCurrency,
          recipient: result.toUser?.full_name || result.toUser?.phone || 'Destinataire',
          balance: result.fromWallet.balance.toFixed(2),
          reference: result.senderTx?.reference || 'N/A',
          rate: result.exchangeRate.toFixed(2),
          fee: result.fee.toFixed(2),
          feePercentage: result.internationalFeePercentage,
          withdrawalFeePercentage: result.withdrawalFeePercentage,
          withdrawalFee: result.withdrawalFee.toFixed(2),
          feeIncluded: result.feeIncluded ? 'Oui' : 'Non',
          debitAmount: result.debitAmount.toFixed(2),
          netAmount: result.netAmount.toFixed(2),
          finalAmount: result.finalAmount.toFixed(2),
          fromCurrency: result.fromWallet.currency,
          countryCode: result.receiverCountryCode,
        }
      ),
      data: {
        wallet: this.toResponse(result.fromWallet),
        transaction: result.senderTx,
      },
    };
  }

  async pay(
    dto: PayDto,
    lang: string = 'fr',
    ipAddress: string,
  ): Promise<ApiResponse<{ wallet: WalletResponseDto; transaction: any }>> {
    const { fromWalletId, toPhone, merchantCode, amount, pin, description, skipPinCheck } = dto;
    console.log('[WalletService] Pay request:', { fromWalletId, toPhone, merchantCode, amount, lang });

    // ========== VALIDATIONS RAPIDES ==========
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

    if (!toPhone && !merchantCode) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.missing_phone_or_code', lang),
        statusCode: 400,
      });
    }

    // ========== RÉCUPÉRATIONS PARALLÈLES ==========
    const [fromWallet, toUser] = await Promise.all([
      this.prisma.wallet.findFirst({
        where: { id: fromWalletId, isActive: true },
        include: { user: true },
      }),
      toPhone
        ? this.prisma.user.findFirst({
          where: { phone: toPhone },
          select: {
            id: true,
            full_name: true,
            phone: true,
            account_number: true,
            role: true,
            merchantCode: true,
          },
        })
        : this.prisma.user.findFirst({
          where: { merchantCode },
          select: {
            id: true,
            full_name: true,
            phone: true,
            account_number: true,
            role: true,
            merchantCode: true,
          },
        }),
    ]);

    // ========== VALIDATIONS ==========
    if (!fromWallet) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.wallet_not_found', lang),
        statusCode: 404,
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

    // ========== VÉRIFICATION DU PIN ==========
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

        // ✅ Logique de blocage automatique (comme le login)
        if (newAttempts >= 10) {
          // 🔒 Blocage de 30 minutes (se débloque automatiquement)
          lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
          newStatus = user_status.SUSPENDED; // ✅ Utiliser SUSPENDED au lieu de BLOCKED
        } else if (newAttempts >= 5) {
          // ⚠️ Avertissement à partir de 5 tentatives (pas de blocage)
          lockedUntil = null;
          newStatus = user_status.ACTIVE;
        }

        await this.prisma.user.update({
          where: { id: fromUser.id },
          data: {
            failed_pin_attempts: newAttempts,
            status: newStatus,
            pin_locked_until: lockedUntil, // ✅ Ajouter le verrouillage PIN
          },
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

        // ✅ Message personnalisé selon le nombre de tentatives
        let errorMessage: string;
        if (newAttempts >= 10) {
          errorMessage = this.i18nService.translate('wallet.pin_locked_auto', lang, {
            minutes: 30,
          });
        } else if (newAttempts >= 5) {
          const remaining = 10 - newAttempts;
          errorMessage = this.i18nService.translate('wallet.pin_incorrect_warning', lang, {
            attempts: remaining,
          });
        } else {
          const remaining = 5 - newAttempts;
          errorMessage = this.i18nService.translate('wallet.pin_incorrect', lang, {
            attempts: remaining,
          });
        }

        throw new RpcException({
          status: 'error',
          message: errorMessage,
          statusCode: 401,
        });
      }

      // ✅ Succès : réinitialiser les tentatives
      await this.prisma.user.update({
        where: { id: fromUser.id },
        data: {
          failed_pin_attempts: 0,
          pin_locked_until: null,
          status: user_status.ACTIVE,
        },
      });
    }

    // ========== RÉCUPÉRER OU CRÉER LE WALLET DU COMMERÇANT ==========
    let merchantWallet = await this.prisma.wallet.findFirst({
      where: { userId: toUser.id, currency: fromWallet.currency, isActive: true },
    });

    if (!merchantWallet) {
      merchantWallet = await this.prisma.wallet.create({
        data: {
          id: crypto.randomUUID(),
          userId: toUser.id,
          currency: fromWallet.currency,
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

    // ========== APPLIQUER LES FRAIS ==========
    const targetPhone = toUser.phone;
    const { fee, debitAmount, creditAmount } = await this.applyInternationalFeeIfNeeded(targetPhone || '', amount);

    if (fromWallet.balance < debitAmount) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.insufficient_wallet_balance', lang),
        statusCode: 400,
      });
    }

    // ========== EXÉCUTER LA TRANSACTION ==========
    const result = await this.prisma.$transaction(async (tx) => {
      // Mettre à jour les soldes
      const [updatedUser, updatedMerchant] = await Promise.all([
        tx.wallet.update({
          where: { id: fromWallet.id },
          data: { balance: { decrement: debitAmount }, updatedAt: new Date() },
        }),
        tx.wallet.update({
          where: { id: merchantWallet.id },
          data: { balance: { increment: creditAmount }, updatedAt: new Date() },
        }),
      ]);

      // Construire les descriptions
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
        payerDescription += ` (frais internationaux 1%: ${fee} ${fromWallet.currency})`;
      }

      if (!merchantDescription) {
        const template = this.i18nService.translate('wallet.transaction_description_payment_received', lang);
        merchantDescription = template
          .replace('{phone}', fromUser.phone || '');
      } else {
        const payerInfo = fromUser.full_name
          ? `${fromUser.full_name} (${fromUser.phone})`
          : fromUser.phone;
        const fromText = this.i18nService.translate('wallet.from', lang);
        merchantDescription = `${merchantDescription} (${fromText}: ${payerInfo})`;
      }

      // Créer les transactions
      const reference = await this.generateTransactionReference('', tx);
      const [payerTx, merchantTx] = await Promise.all([
        tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: fromUser.id,
            walletId: fromWallet.id,
            amount: debitAmount,
            type: 'PAYMENT',
            status: 'SUCCESS',
            reference: reference,
            description: payerDescription,
            movement: 'DEBIT',
            currency: fromWallet.currency,
            paymentMethod: 'MOBILE_MONEY',
          },
        }),
        tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: toUser.id,
            walletId: merchantWallet.id,
            amount: creditAmount,
            type: 'PAYMENT',
            status: 'SUCCESS',
            reference: reference,
            description: merchantDescription,
            movement: 'CREDIT',
            currency: merchantWallet.currency,
            paymentMethod: 'MOBILE_MONEY',
          },
        }),
      ]);

      // Audit log
      await tx.audit_log.create({
        data: {
          id: crypto.randomUUID(),
          userId: fromUser.id,
          action: 'PAYMENT',
          details: JSON.stringify({
            amount: debitAmount,
            merchant: toUser.full_name,
            merchantCode: toUser.merchantCode,
          }),
          ipAddress: ipAddress || null,
          createdAt: new Date(),
        },
      });

      return {
        fromUser,
        toUser,
        fromWallet: updatedUser,
        merchantWallet: updatedMerchant,
        payerTx,
        merchantTx,
      };
    }, { timeout: 30000 });

    // ========== SMS ET NOTIFICATIONS ==========
    // try {
    //   // ✅ 1. Envoyer les SMS (comme dans send)
    //   if (result.fromUser.phone) {
    //     try {
    //       const cleanPhone = result.fromUser.phone.replace(/[^0-9+]/g, '');
    //       const smsText = this.i18nService.translate('wallet.payment_payer_sms', lang, {
    //         full_name: result.fromUser.full_name || '',
    //         amount: amount,
    //         currency: result.fromWallet.currency || 'CDF',
    //         merchantName: result.toUser.full_name || '',
    //         balance: result.fromWallet.balance || 0,
    //       });
    //       await this.smsService.sendSms(cleanPhone, smsText);
    //       console.log('[Pay] ✅ SMS envoyé au payeur');
    //     } catch (err) {
    //       console.error('[Pay] Erreur envoi SMS au payeur:', err);
    //     }
    //   }

    //   if (result.toUser.phone) {
    //     try {
    //       const cleanPhone = result.toUser.phone.replace(/[^0-9+]/g, '');
    //       const smsText = this.i18nService.translate('wallet.payment_merchant_sms', lang, {
    //         full_name: result.toUser.full_name || '',
    //         amount: amount,
    //         currency: result.merchantWallet.currency || 'CDF',
    //         payerName: result.fromUser.full_name || '',
    //         balance: result.merchantWallet.balance || 0,
    //       });
    //       await this.smsService.sendSms(cleanPhone, smsText);
    //       console.log('[Pay] ✅ SMS envoyé au commerçant');
    //     } catch (err) {
    //       console.error('[Pay] Erreur envoi SMS au commerçant:', err);
    //     }
    //   }

    //   // ✅ 2. Envoyer les notifications push (comme dans send)
    //   await Promise.all([
    //     notifyTransaction(
    //       this.smsService,
    //       this.notificationHelper,
    //       this.i18nService,
    //       this.shouldSendSms.bind(this),
    //       this.shouldSendPush.bind(this),
    //       this.getUserLanguage.bind(this),
    //       result.payerTx,
    //       result.fromUser,
    //       result.fromWallet,
    //       'pay_sent',
    //       {
    //         name: result.toUser.full_name ?? undefined,
    //         phone: result.toUser.phone ?? undefined,
    //       },
    //     ),
    //     notifyTransaction(
    //       this.smsService,
    //       this.notificationHelper,
    //       this.i18nService,
    //       this.shouldSendSms.bind(this),
    //       this.shouldSendPush.bind(this),
    //       this.getUserLanguage.bind(this),
    //       result.merchantTx,
    //       result.toUser,
    //       result.merchantWallet,
    //       'pay_received',
    //       {
    //         name: result.fromUser.full_name ?? undefined,
    //         phone: result.fromUser.phone ?? undefined,
    //       },
    //     ),
    //   ]);
    //   console.log('[Pay] ✅ Notifications push envoyées');
    // } catch (err) {
    //   console.error('[Notifications] Pay notification error:', err);
    // }

    return {
      message: this.i18nService.translate('wallet.payment_success', lang, {
        amount: amount.toFixed(2),
        currency: result.fromWallet.currency || 'CDF',
        merchantName: result.toUser.full_name || 'Commerçant',
        balance: result.fromWallet.balance.toFixed(2),
        reference: result.payerTx.reference || 'N/A',
        fee: fee.toFixed(2),
        creditAmount: creditAmount.toFixed(2),
      }),
      data: {
        wallet: this.toResponse(result.fromWallet),
        transaction: result.payerTx,
      },
    };
  }


  async payWithoutPin(
    dto: PayDto,
    lang: string = 'fr',
    ipAddress: string,
  ): Promise<ApiResponse<{ wallet: WalletResponseDto; transaction: any }>> {
    const { fromWalletId, toPhone, merchantCode, amount, description } = dto;
    console.log('[WalletService] PayWithoutPin request:', { fromWalletId, toPhone, merchantCode, amount, lang });

    // ========== VALIDATIONS RAPIDES ==========
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

    if (!toPhone && !merchantCode) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.missing_phone_or_code', lang),
        statusCode: 400,
      });
    }

    // ========== RÉCUPÉRATIONS PARALLÈLES ==========
    const [fromWallet, toUser] = await Promise.all([
      this.prisma.wallet.findFirst({
        where: { id: fromWalletId, isActive: true },
        include: { user: true },
      }),
      toPhone
        ? this.prisma.user.findFirst({
          where: { phone: toPhone },
          select: {
            id: true,
            full_name: true,
            phone: true,
            account_number: true,
            role: true,
            merchantCode: true,
          },
        })
        : this.prisma.user.findFirst({
          where: { merchantCode },
          select: {
            id: true,
            full_name: true,
            phone: true,
            account_number: true,
            role: true,
            merchantCode: true,
          },
        }),
    ]);

    // ========== VALIDATIONS ==========
    if (!fromWallet) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.wallet_not_found', lang),
        statusCode: 404,
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

    // ========== PAS DE VÉRIFICATION DE PIN ==========

    // ========== RÉCUPÉRER OU CRÉER LE WALLET DU COMMERÇANT ==========
    let merchantWallet = await this.prisma.wallet.findFirst({
      where: { userId: toUser.id, currency: fromWallet.currency, isActive: true },
    });

    if (!merchantWallet) {
      merchantWallet = await this.prisma.wallet.create({
        data: {
          id: crypto.randomUUID(),
          userId: toUser.id,
          currency: fromWallet.currency,
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

    // ========== APPLIQUER LES FRAIS ==========
    const targetPhone = toUser.phone;
    const { fee, debitAmount, creditAmount } = await this.applyInternationalFeeIfNeeded(targetPhone || '', amount);

    if (fromWallet.balance < debitAmount) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.insufficient_wallet_balance', lang),
        statusCode: 400,
      });
    }

    // ========== EXÉCUTER LA TRANSACTION ==========
    const result = await this.prisma.$transaction(async (tx) => {
      // Mettre à jour les soldes
      const [updatedUser, updatedMerchant] = await Promise.all([
        tx.wallet.update({
          where: { id: fromWallet.id },
          data: { balance: { decrement: debitAmount }, updatedAt: new Date() },
        }),
        tx.wallet.update({
          where: { id: merchantWallet.id },
          data: { balance: { increment: creditAmount }, updatedAt: new Date() },
        }),
      ]);

      // Construire les descriptions
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
        payerDescription += ` (frais internationaux 1%: ${fee} ${fromWallet.currency})`;
      }

      if (!merchantDescription) {
        const template = this.i18nService.translate('wallet.transaction_description_payment_received', lang);
        merchantDescription = template
          .replace('{phone}', fromUser.phone || '');
      } else {
        const payerInfo = fromUser.full_name
          ? `${fromUser.full_name} (${fromUser.phone})`
          : fromUser.phone;
        const fromText = this.i18nService.translate('wallet.from', lang);
        merchantDescription = `${merchantDescription} (${fromText}: ${payerInfo})`;
      }

      // Créer les transactions
      const reference = await this.generateTransactionReference('', tx);
      const [payerTx, merchantTx] = await Promise.all([
        tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: fromUser.id,
            walletId: fromWallet.id,
            amount: debitAmount,
            type: 'PAYMENT',
            status: 'SUCCESS',
            reference: reference,
            description: payerDescription,
            movement: 'DEBIT',
            currency: fromWallet.currency,
            paymentMethod: 'MOBILE_MONEY',
          },
        }),
        tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: toUser.id,
            walletId: merchantWallet.id,
            amount: creditAmount,
            type: 'PAYMENT',
            status: 'SUCCESS',
            reference: reference,
            description: merchantDescription,
            movement: 'CREDIT',
            currency: merchantWallet.currency,
            paymentMethod: 'MOBILE_MONEY',
          },
        }),
      ]);

      // Audit log
      await tx.audit_log.create({
        data: {
          id: crypto.randomUUID(),
          userId: fromUser.id,
          action: 'PAYMENT_WITHOUT_PIN',
          details: JSON.stringify({
            amount: debitAmount,
            merchant: toUser.full_name,
            merchantCode: toUser.merchantCode,
            note: 'Paiement effectué sans PIN (OAuth)',
          }),
          ipAddress: ipAddress || null,
          createdAt: new Date(),
        },
      });

      return {
        fromUser,
        toUser,
        fromWallet: updatedUser,
        merchantWallet: updatedMerchant,
        payerTx,
        merchantTx,
      };
    }, { timeout: 30000 });

    return {
      message: this.i18nService.translate('wallet.payment_success', lang, {
        amount: amount.toFixed(2),
        currency: result.fromWallet.currency || 'CDF',
        merchantName: result.toUser.full_name || 'Commerçant',
        balance: result.fromWallet.balance.toFixed(2),
        reference: result.payerTx.reference || 'N/A',
        fee: fee.toFixed(2),
        creditAmount: creditAmount.toFixed(2),
      }),
      data: {
        wallet: this.toResponse(result.fromWallet),
        transaction: result.payerTx,
      },
    };
  }
  private async getExchangeRateViaPivot(
    fromCurrency: string,
    toCurrency: string,
    tx: any,
  ): Promise<number> {
    if (fromCurrency === toCurrency) {
      return 1;
    }

    // Cas USD vers autre devise
    if (fromCurrency === 'USD') {
      const rate = await tx.exchange_rate.findFirst({
        where: {
          from_currency: 'USD',
          to_currency: toCurrency,
        },
      });
      if (rate) {
        console.log(`[ExchangeRate] USD → ${toCurrency}: ${rate.rate}`);
        return rate.rate;
      }
      throw new Error(`Taux de change USD → ${toCurrency} non trouvé`);
    }

    // Cas autre devise vers USD
    if (toCurrency === 'USD') {
      const rate = await tx.exchange_rate.findFirst({
        where: {
          from_currency: fromCurrency,
          to_currency: 'USD',
        },
      });
      if (rate) {
        console.log(`[ExchangeRate] ${fromCurrency} → USD: ${rate.rate}`);
        return rate.rate;
      }
      const inverseRate = await tx.exchange_rate.findFirst({
        where: {
          from_currency: 'USD',
          to_currency: fromCurrency,
        },
      });
      if (inverseRate && inverseRate.rate > 0) {
        const result = 1 / inverseRate.rate;
        console.log(`[ExchangeRate] ${fromCurrency} → USD (via inverse): ${result}`);
        return result;
      }
      throw new Error(`Taux de change ${fromCurrency} → USD non trouvé`);
    }

    // ✅ Cas général : passer par USD comme pivot
    let rateFromToUsd: number | null = null;
    const fromToUsd = await tx.exchange_rate.findFirst({
      where: {
        from_currency: fromCurrency,
        to_currency: 'USD',
      },
    });
    if (fromToUsd) {
      rateFromToUsd = fromToUsd.rate;
    } else {
      const usdToFrom = await tx.exchange_rate.findFirst({
        where: {
          from_currency: 'USD',
          to_currency: fromCurrency,
        },
      });
      if (usdToFrom && usdToFrom.rate > 0) {
        rateFromToUsd = 1 / usdToFrom.rate;
      }
    }

    if (!rateFromToUsd) {
      throw new Error(`Taux de change ${fromCurrency} → USD non trouvé`);
    }

    let rateUsdToTarget: number | null = null;
    const usdToTarget = await tx.exchange_rate.findFirst({
      where: {
        from_currency: 'USD',
        to_currency: toCurrency,
      },
    });
    if (usdToTarget) {
      rateUsdToTarget = usdToTarget.rate;
    } else {
      const targetToUsd = await tx.exchange_rate.findFirst({
        where: {
          from_currency: toCurrency,
          to_currency: 'USD',
        },
      });
      if (targetToUsd && targetToUsd.rate > 0) {
        rateUsdToTarget = 1 / targetToUsd.rate;
      }
    }

    if (!rateUsdToTarget) {
      throw new Error(`Taux de change USD → ${toCurrency} non trouvé`);
    }

    const finalRate = rateFromToUsd * rateUsdToTarget;
    console.log(`[ExchangeRate] ${fromCurrency} → ${toCurrency} (via USD): ${finalRate} (${rateFromToUsd} × ${rateUsdToTarget})`);
    return finalRate;
  }

  async sendFidelity(
    dto: SendFidelityDto,
    lang: string = 'fr',
    ipAddress: string = 'system',
  ): Promise<ApiResponse<{ wallet: WalletResponseDto; transaction: any }>> {
    const { fromWalletId, toPhone, amount, description, countryCode } = dto;
    console.log('[WalletService] Send Fidelity request:', { fromWalletId, toPhone, amount, lang, countryCode });

    // ========== VALIDATIONS ==========
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

    if (!toPhone || toPhone.trim() === '') {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.phone_required', lang),
        statusCode: 400,
      });
    }

    const cleanToPhone = toPhone.replace(/[^0-9+]/g, '');
    console.log('[WalletService] Clean phone:', cleanToPhone);

    const result = await this.prisma.$transaction(
      async (tx) => {
        // 1. Vérifier que le destinataire existe
        const toUser = await tx.user.findFirst({
          where: {
            phone: {
              in: [cleanToPhone, toPhone, `+${cleanToPhone.replace(/^\+/, '')}`]
            }
          },
          select: {
            id: true,
            full_name: true,
            phone: true,
            account_number: true,
            countryCode: true,
          },
        });

        if (!toUser) {
          console.error('[WalletService] ❌ Destinataire non trouvé:', cleanToPhone);
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.receiver_not_found', lang, {
              phone: toPhone,
            }),
            statusCode: 404,
          });
        }

        console.log('[WalletService] ✅ Destinataire trouvé:', {
          id: toUser.id,
          name: toUser.full_name,
          phone: toUser.phone,
          countryCode: toUser.countryCode,
        });

        // 2. Récupérer le wallet source
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
                countryCode: true,
                kycStatus: true,
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

        if (fromUser.id === toUser.id) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.cannot_transfer_self', lang),
            statusCode: 400,
          });
        }

        // 3. Déterminer les pays
        const senderCountryCode = fromUser.countryCode || 'CD';
        let receiverCountryCode = toUser.countryCode || 'CD';

        if (countryCode) {
          receiverCountryCode = countryCode.toUpperCase();
          console.log('[WalletService] 📌 CountryCode fourni:', countryCode);
        }

        const isInternational = senderCountryCode !== receiverCountryCode;

        console.log('[WalletService] Transfer type:', {
          senderCountry: senderCountryCode,
          receiverCountry: receiverCountryCode,
          isInternational,
          fromCurrency: fromWallet.currency,
          countryCodeProvided: countryCode || 'Non fourni',
        });

        // ✅ VÉRIFICATION KYC POUR LES TRANSFERTS INTERNATIONAUX
        if (isInternational) {
          const kycStatus = fromUser.kycStatus || 'NOT_SUBMITTED';

          if (kycStatus !== 'VERIFIED') {
            console.error('[WalletService] ❌ KYC non vérifié pour transfert international:', {
              userId: fromUser.id,
              kycStatus: kycStatus,
            });

            let errorMessage = '';
            switch (kycStatus) {
              case 'NOT_SUBMITTED':
                errorMessage = this.i18nService.translate('wallet.kyc_required_for_international_transfer', lang);
                break;
              case 'PENDING':
                errorMessage = this.i18nService.translate('wallet.kyc_pending_for_international_transfer', lang);
                break;
              case 'REJECTED':
                errorMessage = this.i18nService.translate('wallet.kyc_rejected_for_international_transfer', lang);
                break;
              default:
                errorMessage = this.i18nService.translate('wallet.kyc_required_for_international_transfer', lang);
            }

            throw new RpcException({
              status: 'error',
              message: errorMessage,
              statusCode: 403,
            });
          }

          console.log('[WalletService] ✅ KYC vérifié pour transfert international');
        }

        // 4. Récupérer les frais internationaux
        let internationalFeePercentage = 0;
        let fee = 0;
        let debitAmount = amount;
        let netAmount = amount;
        let feeCurrency = fromWallet.currency;

        if (isInternational) {
          const senderCountry = await tx.country_provider.findFirst({
            where: {
              OR: [
                { countryCode: senderCountryCode },
                { code: senderCountryCode },
              ]
            },
            select: {
              international_transfer_fee: true,
              cash_percentage: true,
              momo_percentage: true,
              deposit_fee: true,
              withdrawal_fee: true,
              maintenance_fee: true,
            },
          });

          if (!senderCountry) {
            console.error('[WalletService] ❌ Pays expéditeur non trouvé:', senderCountryCode);
            throw new RpcException({
              status: 'error',
              message: `Pays expéditeur ${senderCountryCode} non trouvé`,
              statusCode: 404,
            });
          }

          internationalFeePercentage = senderCountry.international_transfer_fee ||
            senderCountry.cash_percentage ||
            senderCountry.momo_percentage ||
            0;

          console.log('[WalletService] Frais du pays expéditeur:', {
            senderCountryCode,
            international_transfer_fee: senderCountry.international_transfer_fee,
            cash_percentage: senderCountry.cash_percentage,
            momo_percentage: senderCountry.momo_percentage,
            internationalFeePercentage,
          });

          if (internationalFeePercentage > 0) {
            const percentageDecimal = internationalFeePercentage / 100;
            netAmount = amount / (1 + percentageDecimal);
            fee = amount - netAmount;
            debitAmount = amount;
            feeCurrency = fromWallet.currency;

            console.log('[WalletService] Frais internationaux appliqués:', {
              percentage: internationalFeePercentage,
              brutAmount: amount,
              netAmount,
              fee,
              debitAmount,
              feeCurrency,
              senderCountry: senderCountryCode,
            });
          } else {
            console.log('[WalletService] Aucun frais international configuré pour', senderCountryCode);
            netAmount = amount;
            fee = 0;
            debitAmount = amount;
          }
        } else {
          console.log('[WalletService] ✅ Même pays - Pas de frais');
          internationalFeePercentage = 0;
          fee = 0;
          debitAmount = amount;
          netAmount = amount;
        }

        console.log('[WalletService] Fee calculation:', {
          isInternational,
          amount,
          feePercentage: internationalFeePercentage,
          fee,
          debitAmount,
          netAmount,
          senderCountryCode,
        });

        // 5. Récupérer les wallets du destinataire
        const receiverWallets = await tx.wallet.findMany({
          where: {
            userId: toUser.id,
            isActive: true,
          },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            currency: true,
            balance: true,
          },
        });

        if (!receiverWallets || receiverWallets.length === 0) {
          throw new RpcException({
            status: 'error',
            message: 'Le destinataire ne possède aucun wallet actif',
            statusCode: 404,
          });
        }

        console.log('[WalletService] Wallets du destinataire:', receiverWallets.map(w => w.currency));

        // ✅ La devise du paiement est la devise du wallet source (fromWallet.currency)
        const paymentCurrency = fromWallet.currency;

        console.log('[WalletService] Devise du paiement:', paymentCurrency);

        // ✅ Chercher un wallet du destinataire dans la même devise que le paiement
        let targetWallet = receiverWallets.find(w => w.currency === paymentCurrency);

        // ✅ Si pas de wallet dans cette devise, prendre le premier wallet disponible
        if (!targetWallet) {
          targetWallet = receiverWallets[0];
          console.log(`[WalletService] ⚠️ Aucun wallet en ${paymentCurrency}, utilisation du premier wallet: ${targetWallet.currency}`);
        } else {
          console.log(`[WalletService] ✅ Wallet en ${paymentCurrency} trouvé pour le destinataire`);
        }

        console.log('[WalletService] Wallet cible du destinataire:', {
          id: targetWallet.id,
          currency: targetWallet.currency,
          balance: targetWallet.balance,
        });

        // 6. Calculer le taux de change
        let exchangeRate = 1;
        let convertedAmount = netAmount;

        if (fromWallet.currency !== targetWallet.currency) {
          exchangeRate = await this.getExchangeRateViaPivot(
            fromWallet.currency,
            targetWallet.currency,
            tx,
          );
          convertedAmount = netAmount * exchangeRate;
          console.log('[WalletService] Conversion du montant:', {
            from: fromWallet.currency,
            to: targetWallet.currency,
            netAmount,
            rate: exchangeRate,
            convertedAmount,
          });
        }

        // 7. Vérifier le solde
        if (fromWallet.balance < debitAmount) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.insufficient_wallet_balance', lang),
            statusCode: 400,
          });
        }

        // 8. Mettre à jour les soldes
        const updatedFrom = await tx.wallet.update({
          where: { id: fromWallet.id },
          data: { balance: { decrement: debitAmount }, updatedAt: new Date() },
        });

        let updatedTo: any = null;
        if (!isInternational) {
          updatedTo = await tx.wallet.update({
            where: { id: targetWallet.id },
            data: { balance: { increment: convertedAmount }, updatedAt: new Date() },
          });
          console.log('[WalletService] ✅ Transfert national - Destinataire crédité immédiatement');
        } else {
          console.log('[WalletService] 🌍 Transfert international - Destinataire en attente de validation');
          updatedTo = targetWallet;
        }

        // 8.5 COLLECTER LES FRAIS DANS LE WALLET SYSTÈME
        let systemTransaction: any = null;
        let systemWallet: any = null;
        let systemUser: any = null;

        const feeAmount = fee || 0;

        console.log('[WalletService] 🔍 DEBUG - Fee collection:', {
          feeAmount,
          feeCurrency,
          fromWalletCurrency: fromWallet.currency,
          targetCurrency: targetWallet.currency,
          exchangeRate,
          netAmount,
          convertedAmount,
          amount,
          isInternational,
          internationalFeePercentage,
          senderCountryCode,
        });

        if (feeAmount > 0 && isInternational) {
          try {
            systemUser = await tx.user.findFirst({
              where: {
                email: 'system@fpay.com',
              },
              select: {
                id: true,
                full_name: true,
                email: true,
              },
            });

            if (!systemUser) {
              console.error('[WalletService] ❌ Utilisateur système non trouvé (system@fpay.com)');
              throw new RpcException({
                status: 'error',
                message: 'Utilisateur système non trouvé',
                statusCode: 500,
              });
            }

            systemWallet = await tx.wallet.findFirst({
              where: {
                userId: systemUser.id,
                currency: feeCurrency,
                isActive: true,
              },
            });

            if (!systemWallet) {
              console.error(`[WalletService] ❌ Wallet système non trouvé pour ${feeCurrency}`);
              throw new RpcException({
                status: 'error',
                message: `Wallet système non trouvé pour la devise ${feeCurrency}`,
                statusCode: 500,
              });
            }

            console.log('[WalletService] 🔍 DEBUG - System wallet found:', {
              systemWalletId: systemWallet.id,
              systemWalletCurrency: systemWallet.currency,
              systemWalletBalance: systemWallet.balance,
              feeAmountToCredit: feeAmount,
            });

            if (systemWallet && systemWallet.id) {
              const updatedSystemWallet = await tx.wallet.update({
                where: { id: systemWallet.id },
                data: {
                  balance: { increment: feeAmount },
                  updatedAt: new Date()
                },
              });

              console.log('[WalletService] 🔍 DEBUG - System wallet updated:', {
                balanceBefore: systemWallet.balance,
                balanceAfter: updatedSystemWallet.balance,
                feeAmount: feeAmount,
                currency: feeCurrency,
              });

              const feeReference = await this.generateTransactionReference('', tx);
              const reference = await this.generateTransactionReference('', tx);

              systemTransaction = await tx.transaction.create({
                data: {
                  id: crypto.randomUUID(),
                  userId: systemUser.id,
                  walletId: systemWallet.id,
                  amount: feeAmount,
                  type: 'DEPOSIT',
                  status: 'SUCCESS',
                  reference: feeReference,
                  description: `Frais de transfert international (${internationalFeePercentage}%) - ${fromUser.full_name || fromUser.id} → ${toUser.full_name || toUser.id} | Brut: ${amount} ${feeCurrency} | Net: ${netAmount} ${feeCurrency} | Taux: 1 ${feeCurrency} = ${exchangeRate} ${targetWallet.currency} | Pays: ${senderCountryCode}`,
                  movement: 'CREDIT',
                  currency: feeCurrency,
                  paymentMethod: 'MOBILE_MONEY',
                  external_reference: reference,
                },
              });

              console.log(`[WalletService] ✅ Frais collectés: ${feeAmount} ${feeCurrency} (${internationalFeePercentage}%) dans le wallet système (${systemWallet.id})`);
            }
          } catch (err) {
            console.error('[WalletService] ❌ Erreur lors de la collecte des frais:', err);
            if (err instanceof RpcException) {
              throw err;
            }
            console.warn('[WalletService] ⚠️ La collecte des frais a échoué mais le transfert continue');
          }
        }

        // 9. Construire les descriptions
        let senderDescription = description;
        let receiverDescription = description;

        const toUserDisplay = toUser.full_name ? `${toUser.full_name} (${toUser.phone})` : toUser.phone;
        const fromUserDisplay = fromUser.full_name ? `${fromUser.full_name} (${fromUser.phone})` : fromUser.phone;

        if (!senderDescription) {
          senderDescription = `Frais de fidélité vers ${toUserDisplay}`;
        } else {
          senderDescription = `${senderDescription} (vers: ${toUserDisplay})`;
        }

        if (feeAmount > 0) {
          senderDescription += ` (frais ${internationalFeePercentage}%: ${feeAmount} ${fromWallet.currency})`;
        }

        if (isInternational && fromWallet.currency !== targetWallet.currency) {
          senderDescription += ` - Taux: 1 ${fromWallet.currency} = ${exchangeRate} ${targetWallet.currency}`;
          if (countryCode) {
            senderDescription += ` - Pays: ${countryCode}`;
          }
        }

        if (!receiverDescription) {
          receiverDescription = `Frais de fidélité reçu de ${fromUserDisplay}`;
        } else {
          receiverDescription = `${description} (de: ${fromUserDisplay})`;
        }

        if (isInternational && fromWallet.currency !== targetWallet.currency) {
          receiverDescription += ` - Taux: 1 ${fromWallet.currency} = ${exchangeRate} ${targetWallet.currency}`;
          if (countryCode) {
            receiverDescription += ` - Pays: ${countryCode}`;
          }
        }

        // 10. Créer les transactions
        const reference = await this.generateTransactionReference('', tx);

        const transactionStatus = isInternational ? 'PENDING' : 'SUCCESS';

        console.log('[WalletService] Transaction status:', {
          isInternational,
          transactionStatus,
          senderStatus: 'SUCCESS',
          receiverStatus: transactionStatus,
        });

        const senderTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: fromUser.id,
            walletId: fromWallet.id,
            amount: debitAmount,
            type: 'TRANSFER',
            status: 'SUCCESS',
            reference: reference,
            description: senderDescription,
            movement: 'DEBIT',
            currency: fromWallet.currency,
            paymentMethod: 'MOBILE_MONEY',
          },
        });

        const receiverTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: toUser.id,
            walletId: targetWallet.id,
            amount: convertedAmount,
            type: 'DEPOSIT',
            status: transactionStatus,
            reference: reference,
            description: receiverDescription,
            movement: 'CREDIT',
            currency: targetWallet.currency,
            paymentMethod: 'MOBILE_MONEY',
          },
        });

        await this.logAudit(toUser.id, 'send_fidelity', updatedTo, ipAddress || null);

        return {
          fromWallet: updatedFrom,
          toWallet: updatedTo,
          fromUser,
          toUser,
          senderTx,
          receiverTx,
          isInternational,
          exchangeRate,
          convertedAmount,
          targetCurrency: targetWallet.currency,
          fee: feeAmount,
          internationalFeePercentage,
          debitAmount,
          netAmount,
          receiverCountryCode,
          senderCountryCode,
          systemTransaction: systemTransaction ?? null,
          systemWallet: systemWallet ?? null,
          systemUser: systemUser ?? null,
        };
      },
      { timeout: 60000, maxWait: 60000 },
    );

    // ========== NOTIFICATIONS ==========
    try {
      if (!result.isInternational) {
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
      } else {
        await notifyTransaction(
          this.smsService,
          this.notificationHelper,
          this.i18nService,
          this.shouldSendSms.bind(this),
          this.shouldSendPush.bind(this),
          this.getUserLanguage.bind(this),
          result.senderTx,
          result.fromUser,
          result.fromWallet,
          'send_pending',
          {
            name: result.toUser.full_name ?? undefined,
            phone: result.toUser.phone ?? undefined,
          },
        );
        console.log('[WalletService] 🌍 Transfert international en attente - Pas de notification au destinataire');
      }
    } catch (err) {
      console.error('[Notifications] Send fidelity notification error:', err);
    }

    return {
      message: this.i18nService.translate(
        result.isInternational ? 'wallet.transfer_international_pending' : 'wallet.transfer_success',
        lang,
        {
          amount: result.convertedAmount,
          currency: result.targetCurrency,
          rate: result.exchangeRate,
          fee: result.fee,
          feePercentage: result.internationalFeePercentage,
          debitAmount: result.debitAmount,
          netAmount: result.netAmount,
          fromCurrency: result.fromWallet.currency,
          countryCode: result.receiverCountryCode,
        }
      ),
      data: {
        wallet: this.toResponse(result.fromWallet),
        transaction: result.senderTx,
      },
    };
  }

  async validateInternationalTransfer(
    transactionId: string,
    adminId: string,
    adminPin: string,
    status: 'SUCCESS' | 'FAILED' | 'CANCELLED',
    lang: string = 'fr',
    ipAddress?: string,
  ): Promise<ApiResponse<{ transaction: any; fromWallet: WalletResponseDto; toWallet: WalletResponseDto }>> {
    console.log('[WalletService] Validate international transfer:', { transactionId, adminId, status, lang });

    // 1️⃣ Vérifier l'admin
    const admin = await this.prisma.user.findFirst({
      where: { id: adminId, role: { in: ['ADMIN', 'SUPER_ADMIN'] } },
      select: {
        id: true,
        full_name: true,
        pin: true,
        status: true,
        failed_pin_attempts: true,
        pin_locked_until: true,
        branchId: true,
        role: true,
      },
    });

    if (!admin) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('admin.not_found', lang),
        statusCode: 404,
      });
    }

    const isSuperAdmin = admin.role === 'SUPER_ADMIN';

    if (!admin.branchId && !isSuperAdmin) {
      throw new RpcException({
        status: 'error',
        message: 'L\'admin n\'est pas associé à une agence',
        statusCode: 400,
      });
    }

    // 2️⃣ Vérifier le PIN de l'admin
    if (!admin.pin) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('admin.no_pin_set', lang),
        statusCode: 400,
      });
    }

    if (admin.pin_locked_until && admin.pin_locked_until > new Date()) {
      const minutesLeft = Math.ceil(
        (admin.pin_locked_until.getTime() - Date.now()) / 60000,
      );
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('admin.pin_locked', lang).replace('{minutes}', minutesLeft.toString()),
        statusCode: 403,
      });
    }

    const hashedPin = crypto.createHash('sha256').update(adminPin).digest('hex');
    if (admin.pin !== hashedPin) {
      const newAttempts = (admin.failed_pin_attempts || 0) + 1;
      let newStatus = admin.status;
      let lockedUntil: Date | null = null;
      if (newAttempts >= 10) {
        newStatus = user_status.BLOCKED;
        lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
      }
      await this.prisma.user.update({
        where: { id: admin.id },
        data: {
          failed_pin_attempts: newAttempts,
          status: newStatus,
          pin_locked_until: lockedUntil
        },
      });
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('admin.pin_incorrect', lang),
        statusCode: 401,
      });
    }

    await this.prisma.user.update({
      where: { id: admin.id },
      data: { failed_pin_attempts: 0, pin_locked_until: null },
    });

    // 3️⃣ Récupérer la transaction expéditeur (PENDING)
    const transaction = await this.prisma.transaction.findFirst({
      where: {
        id: transactionId,
        status: 'PENDING',
      },
      include: {
        user: {
          select: {
            id: true,
            full_name: true,
            phone: true,
            countryCode: true,
          },
        },
        wallet: true,
      },
    });

    if (!transaction) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.transaction_not_found', lang),
        statusCode: 404,
      });
    }

    // 4️⃣ Vérifier que c'est un transfert international
    if (transaction.type !== 'TRANSFER' || transaction.movement !== 'DEBIT') {
      throw new RpcException({
        status: 'error',
        message: 'Cette transaction n\'est pas un transfert sortant',
        statusCode: 400,
      });
    }

    8// 5️⃣ Extraire les informations du destinataire depuis external_reference
    let receiverData: any;
    try {
      // ✅ Vérifier que external_reference n'est pas null
      if (!transaction.external_reference) {
        throw new RpcException({
          status: 'error',
          message: 'Données de la transaction manquantes',
          statusCode: 400,
        });
      }
      receiverData = JSON.parse(transaction.external_reference);
    } catch (e) {
      throw new RpcException({
        status: 'error',
        message: 'Données de la transaction corrompues',
        statusCode: 400,
      });
    }

    // ✅ AFFICHER LES DONNÉES RÉCUPÉRÉES
    console.log('[validateInternationalTransfer] 📦 Données récupérées de external_reference:', {
      receiverUserId: receiverData.receiverUserId,
      receiverWalletId: receiverData.receiverWalletId,
      receiverAmount: receiverData.receiverAmount,
      receiverCurrency: receiverData.receiverCurrency,
      receiverPhone: receiverData.receiverPhone,
      receiverName: receiverData.receiverName,
      isInternational: receiverData.isInternational,
      originalAmount: receiverData.originalAmount,
      fee: receiverData.fee,
      netAmount: receiverData.netAmount,
      finalAmount: receiverData.finalAmount,
      exchangeRate: receiverData.exchangeRate,
    });

    // 6️⃣ Récupérer les informations
    const fromUser = transaction.user;
    const fromWallet = transaction.wallet;

    // 7️⃣ Récupérer le wallet du destinataire
    const toWallet = await this.prisma.wallet.findFirst({
      where: {
        id: receiverData.receiverWalletId,
        isActive: true,
      },
      include: {
        user: {
          select: {
            id: true,
            full_name: true,
            phone: true,
            countryCode: true,
          },
        },
      },
    });

    if (!toWallet) {
      throw new RpcException({
        status: 'error',
        message: `Wallet du destinataire non trouvé (ID: ${receiverData.receiverWalletId})`,
        statusCode: 404,
      });
    }

    const toUser = toWallet.user;

    const senderCountryCode = fromUser.countryCode || 'CD';
    const receiverCountryCode = toUser.countryCode || 'CD';

    // 8️⃣ VÉRIFIER LE SOLDE DE L'EXPÉDITEUR (si validation)
    if (status === 'SUCCESS') {
      const currentBalance = fromWallet.balance;
      if (currentBalance < transaction.amount) {
        throw new RpcException({
          status: 'error',
          message: `Solde insuffisant. Disponible: ${currentBalance} ${transaction.currency}, Demandé: ${transaction.amount} ${transaction.currency}`,
          statusCode: 400,
        });
      }
      console.log(`[validateInternationalTransfer] ✅ Solde suffisant: ${currentBalance} ${transaction.currency}`);
    }

    // 9️⃣ RECALCULER LES FRAIS INTERNATIONAUX
    let internationalFeePercentage = 0;
    let withdrawalFeePercentage = 0;
    let fee = 0;
    let debitAmount = transaction.amount;
    let netAmount = transaction.amount;
    let finalAmount = transaction.amount;
    let feeCurrency: string = transaction.currency || 'CDF';
    let selectedReceiverNetwork: any = null;

    // ✅ Récupérer les frais du pays expéditeur
    const senderCountry = await this.prisma.country_provider.findFirst({
      where: {
        OR: [
          { countryCode: senderCountryCode },
          { code: senderCountryCode },
        ]
      },
      select: {
        international_transfer_fee: true,
        cash_percentage: true,
        momo_percentage: true,
      },
    });

    if (!senderCountry) {
      throw new RpcException({
        status: 'error',
        message: `Pays expéditeur ${senderCountryCode} non trouvé`,
        statusCode: 404,
      });
    }

    // ✅ Récupérer les networks du pays destinataire
    const receiverNetworks = await this.prisma.network_provider.findMany({
      where: {
        country_provider: {
          OR: [
            { countryCode: receiverCountryCode },
            { code: receiverCountryCode },
          ],
        },
      },
    });

    if (receiverNetworks.length > 0) {
      selectedReceiverNetwork = receiverNetworks[0];
      for (const network of receiverNetworks) {
        if (network.pourcentage_payout && network.pourcentage_payout > (selectedReceiverNetwork.pourcentage_payout || 0)) {
          selectedReceiverNetwork = network;
        }
      }
    }

    // ✅ Pourcentage international
    internationalFeePercentage = senderCountry.international_transfer_fee ||
      senderCountry.cash_percentage ||
      senderCountry.momo_percentage ||
      0;

    // ✅ Frais de retrait du destinataire
    if (selectedReceiverNetwork && selectedReceiverNetwork.pourcentage_payout) {
      withdrawalFeePercentage = selectedReceiverNetwork.pourcentage_payout;
    } else {
      withdrawalFeePercentage = 0;
    }

    // ✅ CALCUL DES FRAIS
    if (internationalFeePercentage > 0) {
      const percentageDecimal = internationalFeePercentage / 100;

      netAmount = transaction.amount / (1 + percentageDecimal);
      fee = transaction.amount - netAmount;
      debitAmount = transaction.amount;
      const withdrawalDecimal = withdrawalFeePercentage / 100;
      finalAmount = netAmount + (netAmount * withdrawalDecimal);
      feeCurrency = transaction.currency || 'CDF';
    } else {
      netAmount = transaction.amount;
      fee = 0;
      debitAmount = transaction.amount;
      finalAmount = transaction.amount;
      feeCurrency = transaction.currency || 'CDF';
    }

    // 🔟 CONVERTIR LE MONTANT FINAL
    const sourceCurrency = transaction.currency || 'USD';
    const targetCurrency = receiverData.receiverCurrency || toWallet.currency || 'CDF';
    let exchangeRate = receiverData.exchangeRate || 1;
    let convertedAmount = receiverData.receiverAmount || (finalAmount * exchangeRate);

    // ✅ Vérifier si le taux de change a changé
    if (sourceCurrency !== targetCurrency) {
      const rateRecord = await this.prisma.exchange_rate.findFirst({
        where: {
          from_currency: sourceCurrency,
          to_currency: targetCurrency,
        },
      });

      if (rateRecord && rateRecord.rate !== exchangeRate) {
        console.log(`[validateInternationalTransfer] ⚠️ Taux de change mis à jour: ${exchangeRate} → ${rateRecord.rate}`);
        exchangeRate = rateRecord.rate;
        convertedAmount = finalAmount * exchangeRate;
      } else if (!rateRecord) {
        console.warn(`[validateInternationalTransfer] ⚠️ Taux de change non trouvé pour ${sourceCurrency} → ${targetCurrency}, utilisation du taux stocké: ${exchangeRate}`);
      }
    }

    convertedAmount = Math.round(convertedAmount * 100) / 100;

    console.log('[validateInternationalTransfer] 📊 Données de validation:', {
      fromUser: fromUser.id,
      fromWallet: fromWallet.id,
      toUser: toUser.id,
      toWallet: toWallet.id,
      transactionAmount: transaction.amount,
      transactionCurrency: transaction.currency,
      sourceCurrency: sourceCurrency,
      targetCurrency: targetCurrency,
      receiverAmount: receiverData.receiverAmount,
      finalAmount: finalAmount,
      exchangeRate: exchangeRate,
      convertedAmount: convertedAmount,
      fee: fee,
      netAmount: netAmount,
      internationalFeePercentage: internationalFeePercentage,
      withdrawalFeePercentage: withdrawalFeePercentage,
    });

    // 1️⃣1️⃣ Valider ou Rejeter la transaction
    const result = await this.prisma.$transaction(async (tx) => {
      let updatedFromWallet: any;
      let updatedToWallet: any;
      let updatedSender: any;
      let createdReceiver: any;
      let systemTransaction: any = null;

      if (status === 'SUCCESS') {
        // ✅ VALIDATION

        // 1️⃣1a. DÉBITER LE WALLET DE L'EXPÉDITEUR
        updatedFromWallet = await tx.wallet.update({
          where: { id: fromWallet.id },
          data: {
            balance: { decrement: debitAmount },
            updatedAt: new Date(),
          },
        });

        // 1️⃣1b. CRÉDITER LE WALLET DU DESTINATAIRE
        updatedToWallet = await tx.wallet.update({
          where: { id: toWallet.id },
          data: {
            balance: { increment: convertedAmount },
            updatedAt: new Date(),
          },
        });

        // 1️⃣1c. Mettre à jour la transaction expéditeur
        updatedSender = await tx.transaction.update({
          where: { id: transaction.id },
          data: {
            status: 'SUCCESS',
            updatedAt: new Date(),
            description: transaction.description + ` (Validé par admin - Frais: ${fee} ${sourceCurrency}, Taux: 1 ${sourceCurrency} = ${exchangeRate} ${targetCurrency})`,
          },
        });

        // 1️⃣1d. CRÉER LA TRANSACTION DESTINATAIRE
        createdReceiver = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: toUser.id,
            walletId: toWallet.id,
            amount: convertedAmount,
            type: 'DEPOSIT',
            status: 'SUCCESS',
            reference: transaction.reference,
            currency: targetCurrency,
            description: `Reçu de ${fromUser.full_name || fromUser.phone} - Transfert international validé - Frais: ${fee} ${sourceCurrency}, Taux: 1 ${sourceCurrency} = ${exchangeRate} ${targetCurrency}`,
            movement: 'CREDIT',
            branchId: toWallet.branchId ?? null,
            external_reference: JSON.stringify({
              senderTransactionId: transaction.id,
              validatedBy: adminId,
              validatedAt: new Date().toISOString(),
            }),
          },
        });

        // 1️⃣1e. COLLECTER LES FRAIS DANS LE WALLET SYSTÈME
        if (fee > 0) {
          try {
            const systemUser = await tx.user.findFirst({
              where: { email: 'system@fpay.com' },
              select: { id: true, full_name: true, email: true },
            });

            if (systemUser) {
              const feeCurrencyValue = feeCurrency || 'CDF';

              const systemWallet = await tx.wallet.findFirst({
                where: {
                  userId: systemUser.id,
                  currency: feeCurrencyValue as wallet_currency,
                  isActive: true,
                },
              });

              if (systemWallet) {
                await tx.wallet.update({
                  where: { id: systemWallet.id },
                  data: { balance: { increment: fee }, updatedAt: new Date() },
                });

                const feeReference = await this.generateTransactionReference('FEE', tx);
                systemTransaction = await tx.transaction.create({
                  data: {
                    id: crypto.randomUUID(),
                    userId: systemUser.id,
                    walletId: systemWallet.id,
                    amount: fee,
                    type: 'DEPOSIT',
                    status: 'SUCCESS',
                    reference: feeReference,
                    description: `Frais de transfert international (${internationalFeePercentage}%) - ${fromUser.full_name || fromUser.id} → ${toUser.full_name || toUser.id} | Brut: ${transaction.amount} ${sourceCurrency} | Net: ${netAmount} ${sourceCurrency} | Taux: 1 ${sourceCurrency} = ${exchangeRate} ${targetCurrency}`,
                    movement: 'CREDIT',
                    currency: feeCurrencyValue as wallet_currency,
                    paymentMethod: 'MOBILE_MONEY',
                    external_reference: JSON.stringify({
                      senderTransactionId: transaction.id,
                      receiverTransactionId: createdReceiver.id,
                    }),
                  },
                });

                console.log(`[validateInternationalTransfer] ✅ Frais collectés: ${fee} ${feeCurrency}`);
              }
            }
          } catch (err) {
            console.error('[validateInternationalTransfer] ❌ Erreur collecte frais:', err);
          }
        }
      } else {
        // ❌ REJET

        // 1️⃣1a. Mettre à jour la transaction expéditeur
        updatedSender = await tx.transaction.update({
          where: { id: transaction.id },
          data: {
            status: status === 'FAILED' ? 'FAILED' : 'CANCELLED',
            updatedAt: new Date(),
            description: transaction.description + ` (Rejeté par admin - Motif: ${status === 'FAILED' ? 'Échec' : 'Annulé'})`,
          },
        });

        // 1️⃣1b. NE PAS CRÉER la transaction destinataire
        // 1️⃣1c. Les wallets ne sont pas modifiés
        updatedFromWallet = fromWallet;
        updatedToWallet = toWallet;
        createdReceiver = null;

        console.log(`[validateInternationalTransfer] ❌ Transaction rejetée: ${status}`);
      }

      // 1️⃣1f. Audit log
      await tx.audit_log.create({
        data: {
          id: crypto.randomUUID(),
          userId: admin.id,
          action: status === 'SUCCESS' ? 'validateInternationalTransfer' : 'rejectInternationalTransfer',
          details: JSON.stringify({
            transactionId: transaction.id,
            reference: transaction.reference,
            amount: transaction.amount,
            currency: sourceCurrency,
            senderId: fromUser.id,
            receiverId: toUser.id,
            receiverWalletId: toWallet.id,
            targetCurrency: targetCurrency,
            fee: fee,
            netAmount: netAmount,
            finalAmount: finalAmount,
            convertedAmount: convertedAmount,
            exchangeRate: exchangeRate,
            internationalFeePercentage: internationalFeePercentage,
            withdrawalFeePercentage: withdrawalFeePercentage,
            previousStatus: transaction.status,
            newStatus: status,
            adminName: admin.full_name,
            branchId: admin.branchId,
            isSuperAdmin,
            systemTransactionId: systemTransaction?.id || null,
            reason: status === 'SUCCESS' ? 'Validé par admin' : status === 'FAILED' ? 'Échec' : 'Annulé par admin',
          }),
          ipAddress: ipAddress || null,
          createdAt: new Date(),
        },
      });

      return {
        senderTx: updatedSender,
        receiverTx: createdReceiver,
        fromWallet: updatedFromWallet,
        toWallet: updatedToWallet,
        systemTransaction: systemTransaction,
      };
    });

    // 1️⃣2️⃣ NOTIFICATIONS
    if (status === 'SUCCESS') {
      try {
        await notifyTransaction(
          this.smsService,
          this.notificationHelper,
          this.i18nService,
          this.shouldSendSms.bind(this),
          this.shouldSendPush.bind(this),
          this.getUserLanguage.bind(this),
          result.senderTx,
          fromUser,
          result.fromWallet,
          'send_confirmed',
          {
            name: toUser.full_name ?? undefined,
            phone: toUser.phone ?? undefined,
          },
        );
      } catch (err) {
        console.error('[Notifications] Error sending to sender:', err);
      }

      try {
        await notifyTransaction(
          this.smsService,
          this.notificationHelper,
          this.i18nService,
          this.shouldSendSms.bind(this),
          this.shouldSendPush.bind(this),
          this.getUserLanguage.bind(this),
          result.receiverTx,
          toUser,
          result.toWallet,
          'send_received',
          {
            name: fromUser.full_name ?? undefined,
            phone: fromUser.phone ?? undefined,
          },
        );
      } catch (err) {
        console.error('[Notifications] Error sending to receiver:', err);
      }
    } else {
      try {
        await notifyTransaction(
          this.smsService,
          this.notificationHelper,
          this.i18nService,
          this.shouldSendSms.bind(this),
          this.shouldSendPush.bind(this),
          this.getUserLanguage.bind(this),
          result.senderTx,
          fromUser,
          result.fromWallet,
          'send_rejected',
          {
            name: toUser.full_name ?? undefined,
            phone: toUser.phone ?? undefined,
          },
        );
      } catch (err) {
        console.error('[Notifications] Error sending rejection to sender:', err);
      }
    }

    return {
      message: status === 'SUCCESS'
        ? this.i18nService.translate('wallet.transfer_validated_success', lang)
        : this.i18nService.translate('wallet.transfer_rejected_success', lang),
      data: {
        transaction: result.senderTx,
        fromWallet: this.toResponse(result.fromWallet),
        toWallet: this.toResponse(result.toWallet),
      },
    };
  }

  async reconcileTransaction(
    transactionId: string,
    adminId: string,
    adminPin: string  // 👈 PIN de l'admin requis
  ): Promise<{
    updated: boolean;
    message: string;
    transaction?: any;
    wallet?: any;
  }> {
    console.log(`[Réconciliation] Transaction: ${transactionId}, Admin: ${adminId}`);

    // 1. Vérifier l'admin et son PIN
    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: {
        id: true,
        pin: true,
        status: true,
        failed_pin_attempts: true,
        pin_locked_until: true,
        role: true,
      },
    });

    if (!admin) {
      return { updated: false, message: 'Admin non trouvé' };
    }

    // Vérifier que c'est bien un admin
    if (admin.role !== 'ADMIN' && admin.role !== 'SUPER_ADMIN') {
      return { updated: false, message: 'Utilisateur non autorisé' };
    }

    // Vérifier si le PIN est bloqué
    if (admin.pin_locked_until && admin.pin_locked_until > new Date()) {
      const minutesLeft = Math.ceil(
        (admin.pin_locked_until.getTime() - Date.now()) / 60000
      );
      return {
        updated: false,
        message: `PIN bloqué pour ${minutesLeft} minute(s)`,
      };
    }

    // Vérifier le PIN
    const hashedPin = crypto.createHash('sha256').update(adminPin).digest('hex');
    if (admin.pin !== hashedPin) {
      const newAttempts = (admin.failed_pin_attempts || 0) + 1;
      let lockedUntil: Date | null = null;

      if (newAttempts >= 5) {
        lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
      }

      await this.prisma.user.update({
        where: { id: adminId },
        data: {
          failed_pin_attempts: newAttempts,
          pin_locked_until: lockedUntil,
        },
      });

      return {
        updated: false,
        message: `PIN incorrect. Il vous reste ${5 - newAttempts} tentative(s)`,
      };
    }

    // Réinitialiser les tentatives PIN
    await this.prisma.user.update({
      where: { id: adminId },
      data: {
        failed_pin_attempts: 0,
        pin_locked_until: null,
      },
    });

    // 2. Récupérer la transaction
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { wallet: true, user: true },
    });

    if (!transaction) {
      return { updated: false, message: 'Transaction non trouvée' };
    }

    if (transaction.status === 'SUCCESS') {
      return { updated: false, message: 'Transaction déjà en succès' };
    }

    // 3. FORCER la réconciliation par l'admin
    const result = await this.prisma.$transaction(async (tx) => {
      // Mettre à jour la transaction en SUCCESS
      const updated = await tx.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'SUCCESS',
          description: `${transaction.description} (Réconciliée par admin ${adminId})`,
          updatedAt: new Date(),
        },
      });

      // ✅ Ajuster le solde du wallet (pour les crédits)
      if (transaction.movement === 'CREDIT') {
        await tx.wallet.update({
          where: { id: transaction.walletId },
          data: {
            balance: { increment: transaction.amount },
            updatedAt: new Date(),
          },
        });
      }

      // Audit log
      await tx.audit_log.create({
        data: {
          id: crypto.randomUUID(),
          userId: transaction.userId,
          action: 'RECONCILIATION_MANUAL',
          details: JSON.stringify({
            transactionId: transaction.id,
            oldStatus: transaction.status,
            newStatus: 'SUCCESS',
            reconciledBy: adminId,
          }),
          ipAddress: 'system',
          createdAt: new Date(),
        },
      });

      // Historique
      await tx.reconciliation_history.create({
        data: {
          id: crypto.randomUUID(),
          transaction_id: transaction.id,
          user_id: transaction.userId,
          wallet_id: transaction.walletId,
          old_status: transaction.status,
          new_status: 'SUCCESS',
          reference: transaction.reference,
          amount: transaction.amount,
          currency: transaction.currency || 'CDF',
          movement: transaction.movement,
          reconciliation_type: 'MANUAL',
          reason: `Réconciliation forcée par l'admin ${adminId}`,
          metadata: JSON.stringify({ adminId }),
          reconciled_by: adminId,
          reconciled_at: new Date(),
        },
      });

      return { transaction: updated };
    });

    return {
      updated: true,
      message: `Transaction réconciliée avec succès par l'admin ${adminId}`,
      transaction: result.transaction,
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
        branchId: true,
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

  async getTransactionsByWalletId(
    walletId: string,
    page: number = 1,
    limit: number = 10,
    startDate?: Date,
    endDate?: Date,
    lang: string = 'fr',
  ) {
    console.log('[WalletService] Get transactions by walletId:', { walletId, page, limit, startDate, endDate, lang });

    // 1️⃣ Vérifier que le wallet existe
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
      include: { user: { select: { full_name: true, phone: true } } },
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

    // 2️⃣ Construire les filtres (exactement comme dans listTransactions)
    const skip = (page - 1) * limit;
    const where: any = { walletId };

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) {
        const endOfDay = new Date(endDate);
        endOfDay.setHours(23, 59, 59, 999);
        where.createdAt.lte = endOfDay;
      }
    }

    // 3️⃣ Exécuter les requêtes en parallèle (comme dans listTransactions)
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

    // 4️⃣ Enrichir les transactions (exactement comme dans listTransactions)
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

    // 5️⃣ Retourner la réponse (exactement comme dans listTransactions)
    return {
      message: this.i18nService.translate('wallet.transactions_retrieved', lang),
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

    // ========== TRANSACTION ==========
    const result = await this.prisma.$transaction(
      async (tx) => {
        // 1️⃣ Vérifier le PIN de l'admin
        const admin = await tx.user.findFirst({
          where: { id: adminId },
          select: {
            id: true,
            pin: true,
            status: true,
            role: true,
            failed_pin_attempts: true,
            pin_locked_until: true,
            full_name: true,
            phone: true,
            branchId: true,
          }
        });

        if (!admin) {
          throw new RpcException({
            status: 'error',
            message: 'Admin non trouvé',
            statusCode: 404,
          });
        }

        const isSuperAdmin = admin.role === 'SUPER_ADMIN';

        if (!admin.branchId && !isSuperAdmin) {
          throw new RpcException({
            status: 'error',
            message: 'L\'admin n\'est pas associé à une agence',
            statusCode: 400,
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
          if (newAttempts >= 10) {
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

        const wallet = await tx.wallet.findFirst({
          where: { id: walletId, isActive: true },
          include: { user: true }
        });

        if (!wallet) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_not_found', lang),
            statusCode: 404,
          });
        }

        const user = wallet.user;

        const updatedWallet = await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: amount }, updatedAt: new Date() },
        });

        let branchWallet: any = null;
        let branchId: string | null = null;

        if (isSuperAdmin) {
          if (wallet.branchId) {
            try {
              branchWallet = await this.getBranchCashWallet(wallet.branchId, wallet.currency);
              branchId = wallet.branchId;
            } catch (error) {
              console.log('[SuperAdmin] Pas de caisse trouvée pour la branche du client:', wallet.branchId);
            }
          } else {
            console.log('[SuperAdmin] Le client n\'a pas de branche, opération sans caisse');
          }
        } else {
          if (admin.branchId) {
            branchWallet = await this.getBranchCashWallet(admin.branchId, wallet.currency);
            branchId = admin.branchId;
          }
        }

        if (branchWallet) {
          await tx.wallet.update({
            where: { id: branchWallet.id },
            data: { balance: { increment: amount }, updatedAt: new Date() },
          });
        }

        const reference = await this.generateTransactionReference('', tx);
        const transaction = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: user.id,
            walletId: wallet.id,
            amount,
            type: 'DEPOSIT',
            status: 'SUCCESS',
            reference: reference,
            description: `Votre portefeuille a été rechargé avec succès auprès du guichet en espèces.`,
            movement: 'CREDIT',
            currency: wallet.currency,
            paymentMethod: this.mapPaymentMethod(dto.paymentMethod),
            branchId: branchId || admin.branchId,
          },
        });

        if (branchWallet) {
          const cashReference = await this.generateTransactionReference('CASH', tx);
          await tx.transaction.create({
            data: {
              id: crypto.randomUUID(),
              userId: branchWallet.userId,
              walletId: branchWallet.id,
              amount: amount,
              type: 'CASH_IN',
              status: 'SUCCESS',
              reference: cashReference,
              description: `Dépôt cash client ${user.full_name || user.id} - Réf: ${reference}`,
              movement: 'CREDIT',
              currency: wallet.currency,
              paymentMethod: 'CASH',
              branchId: branchId || admin.branchId,
              external_reference: reference,
            },
          });
        }

        await tx.audit_log.create({
          data: {
            id: crypto.randomUUID(),
            userId: admin.id,
            action: 'adminTopUp',
            details: JSON.stringify({
              transaction,
              targetUserId: user.id,
              branchId: branchId || admin.branchId,
              cashWalletId: branchWallet?.id || null,
              amount,
              currency: wallet.currency,
              isSuperAdmin,
            }),
            ipAddress: ipAddress || null,
            createdAt: new Date(),
          },
        });

        return {
          wallet: updatedWallet,
          transaction,
          user,
          admin,
          branchWallet,
          isSuperAdmin,
        };
      },
      {
        timeout: 30000,
        maxWait: 30000,
      }
    );

    // ✅ UN SEUL ENVOI DE SMS ET PUSH VIA notifyTransaction
    try {
      await notifyTransaction(
        this.smsService,
        this.notificationHelper,
        this.i18nService,
        this.shouldSendSms.bind(this),
        this.shouldSendPush.bind(this),
        this.getUserLanguage.bind(this),
        result.transaction,
        result.user,
        result.wallet,
        'topup',
      );
    } catch (err) {
      console.error('[Notifications] adminTopUp error:', err);
    }

    return {
      message: this.i18nService.translate('wallet.top_up_success', lang, {
        amount: amount,
        currency: result.wallet.currency || 'CDF',
        balance: result.wallet.balance || 0,
        reference: result.transaction.reference || 'N/A',
      }),
      data: {
        wallet: this.toResponse(result.wallet),
        transaction: result.transaction,
      },
    };
  }

  async adminCashout(
    dto: AdminCashoutDto,
  ): Promise<ApiResponse<{ wallet?: WalletResponseDto; transaction?: any; transactionId?: string; requiresOtp?: boolean; message: string }>> {
    const { adminId, walletId, amount, pin, otpCode, lang = 'fr', ipAddress, paymentMethod } = dto;
    console.log('[WalletService] Admin Cashout:', { adminId, walletId, amount, hasOtp: !!otpCode, hasAdminPin: !!pin, lang });

    // ========== VALIDATIONS COMMUNES ==========
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

    // ✅ Vérifier que l'admin existe
    const admin = await this.prisma.user.findFirst({
      where: { id: adminId },
      select: {
        id: true,
        full_name: true,
        phone: true,
        branchId: true,
        role: true,
        pin: true,
        status: true,
        failed_pin_attempts: true,
        pin_locked_until: true,
      }
    });

    if (!admin) {
      throw new RpcException({
        status: 'error',
        message: 'Admin non trouvé',
        statusCode: 404,
      });
    }

    // ✅ SUPER_ADMIN n'a pas besoin de branche
    const isSuperAdmin = admin.role === 'SUPER_ADMIN';

    // ✅ Vérifier que l'admin a une branche (sauf SUPER_ADMIN)
    if (!admin.branchId && !isSuperAdmin) {
      throw new RpcException({
        status: 'error',
        message: 'L\'admin n\'est pas associé à une agence',
        statusCode: 400,
      });
    }

    // ✅ Vérifier que le wallet existe et a assez de solde
    const wallet = await this.prisma.wallet.findFirst({
      where: { id: walletId, isActive: true },
      include: { user: true }
    });

    if (!wallet) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.wallet_not_found', lang),
        statusCode: 404,
      });
    }

    if (wallet.balance < amount) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.insufficient_wallet_balance', lang),
        statusCode: 400,
      });
    }

    // ✅ VÉRIFIER LE SOLDE DE CAISSE
    let branchWallet: any = null;
    let branchId: string | null = null;

    if (isSuperAdmin) {
      // ✅ SUPER_ADMIN: Utiliser la caisse de l'agence du client si elle existe
      if (wallet.branchId) {
        try {
          branchWallet = await this.getBranchCashWallet(wallet.branchId, wallet.currency);
          branchId = wallet.branchId;
        } catch (error) {
          console.log('[SuperAdmin] Pas de caisse trouvée pour la branche du client:', wallet.branchId);
        }
      } else {
        console.log('[SuperAdmin] Le client n\'a pas de branche, retrait sans vérification de caisse');
      }
    } else {
      // ✅ ADMIN normal: utiliser sa propre branche
      if (admin.branchId) {
        branchWallet = await this.getBranchCashWallet(admin.branchId, wallet.currency);
        branchId = admin.branchId;
      }
    }

    // Vérifier le solde de caisse (seulement si un wallet de caisse existe)
    if (branchWallet && branchWallet.balance < amount) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: branchId! }
      });

      throw new RpcException({
        status: 'error',
        message: `Solde de caisse insuffisant à l'agence ${branch?.name || branchId}. 
                Disponible: ${branchWallet.balance} ${wallet.currency}, Demandé: ${amount} ${wallet.currency}`,
        statusCode: 400,
      });
    }

    const user = wallet.user;

    // ========== ÉTAPE 1 : Demande de retrait (sans OTP) ==========
    if (!otpCode || otpCode.trim() === '') {
      if (!admin.pin) {
        throw new RpcException({
          status: 'error',
          message: 'L\'admin n\'a pas de PIN défini.',
          statusCode: 400,
        });
      }

      const reference = await this.generateTransactionReference();

      const newOtpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

      await this.prisma.otp.updateMany({
        where: {
          userId: user.id,
          isUsed: false,
          expiresAt: { gt: new Date() },
        },
        data: { isUsed: true },
      });

      await this.prisma.otp.create({
        data: {
          id: crypto.randomUUID(),
          userId: user.id,
          email: user.phone || user.email || '',
          otpCode: newOtpCode,
          expiresAt: otpExpiry,
          isUsed: false,
        },
      });

      // ✅ Créer la transaction en attente
      const pendingTransaction = await this.prisma.transaction.create({
        data: {
          id: crypto.randomUUID(),
          userId: user.id,
          walletId: wallet.id,
          amount,
          type: 'WITHDRAW',
          status: 'PENDING',
          reference: reference,
          description: `Retrait admin (en attente de OTP client) - ${isSuperAdmin ? 'Super Admin' : 'Agence ' + admin.branchId}`,
          movement: 'DEBIT',
          currency: wallet.currency,
          paymentMethod: this.mapPaymentMethod(paymentMethod),
          branchId: branchId || admin.branchId,
          external_reference: JSON.stringify({
            otpCode: newOtpCode,
            expiresAt: otpExpiry,
            adminId: adminId,
            attempts: 0,
            isSuperAdmin,
          }),
        },
      });

      try {
        const cleanPhone = user.phone?.replace(/[^0-9+]/g, '');
        if (cleanPhone) {
          const smsText = this.i18nService.translate('wallet.cashout_client_otp_request', lang, {
            full_name: user.full_name || '',
            amount: amount,
            currency: wallet.currency || 'CDF',
            otpCode: newOtpCode,
            merchant: admin.full_name || 'Admin',
          });
          await this.smsService.sendSms(cleanPhone, smsText);
          console.log(`[AdminCashout] SMS OTP envoyé au client ${cleanPhone}`);
        }
      } catch (err) {
        console.error('[AdminCashout] Erreur envoi SMS OTP:', err);
      }

      await this.logAudit(
        admin.id,
        'adminCashoutRequest',
        {
          walletId,
          amount,
          transactionId: pendingTransaction.id,
          userId: user.id,
          branchId: branchId || admin.branchId,
          isSuperAdmin,
        },
        ipAddress || null,
      );

      return {
        message: this.i18nService.translate('wallet.cashout_otp_sent_client', lang),
        data: {
          transactionId: pendingTransaction.id,
          requiresOtp: true,
          message: 'Un code OTP a été envoyé par SMS au client. Veuillez le saisir pour confirmer le retrait.',
        },
      };
    }

    // ========== ÉTAPE 2 : Confirmation avec OTP + PIN ADMIN ==========
    if (!pin || pin.trim() === '') {
      throw new RpcException({
        status: 'error',
        message: 'Le PIN de l\'admin est requis pour valider la transaction.',
        statusCode: 400,
      });
    }

    if (pin.length < 4) {
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

    if (admin.pin_locked_until && admin.pin_locked_until > new Date()) {
      const minutesLeft = Math.ceil(
        (admin.pin_locked_until.getTime() - Date.now()) / 60000,
      );
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.pin_locked', lang).replace('{minutes}', minutesLeft.toString()),
        statusCode: 404,
      });
    }

    const hashedAdminPin = crypto.createHash('sha256').update(pin).digest('hex');
    if (admin.pin !== hashedAdminPin) {
      const newAttempts = (admin.failed_pin_attempts || 0) + 1;
      let newStatus = admin.status;
      let lockedUntil: Date | null = null;
      if (newAttempts >= 5) {
        newStatus = user_status.BLOCKED;
        lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
      }
      await this.prisma.user.update({
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
        statusCode: 404,
      });
    }

    await this.prisma.user.update({
      where: { id: admin.id },
      data: { failed_pin_attempts: 0, pin_locked_until: null },
    });

    if (otpCode.length < 4) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.otp_min_length', lang),
        statusCode: 400,
      });
    }

    if (!/^\d+$/.test(otpCode)) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.otp_digits_only', lang),
        statusCode: 400,
      });
    }

    const otpRecord = await this.prisma.otp.findFirst({
      where: {
        userId: user.id,
        otpCode: otpCode,
        isUsed: false,
      },
    });

    if (!otpRecord) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.otp_invalid', lang),
        statusCode: 400,
      });
    }

    if (!otpRecord.expiresAt || new Date() > otpRecord.expiresAt) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.otp_expired', lang),
        statusCode: 400,
      });
    }

    const pendingTx = await this.prisma.transaction.findFirst({
      where: {
        userId: user.id,
        walletId: wallet.id,
        amount: amount,
        type: 'WITHDRAW',
        status: 'PENDING',
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!pendingTx) {
      throw new RpcException({
        status: 'error',
        message: 'Aucune transaction en attente trouvée. Veuillez faire une nouvelle demande.',
        statusCode: 404,
      });
    }

    let otpExpiryData: Date | null = null;
    if (pendingTx.external_reference) {
      try {
        const data = JSON.parse(pendingTx.external_reference);
        otpExpiryData = data.expiresAt ? new Date(data.expiresAt) : null;
      } catch (e) {
        console.error('Erreur parsing external_reference:', e);
      }
    }

    if (otpExpiryData && new Date() > otpExpiryData) {
      await this.prisma.transaction.update({
        where: { id: pendingTx.id },
        data: {
          status: 'CANCELLED',
          description: 'Retrait annulé - OTP expiré'
        },
      });
      await this.prisma.otp.update({
        where: { id: otpRecord.id },
        data: { isUsed: true },
      });
      throw new RpcException({
        status: 'error',
        message: 'L\'OTP a expiré. Veuillez refaire la demande.',
        statusCode: 400,
      });
    }

    const result = await this.prisma.$transaction(
      async (tx) => {
        const currentWallet = await tx.wallet.findFirst({
          where: { id: walletId, isActive: true },
          include: { user: true }
        });

        if (!currentWallet) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_not_found', lang),
            statusCode: 404,
          });
        }

        if (currentWallet.balance < amount) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.insufficient_wallet_balance', lang),
            statusCode: 400,
          });
        }

        // ✅ RÉCUPÉRER LA CAISSE
        let branchCashWallet: any = null;
        let cashBranchId: string | null = null;

        if (isSuperAdmin) {
          if (currentWallet.branchId) {
            try {
              branchCashWallet = await this.getBranchCashWallet(currentWallet.branchId, currentWallet.currency);
              cashBranchId = currentWallet.branchId;
            } catch (error) {
              console.log('[SuperAdmin] Pas de caisse trouvée pour la branche du client:', currentWallet.branchId);
            }
          }
        } else {
          if (admin.branchId) {
            branchCashWallet = await this.getBranchCashWallet(admin.branchId, currentWallet.currency);
            cashBranchId = admin.branchId;
          }
        }

        if (branchCashWallet && branchCashWallet.balance < amount) {
          throw new RpcException({
            status: 'error',
            message: `Solde de caisse insuffisant. Disponible: ${branchCashWallet.balance} ${currentWallet.currency}`,
            statusCode: 400,
          });
        }

        // 1️⃣ DÉBITER LE WALLET DU CLIENT
        const updatedWallet = await tx.wallet.update({
          where: { id: currentWallet.id },
          data: { balance: { decrement: amount }, updatedAt: new Date() },
        });

        // 2️⃣ DÉBITER LA CAISSE (si elle existe)
        if (branchCashWallet) {
          await tx.wallet.update({
            where: { id: branchCashWallet.id },
            data: { balance: { decrement: amount }, updatedAt: new Date() },
          });
        }

        // 3️⃣ METTRE À JOUR LA TRANSACTION DU CLIENT
        const transaction = await tx.transaction.update({
          where: { id: pendingTx.id },
          data: {
            status: 'SUCCESS',
            description: `Retrait admin confirmé par le client (OTP) et admin (PIN) - ${isSuperAdmin ? 'Super Admin' : 'Agence ' + admin.branchId}`,
            updatedAt: new Date(),
            branchId: cashBranchId || admin.branchId,
          },
        });

        // 4️⃣ CRÉER LA TRANSACTION DE CAISSE (CASH_OUT) si caisse existe
        if (branchCashWallet) {
          const cashReference = await this.generateTransactionReference('CASH', tx);
          await tx.transaction.create({
            data: {
              id: crypto.randomUUID(),
              userId: branchCashWallet.userId,
              walletId: branchCashWallet.id,
              amount: amount,
              type: 'CASH_OUT',
              status: 'SUCCESS',
              reference: cashReference,
              description: `Retrait cash client ${currentWallet.user.full_name || currentWallet.user.id} - Réf: ${transaction.reference}`,
              movement: 'DEBIT',
              currency: currentWallet.currency,
              paymentMethod: 'CASH',
              branchId: cashBranchId || admin.branchId,
              external_reference: transaction.id,
            },
          });
        }

        await tx.otp.update({
          where: { id: otpRecord.id },
          data: { isUsed: true },
        });

        await tx.audit_log.create({
          data: {
            id: crypto.randomUUID(),
            userId: admin.id,
            action: 'adminCashoutConfirm',
            details: JSON.stringify({
              transaction,
              targetUserId: user.id,
              otpVerified: true,
              adminPinVerified: true,
              branchId: cashBranchId || admin.branchId,
              cashWalletId: branchCashWallet?.id || null,
              amount,
              currency: currentWallet.currency,
              isSuperAdmin,
            }),
            ipAddress: ipAddress || null,
            createdAt: new Date(),
          },
        });

        return { wallet: updatedWallet, transaction, user };
      },
      {
        timeout: 30000,
        maxWait: 30000,
      }
    );

    // ========== NOTIFICATION PUSH ==========
    try {
      await notifyTransaction(
        this.smsService,
        this.notificationHelper,
        this.i18nService,
        this.shouldSendSms.bind(this),
        this.shouldSendPush.bind(this),
        this.getUserLanguage.bind(this),
        result.transaction,
        result.user,
        result.wallet,
        'cashout',
      );
    } catch (err) {
      console.error('[Notifications] adminCashout error:', err);
    }

    return {
      message: this.i18nService.translate('wallet.cashout_success', lang, {
        amount: amount,
        currency: result.wallet.currency || 'CDF',
        balance: result.wallet.balance || 0,
        reference: result.transaction.reference || 'N/A',
      }),
      data: {
        wallet: this.toResponse(result.wallet),
        transaction: result.transaction,
        message: this.i18nService.translate('wallet.cashout_success', lang),
      },
    };
  }

  async adminSend(
    dto: AdminSendDto,
  ): Promise<ApiResponse<{ fromWallet: WalletResponseDto; toWallet: WalletResponseDto; transaction: any }>> {
    const { adminId, fromWalletId, toPhone, amount, pin, description, lang = 'fr', ipAddress, countryCode, feeIncluded } = dto;
    console.log('[WalletService] Admin Send:', { adminId, fromWalletId, toPhone, amount, lang, countryCode, feeIncluded });

    // ========== VALIDATIONS ==========
    if (amount <= 0) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.amount_positive', lang),
        statusCode: 400,
      });
    }

    if (!fromWalletId || !toPhone) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.admin_send_from_wallet_required', lang),
        statusCode: 400,
      });
    }

    if (!adminId) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.admin_id_required', lang),
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

    const cleanToPhone = toPhone.replace(/[^0-9+]/g, '');
    console.log('[AdminSend] Clean phone:', cleanToPhone);

    const result = await this.prisma.$transaction(
      async (tx) => {
        // 1️⃣ Vérifier le PIN de l'admin
        const admin = await tx.user.findFirst({
          where: { id: adminId },
          select: {
            id: true,
            pin: true,
            status: true,
            role: true,
            failed_pin_attempts: true,
            pin_locked_until: true,
            full_name: true,
            phone: true,
            branchId: true,
          }
        });

        if (!admin) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('admin.not_found', lang),
            statusCode: 404,
          });
        }

        const isSuperAdmin = admin.role === 'SUPER_ADMIN';

        if (!admin.branchId && !isSuperAdmin) {
          throw new RpcException({
            status: 'error',
            message: 'L\'admin n\'est pas associé à une agence',
            statusCode: 400,
          });
        }

        if (!admin.pin) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('admin.no_pin_set', lang),
            statusCode: 400,
          });
        }

        if (admin.pin_locked_until && admin.pin_locked_until > new Date()) {
          const minutesLeft = Math.ceil(
            (admin.pin_locked_until.getTime() - Date.now()) / 60000,
          );
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('admin.pin_locked', lang).replace('{minutes}', minutesLeft.toString()),
            statusCode: 403,
          });
        }

        const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
        if (admin.pin !== hashedPin) {
          const newAttempts = (admin.failed_pin_attempts || 0) + 1;
          let newStatus = admin.status;
          let lockedUntil: Date | null = null;
          if (newAttempts >= 10) {
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
            message: this.i18nService.translate('admin.pin_incorrect', lang),
            statusCode: 401,
          });
        }

        await tx.user.update({
          where: { id: admin.id },
          data: { failed_pin_attempts: 0, pin_locked_until: null },
        });

        // 2️⃣ Récupérer le wallet source
        const fromWallet = await tx.wallet.findFirst({
          where: { id: fromWalletId, isActive: true },
          include: {
            user: {
              select: {
                id: true,
                full_name: true,
                phone: true,
                account_number: true,
                pin: true,
                status: true,
                countryCode: true,
                kycStatus: true,
                branchId: true
              }
            }
          }
        });

        if (!fromWallet) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_not_found', lang),
            statusCode: 404
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

        if (fromUser.status === user_status.BLOCKED) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('account_blocked_admin', lang),
            statusCode: 403,
          });
        }

        // 3️⃣ Récupérer le destinataire
        const toUser = await tx.user.findFirst({
          where: {
            phone: {
              in: [cleanToPhone, toPhone, `+${cleanToPhone.replace(/^\+/, '')}`]
            }
          },
          select: {
            id: true,
            full_name: true,
            phone: true,
            account_number: true,
            countryCode: true,
            branchId: true,
          },
        });

        if (!toUser) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.receiver_not_found', lang),
            statusCode: 404,
          });
        }

        if (fromUser.id === toUser.id) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.cannot_transfer_self', lang),
            statusCode: 400,
          });
        }

        // 4️⃣ Déterminer les pays
        const senderCountryCode = fromUser.countryCode || 'CD';
        let receiverCountryCode = toUser.countryCode || 'CD';

        if (countryCode) {
          receiverCountryCode = countryCode.toUpperCase();
        }

        const isInternational = senderCountryCode !== receiverCountryCode;

        if (isInternational) {
          const kycStatus = fromUser.kycStatus || 'NOT_SUBMITTED';

          if (kycStatus !== 'VERIFIED') {
            let errorMessage = '';
            switch (kycStatus) {
              case 'NOT_SUBMITTED':
                errorMessage = this.i18nService.translate('wallet.kyc_required_for_international_transfer', lang);
                break;
              case 'PENDING':
                errorMessage = this.i18nService.translate('wallet.kyc_pending_for_international_transfer', lang);
                break;
              case 'REJECTED':
                errorMessage = this.i18nService.translate('wallet.kyc_rejected_for_international_transfer', lang);
                break;
              default:
                errorMessage = this.i18nService.translate('wallet.kyc_required_for_international_transfer', lang);
            }
            throw new RpcException({
              status: 'error',
              message: errorMessage,
              statusCode: 403,
            });
          }
        }

        // ============================================
        // 5. CALCUL DES FRAIS DE RETRAIT (fee_config)
        // ============================================
        let withdrawalFee = 0;
        let withdrawalFeeCurrency = fromWallet.currency as wallet_currency;
        let feeConfigUsed: any = null;
        let debitAmount = amount;

        // ✅ Si c'est international et que feeIncluded = true
        if (isInternational && feeIncluded === true) {
          const receiverCountry = await tx.country_provider.findFirst({
            where: {
              OR: [
                { countryCode: receiverCountryCode },
                { code: receiverCountryCode },
              ]
            },
            select: {
              id: true,
              code: true,
              countryCode: true,
              default_currency: true,
            },
          });

          if (receiverCountry) {
            try {
              const feeConfigs = await (tx as any).fee_config.findMany({
                where: {
                  countryId: receiverCountry.id,
                  isActive: true,
                  paymentMethod: 'MOBILE_MONEY',
                },
                orderBy: {
                  minAmount: 'asc',
                },
              });

              console.log('[AdminSend] 📊 Fee configs trouvées:', feeConfigs?.length || 0);

              if (feeConfigs && feeConfigs.length > 0) {
                let amountInLocalCurrency = amount;
                const localCurrency = receiverCountry.default_currency || 'XOF';

                if (fromWallet.currency !== localCurrency) {
                  const rate = await this.getExchangeRateViaPivot(fromWallet.currency, localCurrency, tx);
                  amountInLocalCurrency = amount * rate;
                }

                for (const config of feeConfigs) {
                  const minAmount = config.minAmount ? Number(config.minAmount) : 0;
                  const maxAmount = config.maxAmount ? Number(config.maxAmount) : Infinity;

                  if (amountInLocalCurrency >= minAmount && amountInLocalCurrency <= maxAmount) {
                    withdrawalFee = config.feeAmount ? Number(config.feeAmount) : 0;
                    withdrawalFeeCurrency = localCurrency as wallet_currency;
                    feeConfigUsed = config;
                    break;
                  }
                }

                if (withdrawalFee === 0 && feeConfigs.length > 0) {
                  const defaultConfig = feeConfigs[0];
                  withdrawalFee = defaultConfig.feeAmount ? Number(defaultConfig.feeAmount) : 0;
                  withdrawalFeeCurrency = localCurrency as wallet_currency;
                  feeConfigUsed = defaultConfig;
                }
              }
            } catch (error) {
              console.warn('[AdminSend] ⚠️ Erreur récupération frais fee_config:', error.message);
            }

            if (withdrawalFee > 0 && feeIncluded === true) {
              let feeInWalletCurrency = withdrawalFee;
              if (withdrawalFeeCurrency !== fromWallet.currency) {
                const rate = await this.getExchangeRateViaPivot(withdrawalFeeCurrency, fromWallet.currency, tx);
                feeInWalletCurrency = withdrawalFee * rate;
              }
              debitAmount = amount + feeInWalletCurrency;
              console.log('[AdminSend] 💰 Frais inclus:', {
                originalAmount: amount,
                fee: feeInWalletCurrency,
                total: debitAmount,
                feeCurrency: withdrawalFeeCurrency,
              });
            }
          }
        }

        // ============================================
        // 6. CALCUL DES FRAIS INTERNATIONAUX EXISTANTS
        // ============================================
        let internationalFeePercentage = 0;
        let withdrawalFeePercentage = 0;
        let fee = 0;
        let netAmount = amount;
        let finalAmount = amount;
        let feeCurrency = fromWallet.currency;
        let selectedReceiverNetwork: any = null;

        if (isInternational) {
          const senderCountry = await tx.country_provider.findFirst({
            where: {
              OR: [
                { countryCode: senderCountryCode },
                { code: senderCountryCode },
              ]
            },
            select: {
              international_transfer_fee: true,
              cash_percentage: true,
              momo_percentage: true,
            },
          });

          if (!senderCountry) {
            console.error('[AdminSend] ❌ Pays expéditeur non trouvé:', senderCountryCode);
            throw new RpcException({
              status: 'error',
              message: `Pays expéditeur ${senderCountryCode} non trouvé`,
              statusCode: 404,
            });
          }

          const receiverNetworks = await tx.network_provider.findMany({
            where: {
              country_provider: {
                OR: [
                  { countryCode: receiverCountryCode },
                  { code: receiverCountryCode },
                ],
              },
            },
          });

          if (receiverNetworks.length > 0) {
            selectedReceiverNetwork = receiverNetworks[0];
            for (const network of receiverNetworks) {
              if (network.pourcentage_payout && network.pourcentage_payout > (selectedReceiverNetwork.pourcentage_payout || 0)) {
                selectedReceiverNetwork = network;
              }
            }
          }

          internationalFeePercentage = senderCountry.international_transfer_fee ||
            senderCountry.cash_percentage ||
            senderCountry.momo_percentage ||
            0;

          if (selectedReceiverNetwork && selectedReceiverNetwork.pourcentage_payout) {
            withdrawalFeePercentage = selectedReceiverNetwork.pourcentage_payout;
          } else {
            withdrawalFeePercentage = 0;
          }

          if (internationalFeePercentage > 0) {
            const percentageDecimal = internationalFeePercentage / 100;
            netAmount = amount / (1 + percentageDecimal);
            fee = amount - netAmount;
            const withdrawalDecimal = withdrawalFeePercentage / 100;
            finalAmount = netAmount + (netAmount * withdrawalDecimal);
            feeCurrency = fromWallet.currency;
          } else {
            netAmount = amount;
            fee = 0;
            finalAmount = amount;
          }
        } else {
          internationalFeePercentage = 0;
          withdrawalFeePercentage = 0;
          fee = 0;
          netAmount = amount;
          finalAmount = amount;
        }

        // 7. Récupérer les wallets du destinataire
        const receiverWallets = await tx.wallet.findMany({
          where: {
            userId: toUser.id,
            isActive: true,
          },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            currency: true,
            balance: true,
          },
        });

        if (!receiverWallets || receiverWallets.length === 0) {
          throw new RpcException({
            status: 'error',
            message: 'Le destinataire ne possède aucun wallet actif',
            statusCode: 404,
          });
        }

        let targetCurrency: string = receiverWallets[0].currency;
        let targetWallet: any = receiverWallets[0];

        if (isInternational) {
          const receiverCountry = await tx.country_provider.findFirst({
            where: {
              OR: [
                { countryCode: receiverCountryCode },
                { code: receiverCountryCode },
              ]
            },
            select: {
              default_currency: true,
              country_currency: {
                where: { is_default: true },
                take: 1,
                select: { currency_code: true },
              }
            },
          });

          let preferredCurrency: string | null = null;
          if (receiverCountry?.default_currency) {
            preferredCurrency = receiverCountry.default_currency;
          } else if (receiverCountry?.country_currency && receiverCountry.country_currency.length > 0) {
            preferredCurrency = receiverCountry.country_currency[0].currency_code;
          }

          if (preferredCurrency) {
            const foundWallet = receiverWallets.find(w => w.currency === preferredCurrency);
            if (foundWallet) {
              targetWallet = foundWallet;
              targetCurrency = preferredCurrency;
            }
          }

          if (!targetWallet || targetWallet.currency !== targetCurrency) {
            targetWallet = receiverWallets[0];
            targetCurrency = targetWallet.currency;
          }
        } else {
          targetWallet = receiverWallets[0];
          targetCurrency = targetWallet.currency;
        }

        // 8. Calculer le taux de change
        let exchangeRate = 1;
        let convertedAmount = finalAmount;

        if (fromWallet.currency !== targetCurrency) {
          exchangeRate = await this.getExchangeRateViaPivot(
            fromWallet.currency,
            targetCurrency,
            tx,
          );
          convertedAmount = finalAmount * exchangeRate;
        }

        // 9. Vérifier le solde
        if (fromWallet.balance < debitAmount) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.insufficient_wallet_balance', lang),
            statusCode: 400
          });
        }

        // 10. Mettre à jour les soldes
        let updatedFrom: any = fromWallet;
        let updatedTo: any = null;

        if (!isInternational) {
          updatedFrom = await tx.wallet.update({
            where: { id: fromWallet.id },
            data: { balance: { decrement: debitAmount }, updatedAt: new Date() },
          });

          updatedTo = await tx.wallet.update({
            where: { id: targetWallet.id },
            data: { balance: { increment: convertedAmount }, updatedAt: new Date() },
          });
          console.log('[AdminSend] ✅ Transfert national - Expéditeur débité, destinataire crédité');
        } else {
          updatedTo = targetWallet;
          console.log('[AdminSend] 🌍 Transfert international - Balance non modifiée, en attente de validation');
        }

        // 11. COLLECTER LES FRAIS
        let systemTransaction: any = null;
        const totalFee = fee + withdrawalFee;

        if (totalFee > 0 && !isInternational) {
          try {
            const systemUser = await tx.user.findFirst({
              where: { email: 'system@fpay.com' },
              select: { id: true, full_name: true, email: true },
            });

            if (systemUser) {
              const systemWallet = await tx.wallet.findFirst({
                where: {
                  userId: systemUser.id,
                  currency: feeCurrency,
                  isActive: true,
                },
              });

              if (systemWallet) {
                await tx.wallet.update({
                  where: { id: systemWallet.id },
                  data: { balance: { increment: totalFee }, updatedAt: new Date() },
                });

                const feeReference = await this.generateTransactionReference('FEE', tx);
                systemTransaction = await tx.transaction.create({
                  data: {
                    id: crypto.randomUUID(),
                    userId: systemUser.id,
                    walletId: systemWallet.id,
                    amount: totalFee,
                    type: 'DEPOSIT',
                    status: 'SUCCESS',
                    reference: feeReference,
                    description: `Frais de transfert (${internationalFeePercentage}%)${feeConfigUsed ? ` + frais retrait (${feeConfigUsed.description})` : ''} - ${fromUser.full_name || fromUser.id} → ${toUser.full_name || toUser.id}`,
                    movement: 'CREDIT',
                    currency: feeCurrency,
                    paymentMethod: 'MOBILE_MONEY',
                  },
                });
              }
            }
          } catch (err) {
            console.error('[AdminSend] ❌ Erreur collecte frais:', err);
          }
        }

        // 12. Construire les descriptions
        const toUserDisplay = toUser.full_name ? `${toUser.full_name} (${toUser.phone})` : toUser.phone;
        const fromUserDisplay = fromUser.full_name ? `${fromUser.full_name} (${fromUser.phone})` : fromUser.phone;

        let senderDescription = description || `Transfert vers ${toUserDisplay}`;
        if (totalFee > 0) {
          senderDescription += ` (frais: ${totalFee} ${feeCurrency})`;
        }
        if (isInternational && fromWallet.currency !== targetCurrency) {
          senderDescription += ` - Taux: 1 ${fromWallet.currency} = ${exchangeRate} ${targetCurrency}`;
        }

        let receiverDescription = description || `Reçu de ${fromUserDisplay}`;
        if (isInternational && fromWallet.currency !== targetCurrency) {
          receiverDescription += ` - Taux: 1 ${fromWallet.currency} = ${exchangeRate} ${targetCurrency}`;
        }

        // 13. Créer les transactions
        const reference = await this.generateTransactionReference('', tx);

        const senderTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: fromUser.id,
            walletId: fromWallet.id,
            amount: debitAmount,
            type: 'TRANSFER',
            status: isInternational ? 'PENDING' : 'SUCCESS',
            reference: reference,
            currency: fromWallet.currency,
            description: senderDescription,
            paymentMethod: this.mapPaymentMethod(dto.paymentMethod),
            movement: 'DEBIT',
            branchId: admin.branchId ?? null,
            external_reference: isInternational ? JSON.stringify({
              receiverUserId: toUser.id,
              receiverWalletId: targetWallet.id,
              receiverAmount: convertedAmount,
              receiverCurrency: targetCurrency,
              receiverPhone: toUser.phone,
              receiverName: toUser.full_name,
              isInternational: true,
              originalAmount: amount,
              fee: totalFee,
              netAmount: netAmount,
              finalAmount: finalAmount,
              exchangeRate: exchangeRate,
              feeConfig: feeConfigUsed ? {
                id: feeConfigUsed.id,
                minAmount: Number(feeConfigUsed.minAmount),
                maxAmount: Number(feeConfigUsed.maxAmount),
                feeAmount: Number(feeConfigUsed.feeAmount),
                description: feeConfigUsed.description,
              } : null,
            }) : null,
          },
        });

        let receiverTx: any = null;
        if (!isInternational) {
          receiverTx = await tx.transaction.create({
            data: {
              id: crypto.randomUUID(),
              userId: toUser.id,
              walletId: targetWallet.id,
              amount: convertedAmount,
              type: 'DEPOSIT',
              status: 'SUCCESS',
              reference: reference,
              currency: targetCurrency,
              description: receiverDescription,
              movement: 'CREDIT',
              branchId: toUser.branchId ?? null,
            },
          });
          console.log('[AdminSend] ✅ Transfert national - Transaction destinataire créée');
        } else {
          console.log('[AdminSend] 🌍 Transfert international - Transaction destinataire NON créée, en attente de validation');
        }

        await tx.audit_log.create({
          data: {
            id: crypto.randomUUID(),
            userId: admin.id,
            action: 'adminSend',
            details: JSON.stringify({
              from: updatedFrom,
              to: updatedTo,
              toPhone,
              isInternational,
              fee: totalFee,
              internationalFeePercentage,
              withdrawalFeePercentage,
              withdrawalFee: withdrawalFee,
              withdrawalFeeCurrency: withdrawalFeeCurrency,
              feeIncluded: feeIncluded || false,
              netAmount,
              finalAmount,
              feeConfigUsed: feeConfigUsed ? {
                id: feeConfigUsed.id,
                minAmount: Number(feeConfigUsed.minAmount),
                maxAmount: Number(feeConfigUsed.maxAmount),
                feeAmount: Number(feeConfigUsed.feeAmount),
                description: feeConfigUsed.description,
              } : null,
            }),
            ipAddress: ipAddress || null,
            createdAt: new Date(),
          },
        });

        return {
          fromWallet: updatedFrom,
          toWallet: updatedTo,
          fromUser,
          toUser,
          senderTx,
          receiverTx,
          isInternational,
          exchangeRate,
          convertedAmount,
          targetCurrency,
          fee: totalFee,
          internationalFeePercentage,
          withdrawalFeePercentage,
          withdrawalFee: withdrawalFee,
          withdrawalFeeCurrency: withdrawalFeeCurrency,
          feeConfigUsed: feeConfigUsed,
          feeIncluded: feeIncluded || false,
          debitAmount,
          netAmount,
          finalAmount,
          receiverCountryCode,
          admin,
          systemTransaction,
        };
      },
      {
        timeout: 30000,
        maxWait: 30000,
      }
    );

    // ========== NOTIFICATIONS ==========
    try {
      await notifyTransaction(
        this.smsService,
        this.notificationHelper,
        this.i18nService,
        this.shouldSendSms.bind(this),
        this.shouldSendPush.bind(this),
        this.getUserLanguage.bind(this),
        result.senderTx,
        result.fromUser,
        result.fromWallet,
        result.isInternational ? 'send_pending' : 'send_sent',
        { name: result.toUser.full_name ?? undefined, phone: result.toUser.phone ?? undefined }
      );

      if (!result.isInternational) {
        await notifyTransaction(
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
          { name: result.fromUser.full_name ?? undefined, phone: result.fromUser.phone ?? undefined }
        );
      } else {
        console.log('[AdminSend] 🌍 Transfert international admin en attente - Pas de notification push au destinataire');
      }
    } catch (err) {
      console.error('[Notifications] adminSend error:', err);
    }

    return {
      message: this.i18nService.translate(
        result.isInternational ? 'wallet.transfer_international_pending' : 'wallet.transfer_success',
        lang,
        {
          amount: result.convertedAmount,
          currency: result.targetCurrency,
          rate: result.exchangeRate,
          fee: result.fee,
          feePercentage: result.internationalFeePercentage,
          withdrawalFeePercentage: result.withdrawalFeePercentage,
          withdrawalFee: result.withdrawalFee,
          feeIncluded: result.feeIncluded ? 'Oui' : 'Non',
          debitAmount: result.debitAmount,
          netAmount: result.netAmount,
          finalAmount: result.finalAmount,
          fromCurrency: result.fromWallet.currency,
          countryCode: result.receiverCountryCode,
          reference: result.senderTx.reference || 'N/A',
        }
      ),
      data: {
        fromWallet: this.toResponse(result.fromWallet),
        toWallet: this.toResponse(result.toWallet),
        transaction: result.senderTx,
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
        message: this.i18nService.translate('wallet.admin_pay_from_wallet_required', lang),
        statusCode: 400,
      });
    }

    if (!adminId) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.admin_id_required', lang),
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

    const result = await this.prisma.$transaction(
      async (tx) => {
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
            branchId: true,
          }
        });

        if (!admin) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('admin.not_found', lang),
            statusCode: 404,
          });
        }

        if (!admin.pin) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('admin.no_pin_set', lang),
            statusCode: 400,
          });
        }

        if (admin.pin_locked_until && admin.pin_locked_until > new Date()) {
          const minutesLeft = Math.ceil(
            (admin.pin_locked_until.getTime() - Date.now()) / 60000,
          );
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('admin.pin_locked', lang).replace('{minutes}', minutesLeft.toString()),
            statusCode: 403,
          });
        }

        const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
        if (admin.pin !== hashedPin) {
          const newAttempts = (admin.failed_pin_attempts || 0) + 1;
          let newStatus = admin.status;
          let lockedUntil: Date | null = null;
          if (newAttempts >= 10) {
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
            message: this.i18nService.translate('admin.pin_incorrect', lang),
            statusCode: 401,
          });
        }

        await tx.user.update({
          where: { id: admin.id },
          data: { failed_pin_attempts: 0, pin_locked_until: null },
        });

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
            merchantCode: true,
            branchId: true,
          }
        });
        if (!toUser) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.merchant_not_found', lang),
            statusCode: 404
          });
        }

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
          console.log(`[AdminPay] 💰 Nouveau wallet créé en ${fromWallet.currency} pour le commerçant ${toUser.id}`);
        }
        if (!toWallet.isActive) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_inactive', lang),
            statusCode: 403
          });
        }

        const updatedFrom = await tx.wallet.update({
          where: { id: fromWallet.id },
          data: { balance: { decrement: amount }, updatedAt: new Date() },
        });
        const updatedTo = await tx.wallet.update({
          where: { id: toWallet.id },
          data: { balance: { increment: amount }, updatedAt: new Date() },
        });

        const reference = await this.generateTransactionReference('', tx);

        // ✅ Transaction du payeur avec branchId
        const payerTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: fromUser.id,
            walletId: fromWallet.id,
            amount,
            type: 'PAYMENT',
            status: 'SUCCESS',
            reference: reference,
            currency: fromWallet.currency,
            description: description || this.i18nService.translate('wallet.admin_pay_payer_description', lang, {
              amount: amount,
              currency: fromWallet.currency,
              merchantName: toUser.full_name || 'Commerçant',
              merchantCode: merchantCode,
            }),
            paymentMethod: this.mapPaymentMethod(dto.paymentMethod),
            movement: 'DEBIT',
            branchId: admin.branchId ?? null,
          },
        });

        // ✅ Transaction du commerçant avec branchId
        const merchantTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: toUser.id,
            walletId: toWallet.id,
            amount,
            type: 'PAYMENT',
            status: 'SUCCESS',
            reference: reference,
            currency: toWallet.currency,
            description: description || this.i18nService.translate('wallet.admin_pay_merchant_description', lang, {
              amount: amount,
              currency: toWallet.currency,
              payerName: fromUser.full_name || 'Client',
              payerPhone: fromUser.phone || 'N/A',
            }),
            movement: 'CREDIT',
            branchId: toUser.branchId ?? null,
          },
        });

        await tx.audit_log.create({
          data: {
            id: crypto.randomUUID(),
            userId: admin.id,
            action: 'adminPay',
            details: JSON.stringify({ from: updatedFrom, to: updatedTo, merchantCode }),
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
          reference: result.payerTx.reference || 'N/A',
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
          reference: result.merchantTx.reference || 'N/A',
        });
        await this.smsService.sendSms(cleanPhone, smsText);
      } catch (err) {
        console.error('[AdminPay] Erreur envoi SMS:', err);
      }
    }

    // ========== NOTIFICATIONS PUSH ==========
    try {
      // ✅ 1. Notification pour le PAYEUR (le client qui paie)
      await notifyTransaction(
        this.smsService,
        this.notificationHelper,
        this.i18nService,
        this.shouldSendSms.bind(this),
        this.shouldSendPush.bind(this),
        this.getUserLanguage.bind(this),
        result.payerTx,
        result.fromUser, // Le payeur
        result.fromWallet,
        'pay_sent',
        { name: result.toUser.full_name ?? undefined, phone: result.toUser.phone ?? undefined }
      );

      // ✅ 2. Notification pour le COMMERÇANT (celui qui reçoit le paiement)
      await notifyTransaction(
        this.smsService,
        this.notificationHelper,
        this.i18nService,
        this.shouldSendSms.bind(this),
        this.shouldSendPush.bind(this),
        this.getUserLanguage.bind(this),
        result.merchantTx,
        result.toUser, // Le commerçant
        result.toWallet,
        'pay_received',
        { name: result.fromUser.full_name ?? undefined, phone: result.fromUser.phone ?? undefined }
      );
    } catch (err) {
      console.error('[Notifications] adminPay error:', err);
    }

    return {
      message: this.i18nService.translate('wallet.payment_success', lang, {
        amount: amount,
        currency: result.fromWallet.currency || 'CDF',
        merchantName: result.toUser.full_name || '',
        balance: result.fromWallet.balance || 0,
        reference: result.payerTx.reference || 'N/A',
      }),
      data: {
        wallet: this.toResponse(result.fromWallet),
        transaction: result.payerTx,
      },
    };
  }

  async transferCashBetweenBranches(
    dto: {
      fromWalletId: string;
      toWalletId: string;
      amount: number;
      adminId: string;
      currency?: string;
      reason?: string;
      lang?: string;
      ipAddress?: string;
    }
  ) {
    const {
      fromWalletId,
      toWalletId,
      amount,
      adminId,
      currency = 'CDF',
      reason,
      lang = 'fr',
      ipAddress
    } = dto;

    console.log('[WalletService] Transfert cash entre agences:', { fromWalletId, toWalletId, amount, currency });

    // ========== 1️⃣ RÉCUPÉRER LES WALLETS ==========
    const [fromWallet, toWallet] = await Promise.all([
      this.prisma.wallet.findFirst({
        where: {
          id: fromWalletId,
          isActive: true,
          currency: currency as wallet_currency,
          isBranchWallet: true, // 👈 SEULEMENT LES WALLETS DE CAISSE
        },
        include: {
          branch: true,
          user: true,
        },
      }),
      this.prisma.wallet.findFirst({
        where: {
          id: toWalletId,
          isActive: true,
          currency: currency as wallet_currency,
          isBranchWallet: true, // 👈 SEULEMENT LES WALLETS DE CAISSE
        },
        include: {
          branch: true,
          user: true,
        },
      }),
    ]);

    // ========== 2️⃣ VALIDATIONS ==========
    if (!fromWallet) {
      throw new RpcException({
        status: 'error',
        message: `Wallet source ${fromWalletId} non trouvé, inactif ou n'est pas un wallet de caisse`,
        statusCode: 404,
      });
    }

    if (!toWallet) {
      throw new RpcException({
        status: 'error',
        message: `Wallet destination ${toWalletId} non trouvé, inactif ou n'est pas un wallet de caisse`,
        statusCode: 404,
      });
    }

    // Vérifier que ce sont des wallets de caisse (branchId non null)
    if (!fromWallet.branchId) {
      throw new RpcException({
        status: 'error',
        message: 'Le wallet source n\'est pas un wallet de caisse d\'agence',
        statusCode: 400,
      });
    }

    if (!toWallet.branchId) {
      throw new RpcException({
        status: 'error',
        message: 'Le wallet destination n\'est pas un wallet de caisse d\'agence',
        statusCode: 400,
      });
    }

    // Vérifier que les wallets sont dans la même devise
    if (fromWallet.currency !== toWallet.currency) {
      throw new RpcException({
        status: 'error',
        message: `Les devises ne correspondent pas: ${fromWallet.currency} vs ${toWallet.currency}`,
        statusCode: 400,
      });
    }

    // Vérifier que ce n'est pas le même wallet
    if (fromWalletId === toWalletId) {
      throw new RpcException({
        status: 'error',
        message: 'Impossible de transférer vers le même wallet',
        statusCode: 400,
      });
    }

    // Vérifier que les agences sont différentes
    if (fromWallet.branchId === toWallet.branchId) {
      throw new RpcException({
        status: 'error',
        message: 'Impossible de transférer entre deux wallets de la même agence',
        statusCode: 400,
      });
    }

    if (amount <= 0) {
      throw new RpcException({
        status: 'error',
        message: 'Le montant doit être positif',
        statusCode: 400,
      });
    }

    // Vérifier le solde source
    if (fromWallet.balance < amount) {
      throw new RpcException({
        status: 'error',
        message: `Solde insuffisant. Disponible: ${fromWallet.balance} ${currency}, Demandé: ${amount} ${currency}`,
        statusCode: 400,
      });
    }

    // ========== 3️⃣ VÉRIFIER LES PERMISSIONS DE L'ADMIN ==========
    const admin = await this.prisma.user.findFirst({
      where: { id: adminId },
      select: {
        id: true,
        role: true,
        branchId: true,
        full_name: true,
      }
    });

    if (!admin) {
      throw new RpcException({
        status: 'error',
        message: 'Admin non trouvé',
        statusCode: 404,
      });
    }

    // ✅ SUPER_ADMIN peut transférer entre n'importe quelles agences
    // ✅ ADMIN ne peut transférer que depuis son agence
    if (admin.role === 'ADMIN') {
      // Vérifier que le wallet source appartient à la branche de l'admin
      if (fromWallet.branchId !== admin.branchId) {
        throw new RpcException({
          status: 'error',
          message: `Vous ne pouvez transférer que depuis votre agence (${admin.branchId}). 
                  Le wallet source appartient à l'agence ${fromWallet.branchId}`,
          statusCode: 403,
        });
      }
    } else if (admin.role !== 'SUPER_ADMIN') {
      throw new RpcException({
        status: 'error',
        message: 'Seul un administrateur peut effectuer des transferts de cash entre agences',
        statusCode: 403,
      });
    }

    // ========== 4️⃣ EXÉCUTER LE TRANSFERT ==========
    const result = await this.prisma.$transaction(async (tx) => {
      // Débiter le wallet source
      const updatedFromWallet = await tx.wallet.update({
        where: { id: fromWallet.id },
        data: {
          balance: { decrement: amount },
          updatedAt: new Date()
        },
      });

      // Créditer le wallet destination
      const updatedToWallet = await tx.wallet.update({
        where: { id: toWallet.id },
        data: {
          balance: { increment: amount },
          updatedAt: new Date()
        },
      });

      // Créer la transaction de transfert (débit)
      const reference = await this.generateTransactionReference('', tx);

      const debitTx = await tx.transaction.create({
        data: {
          id: crypto.randomUUID(),
          userId: fromWallet.userId,
          walletId: fromWallet.id,
          amount: amount,
          type: 'CASH_TRANSFER', // ✅ Utiliser le type directement
          status: 'SUCCESS',
          reference: reference,
          description: `Transfert cash vers ${toWallet.branch?.name || 'Agence'} ${reason ? `- ${reason}` : ''}`,
          movement: 'DEBIT',
          currency: currency,
          paymentMethod: 'CASH',
          branchId: fromWallet.branchId,
          external_reference: toWallet.branchId,
        },
      });

      // Créer la transaction de transfert (crédit)
      const creditTx = await tx.transaction.create({
        data: {
          id: crypto.randomUUID(),
          userId: toWallet.userId,
          walletId: toWallet.id,
          amount: amount,
          type: 'CASH_TRANSFER', // ✅ Utiliser le type directement
          status: 'SUCCESS',
          reference: reference,
          description: `Transfert cash depuis ${fromWallet.branch?.name || 'Agence'} ${reason ? `- ${reason}` : ''}`,
          movement: 'CREDIT',
          currency: currency,
          paymentMethod: 'CASH',
          branchId: toWallet.branchId,
          external_reference: fromWallet.branchId,
        },
      });

      // Audit log
      await tx.audit_log.create({
        data: {
          id: crypto.randomUUID(),
          userId: adminId,
          action: 'cashTransferBetweenBranches',
          details: JSON.stringify({
            fromWalletId: fromWallet.id,
            toWalletId: toWallet.id,
            fromBranchId: fromWallet.branchId,
            toBranchId: toWallet.branchId,
            amount,
            currency,
            reason,
            debitTx: debitTx.id,
            creditTx: creditTx.id,
            adminName: admin.full_name,
            adminRole: admin.role,
          }),
          ipAddress: ipAddress || null,
          createdAt: new Date(),
        },
      });

      return {
        debitTx,
        creditTx,
        fromWallet: updatedFromWallet,
        toWallet: updatedToWallet
      };
    }, { timeout: 30000 });

    // ========== 5️⃣ RETOUR ==========
    return {
      message: `Transfert de ${amount} ${currency} effectué avec succès de ${fromWallet.branch?.name || 'Agence source'} vers ${toWallet.branch?.name || 'Agence destination'}`,
      data: {
        fromWallet: {
          id: result.fromWallet.id,
          branchId: result.fromWallet.branchId,
          branchName: fromWallet.branch?.name,
          balance: result.fromWallet.balance,
          currency: result.fromWallet.currency,
          isBranchWallet: result.fromWallet.isBranchWallet,
        },
        toWallet: {
          id: result.toWallet.id,
          branchId: result.toWallet.branchId,
          branchName: toWallet.branch?.name,
          balance: result.toWallet.balance,
          currency: result.toWallet.currency,
          isBranchWallet: result.toWallet.isBranchWallet,
        },
        amount,
        currency,
        reference: result.debitTx.reference,
        transaction: {
          debit: result.debitTx,
          credit: result.creditTx,
        },
      },
    };
  }

  async getBranchCashWallet(branchId: string, currency: string = 'CDF'): Promise<any> {
    // 1. Vérifier que la branche existe
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId }
    });

    if (!branch) {
      throw new RpcException({
        status: 'error',
        message: `Agence ${branchId} non trouvée`,
        statusCode: 404,
      });
    }

    // 2. Trouver l'utilisateur caisse de cette agence
    const branchUser = await this.prisma.user.findFirst({
      where: {
        branchId: branchId,
        role: 'ADMIN',
        OR: [
          { email: { contains: `caisse.${branch.code.toLowerCase()}` } },
          { full_name: { contains: `Caisse ${branch.name}` } }
        ]
      }
    });

    if (!branchUser) {
      // Créer un compte caisse pour cette agence s'il n'existe pas
      const newBranchUser = await this.prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: `caisse.${branch.code.toLowerCase()}@fpay.com`,
          full_name: `Caisse ${branch.name}`,
          phone: branch.phone || null,
          account_number: `BR-${branch.code}`,
          role: 'ADMIN',
          status: 'ACTIVE',
          branchId: branch.id,
          password: null,
          pinstatus: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      console.log(`✅ Compte caisse créé pour l'agence ${branch.name}`);

      // 3. Trouver ou créer le wallet pour l'utilisateur caisse
      let wallet = await this.prisma.wallet.findFirst({
        where: {
          userId: newBranchUser.id,
          branchId: branchId,
          currency: currency as wallet_currency,
          isActive: true,
        },
      });

      if (!wallet) {
        wallet = await this.prisma.wallet.create({
          data: {
            id: crypto.randomUUID(),
            userId: newBranchUser.id,
            branchId: branchId,
            currency: currency as wallet_currency,
            balance: 0,
            isActive: true,
            isDefault: false,
          },
        });
        console.log(`Wallet de caisse créé pour ${branch.name} (${currency})`);
      }

      return wallet;
    }

    // 3. Trouver ou créer le wallet pour l'utilisateur caisse existant
    let wallet = await this.prisma.wallet.findFirst({
      where: {
        userId: branchUser.id,
        branchId: branchId,
        currency: currency as wallet_currency,
        isActive: true,
      },
    });

    if (!wallet) {
      wallet = await this.prisma.wallet.create({
        data: {
          id: crypto.randomUUID(),
          userId: branchUser.id,
          branchId: branchId,
          currency: currency as wallet_currency,
          balance: 0,
          isActive: true,
          isDefault: false,
        },
      });
      console.log(`Wallet de caisse créé pour ${branch.name} (${currency})`);
    }

    return wallet;
  }

  async checkBranchCashBalance(branchId: string, amount: number, currency: string = 'CDF'): Promise<any> {
    const branchWallet = await this.getBranchCashWallet(branchId, currency);

    if (branchWallet.balance < amount) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: branchId }
      });

      throw new RpcException({
        status: 'error',
        message: `Solde de caisse insuffisant à l'agence ${branch?.name || branchId}. 
                  Disponible: ${branchWallet.balance} ${currency}, Demandé: ${amount} ${currency}`,
        statusCode: 400,
      });
    }

    return branchWallet;
  }

  async calculateInternationalTransferFees(
    amount: number,
    walletId: string,
    countryCode: string,
    paymentMethod: 'CASH' | 'MOBILE_MONEY' = 'CASH',
  ): Promise<ApiResponse<any>> {
    console.log('[WalletService] Calculating international transfer fees:', {
      amount,
      walletId,
      countryCode,
      paymentMethod,
    });

    // 1️⃣ Récupérer le wallet avec l'utilisateur
    const wallet = await this.prisma.wallet.findFirst({
      where: {
        id: walletId
      },
      include: {
        user: {
          select: {
            countryCode: true,
            full_name: true,
          },
        },
      },
    });

    if (!wallet) {
      throw new RpcException({
        status: 'error',
        message: 'Wallet non trouvé ou inactif',
        statusCode: 404,
      });
    }

    if (!wallet.user) {
      throw new RpcException({
        status: 'error',
        message: 'Utilisateur non trouvé pour ce wallet',
        statusCode: 404,
      });
    }

    const senderCountryCode = wallet.user.countryCode || 'CD';

    // 2️⃣ Récupérer les informations des deux pays
    const [senderCountry, receiverCountry] = await Promise.all([
      this.prisma.country_provider.findFirst({
        where: {
          OR: [
            { countryCode: senderCountryCode },
            { code: senderCountryCode },
          ],
        },
      }),
      this.prisma.country_provider.findFirst({
        where: {
          OR: [
            { countryCode: countryCode },
            { code: countryCode },
          ],
        },
      }),
    ]);

    if (!senderCountry) {
      throw new RpcException({
        status: 'error',
        message: `Pays expéditeur non trouvé pour le code: ${senderCountryCode}`,
        statusCode: 404,
      });
    }

    if (!receiverCountry) {
      throw new RpcException({
        status: 'error',
        message: `Pays destinataire non trouvé pour le code: ${countryCode}`,
        statusCode: 404,
      });
    }

    // 3️⃣ ✅ Seul l'expéditeur supporte les frais, le destinataire ne paie rien
    let senderFee = 0;

    if (paymentMethod === 'CASH') {
      senderFee = senderCountry.cash_percentage || 0;
    } else if (paymentMethod === 'MOBILE_MONEY') {
      senderFee = senderCountry.momo_percentage || 0;
    } else {
      senderFee = senderCountry.international_transfer_fee || 0;
    }

    // ❌ Le destinataire ne paie pas de frais
    const receiverFee = 0;

    // 4️⃣ Calculer les montants des frais
    const senderFeeAmount = (amount * senderFee) / 100;
    const receiverFeeAmount = 0; // ✅ Le destinataire ne paie rien
    const totalFeeAmount = senderFeeAmount;

    // 5️⃣ Montant à débiter (montant + frais de l'expéditeur)
    const debitAmount = amount + senderFeeAmount;

    // 6️⃣ Récupérer la devise cible et le taux de change
    let targetCurrency = receiverCountry.default_currency || wallet.currency;
    let exchangeRate = 1;
    let convertedAmount = amount;
    let creditAmount = amount;

    if (wallet.currency !== targetCurrency) {
      const rate = await this.getExchangeRate(wallet.currency, targetCurrency);
      exchangeRate = rate;
      convertedAmount = amount * rate;
    }

    // 7️⃣ ✅ Le destinataire reçoit la totalité du montant converti (sans frais)
    creditAmount = convertedAmount;

    const result = {
      senderCountryCode: senderCountry.countryCode || senderCountry.code,
      senderCountryName: senderCountry.name,
      receiverCountryCode: receiverCountry.countryCode || receiverCountry.code,
      receiverCountryName: receiverCountry.name,
      paymentMethod,
      senderFeePercentage: senderFee,
      receiverFeePercentage: 0, // ✅ Le destinataire ne paie pas
      totalFeePercentage: senderFee,
      senderFeeAmount,
      receiverFeeAmount: 0,
      totalFeeAmount,
      debitAmount,
      creditAmount,
      currency: wallet.currency,
      targetCurrency,
      exchangeRate,
      convertedAmount,
      feeBreakdown: {
        sender: {
          countryCode: senderCountry.countryCode || senderCountry.code,
          countryName: senderCountry.name,
          cashPercentage: senderCountry.cash_percentage || 0,
          momoPercentage: senderCountry.momo_percentage || 0,
          internationalTransferFee: senderCountry.international_transfer_fee || 0,
          appliedFee: senderFee,
          feeAmount: senderFeeAmount,
        },
        receiver: {
          countryCode: receiverCountry.countryCode || receiverCountry.code,
          countryName: receiverCountry.name,
          cashPercentage: 0, // ✅ Le destinataire ne paie pas
          momoPercentage: 0, // ✅ Le destinataire ne paie pas
          internationalTransferFee: 0, // ✅ Le destinataire ne paie pas
          appliedFee: 0,
          feeAmount: 0,
        },
      },
    };

    return {
      message: 'Calcul des frais de transfert international effectué avec succès',
      data: result,
    };
  }

  async getWalletDashboard(
    userId: string,
    walletId?: string,
    startDate?: string,
    endDate?: string,
    lang: string = 'fr',
  ): Promise<ApiResponse<any>> {
    console.log('[WalletService] Get wallet dashboard:', { userId, walletId, startDate, endDate, lang });

    // 🔍 Vérifier que userId est valide
    if (!userId) {
      throw new RpcException({
        status: 'error',
        message: 'userId is required',
        statusCode: 400,
      });
    }

    // 1️⃣ Récupérer tous les wallets de l'utilisateur
    const allWallets = await this.prisma.wallet.findMany({
      where: {
        userId: userId,
        isActive: true,
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        currency: true,
        balance: true,
        isActive: true,
      },
    });

    console.log('[WalletService] All active wallets found:', allWallets.length);

    if (!allWallets || allWallets.length === 0) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.no_wallet_found', lang),
        statusCode: 404,
      });
    }

    // 2️⃣ Récupérer le wallet (premier si non spécifié)
    let wallet;
    if (walletId) {
      wallet = allWallets.find(w => w.id === walletId);
      if (!wallet) {
        wallet = await this.prisma.wallet.findFirst({
          where: {
            id: walletId,
            userId: userId,
            isActive: true,
          },
        });
      }

      if (!wallet) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('wallet.wallet_not_found', lang),
          statusCode: 404,
        });
      }
    } else {
      wallet = allWallets[0];
    }

    console.log('[WalletService] Selected wallet:', {
      id: wallet.id,
      currency: wallet.currency,
      balance: wallet.balance,
    });

    // 3️⃣ Définir la période (mois en cours par défaut)
    const now = new Date();
    let start: Date;
    let end: Date;

    if (startDate && endDate) {
      start = new Date(startDate);
      end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
    } else {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      end.setHours(23, 59, 59, 999);
    }

    console.log('[WalletService] Period:', { start, end });

    // 4️⃣ Récupérer toutes les transactions du wallet sur la période
    const transactions = await this.prisma.transaction.findMany({
      where: {
        walletId: wallet.id,
        status: 'SUCCESS',
        createdAt: {
          gte: start,
          lte: end,
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    console.log('[WalletService] Transactions found:', transactions.length);

    // 5️⃣ Calculer les statistiques globales
    let totalSent = 0;
    let totalReceived = 0;
    let sentCount = 0;
    let receivedCount = 0;
    let successCount = 0;

    for (const tx of transactions) {
      if (tx.movement === 'DEBIT') {
        totalSent += tx.amount;
        sentCount++;
      } else if (tx.movement === 'CREDIT') {
        totalReceived += tx.amount;
        receivedCount++;
      }
      if (tx.status === 'SUCCESS') {
        successCount++;
      }
    }

    const totalTransactions = transactions.length;
    const successRate = totalTransactions > 0 ? Math.round((successCount / totalTransactions) * 100) : 0;

    // 6️⃣ Calculer la moyenne quotidienne
    const daysDiff = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
    const averageDaily = totalTransactions > 0 ? Math.round((totalSent + totalReceived) / daysDiff) : 0;

    // 7️⃣ Trouver la plus grande transaction
    let largestAmount = 0;
    for (const tx of transactions) {
      if (tx.amount > largestAmount) {
        largestAmount = tx.amount;
      }
    }

    // 8️⃣ Récupérer les informations de l'utilisateur (DYNAMIQUE)
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: {
        countryCode: true,
        phone: true,
      },
    });

    const userCountryCode = user?.countryCode?.toUpperCase() || 'CD';
    const localCurrency = wallet.currency;

    console.log('[WalletService] User country code:', userCountryCode);
    console.log('[WalletService] Local currency:', localCurrency);

    // 9️⃣ Récupérer tous les pays pour référence (DYNAMIQUE)
    const allCountries = await this.prisma.country_provider.findMany({
      select: {
        code: true,
        countryCode: true,
        name: true,
        prefix: true,
      },
    });

    // Créer les maps de pays
    const countryByPrefix = new Map<string, string>();
    const countryByCountryCode = new Map<string, { code: string; name: string }>();
    const countryByCode = new Map<string, { code: string; name: string }>();

    for (const country of allCountries) {
      if (country.prefix) {
        countryByPrefix.set(country.prefix.replace('+', ''), country.countryCode || country.code);
      }
      if (country.countryCode) {
        countryByCountryCode.set(country.countryCode.toUpperCase(), {
          code: country.countryCode,
          name: country.name,
        });
      }
      if (country.code) {
        countryByCode.set(country.code.toUpperCase(), {
          code: country.code,
          name: country.name,
        });
      }
    }

    // ✅ Déterminer dynamiquement le pays de l'utilisateur
    let userPhonePrefix = userCountryCode;
    if (user?.phone) {
      const phoneCode = await this.extractCountryCodeFromPhone(user.phone);
      if (phoneCode) {
        userPhonePrefix = phoneCode;
      }
    }

    // ✅ Pays locaux (le pays de l'utilisateur)
    const localCountries = new Set<string>();
    localCountries.add(userCountryCode);
    if (userPhonePrefix !== userCountryCode) {
      localCountries.add(userPhonePrefix);
    }

    console.log('[WalletService] Local countries:', Array.from(localCountries));

    // 🔟 Récupérer toutes les devises
    const allCurrencies = await this.prisma.currency.findMany({
      select: { code: true },
    });
    const foreignCurrencies = new Set<string>();
    for (const c of allCurrencies) {
      if (c.code !== localCurrency) {
        foreignCurrencies.add(c.code);
      }
    }

    // 1️⃣1️⃣ Statistiques internationales - DYNAMIQUE (CORRIGÉ)
    let totalInternationalSent = 0;
    let totalInternationalReceived = 0;
    let totalFees = 0;
    let feeCount = 0;

    const countryMap = new Map<string, { code: string; name: string; count: number; amount: number }>();

    for (const tx of transactions) {
      let isInternational = false;
      let detectedCountryCode: string | null = null;

      // ✅ 1. Détection par devise (si différente de la devise locale)
      if (tx.type === 'TRANSFER' && tx.currency && tx.currency !== localCurrency) {
        const countryByCurrency = await this.getCountryByCurrency(tx.currency);
        if (countryByCurrency) {
          const countryCode = countryByCurrency.countryCode?.toUpperCase() || countryByCurrency.code?.toUpperCase();
          if (countryCode && !localCountries.has(countryCode)) {
            isInternational = true;
            detectedCountryCode = countryCode;
          }
        } else if (foreignCurrencies.has(tx.currency)) {
          isInternational = true;
          detectedCountryCode = 'INT';
        }
      }

      // ✅ 2. Détection par pays dans la description
      if (!isInternational) {
        const countryMatch = tx.description?.match(/Pays:\s*([A-Z]{2})/i);
        if (countryMatch) {
          const countryCode = countryMatch[1].toUpperCase();
          if (countryCode && !localCountries.has(countryCode)) {
            const countryExists = countryByCountryCode.has(countryCode) || countryByCode.has(countryCode);
            if (countryExists) {
              isInternational = true;
              detectedCountryCode = countryCode;
            }
          }
        }
      }

      // ✅ 3. Détection par indicatif téléphonique
      if (!isInternational) {
        const phoneMatch = tx.description?.match(/\((\+?\d{6,15})\)/);
        if (phoneMatch) {
          const phone = phoneMatch[1];
          const countryCodeFromPhone = await this.extractCountryCodeFromPhone(phone);
          if (countryCodeFromPhone) {
            const countryCode = countryCodeFromPhone.toUpperCase();
            if (!localCountries.has(countryCode)) {
              const countryExists = countryByCountryCode.has(countryCode) || countryByCode.has(countryCode);
              if (countryExists) {
                isInternational = true;
                detectedCountryCode = countryCode;
              }
            }
          }
        }
      }

      // ❌ Si ce n'est pas international ou pas de pays détecté, ignorer
      if (!isInternational || !detectedCountryCode) continue;

      // ❌ Si le pays détecté est le même que le pays de l'utilisateur, ignorer
      if (localCountries.has(detectedCountryCode)) continue;

      // ✅ Récupérer le nom du pays
      let countryName: string = detectedCountryCode;
      if (countryByCountryCode.has(detectedCountryCode)) {
        const country = countryByCountryCode.get(detectedCountryCode);
        if (country) {
          countryName = country.name;
        }
      } else if (countryByCode.has(detectedCountryCode)) {
        const country = countryByCode.get(detectedCountryCode);
        if (country) {
          countryName = country.name;
        }
      }

      if (!countryMap.has(detectedCountryCode)) {
        countryMap.set(detectedCountryCode, {
          code: detectedCountryCode,
          name: countryName,
          count: 0,
          amount: 0,
        });
      }

      const countryData = countryMap.get(detectedCountryCode)!;
      countryData.count += 1;
      countryData.amount += tx.amount;

      if (tx.movement === 'DEBIT') {
        totalInternationalSent += tx.amount;
      } else {
        totalInternationalReceived += tx.amount;
      }

      // Extraire les frais
      const feeMatch = tx.description?.match(/frais\s+([\d.]+)\s*%/i);
      if (feeMatch) {
        const fee = parseFloat(feeMatch[1]);
        totalFees += fee;
        feeCount++;
      }
    }

    const averageFee = feeCount > 0 ? Math.round((totalFees / feeCount) * 10) / 10 : 0;

    // 1️⃣2️⃣ Catégories (Transferts, Paiements, Recharges)
    const categories = [
      {
        name: 'Transferts',
        count: 0,
        amount: 0,
        percentage: 0,
        color: '#3B82F6',
      },
      {
        name: 'Paiements',
        count: 0,
        amount: 0,
        percentage: 0,
        color: '#F59E0B',
      },
      {
        name: 'Recharges',
        count: 0,
        amount: 0,
        percentage: 0,
        color: '#22C55E',
      },
    ];

    for (const tx of transactions) {
      if (tx.type === 'TRANSFER') {
        categories[0].count++;
        categories[0].amount += tx.amount;
      } else if (tx.type === 'PAYMENT') {
        categories[1].count++;
        categories[1].amount += tx.amount;
      } else if (tx.type === 'DEPOSIT') {
        categories[2].count++;
        categories[2].amount += tx.amount;
      }
    }

    const totalAmount = categories.reduce((sum, cat) => sum + cat.amount, 0);
    for (const cat of categories) {
      cat.percentage = totalAmount > 0 ? Math.round((cat.amount / totalAmount) * 100) : 0;
    }

    // 1️⃣3️⃣ Activité mensuelle (6 derniers mois)
    const monthlyActivity = await this.getMonthlyActivity(wallet.id, userId);

    // 1️⃣4️⃣ Évolution du solde sur la période
    const evolutionData = await this.getBalanceEvolution(wallet.id, start, end);

    // 1️⃣5️⃣ Données internationales formatées
    const countries = Array.from(countryMap.values())
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

    // 1️⃣6️⃣ Formater la liste des wallets
    const formattedWallets = allWallets.map(w => ({
      id: w.id,
      currency: w.currency,
      balance: w.balance,
    }));

    // 1️⃣7️⃣ Réponse
    return {
      message: this.i18nService.translate('wallet.dashboard_retrieved', lang),
      data: {
        wallets: formattedWallets,
        walletId: wallet.id,
        currency: wallet.currency,
        balance: wallet.balance,
        transactions: {
          total: totalTransactions,
          sent: sentCount,
          received: receivedCount,
          sentAmount: totalSent,
          receivedAmount: totalReceived,
          successRate: successRate,
          averageDaily: averageDaily,
          largestAmount: largestAmount,
        },
        international: {
          totalSent: totalInternationalSent,
          totalReceived: totalInternationalReceived,
          totalFees: totalFees,
          averageFee: averageFee,
          countries: countries,
        },
        categories: categories,
        monthlyActivity: monthlyActivity,
        evolution: {
          percentageChange: this.calculatePercentageChange(evolutionData),
          data: evolutionData,
        },
      },
    };
  }

  private async getCountryName(countryCode: string): Promise<string> {
    try {
      const country = await this.prisma.country_provider.findFirst({
        where: {
          OR: [
            { countryCode: countryCode },
            { code: countryCode },
          ],
        },
        select: { name: true },
      });
      return country?.name || countryCode;
    } catch (error) {
      return countryCode;
    }
  }

  /**
   * Récupère le pays par devise (dynamique)
   */
  private async getCountryByCurrency(currency: string): Promise<any> {
    try {
      let country = await this.prisma.country_provider.findFirst({
        where: { default_currency: currency },
        select: {
          countryCode: true,
          code: true,
          name: true,
          prefix: true,
        },
      });

      if (!country) {
        const countryCurrency = await this.prisma.country_currency.findFirst({
          where: { currency_code: currency },
          include: {
            country_provider: {
              select: {
                countryCode: true,
                code: true,
                name: true,
                prefix: true,
              },
            },
          },
        });
        if (countryCurrency?.country_provider) {
          country = countryCurrency.country_provider;
        }
      }

      return country;
    } catch (error) {
      console.error('[getCountryByCurrency] Error:', error);
      return null;
    }
  }

  /**
   * Extrait le code pays d'un numéro de téléphone (dynamique)
   */
  private async extractCountryCodeFromPhone(phone: string): Promise<string | null> {
    try {
      const clean = phone.replace(/[^0-9+]/g, '');

      const countries = await this.prisma.country_provider.findMany({
        select: {
          code: true,
          countryCode: true,
          prefix: true,
        },
        where: {
          prefix: { not: null },
        },
      });

      const prefixMap: { prefix: string; code: string }[] = [];
      for (const country of countries) {
        if (country.prefix) {
          const prefix = country.prefix.replace('+', '');
          prefixMap.push({
            prefix: prefix,
            code: country.countryCode || country.code,
          });
        }
      }

      prefixMap.sort((a, b) => b.prefix.length - a.prefix.length);

      let number = clean;
      if (number.startsWith('+')) {
        number = number.substring(1);
      }

      for (const { prefix, code } of prefixMap) {
        if (number.startsWith(prefix)) {
          return code;
        }
      }

      return null;
    } catch (error) {
      console.error('[extractCountryCodeFromPhone] Error:', error);
      return null;
    }
  }

  /**
   * Récupère l'activité mensuelle (6 derniers mois)
   */
  private async getMonthlyActivity(walletId: string, userId: string): Promise<any[]> {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    end.setHours(23, 59, 59, 999);

    const transactions = await this.prisma.transaction.findMany({
      where: {
        walletId: walletId,
        userId: userId,
        status: 'SUCCESS',
        createdAt: {
          gte: start,
          lte: end,
        },
      },
    });

    const monthMap = new Map<string, { month: string; transactions: number; amount: number }>();
    const monthNames = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Jui', 'Jul', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc'];

    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthMap.set(key, {
        month: monthNames[d.getMonth()],
        transactions: 0,
        amount: 0,
      });
    }

    for (const tx of transactions) {
      const d = new Date(tx.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (monthMap.has(key)) {
        const data = monthMap.get(key)!;
        data.transactions += 1;
        data.amount += tx.amount;
      }
    }

    return Array.from(monthMap.values());
  }

  /**
   * Récupère l'évolution du solde sur la période
   */
  private async getBalanceEvolution(
    walletId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<any[]> {
    const transactions = await this.prisma.transaction.findMany({
      where: {
        walletId: walletId,
        status: 'SUCCESS',
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const previousTransactions = await this.prisma.transaction.findMany({
      where: {
        walletId: walletId,
        status: 'SUCCESS',
        createdAt: {
          lt: startDate,
        },
      },
    });

    let balance = 0;
    for (const tx of previousTransactions) {
      if (tx.movement === 'CREDIT') {
        balance += tx.amount;
      } else {
        balance -= tx.amount;
      }
    }

    const data: any[] = [];
    const currentDate = new Date(startDate);

    const dailyMap = new Map<string, { credit: number; debit: number }>();
    for (const tx of transactions) {
      const dateKey = tx.createdAt.toISOString().split('T')[0];
      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, { credit: 0, debit: 0 });
      }
      const daily = dailyMap.get(dateKey)!;
      if (tx.movement === 'CREDIT') {
        daily.credit += tx.amount;
      } else {
        daily.debit += tx.amount;
      }
    }

    while (currentDate <= endDate) {
      const dateKey = currentDate.toISOString().split('T')[0];
      const daily = dailyMap.get(dateKey);

      if (daily) {
        balance += daily.credit - daily.debit;
      }

      data.push({
        date: dateKey,
        balance: Math.round(balance * 100) / 100,
      });

      currentDate.setDate(currentDate.getDate() + 1);
    }

    return data;
  }


  /**
 * Récupère la balance et les transactions d'un utilisateur
 */
  async getWalletBalanceAndTransactions(
    userId: string,
    walletId?: string,
    lang: string = 'fr',
    page: number = 1,
    limit: number = 10,
    startDate?: Date,
    endDate?: Date,
    type?: string,
    status?: string,
    movement?: string,
    search?: string,
  ): Promise<ApiResponse<{
    wallets: WalletResponseDto[];  // ✅ Ajout de la liste des wallets
    wallet: WalletResponseDto;
    balance: number;
    currency: string;
    transactions: {
      data: any[];
      total: number;
      page: number;
      limit: number;
      analytics: {
        totalCredit: number;
        totalDebit: number;
        totalTransactions: number;
      };
    };
    stats: {
      totalSent: number;
      totalReceived: number;
      averageTransaction: number;
      largestTransaction: number;
      smallestTransaction: number;
      transactionCount: number;
    };
  }>> {
    console.log('[WalletService] Get wallet balance and transactions:', {
      userId,
      walletId,
      lang,
      page,
      limit,
      startDate,
      endDate,
      type,
      status,
      movement,
      search,
    });

    // ========== 1️⃣ VALIDATION DE L'UTILISATEUR ==========
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        full_name: true,
        phone: true,
        status: true,
      },
    });

    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.user_not_found', lang),
        statusCode: 404,
      });
    }

    if (user.status === user_status.BLOCKED) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('account_blocked_admin', lang),
        statusCode: 403,
      });
    }

    // ========== 2️⃣ RÉCUPÉRER TOUS LES WALLETS DE L'UTILISATEUR ==========
    const allWallets = await this.prisma.wallet.findMany({
      where: {
        userId: userId,
        isActive: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (!allWallets || allWallets.length === 0) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.no_wallet_found', lang),
        statusCode: 404,
      });
    }

    // ========== 3️⃣ VALIDATION DU WALLET SÉLECTIONNÉ ==========
    let wallet;

    // ✅ Si walletId est fourni, le chercher spécifiquement
    if (walletId) {
      wallet = allWallets.find(w => w.id === walletId);

      if (!wallet) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('wallet.wallet_not_found_or_unauthorized', lang),
          statusCode: 404,
        });
      }
    } else {
      // ✅ Sinon, récupérer le wallet en USD par défaut
      wallet = allWallets.find(w => w.currency === 'USD');

      // ✅ Si pas de wallet en USD, prendre le premier wallet
      if (!wallet) {
        wallet = allWallets[0];
      }
    }

    if (!wallet.isActive) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.wallet_inactive', lang),
        statusCode: 403,
      });
    }

    // ========== 4️⃣ CONSTRUIRE LES FILTRES ==========
    const skip = (page - 1) * limit;
    const where: any = {
      walletId: wallet.id,
      userId: userId,
    };

    // ✅ Filtrer par type (exclure les transactions de caisse par défaut)
    if (type) {
      where.type = type;
    } else {
      where.type = {
        notIn: ['CASH_IN', 'CASH_OUT', 'CASH_TRANSFER']
      };
    }

    // Filtrer par statut
    if (status) where.status = status;

    // Filtrer par mouvement
    if (movement) where.movement = movement;

    // Filtrer par date
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) {
        const endOfDay = new Date(endDate);
        endOfDay.setHours(23, 59, 59, 999);
        where.createdAt.lte = endOfDay;
      }
    }

    // Filtrer par recherche
    if (search && search.trim() !== '') {
      const searchTerm = search.trim();
      where.OR = [
        { description: { contains: searchTerm } },
        { reference: { contains: searchTerm } },
      ];
    }

    // ========== 5️⃣ RÉCUPÉRER LES TRANSACTIONS ==========
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

    // ========== 6️⃣ CALCULER LES STATISTIQUES ==========
    let totalSent = 0;
    let totalReceived = 0;
    let largestTransaction = 0;
    let smallestTransaction = Infinity;
    const transactionCount = transactions.length;

    for (const tx of transactions) {
      if (tx.movement === 'DEBIT') {
        totalSent += tx.amount;
      } else if (tx.movement === 'CREDIT') {
        totalReceived += tx.amount;
      }

      if (tx.amount > largestTransaction) {
        largestTransaction = tx.amount;
      }
      if (tx.amount < smallestTransaction && tx.amount > 0) {
        smallestTransaction = tx.amount;
      }
    }

    if (smallestTransaction === Infinity) {
      smallestTransaction = 0;
    }

    const averageTransaction = transactionCount > 0
      ? Math.round(((totalSent + totalReceived) / transactionCount) * 100) / 100
      : 0;

    // ========== 7️⃣ ENRICHIR LES TRANSACTIONS ==========
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

    // ========== 8️⃣ FORMATER LES WALLETS ==========
    const formattedWallets = allWallets.map(w => this.toResponse(w));

    // ========== 9️⃣ RETOURNER LA RÉPONSE ==========
    return {
      message: this.i18nService.translate('wallet.balance_and_transactions_retrieved', lang),
      data: {
        wallets: formattedWallets,  // ✅ Liste de tous les wallets
        wallet: this.toResponse(wallet),
        balance: wallet.balance,
        currency: wallet.currency,
        transactions: {
          data: enrichedTransactions,
          total,
          page,
          limit,
          analytics: {
            totalCredit,
            totalDebit,
            totalTransactions: total,
          },
        },
        stats: {
          totalSent,
          totalReceived,
          averageTransaction,
          largestTransaction,
          smallestTransaction,
          transactionCount,
        },
      },
    };
  }
  // apps/wallet-service/src/wallet-service.service.ts
  /**
   * Récupère les balances des wallets PawaPay
   * @param country - Code pays (optionnel)
   * @param provider - Nom du provider (optionnel)
   */
  async getPawaPayBalances(
    country?: string,
    provider?: string,
  ): Promise<any> {
    console.log('[WalletService] Get PawaPay balances:', { country, provider });

    try {
      // Appel à PawapayService pour récupérer les balances
      const balancesData = await this.pawapayService.getWalletBalances(country, provider);

      return {
        success: true,
        data: balancesData.balances || [],
        message: 'Balances PawaPay récupérées avec succès',
      };
    } catch (error) {
      console.error('[WalletService] Error getting PawaPay balances:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Erreur lors de la récupération des balances PawaPay',
        statusCode: error.statusCode || 500,
      });
    }
  }

  /**
   * Calcule le pourcentage de changement
   */
  private calculatePercentageChange(data: any[]): number {
    if (data.length < 2) return 0;
    const first = data[0]?.balance || 0;
    const last = data[data.length - 1]?.balance || 0;
    if (first === 0) return 0;
    return Math.round(((last - first) / first) * 100);
  }
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