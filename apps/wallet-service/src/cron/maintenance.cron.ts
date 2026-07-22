// apps/wallet-service/src/services/maintenance.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { I18nService } from '@app/common';
import { SmsService } from 'apps/auth-service/src/sms/sms.service';
import { NotificationHelper } from 'apps/notification-service/src/helpers/NotificationHelper';
import { NotificationType } from 'apps/notification-service/src/type/notification-type';
import * as crypto from 'crypto';

@Injectable()
export class MaintenanceService {
    private readonly logger = new Logger(MaintenanceService.name);
    private isRunning = false;

    private translations: Record<string, Record<string, string | ((params: any) => string)>> = {
        'wallet.maintenance.no_users': {
            fr: 'Aucun utilisateur actif trouvé pour la maintenance',
            en: 'No active users found for maintenance',
            sw: 'Hakuna watumiaji wanaofanya kazi waliopatikana kwa matengenezo',
            es: 'No se encontraron usuarios activos para el mantenimiento',
            ar: 'لم يتم العثور على مستخدمين نشطين للصيانة'
        },
        'wallet.maintenance.no_fee': {
            fr: 'Aucun frais à prélever',
            en: 'No fee to collect',
            sw: 'Hakuna ada ya kukusanya',
            es: 'No hay comisión que cobrar',
            ar: 'لا توجد رسوم للتحصيل'
        },
        'wallet.maintenance.no_wallet': {
            fr: 'Aucun portefeuille actif trouvé',
            en: 'No active wallet found',
            sw: 'Hakuna pochi inayofanya kazi iliyopatikana',
            es: 'No se encontró ninguna billetera activa',
            ar: 'لم يتم العثور على محفظة نشطة'
        },
        'wallet.maintenance.insufficient_balance': {
            fr: (p: any) => `Solde insuffisant: ${p.balance} ${p.currency}, requis: ${p.required} ${p.currency}`,
            en: (p: any) => `Insufficient balance: ${p.balance} ${p.currency}, required: ${p.required} ${p.currency}`,
            sw: (p: any) => `Salio lisilotosha: ${p.balance} ${p.currency}, inahitajika: ${p.required} ${p.currency}`,
            es: (p: any) => `Saldo insuficiente: ${p.balance} ${p.currency}, requerido: ${p.required} ${p.currency}`,
            ar: (p: any) => `الرصيد غير كاف: ${p.balance} ${p.currency}، المطلوب: ${p.required} ${p.currency}`
        },
        'wallet.maintenance.fee_debit': {
            fr: (p: any) => `Frais de maintenance mensuels (${p.country}) - ${p.role} - ${p.amount} ${p.currency}`,
            en: (p: any) => `Monthly maintenance fee (${p.country}) - ${p.role} - ${p.amount} ${p.currency}`,
            sw: (p: any) => `Ada ya matengenezo ya kila mwezi (${p.country}) - ${p.role} - ${p.amount} ${p.currency}`,
            es: (p: any) => `Comisión de mantenimiento mensual (${p.country}) - ${p.role} - ${p.amount} ${p.currency}`,
            ar: (p: any) => `رسوم الصيانة الشهرية (${p.country}) - ${p.role} - ${p.amount} ${p.currency}`
        },
        'wallet.maintenance.fee_credit': {
            fr: (p: any) => `Frais de maintenance reçus de ${p.user} (${p.country}) - ${p.amount} ${p.currency}`,
            en: (p: any) => `Maintenance fee received from ${p.user} (${p.country}) - ${p.amount} ${p.currency}`,
            sw: (p: any) => `Ada ya matengenezo imepokelewa kutoka ${p.user} (${p.country}) - ${p.amount} ${p.currency}`,
            es: (p: any) => `Comisión de mantenimiento recibida de ${p.user} (${p.country}) - ${p.amount} ${p.currency}`,
            ar: (p: any) => `تم استلام رسوم الصيانة من ${p.user} (${p.country}) - ${p.amount} ${p.currency}`
        },
        'wallet.maintenance.completed': {
            fr: (p: any) => `Frais de maintenance exécutés: ${p.total} prélevés sur ${p.users} utilisateurs et ${p.merchants} marchands`,
            en: (p: any) => `Maintenance fees executed: ${p.total} collected from ${p.users} users and ${p.merchants} merchants`,
            sw: (p: any) => `Ada za matengenezo zimetekelezwa: ${p.total} zilizokusanywa kutoka kwa watumiaji ${p.users} na wafanyabiashara ${p.merchants}`,
            es: (p: any) => `Comisiones de mantenimiento ejecutadas: ${p.total} cobradas a ${p.users} usuarios y ${p.merchants} comerciantes`,
            ar: (p: any) => `تم تنفيذ رسوم الصيانة: تم تحصيل ${p.total} من ${p.users} مستخدم و ${p.merchants} تاجر`
        },
        'wallet.maintenance.stats': {
            fr: (p: any) => `Statistiques de maintenance: ${p.total} prélevés sur ${p.users} utilisateurs et ${p.merchants} marchands`,
            en: (p: any) => `Maintenance statistics: ${p.total} collected from ${p.users} users and ${p.merchants} merchants`,
            sw: (p: any) => `Takwimu za matengenezo: ${p.total} zilizokusanywa kutoka kwa watumiaji ${p.users} na wafanyabiashara ${p.merchants}`,
            es: (p: any) => `Estadísticas de mantenimiento: ${p.total} cobradas a ${p.users} usuarios y ${p.merchants} comerciantes`,
            ar: (p: any) => `إحصائيات الصيانة: تم تحصيل ${p.total} من ${p.users} مستخدم و ${p.merchants} تاجر`
        },
        'wallet.maintenance.sms': {
            fr: (p: any) => `Bonjour ${p.full_name}, des frais de maintenance de ${p.amount} ${p.currency} ont été prélevés sur votre compte. Merci de votre confiance.`,
            en: (p: any) => `Hello ${p.full_name}, a maintenance fee of ${p.amount} ${p.currency} has been deducted from your account. Thank you for your trust.`,
            sw: (p: any) => `Habari ${p.full_name}, ada ya matengenezo ya ${p.amount} ${p.currency} imetolewa kwenye akaunti yako. Asante kwa imani yako.`,
            es: (p: any) => `Hola ${p.full_name}, se ha deducido una comisión de mantenimiento de ${p.amount} ${p.currency} de su cuenta. Gracias por su confianza.`,
            ar: (p: any) => `مرحباً ${p.full_name}، تم خصم رسوم صيانة بقيمة ${p.amount} ${p.currency} من حسابك. شكراً لثقتك.`
        },
        'wallet.maintenance.notification_title': {
            fr: 'Frais de maintenance mensuels',
            en: 'Monthly maintenance fee',
            sw: 'Ada ya matengenezo ya kila mwezi',
            es: 'Comisión de mantenimiento mensual',
            ar: 'رسوم الصيانة الشهرية'
        },
        'wallet.maintenance.notification_body': {
            fr: (p: any) => `Des frais de maintenance de ${p.amount} ${p.currency} ont été prélevés sur votre compte (${p.country}).`,
            en: (p: any) => `A maintenance fee of ${p.amount} ${p.currency} has been deducted from your account (${p.country}).`,
            sw: (p: any) => `Ada ya matengenezo ya ${p.amount} ${p.currency} imetolewa kwenye akaunti yako (${p.country}).`,
            es: (p: any) => `Se ha deducido una comisión de mantenimiento de ${p.amount} ${p.currency} de su cuenta (${p.country}).`,
            ar: (p: any) => `تم خصم رسوم صيانة بقيمة ${p.amount} ${p.currency} من حسابك (${p.country}).`
        },
        'wallet.maintenance.selection_reason': {
            fr: (p: any) => `Wallet sélectionné: ${p.currency} - Raison: ${p.reason}`,
            en: (p: any) => `Selected wallet: ${p.currency} - Reason: ${p.reason}`,
            sw: (p: any) => `Pochi iliyochaguliwa: ${p.currency} - Sababu: ${p.reason}`,
            es: (p: any) => `Billetera seleccionada: ${p.currency} - Razón: ${p.reason}`,
            ar: (p: any) => `المحفظة المختارة: ${p.currency} - السبب: ${p.reason}`
        }
    };

    private t(key: string, lang: string, params?: any): string {
        const translation = this.translations[key]?.[lang];
        if (!translation) {
            this.logger.warn(`Missing translation for key: ${key}, lang: ${lang}`);
            return key;
        }
        if (typeof translation === 'function') {
            return translation(params);
        }
        return translation;
    }

    constructor(
        private readonly prisma: PrismaService,
        private readonly smsService: SmsService,
        private readonly notificationHelper: NotificationHelper,
        private readonly i18nService: I18nService,
    ) { }

    /**
     * Récupère le taux de change entre deux devises (DYNAMIQUE)
     */
    private async getExchangeRate(from: string, to: string): Promise<number> {
        if (from === to) return 1;

        const rates = await this.prisma.exchange_rate.findMany({
            where: {
                OR: [
                    { from_currency: from, to_currency: to },
                    { from_currency: from, to_currency: 'USD' },
                    { from_currency: 'USD', to_currency: to },
                    { from_currency: to, to_currency: from },
                    { from_currency: to, to_currency: 'USD' },
                    { from_currency: 'USD', to_currency: from },
                ],
            },
        });

        const rateMap = new Map<string, number>();
        rates.forEach(r => {
            rateMap.set(`${r.from_currency}-${r.to_currency}`, r.rate);
        });

        const directKey = `${from}-${to}`;
        if (rateMap.has(directKey)) {
            return rateMap.get(directKey)!;
        }

        const inverseKey = `${to}-${from}`;
        if (rateMap.has(inverseKey)) {
            const inverseRate = rateMap.get(inverseKey)!;
            if (inverseRate > 0) {
                return 1 / inverseRate;
            }
        }

        const fromToUsdKey = `${from}-USD`;
        const usdToTargetKey = `USD-${to}`;
        if (rateMap.has(fromToUsdKey) && rateMap.has(usdToTargetKey)) {
            return rateMap.get(fromToUsdKey)! * rateMap.get(usdToTargetKey)!;
        }

        const toToUsdKey = `${to}-USD`;
        const usdToFromKey = `USD-${from}`;
        if (rateMap.has(toToUsdKey) && rateMap.has(usdToFromKey)) {
            return 1 / (rateMap.get(toToUsdKey)! * rateMap.get(usdToFromKey)!);
        }

        const availableCurrencies = await this.prisma.currency.findMany({
            select: { code: true },
        });

        for (const currency of availableCurrencies) {
            if (currency.code === from || currency.code === to) continue;

            const fromToInterKey = `${from}-${currency.code}`;
            const interToTargetKey = `${currency.code}-${to}`;

            if (rateMap.has(fromToInterKey) && rateMap.has(interToTargetKey)) {
                return rateMap.get(fromToInterKey)! * rateMap.get(interToTargetKey)!;
            }
        }

        this.logger.warn(`Taux de change non trouvé pour ${from} -> ${to}, utilisation de 1`);
        return 1;
    }

    /**
     * Récupère le pays d'un utilisateur (DYNAMIQUE)
     */
    private async getUserCountry(user: any): Promise<any> {
        const countryCode = user.countryCode || 'CD';

        const country = await this.prisma.country_provider.findFirst({
            where: {
                OR: [
                    { countryCode: countryCode },
                    { code: countryCode },
                ],
            },
        });

        if (!country) {
            this.logger.warn(`Pays non trouvé pour ${countryCode}, utilisation des valeurs par défaut`);
            return {
                maintenance_fee: 0.5,
                merchant_maintenance_multiplier: 2,
                name: countryCode,
            };
        }

        return country;
    }

    /**
     * Compte le nombre de transactions pour un wallet donné (DYNAMIQUE)
     */
    private async getWalletTransactionCount(walletId: string): Promise<number> {
        const count = await this.prisma.transaction.count({
            where: {
                walletId: walletId,
                status: 'SUCCESS',
            },
        });
        return count;
    }

    /**
     * Sélectionne le meilleur wallet pour la maintenance (DYNAMIQUE)
     * Priorité: 1. USD, 2. Plus grand solde, 3. Plus de transactions
     */
    private async selectBestWalletForMaintenance(
        user: any,
        wallets: any[],
        feeUSD: number,
    ): Promise<{
        wallet: any;
        feeInWalletCurrency: number;
        conversionRate: number;
        originalCurrency: string;
        selectionReason: string;
    }> {
        // ✅ 1. Priorité au wallet USD
        const usdWallet = wallets.find(w => w.currency === 'USD');
        if (usdWallet && usdWallet.balance >= feeUSD) {
            return {
                wallet: usdWallet,
                feeInWalletCurrency: feeUSD,
                conversionRate: 1,
                originalCurrency: 'USD',
                selectionReason: 'Wallet USD avec solde suffisant',
            };
        }

        // ✅ 2. Chercher le wallet avec le plus grand solde en USD (converti)
        let bestWallet: any = null;
        let bestBalanceInUSD = 0;
        let bestRate = 1;

        for (const wallet of wallets) {
            const rate = await this.getExchangeRate(wallet.currency, 'USD');
            const balanceInUSD = wallet.balance * rate;

            if (balanceInUSD > bestBalanceInUSD) {
                bestBalanceInUSD = balanceInUSD;
                bestWallet = wallet;
                bestRate = rate;
            }
        }

        if (bestWallet && bestBalanceInUSD >= feeUSD) {
            const feeInWalletCurrency = feeUSD / bestRate;
            return {
                wallet: bestWallet,
                feeInWalletCurrency: feeInWalletCurrency,
                conversionRate: bestRate,
                originalCurrency: bestWallet.currency,
                selectionReason: `Plus grand solde (${bestBalanceInUSD} USD)`,
            };
        }

        // ✅ 3. Si aucun wallet n'a assez de solde, chercher le wallet avec le plus de transactions
        let walletWithMostTransactions: any = null;
        let maxTransactions = 0;
        let rateForMostTransactions = 1;

        for (const wallet of wallets) {
            const txCount = await this.getWalletTransactionCount(wallet.id);
            const rate = await this.getExchangeRate(wallet.currency, 'USD');

            this.logger.log(`Wallet ${wallet.currency}: ${txCount} transactions, balance: ${wallet.balance} ${wallet.currency} (${wallet.balance * rate} USD)`);

            if (txCount > maxTransactions) {
                maxTransactions = txCount;
                walletWithMostTransactions = wallet;
                rateForMostTransactions = rate;
            }
        }

        if (walletWithMostTransactions) {
            const feeInWalletCurrency = feeUSD / rateForMostTransactions;
            return {
                wallet: walletWithMostTransactions,
                feeInWalletCurrency: feeInWalletCurrency,
                conversionRate: rateForMostTransactions,
                originalCurrency: walletWithMostTransactions.currency || 'USD',
                selectionReason: `Plus de transactions (${maxTransactions} transactions)`,
            };
        }

        // ✅ 4. Fallback: premier wallet actif
        const fallbackWallet = wallets[0];
        const rate = await this.getExchangeRate(fallbackWallet.currency, 'USD');
        return {
            wallet: fallbackWallet,
            feeInWalletCurrency: feeUSD / rate,
            conversionRate: rate,
            originalCurrency: fallbackWallet.currency || 'USD',
            selectionReason: 'Fallback - premier wallet',
        };
    }

    /**
     * Exécute les frais de maintenance mensuels
     */
    // @Cron('0 0 1 * *')
    @Cron('*/5 * * * *')
    async runMonthlyMaintenance(lang: string = 'fr'): Promise<{
        message: string;
        data: {
            totalUsers: number;
            totalMerchants: number;
            totalCollected: number;
            byCountry: {
                countryCode: string;
                countryName: string;
                fee: number;
                users: number;
                merchants: number;
                collected: number;
            }[];
            details: {
                userId: string;
                name: string | null;
                role: string;
                country: string;
                success: boolean;
                collected?: boolean;
                amount?: number;
                reason?: string;
                walletId?: string;
                balance?: number;
                required?: number;
                newBalance?: number;
                transactionId?: string;
                systemTransactionId?: string;
                error?: string;
                selectedWalletReason?: string;
            }[];
            summary: {
                usersDebited: number;
                merchantsDebited: number;
                totalDebited: number;
                failed: number;
            };
        };
    }> {
        if (this.isRunning) {
            this.logger.warn('runMonthlyMaintenance already running, skipping');
            return {
                message: 'Maintenance already running',
                data: {
                    totalUsers: 0,
                    totalMerchants: 0,
                    totalCollected: 0,
                    byCountry: [],
                    details: [],
                    summary: {
                        usersDebited: 0,
                        merchantsDebited: 0,
                        totalDebited: 0,
                        failed: 0,
                    },
                },
            };
        }
        this.isRunning = true;

        this.logger.log('========== STARTING MONTHLY MAINTENANCE ==========');
        const startTime = Date.now();

        try {
            const users = await this.prisma.user.findMany({
                where: {
                    status: 'ACTIVE',
                    is_maintenance_exempt: false,
                    deleted: false,
                },
                include: {
                    wallets: {
                        where: { isActive: true },
                    },
                },
            });

            this.logger.log(`Found ${users.length} active users`);

            if (users.length === 0) {
                return {
                    message: this.t('wallet.maintenance.no_users', lang),
                    data: {
                        totalUsers: 0,
                        totalMerchants: 0,
                        totalCollected: 0,
                        byCountry: [],
                        details: [],
                        summary: {
                            usersDebited: 0,
                            merchantsDebited: 0,
                            totalDebited: 0,
                            failed: 0,
                        },
                    },
                };
            }

            let totalCollected = 0;
            let usersDebited = 0;
            let merchantsDebited = 0;
            let failedCount = 0;
            const details: {
                userId: string;
                name: string | null;
                role: string;
                country: string;
                success: boolean;
                collected?: boolean;
                amount?: number;
                reason?: string;
                walletId?: string;
                balance?: number;
                required?: number;
                newBalance?: number;
                transactionId?: string;
                systemTransactionId?: string;
                error?: string;
                selectedWalletReason?: string;
            }[] = [];
            const countryStats = new Map();

            for (const user of users) {
                try {
                    const result = await this.processUserMaintenance(user, lang);
                    details.push(result);

                    const countryCode = user.countryCode || 'CD';
                    if (!countryStats.has(countryCode)) {
                        const country = await this.getUserCountry(user);
                        countryStats.set(countryCode, {
                            countryCode: countryCode,
                            countryName: country.name || countryCode,
                            fee: country.maintenance_fee || 0,
                            users: 0,
                            merchants: 0,
                            collected: 0,
                        });
                    }

                    const stats = countryStats.get(countryCode);
                    if (result.success && result.collected) {
                        totalCollected += result.amount || 0;
                        stats.collected += result.amount || 0;
                        if (user.role === 'MERCHANT') {
                            merchantsDebited++;
                            stats.merchants++;
                        } else {
                            usersDebited++;
                            stats.users++;
                        }
                    } else if (!result.success) {
                        failedCount++;
                    }
                } catch (error: any) {
                    this.logger.error(`Error for user ${user.id}:`, error);
                    failedCount++;
                    details.push({
                        userId: user.id,
                        name: user.full_name,
                        role: user.role,
                        country: user.countryCode || 'CD',
                        success: false,
                        error: error.message || 'Unknown error',
                    });
                }
            }

            const executionTime = (Date.now() - startTime) / 1000;

            await this.prisma.audit_log.create({
                data: {
                    id: crypto.randomUUID(),
                    userId: null,
                    action: 'MONTHLY_MAINTENANCE',
                    details: JSON.stringify({
                        totalUsers: users.length,
                        totalCollected,
                        usersDebited,
                        merchantsDebited,
                        failedCount,
                        executionTime,
                        byCountry: Array.from(countryStats.values()),
                        date: new Date(),
                    }),
                    createdAt: new Date(),
                },
            });

            this.logger.log(`========== COMPLETED in ${executionTime}s ==========`);

            return {
                message: this.t('wallet.maintenance.completed', lang, {
                    total: totalCollected,
                    users: usersDebited,
                    merchants: merchantsDebited,
                }),
                data: {
                    totalUsers: users.length,
                    totalMerchants: users.filter(u => u.role === 'MERCHANT').length,
                    totalCollected,
                    byCountry: Array.from(countryStats.values()),
                    details,
                    summary: {
                        usersDebited,
                        merchantsDebited,
                        totalDebited: usersDebited + merchantsDebited,
                        failed: failedCount,
                    },
                },
            };
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Traite les frais de maintenance pour un utilisateur individuel (DYNAMIQUE)
     */
    private async processUserMaintenance(
        user: any,
        lang: string,
    ): Promise<{
        userId: string;
        name: string | null;
        role: string;
        country: string;
        success: boolean;
        collected: boolean;
        amount: number;
        reason?: string;
        walletId?: string;
        balance?: number;
        required?: number;
        newBalance?: number;
        transactionId?: string;
        systemTransactionId?: string;
        error?: string;
        selectedWalletReason?: string;
    }> {
        const isMerchant = user.role === 'MERCHANT';
        const country = await this.getUserCountry(user);

        let baseFeeUSD = country.maintenance_fee || 0;
        let finalFeeUSD = baseFeeUSD;

        if (isMerchant) {
            const multiplier = country.merchant_maintenance_multiplier || 2;
            finalFeeUSD = baseFeeUSD * multiplier;
        }

        if (user.maintenance_fee && user.maintenance_fee > 0) {
            finalFeeUSD = user.maintenance_fee;
        }

        this.logger.log(`User ${user.id} - ${user.role}: baseFeeUSD=${baseFeeUSD}, finalFeeUSD=${finalFeeUSD}`);

        if (finalFeeUSD <= 0) {
            return {
                userId: user.id,
                name: user.full_name,
                role: user.role,
                country: country.name || user.countryCode || 'CD',
                success: true,
                collected: false,
                amount: 0,
                reason: this.t('wallet.maintenance.no_fee', lang),
            };
        }

        if (!user.wallets || user.wallets.length === 0) {
            return {
                userId: user.id,
                name: user.full_name,
                role: user.role,
                country: country.name || user.countryCode || 'CD',
                success: false,
                collected: false,
                amount: finalFeeUSD,
                reason: this.t('wallet.maintenance.no_wallet', lang),
            };
        }

        const selection = await this.selectBestWalletForMaintenance(user, user.wallets, finalFeeUSD);
        const { wallet: selectedWallet, feeInWalletCurrency, conversionRate, originalCurrency, selectionReason } = selection;

        this.logger.log(`Wallet sélectionné: ${selectedWallet.currency} (${selectedWallet.balance}) - Frais: ${feeInWalletCurrency} ${selectedWallet.currency} - Raison: ${selectionReason}`);

        if (selectedWallet.balance < feeInWalletCurrency) {
            return {
                userId: user.id,
                name: user.full_name,
                role: user.role,
                country: country.name || user.countryCode || 'CD',
                success: false,
                collected: false,
                amount: finalFeeUSD,
                reason: this.t('wallet.maintenance.insufficient_balance', lang, {
                    balance: selectedWallet.balance,
                    required: feeInWalletCurrency,
                    currency: selectedWallet.currency,
                }),
                walletId: selectedWallet.id,
                balance: selectedWallet.balance,
                required: feeInWalletCurrency,
                selectedWalletReason: selectionReason,
            };
        }

        const systemUserId = process.env.SYSTEM_USER_ID || 'system-maintenance-account';

        const result = await this.prisma.$transaction(async (tx) => {
            const updatedWallet = await tx.wallet.update({
                where: { id: selectedWallet.id },
                data: {
                    balance: { decrement: feeInWalletCurrency },
                    updatedAt: new Date(),
                },
            });

            const userTransaction = await tx.transaction.create({
                data: {
                    id: crypto.randomUUID(),
                    userId: user.id,
                    walletId: selectedWallet.id,
                    amount: feeInWalletCurrency,
                    type: 'WITHDRAW',
                    status: 'SUCCESS',
                    reference: await this.generateMaintenanceReference(tx),
                    description: this.t('wallet.maintenance.fee_debit', lang, {
                        amount: feeInWalletCurrency,
                        currency: selectedWallet.currency,
                        role: isMerchant ? 'Marchand' : 'Utilisateur',
                        country: country.name || user.countryCode || 'CD',
                    }),
                    movement: 'DEBIT',
                    currency: selectedWallet.currency,
                    paymentMethod: 'INTERNAL',
                },
            });

            let systemWallet = await tx.wallet.findFirst({
                where: {
                    userId: systemUserId,
                    currency: 'USD',
                    isActive: true,
                },
            });

            if (!systemWallet) {
                systemWallet = await tx.wallet.create({
                    data: {
                        id: crypto.randomUUID(),
                        userId: systemUserId,
                        currency: 'USD',
                        balance: 0,
                        isActive: true,
                        cashCode: `MAINT${Math.floor(10000000 + Math.random() * 90000000)}`,
                    },
                });
            }

            const systemAmount = finalFeeUSD;

            const updatedSystemWallet = await tx.wallet.update({
                where: { id: systemWallet.id },
                data: {
                    balance: { increment: systemAmount },
                    updatedAt: new Date(),
                },
            });

            const systemTransaction = await tx.transaction.create({
                data: {
                    id: crypto.randomUUID(),
                    userId: systemUserId,
                    walletId: systemWallet.id,
                    amount: systemAmount,
                    type: 'DEPOSIT',
                    status: 'SUCCESS',
                    reference: await this.generateMaintenanceReference(tx),
                    description: this.t('wallet.maintenance.fee_credit', lang, {
                        amount: systemAmount,
                        currency: 'USD',
                        user: user.full_name || user.id,
                        country: country.name || user.countryCode || 'CD',
                    }),
                    movement: 'CREDIT',
                    currency: 'USD',
                    paymentMethod: 'INTERNAL',
                },
            });

            await tx.user.update({
                where: { id: user.id },
                data: {
                    last_maintenance_date: new Date(),
                },
            });

            await tx.audit_log.create({
                data: {
                    id: crypto.randomUUID(),
                    userId: user.id,
                    action: 'MAINTENANCE_FEE',
                    details: JSON.stringify({
                        amount: feeInWalletCurrency,
                        currency: selectedWallet.currency,
                        systemAmount: systemAmount,
                        systemCurrency: 'USD',
                        walletId: selectedWallet.id,
                        systemWalletId: systemWallet.id,
                        role: user.role,
                        country: country.name || user.countryCode || 'CD',
                        baseFee: baseFeeUSD,
                        finalFee: finalFeeUSD,
                        isMerchant,
                        conversionRate,
                        originalCurrency,
                        merchantMultiplier: country.merchant_maintenance_multiplier || 2,
                        selectionReason: selectionReason,
                        walletBalance: selectedWallet.balance,
                        walletTransactions: await this.getWalletTransactionCount(selectedWallet.id),
                    }),
                    createdAt: new Date(),
                },
            });

            return {
                updatedWallet,
                userTransaction,
                systemWallet: updatedSystemWallet,
                systemTransaction,
            };
        }, { timeout: 30000 });

        await this.sendMaintenanceNotifications(user, feeInWalletCurrency, selectedWallet.currency, lang);

        return {
            userId: user.id,
            name: user.full_name,
            role: user.role,
            country: country.name || user.countryCode || 'CD',
            success: true,
            collected: true,
            amount: feeInWalletCurrency,
            walletId: selectedWallet.id,
            newBalance: result.updatedWallet.balance,
            transactionId: result.userTransaction.id,
            systemTransactionId: result.systemTransaction.id,
            selectedWalletReason: selectionReason,
        };
    }

    /**
     * Génère une référence unique
     */
    private async generateMaintenanceReference(tx: any): Promise<string> {
        const date = new Date();
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const random = Math.floor(1000 + Math.random() * 9000);
        const ref = `MAINT-${year}${month}-${random}`;

        const existing = await tx.transaction.findFirst({
            where: { reference: ref },
        });

        if (existing) {
            return `${ref}-${Math.floor(Math.random() * 100)}`;
        }

        return ref;
    }

    /**
     * Envoie les notifications à l'utilisateur
     */
    private async sendMaintenanceNotifications(
        user: any,
        amount: number,
        currency: string,
        lang: string,
    ): Promise<void> {
        if (user.phone) {
            try {
                const cleanPhone = user.phone.replace(/[^0-9+]/g, '');
                const smsText = this.t('wallet.maintenance.sms', lang, {
                    full_name: user.full_name || '',
                    amount: amount,
                    currency: currency,
                });
                await this.smsService.sendSms(cleanPhone, smsText);
                this.logger.log(`SMS sent to ${cleanPhone}`);
            } catch (err) {
                this.logger.error('SMS error:', err);
            }
        }

        try {
            const title = this.t('wallet.maintenance.notification_title', lang);
            const body = this.t('wallet.maintenance.notification_body', lang, {
                amount: amount,
                currency: currency,
                country: user.countryCode || 'CD',
            });

            await this.notificationHelper.notify(
                user.id,
                NotificationType.MAINTENANCE_FEE,
                {
                    title,
                    message: body,
                    amount: amount,
                    currency: currency,
                    role: user.role === 'MERCHANT' ? 'Marchand' : 'Utilisateur',
                    country: user.countryCode || 'CD',
                },
                'MAINTENANCE',
                crypto.randomUUID(),
                lang,
            );
        } catch (err) {
            this.logger.error('Push notification error:', err);
        }
    }

    /**
     * Récupère la dernière date de maintenance
     */
    async getLastMaintenanceDate(): Promise<Date | null> {
        const lastAudit = await this.prisma.audit_log.findFirst({
            where: {
                action: 'MONTHLY_MAINTENANCE',
            },
            orderBy: {
                createdAt: 'desc',
            },
            select: {
                createdAt: true,
            },
        });

        return lastAudit?.createdAt || null;
    }

    /**
     * Vérifie si la maintenance a déjà été exécutée ce mois
     */
    async isMaintenanceDoneThisMonth(): Promise<boolean> {
        const now = new Date();
        const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const lastAudit = await this.prisma.audit_log.findFirst({
            where: {
                action: 'MONTHLY_MAINTENANCE',
                createdAt: {
                    gte: firstDayOfMonth,
                },
            },
            select: {
                createdAt: true,
            },
        });

        return !!lastAudit;
    }

    /**
     * Récupère les statistiques de maintenance
     */
    async getMaintenanceStats(lang: string = 'fr'): Promise<any> {
        const now = new Date();
        const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

        const systemUserId = process.env.SYSTEM_USER_ID || 'system-maintenance-account';

        const [maintenanceTransactions, totalUsers, totalMerchants, systemWallets, countries] = await Promise.all([
            this.prisma.transaction.findMany({
                where: {
                    type: 'WITHDRAW',
                    description: { contains: 'Frais de maintenance' },
                    createdAt: {
                        gte: firstDayOfMonth,
                        lte: lastDayOfMonth,
                    },
                },
            }),
            this.prisma.user.count({ where: { deleted: false, status: 'ACTIVE' } }),
            this.prisma.user.count({
                where: { deleted: false, status: 'ACTIVE', role: 'MERCHANT' },
            }),
            this.prisma.wallet.findMany({
                where: { userId: systemUserId, isActive: true },
            }),
            this.prisma.country_provider.findMany({
                where: { status: 'ACTIVE' },
                select: {
                    code: true,
                    countryCode: true,
                    name: true,
                    maintenance_fee: true,
                    merchant_maintenance_multiplier: true,
                },
                orderBy: { name: 'asc' },
            }),
        ]);

        const totalCollected = maintenanceTransactions.reduce(
            (sum, t) => sum + t.amount,
            0,
        );

        const systemBalance = systemWallets.reduce(
            (sum, w) => sum + w.balance,
            0,
        );

        return {
            message: this.t('wallet.maintenance.stats', lang, {
                total: totalCollected,
                users: totalUsers,
                merchants: totalMerchants,
            }),
            data: {
                period: {
                    start: firstDayOfMonth,
                    end: lastDayOfMonth,
                },
                totalUsers,
                totalMerchants,
                maintenanceTransactions: maintenanceTransactions.length,
                totalCollected,
                averagePerUser: totalUsers > 0 ? totalCollected / totalUsers : 0,
                systemBalance,
                systemWallets,
                countries: countries.map(c => ({
                    code: c.code,
                    countryCode: c.countryCode,
                    name: c.name,
                    maintenance_fee: c.maintenance_fee || 0,
                    merchant_multiplier: c.merchant_maintenance_multiplier || 2,
                })),
            },
        };
    }
}