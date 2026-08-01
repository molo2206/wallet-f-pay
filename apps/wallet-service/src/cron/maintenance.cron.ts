// apps/wallet-service/src/services/maintenance.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { I18nService } from '@app/common';
import { SmsService } from 'apps/auth-service/src/sms/sms.service';
import { NotificationHelper } from 'apps/notification-service/src/helpers/NotificationHelper';
import { NotificationType } from 'apps/notification-service/src/type/notification-type';
import { user_status } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class MaintenanceService {
    private readonly logger = new Logger(MaintenanceService.name);
    private isRunning = false;

    private translations: Record<string, Record<string, string | ((params: any) => string)>> = {
        'wallet.maintenance.no_users': {
            fr: 'Aucun utilisateur actif trouve pour la maintenance',
            en: 'No active users found for maintenance',
            sw: 'Hakuna watumiaji wanaofanya kazi waliopatikana kwa matengenezo',
            es: 'No se encontraron usuarios activos para el mantenimiento',
            ar: 'لم يتم العثور على مستخدمين نشطين للصيانة'
        },
        'wallet.maintenance.no_fee': {
            fr: 'Aucun frais a prelever',
            en: 'No fee to collect',
            sw: 'Hakuna ada ya kukusanya',
            es: 'No hay comision que cobrar',
            ar: 'لا توجد رسوم للتحصيل'
        },
        'wallet.maintenance.no_wallet': {
            fr: 'Aucun portefeuille actif trouve',
            en: 'No active wallet found',
            sw: 'Hakuna pochi inayofanya kazi iliyopatikana',
            es: 'No se encontro ninguna billetera activa',
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
            fr: (p: any) => `Frais maintenance (${p.country}) - ${p.role} - ${p.amount} ${p.currency}`,
            en: (p: any) => `Maintenance fee (${p.country}) - ${p.role} - ${p.amount} ${p.currency}`,
            sw: (p: any) => `Ada ya matengenezo (${p.country}) - ${p.role} - ${p.amount} ${p.currency}`,
            es: (p: any) => `Comision mantenimiento (${p.country}) - ${p.role} - ${p.amount} ${p.currency}`,
            ar: (p: any) => `رسوم الصيانة (${p.country}) - ${p.role} - ${p.amount} ${p.currency}`
        },
        'wallet.maintenance.fee_credit': {
            fr: (p: any) => `Frais maintenance recus de ${p.user} - ${p.amount} ${p.currency}`,
            en: (p: any) => `Maintenance fee received from ${p.user} - ${p.amount} ${p.currency}`,
            sw: (p: any) => `Ada ya matengenezo imepokelewa kutoka ${p.user} - ${p.amount} ${p.currency}`,
            es: (p: any) => `Comision mantenimiento recibida de ${p.user} - ${p.amount} ${p.currency}`,
            ar: (p: any) => `تم استلام رسوم الصيانة من ${p.user} - ${p.amount} ${p.currency}`
        },
        'wallet.maintenance.completed': {
            fr: (p: any) => `Maintenance effectuee: ${p.total} preleves sur ${p.users} utilisateurs et ${p.merchants} marchands`,
            en: (p: any) => `Maintenance completed: ${p.total} collected from ${p.users} users and ${p.merchants} merchants`,
            sw: (p: any) => `Matengenezo yamekamilika: ${p.total} zilizokusanywa kutoka kwa watumiaji ${p.users} na wafanyabiashara ${p.merchants}`,
            es: (p: any) => `Mantenimiento completado: ${p.total} cobrados de ${p.users} usuarios y ${p.merchants} comerciantes`,
            ar: (p: any) => `اكتملت الصيانة: تم تحصيل ${p.total} من ${p.users} مستخدم و ${p.merchants} تاجر`
        },
        'wallet.maintenance.stats': {
            fr: (p: any) => `Maintenance: ${p.total} preleves sur ${p.users} utilisateurs et ${p.merchants} marchands`,
            en: (p: any) => `Maintenance: ${p.total} collected from ${p.users} users and ${p.merchants} merchants`,
            sw: (p: any) => `Matengenezo: ${p.total} zilizokusanywa kutoka kwa watumiaji ${p.users} na wafanyabiashara ${p.merchants}`,
            es: (p: any) => `Mantenimiento: ${p.total} cobrados de ${p.users} usuarios y ${p.merchants} comerciantes`,
            ar: (p: any) => `الصيانة: تم تحصيل ${p.total} من ${p.users} مستخدم و ${p.merchants} تاجر`
        },
        'wallet.maintenance.sms': {
            fr: (p: any) => `Bonjour ${p.full_name}, frais maintenance de ${p.amount} ${p.currency} preleves. Merci.`,
            en: (p: any) => `Hello ${p.full_name}, maintenance fee of ${p.amount} ${p.currency} deducted. Thank you.`,
            sw: (p: any) => `Habari ${p.full_name}, ada ya matengenezo ya ${p.amount} ${p.currency} imetolewa. Asante.`,
            es: (p: any) => `Hola ${p.full_name}, comision de mantenimiento de ${p.amount} ${p.currency} deducida. Gracias.`,
            ar: (p: any) => `مرحباً ${p.full_name}، تم خصم رسوم صيانة بقيمة ${p.amount} ${p.currency}. شكراً.`
        },
        'wallet.maintenance.sms_debt': {
            fr: (p: any) => `Bonjour ${p.full_name}, frais maintenance de ${p.amount} ${p.currency} preleves. Solde debiteur de ${p.debt} ${p.currency}.`,
            en: (p: any) => `Hello ${p.full_name}, maintenance fee of ${p.amount} ${p.currency} deducted. Balance overdrawn by ${p.debt} ${p.currency}.`,
            sw: (p: any) => `Habari ${p.full_name}, ada ya matengenezo ya ${p.amount} ${p.currency} imetolewa. Salio ni deni la ${p.debt} ${p.currency}.`,
            es: (p: any) => `Hola ${p.full_name}, comision de mantenimiento de ${p.amount} ${p.currency} deducida. Saldo deudor de ${p.debt} ${p.currency}.`,
            ar: (p: any) => `مرحباً ${p.full_name}، تم خصم رسوم صيانة بقيمة ${p.amount} ${p.currency}. رصيدك مدين بمبلغ ${p.debt} ${p.currency}.`
        },
        'wallet.maintenance.sms_blocked': {
            fr: (p: any) => `Bonjour ${p.full_name}, votre compte est bloque car vous avez ${p.months} mois de frais de maintenance impayes (${p.debt} ${p.currency}). Contactez le support.`,
            en: (p: any) => `Hello ${p.full_name}, your account has been blocked because you have ${p.months} months of unpaid maintenance fees (${p.debt} ${p.currency}). Contact support.`,
            sw: (p: any) => `Habari ${p.full_name}, akaunti yako imefungwa kwa sababu una miezi ${p.months} ya ada ya matengenezo ambayo haijalipwa (${p.debt} ${p.currency}). Wasiliana na msaada.`,
            es: (p: any) => `Hola ${p.full_name}, su cuenta ha sido bloqueada porque tiene ${p.months} meses de comisiones de mantenimiento impagas (${p.debt} ${p.currency}). Contacte a soporte.`,
            ar: (p: any) => `مرحباً ${p.full_name}، تم حظر حسابك لأن لديك ${p.months} أشهر من رسوم الصيانة غير المدفوعة (${p.debt} ${p.currency}). اتصل بالدعم.`
        },
        'wallet.maintenance.notification_title': {
            fr: 'Frais maintenance',
            en: 'Maintenance fee',
            sw: 'Ada ya matengenezo',
            es: 'Comision mantenimiento',
            ar: 'رسوم الصيانة'
        },
        'wallet.maintenance.notification_title_debt': {
            fr: 'Dette maintenance',
            en: 'Maintenance debt',
            sw: 'Deni la matengenezo',
            es: 'Deuda mantenimiento',
            ar: 'دين الصيانة'
        },
        'wallet.maintenance.notification_title_blocked': {
            fr: 'Compte bloque - Frais impayes',
            en: 'Account blocked - Unpaid fees',
            sw: 'Akaunti imefungwa - Ada ambazo hazijalipwa',
            es: 'Cuenta bloqueada - Comisiones impagas',
            ar: 'الحساب محظور - رسوم غير مدفوعة'
        },
        'wallet.maintenance.notification_body': {
            fr: (p: any) => `Frais maintenance de ${p.amount} ${p.currency} preleves (${p.country}).`,
            en: (p: any) => `Maintenance fee of ${p.amount} ${p.currency} deducted (${p.country}).`,
            sw: (p: any) => `Ada ya matengenezo ya ${p.amount} ${p.currency} imetolewa (${p.country}).`,
            es: (p: any) => `Comision de mantenimiento de ${p.amount} ${p.currency} deducida (${p.country}).`,
            ar: (p: any) => `تم خصم رسوم صيانة بقيمة ${p.amount} ${p.currency} (${p.country}).`
        },
        'wallet.maintenance.notification_body_debt': {
            fr: (p: any) => `Frais maintenance de ${p.amount} ${p.currency} preleves. Solde debiteur de ${p.debt} ${p.currency} (${p.country}).`,
            en: (p: any) => `Maintenance fee of ${p.amount} ${p.currency} deducted. Balance overdrawn by ${p.debt} ${p.currency} (${p.country}).`,
            sw: (p: any) => `Ada ya matengenezo ya ${p.amount} ${p.currency} imetolewa. Salio ni deni la ${p.debt} ${p.currency} (${p.country}).`,
            es: (p: any) => `Comision de mantenimiento de ${p.amount} ${p.currency} deducida. Saldo deudor de ${p.debt} ${p.currency} (${p.country}).`,
            ar: (p: any) => `تم خصم رسوم صيانة بقيمة ${p.amount} ${p.currency}. رصيدك مدين بمبلغ ${p.debt} ${p.currency} (${p.country}).`
        },
        'wallet.maintenance.notification_body_blocked': {
            fr: (p: any) => `Votre compte a ete bloque car vous avez ${p.months} mois de frais de maintenance impayes (${p.debt} ${p.currency}). Contactez le support pour regulariser.`,
            en: (p: any) => `Your account has been blocked because you have ${p.months} months of unpaid maintenance fees (${p.debt} ${p.currency}). Contact support to resolve.`,
            sw: (p: any) => `Akaunti yako imefungwa kwa sababu una miezi ${p.months} ya ada ya matengenezo ambayo haijalipwa (${p.debt} ${p.currency}). Wasiliana na msaada ili kutatua.`,
            es: (p: any) => `Su cuenta ha sido bloqueada porque tiene ${p.months} meses de comisiones de mantenimiento impagas (${p.debt} ${p.currency}). Contacte a soporte para resolver.`,
            ar: (p: any) => `تم حظر حسابك لأن لديك ${p.months} أشهر من رسوم الصيانة غير المدفوعة (${p.debt} ${p.currency}). اتصل بالدعم لحل المشكلة.`
        },
        'wallet.maintenance.selection_reason': {
            fr: (p: any) => `Portefeuille: ${p.currency} - ${p.reason}`,
            en: (p: any) => `Wallet: ${p.currency} - ${p.reason}`,
            sw: (p: any) => `Pochi: ${p.currency} - ${p.reason}`,
            es: (p: any) => `Billetera: ${p.currency} - ${p.reason}`,
            ar: (p: any) => `المحفظة: ${p.currency} - ${p.reason}`
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
    ) {
        this.logger.log('MaintenanceService initialized');
        this.logger.log(`Current time: ${new Date().toISOString()}`);
    }

    /**
     * Récupère l'utilisateur système (system@fpay.com)
     */
    private async getSystemUser(): Promise<any> {
        const systemUser = await this.prisma.user.findFirst({
            where: {
                email: 'system@fpay.com',
            },
            select: {
                id: true,
                email: true,
                full_name: true,
            },
        });

        if (!systemUser) {
            this.logger.error('❌ Utilisateur système (system@fpay.com) non trouvé !');
            throw new Error('System user not found');
        }

        return systemUser;
    }

    /**
     * Récupère ou crée le wallet système en USD
     */
    private async getSystemWalletUSD(): Promise<any> {
        const systemUser = await this.getSystemUser();

        let systemWallet = await this.prisma.wallet.findFirst({
            where: {
                userId: systemUser.id,
                currency: 'USD',
                isActive: true,
            },
        });

        if (!systemWallet) {
            this.logger.log('💰 Création du wallet système USD...');
            systemWallet = await this.prisma.wallet.create({
                data: {
                    id: crypto.randomUUID(),
                    userId: systemUser.id,
                    currency: 'USD',
                    balance: 0,
                    isActive: true,
                    cashCode: `SYS${Math.floor(10000000 + Math.random() * 90000000)}`,
                },
            });
            this.logger.log(`✅ Wallet système USD créé: ${systemWallet.id}`);
        }

        return systemWallet;
    }

    /**
     * Récupère le nombre de mois consécutifs en dette
     */
    private async getMonthsInDebt(userId: string): Promise<number> {
        const debtTransactions = await this.prisma.transaction.findMany({
            where: {
                userId: userId,
                type: 'WITHDRAW',
                status: 'PENDING',
                description: { contains: 'Dette de maintenance' },
            },
            orderBy: { createdAt: 'asc' },
        });

        const months = new Set<string>();
        for (const tx of debtTransactions) {
            const date = new Date(tx.createdAt);
            const key = `${date.getFullYear()}-${date.getMonth()}`;
            months.add(key);
        }

        return months.size;
    }

    /**
     * Calcule les frais de maintenance
     * Basé sur : pays + rôle
     */
    private async calculateMaintenanceFee(
        user: any,
        country: any,
        isMerchant: boolean,
    ): Promise<{
        countryFee: number;
        multiplier: number;
        calculatedFee: number;
        finalFee: number;
        isMaintenanceDay: boolean;
        daysUntilNextMaintenance: number;
        nextMaintenanceDate: Date;
    }> {
        const now = new Date();
        const creationDate = new Date(user.createdAt);

        // ✅ Jour anniversaire
        const creationDay = creationDate.getDate();
        const currentDay = now.getDate();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();
        const isMaintenanceDay = (currentDay === creationDay);

        // ✅ Prochaine maintenance
        let nextMaintenanceDate = new Date(currentYear, currentMonth, creationDay);
        if (nextMaintenanceDate <= now) {
            nextMaintenanceDate = new Date(currentYear, currentMonth + 1, creationDay);
        }
        const daysUntilNextMaintenance = Math.ceil(
            (nextMaintenanceDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
        );

        // ✅ Frais de base du pays
        const countryFee = country.maintenance_fee || 0;

        // ✅ Multiplicateur pour marchands
        let multiplier = 1;
        if (isMerchant) {
            multiplier = country.merchant_maintenance_multiplier || 2;
        }

        // ✅ Frais final = pays × multiplicateur
        let finalFee = countryFee * multiplier;
        finalFee = Math.round(finalFee * 100) / 100;

        this.logger.log(`User ${user.id}: Fee breakdown - Country: ${countryFee}, Multiplier: ${multiplier}, Final: ${finalFee}, isMaintenanceDay: ${isMaintenanceDay}`);

        return {
            countryFee,
            multiplier,
            calculatedFee: finalFee,
            finalFee,
            isMaintenanceDay,
            daysUntilNextMaintenance,
            nextMaintenanceDate,
        };
    }

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

    private async getWalletTransactionCount(walletId: string): Promise<number> {
        const count = await this.prisma.transaction.count({
            where: {
                walletId: walletId,
                status: 'SUCCESS',
            },
        });
        return count;
    }

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

    @Cron('0 0 * * *')
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
                blocked: number;
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
                isDebt?: boolean;
                debtAmount?: number;
                monthsInDebt?: number;
                isBlocked?: boolean;
                isMaintenanceDay: boolean;
                daysUntilNextMaintenance: number;
                nextMaintenanceDate: Date;
                feeBreakdown: {
                    countryFee: number;
                    multiplier: number;
                    calculatedFee: number;
                    finalFee: number;
                };
            }[];
            summary: {
                usersDebited: number;
                merchantsDebited: number;
                totalDebited: number;
                failed: number;
                totalDebt: number;
                usersWithDebt: number;
                blockedUsers: number;
            };
        };
    }> {
        this.logger.log('MAINTENANCE CRON STARTED at: ' + new Date().toISOString());

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
                        totalDebt: 0,
                        usersWithDebt: 0,
                        blockedUsers: 0,
                    },
                },
            };
        }
        this.isRunning = true;

        this.logger.log('========== STARTING MONTHLY MAINTENANCE ==========');
        const startTime = Date.now();

        try {
            const countriesWithFees = await this.prisma.country_provider.findMany({
                where: {
                    status: 'ACTIVE',
                    maintenance_fee: { gt: 0 },
                },
                select: {
                    countryCode: true,
                    name: true,
                    maintenance_fee: true,
                    merchant_maintenance_multiplier: true,
                },
            });
            this.logger.log('Countries with maintenance fees:', JSON.stringify(countriesWithFees, null, 2));

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

            this.logger.log(`Found ${users.length} active users eligible for maintenance`);

            if (users.length === 0) {
                this.logger.warn('No active users found for maintenance');
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
                            totalDebt: 0,
                            usersWithDebt: 0,
                            blockedUsers: 0,
                        },
                    },
                };
            }

            let totalCollected = 0;
            let usersDebited = 0;
            let merchantsDebited = 0;
            let failedCount = 0;
            let totalDebt = 0;
            let usersWithDebt = 0;
            let blockedUsers = 0;

            const details: any[] = [];
            const countryStats = new Map();

            for (const user of users) {
                try {
                    this.logger.log(`Processing user ${user.id} (${user.full_name || 'No name'})...`);
                    const result = await this.processUserMaintenance(user, lang);
                    details.push(result);

                    this.logger.log(`Result for user ${user.id}: success=${result.success}, collected=${result.collected}, amount=${result.amount || 0}, isDebt=${result.isDebt || false}, isBlocked=${result.isBlocked || false}`);

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
                            debts: 0,
                            blocked: 0,
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

                        if (result.isDebt && result.debtAmount) {
                            totalDebt += result.debtAmount;
                            usersWithDebt++;
                            stats.debts += result.debtAmount;
                        }

                        if (result.isBlocked) {
                            blockedUsers++;
                            stats.blocked++;
                        }

                        this.logger.log(`User ${user.id} debited: ${result.amount} ${result.currency || 'USD'}${result.isDebt ? ` (dette: ${result.debtAmount})` : ''}${result.isBlocked ? ' 🔒 BLOCKED' : ''}`);
                    } else if (!result.success) {
                        failedCount++;
                        this.logger.warn(`User ${user.id} failed: ${result.reason || 'Unknown reason'}`);
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

            this.logger.log(`MAINTENANCE SUMMARY: Total collected: ${totalCollected} USD, Users: ${usersDebited}, Merchants: ${merchantsDebited}, Failed: ${failedCount}, Total Debt: ${totalDebt}, Users with debt: ${usersWithDebt}, Blocked: ${blockedUsers}`);

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
                        totalDebt,
                        usersWithDebt,
                        blockedUsers,
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
                        totalDebt,
                        usersWithDebt,
                        blockedUsers,
                    },
                },
            };
        } finally {
            this.isRunning = false;
        }
    }

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
        currency?: string;
        reason?: string;
        walletId?: string;
        balance?: number;
        required?: number;
        newBalance?: number;
        transactionId?: string;
        systemTransactionId?: string;
        error?: string;
        selectedWalletReason?: string;
        isDebt?: boolean;
        debtAmount?: number;
        monthsInDebt?: number;
        isBlocked?: boolean;
        isMaintenanceDay: boolean;
        daysUntilNextMaintenance: number;
        nextMaintenanceDate: Date;
        feeBreakdown: {
            countryFee: number;
            multiplier: number;
            calculatedFee: number;
            finalFee: number;
        };
    }> {
        const isMerchant = user.role === 'MERCHANT';
        const country = await this.getUserCountry(user);

        // ✅ Calculer les frais dynamiques
        const feeResult = await this.calculateMaintenanceFee(user, country, isMerchant);
        const finalFeeUSD = feeResult.finalFee;

        this.logger.log(`User ${user.id} - ${user.role}: Final Fee: ${finalFeeUSD} USD, isMaintenanceDay: ${feeResult.isMaintenanceDay}`);

        // ✅ Si ce n'est pas le jour anniversaire, on ne prélève rien
        if (!feeResult.isMaintenanceDay) {
            return {
                userId: user.id,
                name: user.full_name,
                role: user.role,
                country: country.name || user.countryCode || 'CD',
                success: true,
                collected: false,
                amount: 0,
                reason: `Prochaine maintenance: ${feeResult.nextMaintenanceDate.toLocaleDateString()} (dans ${feeResult.daysUntilNextMaintenance} jours)`,
                isDebt: false,
                debtAmount: 0,
                monthsInDebt: 0,
                isBlocked: false,
                isMaintenanceDay: false,
                daysUntilNextMaintenance: feeResult.daysUntilNextMaintenance,
                nextMaintenanceDate: feeResult.nextMaintenanceDate,
                feeBreakdown: {
                    countryFee: feeResult.countryFee,
                    multiplier: feeResult.multiplier,
                    calculatedFee: feeResult.calculatedFee,
                    finalFee: feeResult.finalFee,
                },
            };
        }

        if (finalFeeUSD <= 0) {
            this.logger.log(`User ${user.id}: No fee to collect (${finalFeeUSD})`);
            return {
                userId: user.id,
                name: user.full_name,
                role: user.role,
                country: country.name || user.countryCode || 'CD',
                success: true,
                collected: false,
                amount: 0,
                reason: this.t('wallet.maintenance.no_fee', lang),
                isDebt: false,
                debtAmount: 0,
                monthsInDebt: 0,
                isBlocked: false,
                isMaintenanceDay: true,
                daysUntilNextMaintenance: 0,
                nextMaintenanceDate: new Date(),
                feeBreakdown: {
                    countryFee: feeResult.countryFee,
                    multiplier: feeResult.multiplier,
                    calculatedFee: feeResult.calculatedFee,
                    finalFee: feeResult.finalFee,
                },
            };
        }

        if (!user.wallets || user.wallets.length === 0) {
            this.logger.warn(`User ${user.id}: No active wallets found`);
            return {
                userId: user.id,
                name: user.full_name,
                role: user.role,
                country: country.name || user.countryCode || 'CD',
                success: false,
                collected: false,
                amount: finalFeeUSD,
                reason: this.t('wallet.maintenance.no_wallet', lang),
                isDebt: false,
                debtAmount: 0,
                monthsInDebt: 0,
                isBlocked: false,
                isMaintenanceDay: true,
                daysUntilNextMaintenance: 0,
                nextMaintenanceDate: new Date(),
                feeBreakdown: {
                    countryFee: feeResult.countryFee,
                    multiplier: feeResult.multiplier,
                    calculatedFee: feeResult.calculatedFee,
                    finalFee: feeResult.finalFee,
                },
            };
        }

        this.logger.log(`User ${user.id}: Selecting best wallet for fee ${finalFeeUSD} USD`);
        const selection = await this.selectBestWalletForMaintenance(user, user.wallets, finalFeeUSD);
        const { wallet: selectedWallet, feeInWalletCurrency, conversionRate, originalCurrency, selectionReason } = selection;

        this.logger.log(`User ${user.id}: Wallet selected: ${selectedWallet.currency} (balance: ${selectedWallet.balance}) - Fee: ${feeInWalletCurrency} ${selectedWallet.currency} - Reason: ${selectionReason}`);

        if (selectedWallet.balance < feeInWalletCurrency) {
            this.logger.log(`User ${user.id}: Balance insufficient (${selectedWallet.balance} < ${feeInWalletCurrency}), creating debt`);
            return await this.processDebtMaintenance(
                user,
                selectedWallet,
                selectedWallet.balance,
                feeInWalletCurrency,
                finalFeeUSD,
                country,
                isMerchant,
                conversionRate,
                originalCurrency,
                selectionReason,
                lang,
                feeResult,
            );
        }

        return await this.processFullMaintenance(
            user,
            selectedWallet,
            feeInWalletCurrency,
            finalFeeUSD,
            country,
            isMerchant,
            conversionRate,
            originalCurrency,
            selectionReason,
            lang,
            feeResult,
        );
    }

    private async processFullMaintenance(
        user: any,
        selectedWallet: any,
        feeInWalletCurrency: number,
        finalFeeUSD: number,
        country: any,
        isMerchant: boolean,
        conversionRate: number,
        originalCurrency: string,
        selectionReason: string,
        lang: string,
        feeResult: any,
    ): Promise<any> {
        try {
            const systemUser = await this.getSystemUser();
            const systemWallet = await this.getSystemWalletUSD();

            const result = await this.prisma.$transaction(async (tx) => {
                // ✅ 1. Débiter le wallet de l'utilisateur
                const updatedWallet = await tx.wallet.update({
                    where: { id: selectedWallet.id },
                    data: {
                        balance: { decrement: feeInWalletCurrency },
                        updatedAt: new Date(),
                    },
                });

                // ✅ 2. Transaction utilisateur (DÉBIT)
                const userTransaction = await tx.transaction.create({
                    data: {
                        id: crypto.randomUUID(),
                        userId: user.id,
                        walletId: selectedWallet.id,
                        amount: feeInWalletCurrency,
                        type: 'WITHDRAW',
                        status: 'SUCCESS',
                        reference: await this.generateMaintenanceReference(tx),
                        description: `Frais maintenance (${country.name || user.countryCode || 'CD'}) - ${isMerchant ? 'Marchand' : 'Utilisateur'} - ${feeInWalletCurrency} ${selectedWallet.currency}`,
                        movement: 'DEBIT',
                        currency: selectedWallet.currency,
                        paymentMethod: 'INTERNAL',
                    },
                });

                // ✅ 3. Créditer le wallet système
                await tx.wallet.update({
                    where: { id: systemWallet.id },
                    data: {
                        balance: { increment: finalFeeUSD },
                        updatedAt: new Date(),
                    },
                });

                // ✅ 4. Transaction système (CRÉDIT)
                const systemTransaction = await tx.transaction.create({
                    data: {
                        id: crypto.randomUUID(),
                        userId: systemUser.id,
                        walletId: systemWallet.id,
                        amount: finalFeeUSD,
                        type: 'DEPOSIT',
                        status: 'SUCCESS',
                        reference: await this.generateMaintenanceReference(tx),
                        description: `Frais maintenance reçus de ${user.full_name || user.id} (${feeInWalletCurrency} ${selectedWallet.currency} = ${finalFeeUSD} USD) - ${country.name || user.countryCode || 'CD'}`,
                        movement: 'CREDIT',
                        currency: 'USD',
                        paymentMethod: 'INTERNAL',
                    },
                });

                // ✅ 5. Mettre à jour la date de dernière maintenance
                await tx.user.update({
                    where: { id: user.id },
                    data: {
                        last_maintenance_date: new Date(),
                    },
                });

                // ✅ 6. Audit log
                await tx.audit_log.create({
                    data: {
                        id: crypto.randomUUID(),
                        userId: user.id,
                        action: 'MAINTENANCE_FEE',
                        details: JSON.stringify({
                            amount: feeInWalletCurrency,
                            currency: selectedWallet.currency,
                            systemAmount: finalFeeUSD,
                            systemCurrency: 'USD',
                            walletId: selectedWallet.id,
                            systemWalletId: systemWallet.id,
                            role: user.role,
                            country: country.name || user.countryCode || 'CD',
                            isMerchant,
                            conversionRate,
                            originalCurrency,
                            selectionReason: selectionReason,
                            feeBreakdown: {
                                countryFee: feeResult.countryFee,
                                multiplier: feeResult.multiplier,
                                calculatedFee: feeResult.calculatedFee,
                                finalFee: feeResult.finalFee,
                            },
                            isMaintenanceDay: feeResult.isMaintenanceDay,
                            nextMaintenanceDate: feeResult.nextMaintenanceDate,
                        }),
                        createdAt: new Date(),
                    },
                });

                return {
                    updatedWallet,
                    userTransaction,
                    systemWallet,
                    systemTransaction,
                };
            }, { timeout: 30000 });

            await this.sendMaintenanceNotifications(user, feeInWalletCurrency, selectedWallet.currency, lang, false, 0, 0, false);

            return {
                userId: user.id,
                name: user.full_name,
                role: user.role,
                country: country.name || user.countryCode || 'CD',
                success: true,
                collected: true,
                amount: feeInWalletCurrency,
                currency: selectedWallet.currency,
                walletId: selectedWallet.id,
                newBalance: result.updatedWallet.balance,
                transactionId: result.userTransaction.id,
                systemTransactionId: result.systemTransaction.id,
                selectedWalletReason: selectionReason,
                isDebt: false,
                debtAmount: 0,
                monthsInDebt: 0,
                isBlocked: false,
                isMaintenanceDay: feeResult.isMaintenanceDay,
                daysUntilNextMaintenance: feeResult.daysUntilNextMaintenance,
                nextMaintenanceDate: feeResult.nextMaintenanceDate,
                feeBreakdown: {
                    countryFee: feeResult.countryFee,
                    multiplier: feeResult.multiplier,
                    calculatedFee: feeResult.calculatedFee,
                    finalFee: feeResult.finalFee,
                },
            };
        } catch (error: any) {
            this.logger.error(`Error processing full maintenance for user ${user.id}:`, error);
            return {
                userId: user.id,
                name: user.full_name,
                role: user.role,
                country: country.name || user.countryCode || 'CD',
                success: false,
                collected: false,
                amount: finalFeeUSD,
                error: error.message || 'Transaction failed',
                isDebt: false,
                debtAmount: 0,
                monthsInDebt: 0,
                isBlocked: false,
                isMaintenanceDay: feeResult.isMaintenanceDay,
                daysUntilNextMaintenance: feeResult.daysUntilNextMaintenance,
                nextMaintenanceDate: feeResult.nextMaintenanceDate,
                feeBreakdown: {
                    countryFee: feeResult.countryFee,
                    multiplier: feeResult.multiplier,
                    calculatedFee: feeResult.calculatedFee,
                    finalFee: feeResult.finalFee,
                },
            };
        }
    }

    private async processDebtMaintenance(
        user: any,
        selectedWallet: any,
        currentBalance: number,
        feeInWalletCurrency: number,
        finalFeeUSD: number,
        country: any,
        isMerchant: boolean,
        conversionRate: number,
        originalCurrency: string,
        selectionReason: string,
        lang: string,
        feeResult: any,
    ): Promise<any> {
        const collectedAmount = currentBalance > 0 ? currentBalance : 0;
        const debtAmount = feeInWalletCurrency - (currentBalance > 0 ? currentBalance : 0);

        // ✅ Récupérer le nombre de mois en dette
        const monthsInDebt = await this.getMonthsInDebt(user.id);
        const newMonthsInDebt = monthsInDebt + 1;

        this.logger.log(`User ${user.id}: Debt calculation - Balance: ${currentBalance}, Fee: ${feeInWalletCurrency}, Collected: ${collectedAmount}, Debt: ${debtAmount}, Months in debt: ${newMonthsInDebt}`);

        try {
            const systemUser = await this.getSystemUser();
            const systemWallet = await this.getSystemWalletUSD();

            let userTransaction: any = null;
            let debtTransaction: any = null;
            let statusUpdate: any = null;

            const result = await this.prisma.$transaction(async (tx) => {
                const newBalance = currentBalance - feeInWalletCurrency;

                // ✅ 1. Mettre à jour le wallet
                const updatedWallet = await tx.wallet.update({
                    where: { id: selectedWallet.id },
                    data: {
                        balance: newBalance,
                        updatedAt: new Date(),
                    },
                });

                // ✅ 2. Transaction de collection (si montant > 0)
                if (collectedAmount > 0) {
                    userTransaction = await tx.transaction.create({
                        data: {
                            id: crypto.randomUUID(),
                            userId: user.id,
                            walletId: selectedWallet.id,
                            amount: collectedAmount,
                            type: 'WITHDRAW',
                            status: 'SUCCESS',
                            reference: await this.generateMaintenanceReference(tx),
                            description: `Frais maintenance (${country.name || user.countryCode || 'CD'}) - ${isMerchant ? 'Marchand' : 'Utilisateur'} - ${collectedAmount} ${selectedWallet.currency} prélevés`,
                            movement: 'DEBIT',
                            currency: selectedWallet.currency,
                            paymentMethod: 'INTERNAL',
                        },
                    });
                }

                // ✅ 3. Transaction de dette (si montant > 0)
                if (debtAmount > 0) {
                    debtTransaction = await tx.transaction.create({
                        data: {
                            id: crypto.randomUUID(),
                            userId: user.id,
                            walletId: selectedWallet.id,
                            amount: debtAmount,
                            type: 'WITHDRAW',
                            status: 'PENDING',
                            reference: await this.generateMaintenanceReference(tx),
                            description: `Dette de maintenance (${debtAmount} ${selectedWallet.currency}) - ${country.name || user.countryCode || 'CD'} - Mois ${newMonthsInDebt}`,
                            movement: 'DEBIT',
                            currency: selectedWallet.currency,
                            paymentMethod: 'INTERNAL',
                        },
                    });
                }

                // ✅ 4. 🔒 BLOCAGE PERMANENT DU COMPTE SI 5 MOIS DE DETTE
                let isBlocked = false;
                if (newMonthsInDebt >= 5) {
                    statusUpdate = await tx.user.update({
                        where: { id: user.id },
                        data: {
                            status: user_status.BLOCKED,
                            locked_until: null,
                            updatedAt: new Date(),
                        },
                    });
                    isBlocked = true;

                    this.logger.warn(`🔒 User ${user.id} BLOCKED permanently due to ${newMonthsInDebt} months of unpaid fees`);

                    await tx.audit_log.create({
                        data: {
                            id: crypto.randomUUID(),
                            userId: user.id,
                            action: 'ACCOUNT_BLOCKED_AUTO_MAINTENANCE',
                            details: JSON.stringify({
                                reason: '5 mois de frais de maintenance impayés',
                                monthsInDebt: newMonthsInDebt,
                                totalDebt: debtAmount,
                                currency: selectedWallet.currency,
                                date: new Date(),
                                isPermanent: true,
                            }),
                            createdAt: new Date(),
                        },
                    });
                }

                // ✅ 5. Créditer le wallet système
                await tx.wallet.update({
                    where: { id: systemWallet.id },
                    data: {
                        balance: { increment: finalFeeUSD },
                        updatedAt: new Date(),
                    },
                });

                // ✅ 6. Transaction système
                const systemTransaction = await tx.transaction.create({
                    data: {
                        id: crypto.randomUUID(),
                        userId: systemUser.id,
                        walletId: systemWallet.id,
                        amount: finalFeeUSD,
                        type: 'DEPOSIT',
                        status: 'SUCCESS',
                        reference: await this.generateMaintenanceReference(tx),
                        description: `Frais maintenance reçus de ${user.full_name || user.id} (${feeInWalletCurrency} ${selectedWallet.currency} = ${finalFeeUSD} USD) - ${country.name || user.countryCode || 'CD'}${debtAmount > 0 ? ` (dette: ${debtAmount} ${selectedWallet.currency}, ${newMonthsInDebt} mois)` : ''}`,
                        movement: 'CREDIT',
                        currency: 'USD',
                        paymentMethod: 'INTERNAL',
                    },
                });

                // ✅ 7. Mettre à jour la date de dernière maintenance
                await tx.user.update({
                    where: { id: user.id },
                    data: {
                        last_maintenance_date: new Date(),
                    },
                });

                // ✅ 8. Audit log
                await tx.audit_log.create({
                    data: {
                        id: crypto.randomUUID(),
                        userId: user.id,
                        action: debtAmount > 0 ? 'MAINTENANCE_FEE_WITH_DEBT' : 'MAINTENANCE_FEE',
                        details: JSON.stringify({
                            collectedAmount: collectedAmount,
                            debtAmount: debtAmount,
                            totalAmount: feeInWalletCurrency,
                            currency: selectedWallet.currency,
                            systemAmount: finalFeeUSD,
                            systemCurrency: 'USD',
                            walletId: selectedWallet.id,
                            systemWalletId: systemWallet.id,
                            role: user.role,
                            country: country.name || user.countryCode || 'CD',
                            isMerchant,
                            conversionRate,
                            originalCurrency,
                            selectionReason: selectionReason,
                            hasDebt: debtAmount > 0,
                            walletBalance: currentBalance,
                            newBalance: currentBalance - feeInWalletCurrency,
                            monthsInDebt: newMonthsInDebt,
                            isBlocked: isBlocked,
                            feeBreakdown: {
                                countryFee: feeResult.countryFee,
                                multiplier: feeResult.multiplier,
                                calculatedFee: feeResult.calculatedFee,
                                finalFee: feeResult.finalFee,
                            },
                            isMaintenanceDay: feeResult.isMaintenanceDay,
                            nextMaintenanceDate: feeResult.nextMaintenanceDate,
                        }),
                        createdAt: new Date(),
                    },
                });

                return {
                    updatedWallet,
                    userTransaction,
                    debtTransaction,
                    systemWallet,
                    systemTransaction,
                    collectedAmount,
                    debtAmount,
                    statusUpdate,
                    newMonthsInDebt,
                    isBlocked,
                };
            }, { timeout: 30000 });

            // ✅ Envoyer notification spéciale si bloqué
            if (result.isBlocked) {
                await this.sendBlockNotification(user, debtAmount, selectedWallet.currency, lang, result.newMonthsInDebt);
            } else {
                await this.sendMaintenanceNotifications(user, feeInWalletCurrency, selectedWallet.currency, lang, debtAmount > 0, debtAmount, result.newMonthsInDebt, false);
            }

            return {
                userId: user.id,
                name: user.full_name,
                role: user.role,
                country: country.name || user.countryCode || 'CD',
                success: true,
                collected: true,
                amount: collectedAmount,
                currency: selectedWallet.currency,
                walletId: selectedWallet.id,
                newBalance: result.updatedWallet.balance,
                transactionId: result.userTransaction?.id ?? null,
                debtTransactionId: result.debtTransaction?.id ?? null,
                systemTransactionId: result.systemTransaction.id,
                selectedWalletReason: debtAmount > 0
                    ? `Dette créée: ${debtAmount} ${selectedWallet.currency} (solde: ${currentBalance}, prélevé: ${collectedAmount}) - ${result.newMonthsInDebt}/5 mois`
                    : `Prélèvement complet de ${feeInWalletCurrency} ${selectedWallet.currency}`,
                isDebt: debtAmount > 0,
                debtAmount: debtAmount,
                monthsInDebt: result.newMonthsInDebt,
                isBlocked: result.isBlocked,
                isMaintenanceDay: feeResult.isMaintenanceDay,
                daysUntilNextMaintenance: feeResult.daysUntilNextMaintenance,
                nextMaintenanceDate: feeResult.nextMaintenanceDate,
                feeBreakdown: {
                    countryFee: feeResult.countryFee,
                    multiplier: feeResult.multiplier,
                    calculatedFee: feeResult.calculatedFee,
                    finalFee: feeResult.finalFee,
                },
            };
        } catch (error: any) {
            this.logger.error(`Error processing debt maintenance for user ${user.id}:`, error);
            return {
                userId: user.id,
                name: user.full_name,
                role: user.role,
                country: country.name || user.countryCode || 'CD',
                success: false,
                collected: false,
                amount: 0,
                error: error.message || 'Debt transaction failed',
                isDebt: false,
                debtAmount: 0,
                monthsInDebt: 0,
                isBlocked: false,
                isMaintenanceDay: feeResult.isMaintenanceDay,
                daysUntilNextMaintenance: feeResult.daysUntilNextMaintenance,
                nextMaintenanceDate: feeResult.nextMaintenanceDate,
                feeBreakdown: {
                    countryFee: feeResult.countryFee,
                    multiplier: feeResult.multiplier,
                    calculatedFee: feeResult.calculatedFee,
                    finalFee: feeResult.finalFee,
                },
            };
        }
    }

    private async generateMaintenanceReference(tx: any): Promise<string> {
        const date = new Date();
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const random = Math.floor(1000 + Math.random() * 9000);
        const ref = `${year}${month}${random}`;

        const existing = await tx.transaction.findFirst({
            where: { reference: ref },
        });

        if (existing) {
            return `${ref}${Math.floor(Math.random() * 100)}`;
        }

        return ref;
    }

    private async sendMaintenanceNotifications(
        user: any,
        amount: number,
        currency: string,
        lang: string,
        hasDebt: boolean = false,
        debtAmount: number = 0,
        monthsInDebt: number = 0,
        isBlocked: boolean = false,
    ): Promise<void> {
        try {
            let titleKey = 'wallet.maintenance.notification_title';
            let bodyKey = 'wallet.maintenance.notification_body';
            const params: any = {
                amount: amount,
                currency: currency,
                country: user.countryCode || 'CD',
            };

            if (hasDebt && debtAmount > 0) {
                titleKey = 'wallet.maintenance.notification_title_debt';
                bodyKey = 'wallet.maintenance.notification_body_debt';
                params.debt = debtAmount;
            }

            const title = this.t(titleKey, lang);
            const body = this.t(bodyKey, lang, params);

            await this.notificationHelper.notify(
                user.id,
                NotificationType.MAINTENANCE_FEE,
                {
                    title,
                    message: body,
                    amount: amount,
                    currency: currency,
                    debt: debtAmount,
                    monthsInDebt: monthsInDebt,
                    hasDebt: hasDebt,
                    isBlocked: isBlocked,
                    role: user.role === 'MERCHANT' ? 'Marchand' : 'Utilisateur',
                    country: user.countryCode || 'CD',
                },
                'MAINTENANCE',
                crypto.randomUUID(),
                lang,
            );
            this.logger.log(`Push notification sent to user ${user.id}`);
        } catch (err) {
            this.logger.error('Push notification error:', err);
        }
    }

    private async sendBlockNotification(
        user: any,
        debtAmount: number,
        currency: string,
        lang: string,
        monthsInDebt: number,
    ): Promise<void> {
        try {
            const titleKey = 'wallet.maintenance.notification_title_blocked';
            const bodyKey = 'wallet.maintenance.notification_body_blocked';
            const params: any = {
                debt: debtAmount,
                currency: currency,
                months: monthsInDebt,
                name: user.full_name || 'Cher client',
            };

            const title = this.t(titleKey, lang);
            const body = this.t(bodyKey, lang, params);

            await this.notificationHelper.notify(
                user.id,
                NotificationType.SECURITY_ALERT,
                {
                    title,
                    message: body,
                    debt: debtAmount,
                    currency: currency,
                    months: monthsInDebt,
                    action: 'UNBLOCK',
                },
                'MAINTENANCE',
                crypto.randomUUID(),
                lang,
            );

            // ✅ Envoyer aussi un SMS si disponible
            if (user.phone) {
                try {
                    const smsKey = 'wallet.maintenance.sms_blocked';
                    const smsText = this.t(smsKey, lang, {
                        full_name: user.full_name || 'Cher client',
                        debt: debtAmount,
                        currency: currency,
                        months: monthsInDebt,
                    });
                    await this.smsService.sendSms(user.phone, smsText);
                    this.logger.log(`📱 Block SMS sent to ${user.phone}`);
                } catch (err) {
                    this.logger.error('Block SMS error:', err);
                }
            }

            this.logger.log(`🔒 Block notification sent to user ${user.id}`);
        } catch (err) {
            this.logger.error('Block notification error:', err);
        }
    }

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

    async isMaintenanceDoneToday(): Promise<boolean> {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        const lastAudit = await this.prisma.audit_log.findFirst({
            where: {
                action: 'MONTHLY_MAINTENANCE',
                createdAt: {
                    gte: todayStart,
                },
            },
            select: {
                createdAt: true,
            },
        });

        return !!lastAudit;
    }

    async getMaintenanceStats(lang: string = 'fr'): Promise<any> {
        const now = new Date();
        const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

        const systemUser = await this.getSystemUser();

        const [maintenanceTransactions, debtTransactions, totalUsers, totalMerchants, systemWallets, countries] = await Promise.all([
            this.prisma.transaction.findMany({
                where: {
                    type: 'WITHDRAW',
                    description: { contains: 'Frais maintenance' },
                    createdAt: {
                        gte: firstDayOfMonth,
                        lte: lastDayOfMonth,
                    },
                },
            }),
            this.prisma.transaction.findMany({
                where: {
                    type: 'WITHDRAW',
                    description: { contains: 'Dette de maintenance' },
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
                where: { userId: systemUser.id, isActive: true },
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

        const totalDebt = debtTransactions.reduce(
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
                totalDebt,
                debtTransactions: debtTransactions.length,
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