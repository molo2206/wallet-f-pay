// apps/wallet-service/src/services/communication-cron.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { I18nService } from '@app/common';
import { SmsService } from 'apps/auth-service/src/sms/sms.service';
import { NotificationHelper } from 'apps/notification-service/src/helpers/NotificationHelper';
import { NotificationType } from 'apps/notification-service/src/type/notification-type';
import * as crypto from 'crypto';

@Injectable()
export class CommunicationCronService {
    private readonly logger = new Logger(CommunicationCronService.name);
    private isRunning = false;

    private translations: Record<string, Record<string, string | ((params: any) => string)>> = {
        'cron.kyc_reminder.title': {
            fr: 'Verification KYC requise',
            en: 'KYC Verification Required',
            sw: 'Uthibitisho wa KYC Unahitajika',
            es: 'Verificacion KYC Requerida',
            ar: 'التحقق من KYC مطلوب'
        },
        'cron.kyc_reminder.body': {
            fr: (p: any) => `Bonjour ${p.name}, n'oubliez pas de vérifier votre KYC pour profiter de toutes les fonctionnalités F-Pay.`,
            en: (p: any) => `Hello ${p.name}, don't forget to verify your KYC to enjoy all F-Pay features.`,
            sw: (p: any) => `Habari ${p.name}, usisahau kuthibitisha KYC yako ili kufurahia huduma zote za F-Pay.`,
            es: (p: any) => `Hola ${p.name}, no olvides verificar tu KYC para disfrutar de todas las funciones de F-Pay.`,
            ar: (p: any) => `مرحباً ${p.name}، لا تنس التحقق من KYC الخاص بك للاستمتاع بجميع ميزات F-Pay.`
        },
        'cron.transfer_reminder.title': {
            fr: 'Transferts internationaux',
            en: 'International Transfers',
            sw: 'Uhamisho wa Kimataifa',
            es: 'Transferencias Internacionales',
            ar: 'التحويلات الدولية'
        },
        'cron.transfer_reminder.body': {
            fr: (p: any) => `Utilisez F-Pay pour vos transferts vers ${p.country}. Envoyez ${p.amount} ${p.currency} à ${p.phone} en toute sécurité.`,
            en: (p: any) => `Use F-Pay for your transfers to ${p.country}. Send ${p.amount} ${p.currency} to ${p.phone} securely.`,
            sw: (p: any) => `Tumia F-Pay kwa uhamisho wako kwenda ${p.country}. Tuma ${p.amount} ${p.currency} kwa ${p.phone} kwa usalama.`,
            es: (p: any) => `Use F-Pay para tus transferencias a ${p.country}. Envía ${p.amount} ${p.currency} a ${p.phone} de forma segura.`,
            ar: (p: any) => `استخدم F-Pay لتحويلاتك إلى ${p.country}. أرسل ${p.amount} ${p.currency} إلى ${p.phone} بأمان.`
        },
        'cron.welcome.title': {
            fr: 'Bienvenue sur F-Pay',
            en: 'Welcome to F-Pay',
            sw: 'Karibu F-Pay',
            es: 'Bienvenido a F-Pay',
            ar: 'مرحباً بك في F-Pay'
        },
        'cron.welcome.body': {
            fr: 'Bienvenue sur F-Pay ! Verifiez votre KYC et commencez à utiliser nos services de transfert d\'argent, paiement et bien plus encore.',
            en: 'Welcome to F-Pay! Verify your KYC and start using our money transfer, payment and more services.',
            sw: 'Karibu F-Pay! Thibitisha KYC yako na anza kutumia huduma zetu za uhamisho wa pesa, malipo na zaidi.',
            es: '¡Bienvenido a F-Pay! Verifica tu KYC y comienza a usar nuestros servicios de transferencia de dinero, pago y más.',
            ar: 'مرحباً بك في F-Pay! تحقق من KYC الخاص بك وابدأ في استخدام خدمات تحويل الأموال والدفع والمزيد.'
        },
        'cron.promotion.title': {
            fr: 'Offre Speciale',
            en: 'Special Offer',
            sw: 'Ofa Maalum',
            es: 'Oferta Especial',
            ar: 'عرض خاص'
        },
        'cron.promotion.body': {
            fr: (p: any) => `${p.message}`,
            en: (p: any) => `${p.message}`,
            sw: (p: any) => `${p.message}`,
            es: (p: any) => `${p.message}`,
            ar: (p: any) => `${p.message}`
        },
        'cron.transaction_reminder.title': {
            fr: 'Transactions en cours',
            en: 'Pending Transactions',
            sw: 'Miamala Inayoendelea',
            es: 'Transacciones Pendientes',
            ar: 'المعاملات المعلقة'
        },
        'cron.transaction_reminder.body_single': {
            fr: (p: any) => `Vous avez une transaction en attente de ${p.amount} ${p.currency}. Finalisez-la dès maintenant.`,
            en: (p: any) => `You have a pending transaction of ${p.amount} ${p.currency}. Finalize it now.`,
            sw: (p: any) => `Una miamala inayosubiri ya ${p.amount} ${p.currency}. Ikamilishe sasa.`,
            es: (p: any) => `Tienes una transacción pendiente de ${p.amount} ${p.currency}. Finalízala ahora.`,
            ar: (p: any) => `لديك معاملة معلقة بقيمة ${p.amount} ${p.currency}. أنهِها الآن.`
        },
        'cron.transaction_reminder.body_multiple': {
            fr: (p: any) => `Vous avez ${p.count} transactions en attente. Consultez votre historique.`,
            en: (p: any) => `You have ${p.count} pending transactions. Check your history.`,
            sw: (p: any) => `Una miamala ${p.count} inayosubiri. Angalia historia yako.`,
            es: (p: any) => `Tienes ${p.count} transacciones pendientes. Consulta tu historial.`,
            ar: (p: any) => `لديك ${p.count} معاملة معلقة. تحقق من سجلك.`
        },
        'cron.low_balance.title': {
            fr: 'Solde faible',
            en: 'Low Balance',
            sw: 'Salio Chini',
            es: 'Saldo Bajo',
            ar: 'رصيد منخفض'
        },
        'cron.low_balance.body': {
            fr: (p: any) => `Votre solde est de ${p.balance} ${p.currency}. Pensez à recharger votre compte.`,
            en: (p: any) => `Your balance is ${p.balance} ${p.currency}. Consider topping up your account.`,
            sw: (p: any) => `Salio lako ni ${p.balance} ${p.currency}. Fikiria kuongeza akaunti yako.`,
            es: (p: any) => `Tu saldo es de ${p.balance} ${p.currency}. Considera recargar tu cuenta.`,
            ar: (p: any) => `رصيدك هو ${p.balance} ${p.currency}. فكر في شحن حسابك.`
        },
        'cron.benin_transfer.title': {
            fr: 'Transferts vers le Benin',
            en: 'Transfers to Benin',
            sw: 'Uhamisho kwenda Benin',
            es: 'Transferencias a Benin',
            ar: 'تحويلات إلى بنين'
        },
        'cron.benin_transfer.body': {
            fr: 'Envoyez de l\'argent vers le Benin à des tarifs compétitifs avec F-Pay. Rapide, sécurisé et fiable.',
            en: 'Send money to Benin at competitive rates with F-Pay. Fast, secure and reliable.',
            sw: 'Tuma pesa kwenda Benin kwa viwango vya ushindani na F-Pay. Haraka, salama na ya kuaminika.',
            es: 'Envía dinero a Benín a precios competitivos con F-Pay. Rápido, seguro y fiable.',
            ar: 'أرسل الأموال إلى بنين بأسعار تنافسية مع F-Pay. سريع وآمن وموثوق.'
        },
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

    // ==================== RAPPEL KYC (9h) ====================
    // ==================== RAPPEL KYC (12h) ====================
    @Cron('0 12 * * *')
    async remindKyc() {
        if (this.isRunning) return;
        this.isRunning = true;
        try {
            this.logger.log('Debut du rappel KYC');

            const users = await this.prisma.user.findMany({
                where: {
                    kycStatus: 'NOT_SUBMITTED',
                    status: 'ACTIVE',
                    deleted: false,
                },
                include: {
                    user_settings: true,
                },
            });

            let sentCount = 0;
            for (const user of users) {
                const settings = user.user_settings && user.user_settings.length > 0 ? user.user_settings[0] : null;
                const lang = settings?.language || 'fr';

                const title = this.t('cron.kyc_reminder.title', lang);
                const body = this.t('cron.kyc_reminder.body', lang, { name: user.full_name || 'Cher client' });

                // ✅ Passer les bonnes données
                await this.notificationHelper.notify(
                    user.id,
                    NotificationType.REMINDER,
                    {
                        title,
                        message: body,
                        name: user.full_name || 'Cher client',
                    },
                    'KYC',
                    crypto.randomUUID(),
                    lang,
                );

                if (user.phone) {
                    await this.smsService.sendSms(
                        user.phone.replace(/[^0-9+]/g, ''),
                        body
                    );
                }

                sentCount++;
            }

            this.logger.log(`Rappel KYC envoye à ${sentCount} utilisateurs`);
        } catch (error) {
            this.logger.error('Erreur rappel KYC:', error);
        } finally {
            this.isRunning = false;
        }
    }
    // ==================== PROMOTION TRANSFERT BENIN (10h lundi) ====================
    @Cron('0 10 * * 1')
    async promoteBeninTransfer() {
        if (this.isRunning) return;
        this.isRunning = true;
        try {
            this.logger.log('Debut promotion transferts Benin');

            const users = await this.prisma.user.findMany({
                where: {
                    status: 'ACTIVE',
                    deleted: false,
                },
                include: {
                    user_settings: true,
                },
            });

            let sentCount = 0;
            for (const user of users) {
                const settings = user.user_settings && user.user_settings.length > 0 ? user.user_settings[0] : null;
                const lang = settings?.language || 'fr';

                const title = this.t('cron.benin_transfer.title', lang);
                const body = this.t('cron.benin_transfer.body', lang);

                await this.notificationHelper.notify(
                    user.id,
                    NotificationType.PROMOTION,
                    { title, message: body },
                    'PROMOTION',
                    crypto.randomUUID(),
                    lang,
                );

                sentCount++;
            }

            this.logger.log(`Promotion Benin envoyee à ${sentCount} utilisateurs`);
        } catch (error) {
            this.logger.error('Erreur promotion Benin:', error);
        } finally {
            this.isRunning = false;
        }
    }

    // ==================== RAPPEL SOLDE FAIBLE (18h) ====================
    @Cron('0 18 * * *')
    async remindLowBalance() {
        if (this.isRunning) return;
        this.isRunning = true;
        try {
            this.logger.log('Verification des soldes faibles');

            const users = await this.prisma.user.findMany({
                where: {
                    status: 'ACTIVE',
                    deleted: false,
                },
                include: {
                    wallets: {
                        where: { isActive: true },
                    },
                    user_settings: true,
                },
            });

            let sentCount = 0;
            for (const user of users) {
                const mainWallet = user.wallets?.sort((a, b) => a.balance - b.balance)[0];
                if (!mainWallet || mainWallet.balance > 500) continue;

                const settings = user.user_settings && user.user_settings.length > 0 ? user.user_settings[0] : null;
                const lang = settings?.language || 'fr';

                const title = this.t('cron.low_balance.title', lang);
                const body = this.t('cron.low_balance.body', lang, {
                    balance: mainWallet.balance || 0,
                    currency: mainWallet.currency || 'CDF',
                });

                // ✅ Passer les bonnes données
                await this.notificationHelper.notify(
                    user.id,
                    NotificationType.WALLET,
                    {
                        title,
                        message: body,
                        balance: mainWallet.balance || 0,
                        currency: mainWallet.currency || 'CDF',
                    },
                    'WALLET',
                    mainWallet.id,
                    lang,
                );

                sentCount++;
            }

            this.logger.log(`Rappels solde faible envoyes à ${sentCount} utilisateurs`);
        } catch (error) {
            this.logger.error('Erreur rappel solde faible:', error);
        } finally {
            this.isRunning = false;
        }
    }
    // ==================== RAPPEL TRANSACTIONS EN ATTENTE (14h) ====================
    @Cron('0 14 * * *')
    async remindPendingTransactions() {
        if (this.isRunning) return;
        this.isRunning = true;
        try {
            this.logger.log('Verification des transactions en attente');

            const transactions = await this.prisma.transaction.findMany({
                where: {
                    status: 'PENDING',
                    createdAt: {
                        lt: new Date(Date.now() - 24 * 60 * 60 * 1000),
                    },
                },
                include: {
                    user: {
                        include: {
                            user_settings: true,
                        },
                    },
                },
            });

            const userTransactions = new Map<string, any[]>();
            for (const tx of transactions) {
                if (!tx.user) continue;
                const list = userTransactions.get(tx.userId) || [];
                list.push(tx);
                userTransactions.set(tx.userId, list);
            }

            let sentCount = 0;
            for (const [userId, txs] of userTransactions) {
                const user = txs[0].user;
                const settings = user.user_settings && user.user_settings.length > 0 ? user.user_settings[0] : null;
                const lang = settings?.language || 'fr';

                // ✅ Calculer le montant total et la devise
                const totalAmount = txs.reduce((sum, tx) => sum + (tx.amount || 0), 0);
                const currency = txs[0]?.currency || 'CDF';

                let body = '';
                if (txs.length === 1) {
                    body = this.t('cron.transaction_reminder.body_single', lang, {
                        amount: txs[0].amount || 0,
                        currency: currency,
                    });
                } else {
                    body = this.t('cron.transaction_reminder.body_multiple', lang, {
                        count: txs.length,
                    });
                }

                const title = this.t('cron.transaction_reminder.title', lang);

                // ✅ Passer les bonnes données
                await this.notificationHelper.notify(
                    userId,
                    NotificationType.TRANSACTION,
                    {
                        title,
                        message: body,
                        amount: totalAmount,
                        currency: currency,
                        count: txs.length,
                    },
                    'TRANSACTION',
                    txs[0].id,
                    lang,
                );

                sentCount++;
            }

            this.logger.log(`Rappels transactions envoyes à ${sentCount} utilisateurs`);
        } catch (error) {
            this.logger.error('Erreur rappel transactions:', error);
        } finally {
            this.isRunning = false;
        }
    }
    // ==================== BIENVENUE NOUVEAUX UTILISATEURS ====================
    @Cron('0 8 * * *')
    async welcomeNewUsers() {
        if (this.isRunning) return;
        this.isRunning = true;
        try {
            this.logger.log('Envoi des messages de bienvenue');

            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const newUsers = await this.prisma.user.findMany({
                where: {
                    createdAt: { gt: oneDayAgo },
                    status: 'ACTIVE',
                    deleted: false,
                },
                include: {
                    user_settings: true,
                },
            });

            let sentCount = 0;
            for (const user of newUsers) {
                const settings = user.user_settings && user.user_settings.length > 0 ? user.user_settings[0] : null;
                const lang = settings?.language || 'fr';

                const title = this.t('cron.welcome.title', lang);
                const body = this.t('cron.welcome.body', lang);

                await this.notificationHelper.notify(
                    user.id,
                    NotificationType.WELCOME,
                    { title, message: body },
                    'WELCOME',
                    crypto.randomUUID(),
                    lang,
                );

                sentCount++;
            }

            this.logger.log(`Messages de bienvenue envoyes à ${sentCount} nouveaux utilisateurs`);
        } catch (error) {
            this.logger.error('Erreur welcome new users:', error);
        } finally {
            this.isRunning = false;
        }
    }

    // ==================== RAPPEL TRANSFERTS INTERNATIONAUX (11h) ====================
    @Cron('0 11 * * *')
    async remindInternationalTransfers() {
        if (this.isRunning) return;
        this.isRunning = true;
        try {
            this.logger.log('Debut rappel transferts internationaux');

            const users = await this.prisma.user.findMany({
                where: {
                    status: 'ACTIVE',
                    deleted: false,
                },
                include: {
                    user_settings: true,
                },
            });

            let sentCount = 0;
            for (const user of users) {
                const settings = user.user_settings && user.user_settings.length > 0 ? user.user_settings[0] : null;
                const lang = settings?.language || 'fr';

                const title = this.t('cron.transfer_reminder.title', lang);
                const body = this.t('cron.transfer_reminder.body', lang, {
                    country: 'Benin',
                    amount: '100',
                    currency: 'USD',
                    phone: 'votre beneficiaire',
                });

                await this.notificationHelper.notify(
                    user.id,
                    NotificationType.TRANSFER,
                    { title, message: body },
                    'TRANSFER',
                    crypto.randomUUID(),
                    lang,
                );

                sentCount++;
            }

            this.logger.log(`Rappel transferts internationaux envoye à ${sentCount} utilisateurs`);
        } catch (error) {
            this.logger.error('Erreur rappel transferts internationaux:', error);
        } finally {
            this.isRunning = false;
        }
    }

    // ==================== PROMOTION HEBDOMADAIRE (9h lundi) ====================
    @Cron('0 9 * * 1')
    async weeklyPromotion() {
        if (this.isRunning) return;
        this.isRunning = true;
        try {
            this.logger.log('Debut promotion hebdomadaire');

            const users = await this.prisma.user.findMany({
                where: {
                    status: 'ACTIVE',
                    deleted: false,
                },
                include: {
                    user_settings: true,
                },
            });

            const promotions = [
                'Profitez de frais reduits sur vos transferts vers le Benin cette semaine !',
                'Offre speciale : 0% de frais sur vos premiers transferts internationaux.',
                'Envoyez de l\'argent vers le Benin à partir de 1% de frais seulement.',
            ];

            let sentCount = 0;
            for (const user of users) {
                const settings = user.user_settings && user.user_settings.length > 0 ? user.user_settings[0] : null;
                const lang = settings?.language || 'fr';

                const randomPromo = promotions[Math.floor(Math.random() * promotions.length)];
                const title = this.t('cron.promotion.title', lang);
                const body = this.t('cron.promotion.body', lang, { message: randomPromo });

                await this.notificationHelper.notify(
                    user.id,
                    NotificationType.PROMOTION,
                    { title, message: body },
                    'PROMOTION',
                    crypto.randomUUID(),
                    lang,
                );

                sentCount++;
            }

            this.logger.log(`Promotion hebdomadaire envoyee à ${sentCount} utilisateurs`);
        } catch (error) {
            this.logger.error('Erreur promotion hebdomadaire:', error);
        } finally {
            this.isRunning = false;
        }
    }
}