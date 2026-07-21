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
      if (newAttempts >= 5) {
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

    // ✅ Récupérer le taux de change une seule fois (optimisé)
    const rate = await this.getExchangeRate(fromWallet.currency, toWallet.currency);

    // ✅ Calculer le montant converti avec arrondi par défaut (floor)
    const rawConvertedAmount = amount * rate;
    const convertedAmount = Math.floor(rawConvertedAmount * 100) / 100; // Arrondi à 2 décimales par défaut

    console.log('[WalletService] Conversion calculée:', {
      fromCurrency: fromWallet.currency,
      toCurrency: toWallet.currency,
      amount,
      rate,
      rawConvertedAmount,
      convertedAmount,
    });

    // ✅ Vérifier que le montant converti est valide
    if (convertedAmount <= 0) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.conversion_amount_too_small', lang),
        statusCode: 400,
      });
    }

    // ✅ Transaction rapide
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

        // Créer les transactions
        const reference = `CONV_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

        const senderTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: user.id,
            walletId: fromWallet.id,
            amount,
            type: 'TRANSFER',
            status: 'SUCCESS',
            reference: reference,
            description: description || this.i18nService.translate('wallet.conversion_debit', lang, {
              amount,
              fromCurrency: fromWallet.currency,
              toCurrency: toWallet.currency,
              rate,
              convertedAmount,
            }),
            movement: 'DEBIT',
            currency: fromWallet.currency,
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
            reference: reference,
            description: description || this.i18nService.translate('wallet.conversion_credit', lang, {
              amount,
              fromCurrency: fromWallet.currency,
              toCurrency: toWallet.currency,
              rate,
              convertedAmount,
            }),
            movement: 'CREDIT',
            currency: toWallet.currency,
          },
        });

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

    // Notifications
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
        timeout: 30000,
        maxWait: 30000,
      }
    );

    // ========== ENVOYER LE SMS AU CLIENT ==========
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
        console.log(`[AdminTopUp] SMS envoyé au client ${cleanPhone}`);
      } catch (err) {
        console.error('[AdminTopUp] Erreur envoi SMS:', err);
      }
    }

    // ========== NOTIFICATION PUSH AU CLIENT ==========
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

    // ✅ Vérifier que le wallet existe et a assez de solde
    const wallet = await this.prisma.wallet.findFirst({
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

    const user = wallet.user; // Le client

    // ========== ÉTAPE 1 : Demande de retrait (sans OTP) ==========
    // ✅ On ne vérifie PAS le PIN de l'admin ici
    if (!otpCode || otpCode.trim() === '') {
      // Vérifier que l'admin a un PIN (pour la suite)
      if (!admin.pin) {
        throw new RpcException({
          status: 'error',
          message: 'L\'admin n\'a pas de PIN défini.',
          statusCode: 400,
        });
      }

      // Créer une transaction en attente
      const reference = await this.generateTransactionReference();

      // Générer un OTP (6 chiffres)
      const newOtpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

      // Désactiver les anciens OTP du client
      await this.prisma.otp.updateMany({
        where: {
          userId: user.id,
          isUsed: false,
          expiresAt: { gt: new Date() },
        },
        data: { isUsed: true },
      });

      // Créer le nouvel OTP
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

      // Créer la transaction en attente
      const pendingTransaction = await this.prisma.transaction.create({
        data: {
          id: crypto.randomUUID(),
          userId: user.id,
          walletId: wallet.id,
          amount,
          type: 'WITHDRAW',
          status: 'PENDING',
          reference: reference,
          description: `Retrait admin (en attente de OTP client)`,
          movement: 'DEBIT',
          currency: wallet.currency,
          paymentMethod: this.mapPaymentMethod(paymentMethod),
          external_reference: JSON.stringify({
            otpCode: newOtpCode,
            expiresAt: otpExpiry,
            adminId: adminId,
            attempts: 0
          }),
        },
      });

      // ✅ Envoyer l'OTP par SMS au CLIENT
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

      // Audit log
      await this.logAudit(
        admin.id,
        'adminCashoutRequest',
        { walletId, amount, transactionId: pendingTransaction.id, userId: user.id },
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
    // ✅ ICI on vérifie le PIN de l'admin

    // ✅ 1. Vérifier le PIN de l'admin
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

    // Vérifier si le PIN de l'admin est bloqué
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

    // Vérifier le PIN de l'admin
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

    // Réinitialiser les tentatives de PIN de l'admin
    await this.prisma.user.update({
      where: { id: admin.id },
      data: { failed_pin_attempts: 0, pin_locked_until: null },
    });

    // ✅ 2. Vérifier l'OTP du client
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

    // ✅ 3. Récupérer la transaction en attente
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

    // Vérifier l'expiration de la transaction
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

    // ========== EXÉCUTER LA TRANSACTION ==========
    const result = await this.prisma.$transaction(
      async (tx) => {
        const currentWallet = await tx.wallet.findFirst({
          where: { id: walletId },
          include: { user: true }
        });

        if (!currentWallet) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_not_found', lang),
            statusCode: 404,
          });
        }

        if (!currentWallet.isActive) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.wallet_inactive', lang),
            statusCode: 403,
          });
        }

        if (currentWallet.balance < amount) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.insufficient_wallet_balance', lang),
            statusCode: 400,
          });
        }

        const updated = await tx.wallet.update({
          where: { id: currentWallet.id },
          data: { balance: { decrement: amount }, updatedAt: new Date() },
        });

        const transaction = await tx.transaction.update({
          where: { id: pendingTx.id },
          data: {
            status: 'SUCCESS',
            description: `Retrait admin confirmé par le client (OTP) et admin (PIN)`,
            updatedAt: new Date(),
          },
        });

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
              adminPinVerified: true
            }),
            ipAddress: ipAddress || null,
            createdAt: new Date(),
          },
        });

        return { wallet: updated, transaction, user };
      },
      {
        timeout: 30000,
        maxWait: 30000,
      }
    );

    // ========== SMS DE CONFIRMATION AU CLIENT ==========
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
        console.log(`[AdminCashout] SMS confirmation envoyé au client ${cleanPhone}`);
      } catch (err) {
        console.error('[AdminCashout] Erreur envoi SMS:', err);
      }
    }

    // ========== NOTIFICATION PUSH AU CLIENT ==========
    await this.notificationHelper.notify(
      result.user.id,
      NotificationType.CASHOUT_SUCCESS,
      {
        amount,
        currency: result.wallet.currency || 'CDF',
        balance: result.wallet.balance || 0
      },
      'TRANSACTION',
      result.transaction.id,
      lang,
    );

    return {
      message: this.i18nService.translate('wallet.cashout_success', lang),
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
    const { adminId, fromWalletId, toPhone, amount, pin, description, lang = 'fr', ipAddress, countryCode } = dto;
    console.log('[WalletService] Admin Send:', { adminId, fromWalletId, toPhone, amount, lang, countryCode });

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
                countryCode: true,
                kycStatus: true,
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

        // 3️⃣ Récupérer le destinataire par téléphone
        const toUser = await tx.user.findFirst({
          where: { phone: toPhone },
          select: {
            id: true,
            full_name: true,
            phone: true,
            account_number: true,
            countryCode: true,
          },
        });
        if (!toUser) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.receiver_not_found', lang),
            statusCode: 404,
          });
        }

        // 4️⃣ Déterminer les pays et si transfert international
        const senderCountryCode = fromUser.countryCode || 'CD';
        let receiverCountryCode = toUser.countryCode || 'CD';

        if (countryCode) {
          receiverCountryCode = countryCode.toUpperCase();
        }

        const isInternational = senderCountryCode !== receiverCountryCode;

        // ✅ VÉRIFICATION KYC POUR LES TRANSFERTS INTERNATIONAUX
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

        // 5️⃣ Récupérer les frais internationaux
        let internationalFeePercentage = 0;
        let fee = 0;
        let debitAmount = amount;

        if (isInternational) {
          const fees = await this.getInternationalFeesByCountry(senderCountryCode, tx);
          internationalFeePercentage = fees.depositFee || 0;

          if (internationalFeePercentage > 0) {
            fee = (amount * internationalFeePercentage) / 100;
            debitAmount = amount + fee;
          }
        }

        // 6️⃣ Récupérer la devise du destinataire
        let targetCurrency: string = fromWallet.currency;
        let exchangeRate = 1;
        let convertedAmount = amount;

        if (isInternational) {
          const receiverCountry = await tx.country_provider.findFirst({
            where: {
              OR: [
                { countryCode: receiverCountryCode },
                { code: receiverCountryCode },
              ]
            },
            include: {
              country_currency: {
                include: { currency: true },
                where: { is_default: true },
                take: 1,
              }
            },
          });

          if (receiverCountry?.country_currency && receiverCountry.country_currency.length > 0) {
            const currencyCode = receiverCountry.country_currency[0].currency_code;
            const validCurrencies: string[] = ['USD', 'EUR', 'CDF', 'XOF', 'XAF', 'KES', 'RWF', 'UGX', 'ZMW', 'SLE'];
            if (validCurrencies.includes(currencyCode)) {
              targetCurrency = currencyCode;
            } else {
              targetCurrency = fromWallet.currency;
            }
          } else {
            targetCurrency = fromWallet.currency;
          }

          if (fromWallet.currency !== targetCurrency) {
            let rateRecord = await tx.exchange_rate.findFirst({
              where: {
                from_currency: fromWallet.currency,
                to_currency: targetCurrency,
              }
            });

            if (!rateRecord) {
              const fromToUsd = await tx.exchange_rate.findFirst({
                where: {
                  from_currency: fromWallet.currency,
                  to_currency: 'USD',
                }
              });

              const usdToTarget = await tx.exchange_rate.findFirst({
                where: {
                  from_currency: 'USD',
                  to_currency: targetCurrency,
                }
              });

              if (fromToUsd && usdToTarget) {
                exchangeRate = fromToUsd.rate * usdToTarget.rate;
              } else {
                throw new RpcException({
                  status: 'error',
                  message: this.i18nService.translate('wallet.exchange_rate_not_found', lang, {
                    from: fromWallet.currency,
                    to: targetCurrency,
                  }),
                  statusCode: 404,
                });
              }
            } else {
              exchangeRate = rateRecord.rate;
            }

            convertedAmount = amount * exchangeRate;
          }
        } else {
          targetCurrency = fromWallet.currency;
          exchangeRate = 1;
          convertedAmount = amount;
        }

        // 7️⃣ Récupérer ou créer le wallet du destinataire
        let toWallet = await tx.wallet.findFirst({
          where: {
            userId: toUser.id,
            currency: targetCurrency as any,
            isActive: true,
          },
        });

        if (!toWallet) {
          toWallet = await tx.wallet.create({
            data: {
              id: crypto.randomUUID(),
              userId: toUser.id,
              currency: targetCurrency as any,
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

        // 8️⃣ Vérifier le solde
        if (fromWallet.balance < debitAmount) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('wallet.insufficient_wallet_balance', lang),
            statusCode: 400
          });
        }

        // 9️⃣ Mettre à jour les soldes
        const updatedFrom = await tx.wallet.update({
          where: { id: fromWallet.id },
          data: { balance: { decrement: debitAmount }, updatedAt: new Date() },
        });
        const updatedTo = await tx.wallet.update({
          where: { id: toWallet.id },
          data: { balance: { increment: convertedAmount }, updatedAt: new Date() },
        });

        // 🔟 Construire les descriptions
        const toUserDisplay = toUser.full_name ? `${toUser.full_name} (${toUser.phone})` : toUser.phone;
        const fromUserDisplay = fromUser.full_name ? `${fromUser.full_name} (${fromUser.phone})` : fromUser.phone;

        let senderDescription = description || `Transfert vers ${toUserDisplay}`;
        if (fee > 0) {
          senderDescription += ` (frais ${internationalFeePercentage}%: ${fee} ${fromWallet.currency})`;
        }
        if (isInternational) {
          senderDescription += ` - Taux: 1 ${fromWallet.currency} = ${exchangeRate} ${targetCurrency}`;
        }

        let receiverDescription = description || `Reçu de ${fromUserDisplay}`;
        if (isInternational) {
          receiverDescription += ` - Taux: 1 ${fromWallet.currency} = ${exchangeRate} ${targetCurrency}`;
        }

        // 1️⃣1️⃣ Créer les transactions
        const reference = await this.generateTransactionReference('', tx);
        const transactionStatus = isInternational ? 'PENDING' : 'SUCCESS';

        const senderTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: fromUser.id,
            walletId: fromWallet.id,
            amount: debitAmount,
            type: 'TRANSFER',
            status: transactionStatus,
            reference: reference,
            currency: fromWallet.currency,
            description: senderDescription,
            paymentMethod: this.mapPaymentMethod(dto.paymentMethod),
            movement: 'DEBIT',
          },
        });

        const receiverTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: toUser.id,
            walletId: toWallet.id,
            amount: convertedAmount,
            type: 'DEPOSIT',
            status: transactionStatus,
            reference: reference,
            currency: targetCurrency,
            description: receiverDescription,
            movement: 'CREDIT',
          },
        });

        // 1️⃣2️⃣ Audit log
        await tx.audit_log.create({
          data: {
            id: crypto.randomUUID(),
            userId: admin.id,
            action: 'adminSend',
            details: JSON.stringify({ from: updatedFrom, to: updatedTo, toPhone, isInternational }),
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
          fee,
          internationalFeePercentage,
          debitAmount,
          receiverCountryCode,
          admin,
        };
      },
      {
        timeout: 30000,
        maxWait: 30000,
      }
    );

    // ========== SMS AUX DEUX PARTIES ==========
    // ✅ CORRECTION : Les transferts internationaux n'envoient PAS de SMS au destinataire
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

    // ✅ SMS au destinataire UNIQUEMENT si ce n'est pas un transfert international
    if (!result.isInternational && result.toUser.phone) {
      try {
        const cleanPhone = result.toUser.phone.replace(/[^0-9+]/g, '');
        const smsText = this.i18nService.translate('wallet.transfer_receiver_sms', lang, {
          full_name: result.toUser.full_name || '',
          amount: result.convertedAmount,
          currency: result.targetCurrency || 'CDF',
          fromPhone: result.fromUser.phone || '',
          balance: result.toWallet.balance || 0,
        });
        await this.smsService.sendSms(cleanPhone, smsText);
      } catch (err) {
        console.error('[AdminSend] Erreur envoi SMS:', err);
      }
    } else if (result.isInternational) {
      console.log('[AdminSend] 🌍 Transfert international admin en attente - Pas de SMS au destinataire');
    }

    // ========== NOTIFICATIONS PUSH ==========
    // ✅ CORRECTION : Les transferts internationaux n'envoient PAS de notification push au destinataire
    try {
      // Notification à l'expéditeur
      await notifyTransaction(
        this.smsService, this.notificationHelper, this.i18nService,
        this.shouldSendSms.bind(this), this.shouldSendPush.bind(this), this.getUserLanguage.bind(this),
        result.senderTx, result.fromUser, result.fromWallet,
        result.isInternational ? 'send_pending' : 'send_sent',
        { name: result.toUser.full_name ?? undefined, phone: result.toUser.phone ?? undefined }
      );

      // ✅ Notification au destinataire UNIQUEMENT si ce n'est pas international
      if (!result.isInternational) {
        await notifyTransaction(
          this.smsService, this.notificationHelper, this.i18nService,
          this.shouldSendSms.bind(this), this.shouldSendPush.bind(this), this.getUserLanguage.bind(this),
          result.receiverTx, result.toUser, result.toWallet,
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
          debitAmount: result.debitAmount,
          fromCurrency: result.fromWallet.currency,
          countryCode: result.receiverCountryCode,
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
            message: this.i18nService.translate('admin.pin_incorrect', lang),
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

        // 3️⃣ Récupérer le commerçant par son merchantCode
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
          console.log(`[AdminPay] 💰 Nouveau wallet créé en ${fromWallet.currency} pour le commerçant ${toUser.id}`);
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

        // 6️⃣ Créer les transactions avec descriptions enrichies
        const reference = await this.generateTransactionReference('', tx);
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
            reference: reference,
            currency: toWallet.currency,
            description: description || this.i18nService.translate('wallet.admin_pay_merchant_description', lang, {
              amount: amount,
              currency: toWallet.currency,
              payerName: fromUser.full_name || 'Client',
              payerPhone: fromUser.phone || 'N/A',
            }),
            movement: 'CREDIT',
          },
        });

        // 7️⃣ Audit log
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
    const where: any = {
      userId,
      status: 'SUCCESS',
    };
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
            reference: await this.generateTransactionReference('', tx),
            description: this.i18nService.translate('wallet.failed_description', lang, {
              reason: failureMessage,
            }),
            movement: 'CREDIT',
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
            reference: await this.generateTransactionReference('', tx),
            description,
            movement: 'CREDIT',
            currency: wallet.currency,
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
      data: { failed_pin_attempts: 0, pin_locked_until: null },
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

    // Récupérer les frais
    const fees = await this.getNetworkProviderFees(provider);
    const feeAmount = (amount * fees.payoutFee) / 100;
    const totalAmount = amount + feeAmount; // Montant total à débiter (montant + frais)
    const netAmount = amount; // Montant net envoyé à PawaPay

    console.log('[WalletService] Cashout fees:', {
      amount,
      feeAmount,
      totalAmount,
      netAmount,
      payoutFee: fees.payoutFee,
    });

    // Vérifier le solde (montant + frais)
    if (wallet.balance < totalAmount) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('wallet.insufficient_wallet_balance', lang),
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

    console.log('[WalletService] Appel PawaPay payout:', JSON.stringify(pawapayData, null, 2));

    try {
      const pawapayResponse = await this.pawapayService.createPayoutSimple(pawapayData);
      console.log('[WalletService] Réponse PawaPay payout:', JSON.stringify(pawapayResponse, null, 2));

      const payoutStatus = pawapayResponse.finalStatus?.data?.status;

      if (payoutStatus === 'COMPLETED') {
        paymentSucceeded = true;
        externalReference = pawapayResponse.payout?.payoutId;
      } else {
        // Récupérer les détails d'erreur de PawaPay
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

      // Extraire le message d'erreur de PawaPay
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
      // Construire le message d'erreur avec les détails PawaPay
      let failureMessage = this.i18nService.translate('wallet.payout_failed', lang, {
        reason: pawaPayErrorMessage || 'Unknown error',
        code: pawaPayErrorCode || 'UNKNOWN',
      });

      // Ajouter les détails supplémentaires
      if (pawaPayErrorDetails) {
        failureMessage = `${failureMessage} - Details: ${JSON.stringify(pawaPayErrorDetails)}`;
      }

      console.log('[WalletService] Cashout failure message:', failureMessage);

      // Créer la transaction failed
      let failedTransaction;
      try {
        failedTransaction = await this.prisma.$transaction(async (tx) => {
          return await tx.transaction.create({
            data: {
              id: crypto.randomUUID(),
              userId,
              walletId: wallet.id,
              amount: totalAmount,
              type: 'WITHDRAW',
              status: 'FAILED',
              reference: await this.generateTransactionReference('', tx),
              description: this.i18nService.translate('wallet.failed_description', lang, {
                reason: failureMessage,
              }),
              movement: 'DEBIT',
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
            ` (frais ${fees.payoutFee}% : ${feeAmount} ${wallet.currency}) - Net envoyé: ${netAmount} ${wallet.currency}` +
            ' ' +
            this.i18nService.translate('wallet.via_pawapay', lang, { provider }) +
            (externalReference ? ` Ref: ${externalReference}` : '');

          // Débiter le montant total (montant + frais)
          const upd = await tx.wallet.update({
            where: { id: wallet.id },
            data: { balance: { decrement: totalAmount }, updatedAt: new Date() },
          });

          const reference = await this.generateTransactionReference('', tx);
          const txRecord = await tx.transaction.create({
            data: {
              id: crypto.randomUUID(),
              userId,
              walletId: wallet.id,
              amount: totalAmount,
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

  // apps/wallet-service/src/wallet-service.service.ts

  async send(
    dto: SendDto,
    lang: string = 'fr',
    ipAddress: string,
  ): Promise<ApiResponse<{ wallet: WalletResponseDto; transaction: any }>> {
    const { fromWalletId, toPhone, amount, pin, description, countryCode } = dto;
    console.log('[WalletService] Send request:', { fromWalletId, toPhone, amount, lang, countryCode });

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
          console.log('[WalletService] 📌 CountryCode fourni par le client:', countryCode);
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

        // 4. Récupérer les frais internationaux dynamiques
        let internationalFeePercentage = 0;
        let fee = 0;
        let debitAmount = amount;

        if (isInternational) {
          const fees = await this.getInternationalFeesByCountry(senderCountryCode, tx);
          internationalFeePercentage = fees.depositFee || 0;

          if (internationalFeePercentage > 0) {
            fee = (amount * internationalFeePercentage) / 100;
            debitAmount = amount + fee;
            console.log('[WalletService] Frais internationaux appliqués:', {
              percentage: internationalFeePercentage,
              fee,
              debitAmount,
            });
          } else {
            console.log('[WalletService] Aucun frais international configuré pour', senderCountryCode);
          }
        } else {
          console.log('[WalletService] ✅ Même pays - Pas de frais');
          internationalFeePercentage = 0;
          fee = 0;
          debitAmount = amount;
        }

        console.log('[WalletService] Fee calculation:', {
          isInternational,
          amount,
          feePercentage: internationalFeePercentage,
          fee,
          debitAmount,
        });

        // 5. ✅ STRATÉGIE A : Utiliser le premier wallet actif du destinataire
        // Récupérer tous les wallets actifs du destinataire
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

        // ✅ INITIALISER AVEC LE PREMIER WALLET DU DESTINATAIRE
        let targetCurrency: string = receiverWallets[0].currency;
        let targetWallet: any = receiverWallets[0];

        if (isInternational) {
          // 🔍 Essayer de trouver la devise par défaut du pays du destinataire
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

          console.log('[WalletService] Devise préférée du destinataire:', preferredCurrency);

          // ✅ Chercher le wallet du destinataire dans la devise préférée
          if (preferredCurrency) {
            const foundWallet = receiverWallets.find(w => w.currency === preferredCurrency);
            if (foundWallet) {
              targetWallet = foundWallet;
              targetCurrency = preferredCurrency;
              console.log(`[WalletService] ✅ Wallet trouvé en ${targetCurrency} (devise préférée)`);
            }
          }

          // ✅ Si pas de wallet dans la devise préférée, utiliser le premier wallet actif
          if (!targetWallet || targetWallet.currency !== targetCurrency) {
            targetWallet = receiverWallets[0];
            targetCurrency = targetWallet.currency;
            console.log(`[WalletService] ⚠️ Aucun wallet en devise préférée, utilisation du premier wallet: ${targetCurrency}`);
          }
        } else {
          // 🔵 Transfert national : utiliser le premier wallet actif du destinataire
          targetWallet = receiverWallets[0];
          targetCurrency = targetWallet.currency;
          console.log(`[WalletService] 🔵 Transfert national, utilisation du premier wallet: ${targetCurrency}`);
        }

        console.log('[WalletService] Wallet cible du destinataire:', {
          id: targetWallet.id,
          currency: targetCurrency,
          balance: targetWallet.balance,
        });

        // 6. Calculer le taux de change et convertir si nécessaire
        let exchangeRate = 1;
        let convertedAmount = amount;

        if (fromWallet.currency !== targetCurrency) {
          let rateRecord = await tx.exchange_rate.findFirst({
            where: {
              from_currency: fromWallet.currency,
              to_currency: targetCurrency,
            }
          });

          if (!rateRecord) {
            const fromToUsd = await tx.exchange_rate.findFirst({
              where: {
                from_currency: fromWallet.currency,
                to_currency: 'USD',
              }
            });

            const usdToTarget = await tx.exchange_rate.findFirst({
              where: {
                from_currency: 'USD',
                to_currency: targetCurrency,
              }
            });

            if (fromToUsd && usdToTarget) {
              exchangeRate = fromToUsd.rate * usdToTarget.rate;
            } else {
              throw new RpcException({
                status: 'error',
                message: this.i18nService.translate('wallet.exchange_rate_not_found', lang, {
                  from: fromWallet.currency,
                  to: targetCurrency,
                }),
                statusCode: 404,
              });
            }
          } else {
            exchangeRate = rateRecord.rate;
          }

          convertedAmount = amount * exchangeRate;
          console.log('[WalletService] Conversion automatique:', {
            from: fromWallet.currency,
            to: targetCurrency,
            amount,
            rate: exchangeRate,
            convertedAmount,
          });
        }

        // 7. Vérifier le solde de l'expéditeur
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

        const updatedTo = await tx.wallet.update({
          where: { id: targetWallet.id },
          data: { balance: { increment: convertedAmount }, updatedAt: new Date() },
        });

        // 9. Construire les descriptions
        let senderDescription = description;
        let receiverDescription = description;

        const toUserDisplay = toUser.full_name ? `${toUser.full_name} (${toUser.phone})` : toUser.phone;
        const fromUserDisplay = fromUser.full_name ? `${fromUser.full_name} (${fromUser.phone})` : fromUser.phone;

        if (!senderDescription) {
          senderDescription = `Transfert vers ${toUserDisplay}`;
        } else {
          senderDescription = `${senderDescription} (vers: ${toUserDisplay})`;
        }

        if (fee > 0) {
          senderDescription += ` (frais ${internationalFeePercentage}%: ${fee} ${fromWallet.currency})`;
        }

        if (isInternational && fromWallet.currency !== targetCurrency) {
          senderDescription += ` - Taux: 1 ${fromWallet.currency} = ${exchangeRate} ${targetCurrency}`;
          if (countryCode) {
            senderDescription += ` - Pays: ${countryCode}`;
          }
        }

        if (!receiverDescription) {
          receiverDescription = `Reçu de ${fromUserDisplay}`;
        } else {
          receiverDescription = `${description} (de: ${fromUserDisplay})`;
        }

        if (isInternational && fromWallet.currency !== targetCurrency) {
          receiverDescription += ` - Taux: 1 ${fromWallet.currency} = ${exchangeRate} ${targetCurrency}`;
          if (countryCode) {
            receiverDescription += ` - Pays: ${countryCode}`;
          }
        }

        // 10. Créer les transactions
        const reference = await this.generateTransactionReference('', tx);

        // ✅ Déterminer le statut de la transaction
        // - Si international : PENDING (en attente de validation)
        // - Si national : SUCCESS (immédiat)
        const transactionStatus = isInternational ? 'PENDING' : 'SUCCESS';

        console.log('[WalletService] Transaction status:', {
          isInternational,
          transactionStatus,
          senderStatus: 'SUCCESS',
          receiverStatus: transactionStatus,
        });

        // ✅ Transaction expéditeur (DEBIT) - toujours SUCCESS
        const senderTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: fromUser.id,
            walletId: fromWallet.id,
            amount: debitAmount,
            type: 'TRANSFER',
            status: 'SUCCESS', // ✅ Débit immédiat
            reference: reference,
            description: senderDescription,
            movement: 'DEBIT',
            currency: fromWallet.currency,
          },
        });

        // ✅ Transaction destinataire (CREDIT) - PENDING si international
        const receiverTx = await tx.transaction.create({
          data: {
            id: crypto.randomUUID(),
            userId: toUser.id,
            walletId: targetWallet.id,
            amount: convertedAmount,
            type: 'DEPOSIT',
            status: 'PENDING', // ✅ PENDING si international, SUCCESS sinon
            reference: reference,
            description: receiverDescription,
            movement: 'CREDIT',
            currency: targetCurrency,
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
          isInternational,
          exchangeRate,
          convertedAmount,
          targetCurrency,
          fee,
          internationalFeePercentage,
          debitAmount,
          receiverCountryCode,
        };
      },
      { timeout: 60000, maxWait: 60000 },
    );

    // ========== NOTIFICATIONS ==========
    try {
      if (!result.isInternational) {
        // 🔵 Transfert national - Notifier les deux parties
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
        // 🌍 Transfert international - Notifier SEULEMENT l'expéditeur
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
          amount: result.convertedAmount,
          currency: result.targetCurrency,
          rate: result.exchangeRate,
          fee: result.fee,
          feePercentage: result.internationalFeePercentage,
          debitAmount: result.debitAmount,
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
          where: { phone: toPhone, role: 'MERCHANT' },
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
          where: { merchantCode, role: 'MERCHANT' },
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
        if (newAttempts >= 5) {
          newStatus = user_status.BLOCKED;
          lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
        }
        await this.prisma.user.update({
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
      await this.prisma.user.update({
        where: { id: fromUser.id },
        data: { failed_pin_attempts: 0 },
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
        console.error('[Pay] Erreur envoi SMS au payeur:', err);
      }
    }

    if (result.toUser.phone) {
      try {
        const cleanPhone = result.toUser.phone.replace(/[^0-9+]/g, '');
        const smsText = this.i18nService.translate('wallet.payment_merchant_sms', lang, {
          full_name: result.toUser.full_name || '',
          amount: amount,
          currency: result.merchantWallet.currency || 'CDF',
          payerName: result.fromUser.full_name || '',
          balance: result.merchantWallet.balance || 0,
        });
        await this.smsService.sendSms(cleanPhone, smsText);
      } catch (err) {
        console.error('[Pay] Erreur envoi SMS au commerçant:', err);
      }
    }

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
          result.fromWallet,
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
            phone: result.fromUser.phone ?? undefined,
          },
        ),
      ]);
    } catch (err) {
      console.error('[Notifications] Pay notification error:', err);
    }

    // ✅ Format unifié
    return {
      message: this.i18nService.translate('wallet.payment_success', lang),
      data: {
        wallet: this.toResponse(result.fromWallet),
        transaction: result.payerTx,
      },
    };
  }

  // apps/wallet-service/src/wallet-service.service.ts

  async validateInternationalTransfer(
    transactionId: string,
    adminId: string,
    adminPin: string,
    lang: string = 'fr',
    ipAddress?: string,
  ): Promise<ApiResponse<{ transaction: any; fromWallet: WalletResponseDto; toWallet: WalletResponseDto }>> {
    console.log('[WalletService] Validate international transfer:', { transactionId, adminId, lang });

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
      },
    });

    if (!admin) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('admin.not_found', lang),
        statusCode: 404,
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
      if (newAttempts >= 5) {
        await this.prisma.user.update({
          where: { id: admin.id },
          data: { failed_pin_attempts: newAttempts, status: user_status.BLOCKED },
        });
      }
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

    // 3️⃣ Récupérer la transaction (uniquement PENDING)
    console.log('[WalletService] Searching for transaction:', transactionId);

    const transaction = await this.prisma.transaction.findFirst({
      where: {
        id: transactionId,
        status: 'PENDING', // ✅ UNIQUEMENT PENDING
        type: 'TRANSFER',
        movement: 'DEBIT',
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
        wallet: {
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
        },
      },
    });

    console.log('[WalletService] Transaction found:', transaction ? transaction.id : 'NOT FOUND');

    if (!transaction) {
      throw new RpcException({
        status: 'error',
        message: 'Transaction PENDING non trouvée. Vérifiez que la transaction est en attente.',
        statusCode: 404,
      });
    }

    // 4️⃣ Vérifier que c'est bien un transfert international
    const isInternational = transaction.description?.includes('Taux:') ||
      transaction.description?.includes('international') ||
      transaction.description?.match(/Pays:\s*([A-Z]{2})/i) ||
      transaction.description?.match(/\(\+?\d{10,15}\)/);

    console.log('[WalletService] Is international:', isInternational);

    if (!isInternational) {
      throw new RpcException({
        status: 'error',
        message: 'Cette transaction n\'est pas un transfert international',
        statusCode: 400,
      });
    }

    // 5️⃣ Récupérer la transaction réceptrice (CREDIT en PENDING)
    console.log('[WalletService] Searching for receiver transaction with reference:', transaction.reference);

    const receiverTransaction = await this.prisma.transaction.findFirst({
      where: {
        reference: transaction.reference,
        movement: 'CREDIT',
        type: 'DEPOSIT',
        status: 'PENDING', // ✅ UNIQUEMENT PENDING
      },
      include: {
        wallet: {
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
        },
      },
    });

    console.log('[WalletService] Receiver transaction found:', receiverTransaction ? receiverTransaction.id : 'NOT FOUND');

    if (!receiverTransaction) {
      throw new RpcException({
        status: 'error',
        message: 'Transaction réceptrice PENDING non trouvée',
        statusCode: 404,
      });
    }

    // 6️⃣ Valider la transaction - PASSER DE PENDING À SUCCESS
    const result = await this.prisma.$transaction(async (tx) => {
      // ✅ Mettre à jour la transaction expéditeur
      const updatedSender = await tx.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'SUCCESS',
          updatedAt: new Date(),
          description: transaction.description + ' (Validé par admin)',
        },
      });

      // ✅ Mettre à jour la transaction réceptrice
      const updatedReceiver = await tx.transaction.update({
        where: { id: receiverTransaction.id },
        data: {
          status: 'SUCCESS',
          updatedAt: new Date(),
          description: receiverTransaction.description + ' (Validé par admin)',
        },
      });

      // ✅ CRÉDITER LE WALLET DU DESTINATAIRE
      const updatedWallet = await tx.wallet.update({
        where: { id: receiverTransaction.walletId },
        data: {
          balance: { increment: receiverTransaction.amount },
          updatedAt: new Date(),
        },
      });

      // ✅ Audit log
      await tx.audit_log.create({
        data: {
          id: crypto.randomUUID(),
          userId: admin.id,
          action: 'validateInternationalTransfer',
          details: JSON.stringify({
            transactionId: transaction.id,
            reference: transaction.reference,
            amount: transaction.amount,
            senderId: transaction.userId,
            receiverId: receiverTransaction.userId,
            previousStatus: transaction.status,
            newStatus: 'SUCCESS',
          }),
          ipAddress: ipAddress || null,
          createdAt: new Date(),
        },
      });

      return {
        senderTx: updatedSender,
        receiverTx: updatedReceiver,
        wallet: updatedWallet
      };
    });

    // 7️⃣ 🔔 NOTIFICATIONS APRÈS VALIDATION
    const sender = transaction.user;
    const senderWallet = transaction.wallet;
    const receiver = receiverTransaction.wallet.user;
    const receiverWallet = receiverTransaction.wallet;
    const receiverWalletId = receiverTransaction.walletId;

    // ✅ SMS et PUSH à l'expéditeur
    try {
      await notifyTransaction(
        this.smsService,
        this.notificationHelper,
        this.i18nService,
        this.shouldSendSms.bind(this),
        this.shouldSendPush.bind(this),
        this.getUserLanguage.bind(this),
        result.senderTx,
        sender,
        senderWallet,
        'send_confirmed',
        {
          name: receiver.full_name ?? undefined,
          phone: receiver.phone ?? undefined,
        },
      );
    } catch (err) {
      console.error('[Notifications] Error sending to sender:', err);
    }

    // ✅ SMS et PUSH au destinataire (MAINTENANT SEULEMENT)
    try {
      // SMS au destinataire
      if (receiver.phone) {
        const cleanPhone = receiver.phone.replace(/[^0-9+]/g, '');
        const smsText = this.i18nService.translate('wallet.transfer_received_confirmed_sms', lang, {
          full_name: receiver.full_name || 'Cher client',
          amount: receiverTransaction.amount,
          currency: receiverTransaction.currency || 'CDF',
          fromName: sender.full_name || 'Expéditeur',
          balance: result.wallet.balance || 0,
        });
        await this.smsService.sendSms(cleanPhone, smsText);
        console.log(`[validateInternationalTransfer] SMS envoyé au destinataire ${cleanPhone}`);
      }

      // PUSH au destinataire
      await notifyTransaction(
        this.smsService,
        this.notificationHelper,
        this.i18nService,
        this.shouldSendSms.bind(this),
        this.shouldSendPush.bind(this),
        this.getUserLanguage.bind(this),
        result.receiverTx,
        receiver,
        receiverWallet,
        'send_received',
        {
          name: sender.full_name ?? undefined,
          phone: sender.phone ?? undefined,
        },
      );
    } catch (err) {
      console.error('[Notifications] Error sending to receiver:', err);
    }

    // ✅ Notification PUSH au destinataire via NotificationHelper
    try {
      await this.notificationHelper.notify(
        receiver.id,
        NotificationType.TRANSFER_RECEIVED,
        {
          amount: receiverTransaction.amount,
          currency: receiverTransaction.currency || 'CDF',
          fromName: sender.full_name || 'Expéditeur',
          balance: result.wallet.balance || 0,
        },
        'TRANSACTION',
        receiverTransaction.id,
        lang,
      );
    } catch (err) {
      console.error('[Notifications] Push notification error for receiver:', err);
    }

    return {
      message: this.i18nService.translate('wallet.transfer_validated_success', lang),
      data: {
        transaction: result.senderTx,
        fromWallet: this.toResponse(senderWallet),
        toWallet: this.toResponse(receiverWallet),
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

  // apps/wallet-service/src/wallet-service.service.ts

  /**
   * Calcule les frais de transfert international
   * Basé sur le pays du wallet (expéditeur) et le pays de destination (countryCode)
   */
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


  // apps/wallet-service/src/wallet-service.service.ts

  /**
   * Récupère le dashboard d'un wallet
   */
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