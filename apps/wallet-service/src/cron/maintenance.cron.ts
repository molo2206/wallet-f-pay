// apps/wallet-service/src/services/maintenance.service.ts
import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { PrismaService } from '../prisma/prisma.service';
import { I18nService } from '@app/common';
import { SmsService } from 'apps/auth-service/src/sms/sms.service';
import { NotificationHelper } from 'apps/notification-service/src/helpers/NotificationHelper';
import { NotificationType } from 'apps/notification-service/src/type/notification-type';
import * as crypto from 'crypto';

@Injectable()
export class MaintenanceService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly smsService: SmsService,
        private readonly notificationHelper: NotificationHelper,
        private readonly i18nService: I18nService,
    ) { }

    /**
     * Exécute les frais de maintenance mensuels par pays
     * Les marchands paient 2x le montant des utilisateurs normaux
     */
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
            }[];
            summary: {
                usersDebited: number;
                merchantsDebited: number;
                totalDebited: number;
                failed: number;
            };
        };
    }> {
        console.log('[MaintenanceService] ========== STARTING MONTHLY MAINTENANCE ==========');
        const startTime = Date.now();

        // 1️⃣ Récupérer tous les utilisateurs actifs (sauf exemptés)
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

        console.log(`[MaintenanceService] Found ${users.length} active users`);

        if (users.length === 0) {
            return {
                message: this.i18nService.translate('wallet.maintenance_no_users', lang),
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

        // 2️⃣ Récupérer tous les pays avec leurs frais de maintenance
        const countries = await this.prisma.country_provider.findMany({
            where: {
                status: 'ACTIVE',
            },
            select: {
                code: true,
                countryCode: true,
                name: true,
                maintenance_fee: true,
            },
        });

        const countryMap = new Map();
        countries.forEach(c => {
            const key = c.countryCode || c.code;
            countryMap.set(key, {
                name: c.name,
                maintenance_fee: c.maintenance_fee || 0,
            });
        });

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
        }[] = [];
        const countryStats = new Map();

        // 3️⃣ Pour chaque utilisateur, calculer et prélever les frais
        for (const user of users) {
            try {
                const countryCode = user.countryCode || 'CD';
                const countryConfig = countryMap.get(countryCode);

                if (!countryConfig) {
                    console.warn(`[MaintenanceService] No country config for ${countryCode}, skipping user ${user.id}`);
                    continue;
                }

                const result = await this.processUserMaintenance(user, countryConfig, lang);
                details.push(result);

                const statsKey = countryCode;
                if (!countryStats.has(statsKey)) {
                    countryStats.set(statsKey, {
                        countryCode: countryCode,
                        countryName: countryConfig.name,
                        fee: countryConfig.maintenance_fee,
                        users: 0,
                        merchants: 0,
                        collected: 0,
                    });
                }

                const stats = countryStats.get(statsKey);
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
                console.error(`[MaintenanceService] Error for user ${user.id}:`, error);
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

        // 4️⃣ Audit log
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

        console.log(`[MaintenanceService] ========== COMPLETED in ${executionTime}s ==========`);

        return {
            message: this.i18nService.translate('wallet.maintenance_completed', lang, {
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
    }

    /**
     * Traite les frais de maintenance pour un utilisateur individuel
     */
    private async processUserMaintenance(
        user: any,
        countryConfig: {
            name: string;
            maintenance_fee: number;
        },
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
    }> {
        const isMerchant = user.role === 'MERCHANT';

        // 1️⃣ Calculer les frais
        let baseFee = countryConfig.maintenance_fee || 0;
        let finalFee = baseFee;
        if (isMerchant) {
            finalFee = baseFee * 2;
        }

        if (user.maintenance_fee && user.maintenance_fee > 0) {
            finalFee = user.maintenance_fee;
        }

        console.log(`[MaintenanceService] User ${user.id} - ${user.role}: baseFee=${baseFee}, finalFee=${finalFee}`);

        if (finalFee <= 0) {
            return {
                userId: user.id,
                name: user.full_name,
                role: user.role,
                country: countryConfig.name,
                success: true,
                collected: false,
                amount: 0,
                reason: this.i18nService.translate('wallet.maintenance_no_fee', lang),
            };
        }

        if (!user.wallets || user.wallets.length === 0) {
            return {
                userId: user.id,
                name: user.full_name,
                role: user.role,
                country: countryConfig.name,
                success: false,
                collected: false,
                amount: finalFee,
                reason: this.i18nService.translate('wallet.maintenance_no_wallet', lang),
            };
        }

        // 2️⃣ Sélectionner le wallet avec le plus grand solde
        const sortedWallets = user.wallets.sort((a, b) => b.balance - a.balance);
        const mainWallet = sortedWallets[0];

        if (!mainWallet || mainWallet.balance < finalFee) {
            return {
                userId: user.id,
                name: user.full_name,
                role: user.role,
                country: countryConfig.name,
                success: false,
                collected: false,
                amount: finalFee,
                reason: this.i18nService.translate('wallet.maintenance_insufficient_balance', lang, {
                    balance: mainWallet?.balance || 0,
                    required: finalFee,
                    currency: mainWallet?.currency || 'CDF',
                }),
                walletId: mainWallet?.id,
                balance: mainWallet?.balance || 0,
                required: finalFee,
            };
        }

        // 3️⃣ Prélever les frais
        const systemUserId = process.env.SYSTEM_USER_ID || 'system-maintenance-account';

        const result = await this.prisma.$transaction(async (tx) => {
            const updatedWallet = await tx.wallet.update({
                where: { id: mainWallet.id },
                data: {
                    balance: { decrement: finalFee },
                    updatedAt: new Date(),
                },
            });

            const userTransaction = await tx.transaction.create({
                data: {
                    id: crypto.randomUUID(),
                    userId: user.id,
                    walletId: mainWallet.id,
                    amount: finalFee,
                    type: 'WITHDRAW',
                    status: 'SUCCESS',
                    reference: await this.generateMaintenanceReference(tx),
                    description: this.i18nService.translate('wallet.maintenance_fee_debit', lang, {
                        amount: finalFee,
                        currency: mainWallet.currency,
                        role: isMerchant ? 'Marchand' : 'Utilisateur',
                        country: countryConfig.name,
                    }),
                    movement: 'DEBIT',
                    currency: mainWallet.currency,
                    paymentMethod: 'INTERNAL',
                },
            });

            // 4️⃣ Créditer le compte système
            let systemWallet = await tx.wallet.findFirst({
                where: {
                    userId: systemUserId,
                    currency: mainWallet.currency,
                    isActive: true,
                },
            });

            if (!systemWallet) {
                systemWallet = await tx.wallet.create({
                    data: {
                        id: crypto.randomUUID(),
                        userId: systemUserId,
                        currency: mainWallet.currency,
                        balance: 0,
                        isActive: true,
                        cashCode: `MAINT${Math.floor(10000000 + Math.random() * 90000000)}`,
                    },
                });
            }

            const updatedSystemWallet = await tx.wallet.update({
                where: { id: systemWallet.id },
                data: {
                    balance: { increment: finalFee },
                    updatedAt: new Date(),
                },
            });

            const systemTransaction = await tx.transaction.create({
                data: {
                    id: crypto.randomUUID(),
                    userId: systemUserId,
                    walletId: systemWallet.id,
                    amount: finalFee,
                    type: 'DEPOSIT',
                    status: 'SUCCESS',
                    reference: await this.generateMaintenanceReference(tx),
                    description: this.i18nService.translate('wallet.maintenance_fee_credit', lang, {
                        amount: finalFee,
                        currency: mainWallet.currency,
                        user: user.full_name || user.id,
                        country: countryConfig.name,
                    }),
                    movement: 'CREDIT',
                    currency: mainWallet.currency,
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
                        amount: finalFee,
                        walletId: mainWallet.id,
                        systemWalletId: systemWallet.id,
                        currency: mainWallet.currency,
                        role: user.role,
                        country: countryConfig.name,
                        baseFee,
                        isMerchant,
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

        // 5️⃣ Notifications
        await this.sendMaintenanceNotifications(user, finalFee, mainWallet.currency, lang);

        return {
            userId: user.id,
            name: user.full_name,
            role: user.role,
            country: countryConfig.name,
            success: true,
            collected: true,
            amount: finalFee,
            walletId: mainWallet.id,
            newBalance: result.updatedWallet.balance,
            transactionId: result.userTransaction.id,
            systemTransactionId: result.systemTransaction.id,
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
        // ✅ SMS
        // if (user.phone) {
        //     try {
        //         const cleanPhone = user.phone.replace(/[^0-9+]/g, '');
        //         const smsText = this.i18nService.translate('wallet.maintenance_sms', lang, {
        //             full_name: user.full_name || '',
        //             amount: amount,
        //             currency: currency,
        //         });
        //         await this.smsService.sendSms(cleanPhone, smsText);
        //         console.log(`[MaintenanceService] SMS sent to ${cleanPhone}`);
        //     } catch (err) {
        //         console.error('[MaintenanceService] SMS error:', err);
        //     }
        // }

        // ✅ Notification Push
        try {
            await this.notificationHelper.notify(
                user.id,
                NotificationType.MAINTENANCE_FEE,
                {
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
            console.error('[MaintenanceService] Push notification error:', err);
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

        const [maintenanceTransactions, totalUsers, totalMerchants, systemWallets, countryFees] = await Promise.all([
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
            message: this.i18nService.translate('wallet.maintenance_stats', lang, {
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
                countryFees: countryFees.map(c => ({
                    code: c.code,
                    countryCode: c.countryCode,
                    name: c.name,
                    maintenance_fee: c.maintenance_fee || 0,
                })),
            },
        };
    }
}