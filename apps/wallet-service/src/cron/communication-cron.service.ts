// apps/wallet-service/src/services/communication-cron.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { I18nService } from '@app/common';
import { NotificationHelper } from 'apps/notification-service/src/helpers/NotificationHelper';
import { NotificationType } from 'apps/notification-service/src/type/notification-type';
import * as crypto from 'crypto';

@Injectable()
export class CommunicationCronService {
    private readonly logger = new Logger(CommunicationCronService.name);
    private isRunning = false;

    private translations: Record<string, Record<string, string | ((params: any) => string)>> = {
        // ==================== RAPPEL KYC STANDARD ====================
        'cron.kyc_reminder.title': 
        {
            fr: 'Verification KYC en attente',
            en: 'KYC Verification Pending',
            sw: 'Uthibitisho wa KYC Unasubiri',
            es: 'Verificacion KYC Pendiente',
            ar: 'التحقق من KYC معلق'
        },
        'cron.kyc_reminder.body': {
            fr: (p: any) => `Bonjour ${p.name}, pour profiter pleinement de vos envois et recevoir de l'argent en toute securite, veuillez finaliser votre verification KYC. Cela ne prend que 2 minutes.`,
            en: (p: any) => `Hello ${p.name}, to fully enjoy your transfers and receive money securely, please complete your KYC verification. It only takes 2 minutes.`,
            sw: (p: any) => `Habari ${p.name}, ili kufurahia kikamilifu uhamisho wako na kupokea pesa kwa usalama, tafadhali kamilisha uthibitisho wako wa KYC. Inachukua dakika 2 tu.`,
            es: (p: any) => `Hola ${p.name}, para disfrutar plenamente de tus envios y recibir dinero de forma segura, completa tu verificacion KYC. Solo toma 2 minutos.`,
            ar: (p: any) => `مرحباً ${p.name}، للاستمتاع الكامل بتحويلاتك واستلام الأموال بأمان، يرجى إكمال التحقق من KYC الخاص بك. لا يستغرق سوى دقيقتين.`
        },

        // ==================== KYC POUR TRANSFERTS INTERNATIONAUX ====================
        'cron.kyc_for_international_transfer.title': {
            fr: "Verification d'identite requise",
            en: 'Identity Verification Required',
            sw: 'Uthibitishaji wa Utambulisho Unahitajika',
            es: 'Se Requiere Verificación de Identidad',
            ar: 'مطلوب التحقق من الهوية',
        },
        'cron.kyc_for_international_transfer.body': {
            fr: (p: any) =>
                `Bonjour ${p.name}, verifiez votre identite (KYC) pour acceder aux transferts internationaux vers plus de 15 pays africains. La verification est rapide, securisee et ne prend que quelques minutes.`,
            en: (p: any) =>
                `Hello ${p.name}, verify your identity (KYC) to access international transfers to more than 15 African countries. Verification is fast, secure, and only takes a few minutes.`,
            sw: (p: any) =>
                `Habari ${p.name}, thibitisha utambulisho wako (KYC) ili uweze kufanya uhamisho wa kimataifa kwenda zaidi ya nchi 15 za Afrika. Ni haraka, salama na huchukua dakika chache tu.`,
            es: (p: any) =>
                `Hola ${p.name}, verifica tu identidad (KYC) para acceder a transferencias internacionales a mas de 15 paises africanos. El proceso es rapido, seguro y solo toma unos minutos.`,
            ar: (p: any) =>
                `مرحباً ${p.name}، يرجى التحقق من هويتك (KYC) للوصول إلى التحويلات الدولية إلى أكثر من 15 دولة أفريقية. العملية سريعة وآمنة ولا تستغرق سوى بضع دقائق.`,
        },

        // ==================== RAPPEL KYC INTERNATIONAL ====================
        'cron.kyc_reminder_international.title': {
            fr: 'Finalisez votre verification KYC',
            en: 'Complete Your KYC Verification',
            sw: 'Kamilisha Uthibitishaji wa KYC',
            es: 'Completa tu Verificación KYC',
            ar: 'أكمل التحقق من KYC',
        },
        'cron.kyc_reminder_international.body': {
            fr: (p: any) =>
                `Bonjour ${p.name}, votre verification KYC est toujours en attente. Finalisez-la pour envoyer de l'argent vers plus de 15 pays africains en toute securite et profiter de frais competitifs.`,
            en: (p: any) =>
                `Hello ${p.name}, your KYC verification is still pending. Complete it to send money securely to more than 15 African countries and enjoy competitive fees.`,
            sw: (p: any) =>
                `Habari ${p.name}, uthibitishaji wako wa KYC bado haujakamilika. Ukamilishe ili kutuma pesa salama kwenda zaidi ya nchi 15 za Afrika na kufurahia ada nafuu.`,
            es: (p: any) =>
                `Hola ${p.name}, tu verificacion KYC sigue pendiente. Completa para enviar dinero de forma segura a mas de 15 paises africanos y disfrutar de tarifas competitivas.`,
            ar: (p: any) =>
                `مرحباً ${p.name}، لا يزال التحقق من KYC الخاص بك قيد الانتظار. أكمله لإرسال الأموال بأمان إلى أكثر من 15 دولة أفريقية والاستفادة من رسوم تنافسية.`,
        },

        // ==================== AVANTAGES KYC INTERNATIONAL ====================
        'cron.kyc_international_benefits.title': {
            fr: 'Votre KYC ouvre les transferts internationaux',
            en: 'Your KYC Unlocks International Transfers',
            sw: 'KYC Yako Inafungua Uhamisho wa Kimataifa',
            es: 'Tu KYC Desbloquea las Transferencias Internacionales',
            ar: 'التحقق من KYC يفتح لك التحويلات الدولية',
        },
        'cron.kyc_international_benefits.body': {
            fr: (p: any) =>
                `Bonjour ${p.name}, une fois votre identite verifiee, vous pourrez envoyer de l'argent vers plus de 15 pays africains avec des frais competitifs, un traitement rapide et une securite renforcee.`,
            en: (p: any) =>
                `Hello ${p.name}, once your identity is verified, you'll be able to send money to more than 15 African countries with competitive fees, fast processing, and enhanced security.`,
            sw: (p: any) =>
                `Habari ${p.name}, baada ya KYC yako kuthibitishwa, utaweza kutuma pesa kwenda zaidi ya nchi 15 za Afrika kwa ada nafuu, huduma ya haraka na usalama wa hali ya juu.`,
            es: (p: any) =>
                `Hola ${p.name}, una vez verificada tu identidad, podras enviar dinero a mas de 15 paises africanos con tarifas competitivas, procesamiento rapido y mayor seguridad.`,
            ar: (p: any) =>
                `مرحباً ${p.name}، بعد التحقق من هويتك، ستتمكن من إرسال الأموال إلى أكثر من 15 دولة أفريقية برسوم تنافسية وسرعة في المعالجة وأمان معزز.`,
        },

        // ==================== DESTINATIONS INTERNATIONALES ====================
        'cron.international_destinations.title': {
            fr: "Envoyez de l'argent a l'international",
            en: 'Send Money Internationally',
            sw: 'Tuma Pesa Kimataifa',
            es: 'Envia Dinero Internacionalmente',
            ar: 'أرسل الأموال دولياً',
        },
        'cron.international_destinations.body': {
            fr: (p: any) =>
                `Bonjour ${p.name}, avec F-Pay, envoyez de l'argent vers plus de 15 pays africains, notamment le Benin, le Cameroun, la Cote d'Ivoire, le Kenya et le Senegal. Verifiez votre identite (KYC) et commencez des aujourd'hui.`,
            en: (p: any) =>
                `Hello ${p.name}, with F-Pay, send money to more than 15 African countries, including Benin, Cameroon, Ivory Coast, Kenya, and Senegal. Verify your identity (KYC) and get started today.`,
            sw: (p: any) =>
                `Habari ${p.name}, kwa kutumia F-Pay unaweza kutuma pesa kwenda zaidi ya nchi 15 za Afrika, ikiwemo Benin, Cameroon, Ivory Coast, Kenya na Senegal. Thibitisha KYC yako na anza leo.`,
            es: (p: any) =>
                `Hola ${p.name}, con F-Pay puedes enviar dinero a mas de 15 paises africanos, incluidos Benin, Camerun, Costa de Marfil, Kenia y Senegal. Verifica tu identidad (KYC) y comienza hoy.`,
            ar: (p: any) =>
                `مرحباً ${p.name}، مع F-Pay يمكنك إرسال الأموال إلى أكثر من 15 دولة أفريقية، بما في ذلك بنين والكاميرون وساحل العاج وكينيا والسنغال. تحقق من هويتك (KYC) وابدأ اليوم.`,
        },

        // ==================== RAPPEL TRANSFERTS INTERNATIONAUX ====================
        'cron.transfer_reminder.title': {
            fr: 'Envoyez de l\'argent au Benin',
            en: 'Send Money to Benin',
            sw: 'Tuma Pesa Kwenda Benin',
            es: 'Envia Dinero a Benin',
            ar: 'أرسل الأموال إلى بنين'
        },
        'cron.transfer_reminder.body': {
            fr: (p: any) => `Bonjour ${p.name}, avec F-Pay, envoyez jusqu'a ${p.amount} ${p.currency} vers le Benin en quelques secondes. Taux competitifs et securite garantie. Essayez maintenant !`,
            en: (p: any) => `Hello ${p.name}, with F-Pay, send up to ${p.amount} ${p.currency} to Benin in seconds. Competitive rates and guaranteed security. Try it now!`,
            sw: (p: any) => `Habari ${p.name}, kwa F-Pay, tuma hadi ${p.amount} ${p.currency} kwenda Benin kwa sekunde chache. Viwango vya ushindani na usalama uliohakikishwa. Jaribu sasa!`,
            es: (p: any) => `Hola ${p.name}, con F-Pay, envia hasta ${p.amount} ${p.currency} a Benin en segundos. Tarifas competitivas y seguridad garantizada. ¡Pruébalo ahora!`,
            ar: (p: any) => `مرحباً ${p.name}، مع F-Pay، أرسل ما يصل إلى ${p.amount} ${p.currency} إلى بنين في ثوانٍ. أسعار تنافسية وأمان مضمون. جربه الآن!`
        },

        // ==================== MESSAGE DE BIENVENUE ====================
        'cron.welcome.title': {
            fr: 'Bienvenue sur F-Pay',
            en: 'Welcome to F-Pay',
            sw: 'Karibu F-Pay',
            es: 'Bienvenido a F-Pay',
            ar: 'مرحباً بك في F-Pay'
        },
        'cron.welcome.body': {
            fr: (p: any) => `Bonjour ${p.name}, bienvenue sur F-Pay ! Pour commencer, verifiez votre identite (KYC) et effectuez votre premier transfert. Nous sommes la pour vous accompagner.`,
            en: (p: any) => `Hello ${p.name}, welcome to F-Pay! To get started, verify your identity (KYC) and make your first transfer. We are here to support you.`,
            sw: (p: any) => `Habari ${p.name}, karibu F-Pay! Kuanza, thibitisha utambulisho wako (KYC) na ufanye uhamisho wako wa kwanza. Tuko hapa kukusaidia.`,
            es: (p: any) => `Hola ${p.name}, ¡bienvenido a F-Pay! Para comenzar, verifica tu identidad (KYC) y realiza tu primera transferencia. Estamos aqui para apoyarte.`,
            ar: (p: any) => `مرحباً ${p.name}، مرحباً بك في F-Pay! للبدء، تحقق من هويتك (KYC) وقم بتحويلك الأول. نحن هنا لدعمك.`
        },

        // ==================== PROMOTION ====================
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

        // ==================== RAPPEL TRANSACTIONS EN ATTENTE ====================
        'cron.transaction_reminder.title': {
            fr: 'Transaction en attente',
            en: 'Pending Transaction',
            sw: 'Miamala Inayosubiri',
            es: 'Transaccion Pendiente',
            ar: 'معاملة معلقة'
        },
        'cron.transaction_reminder.body_single': {
            fr: (p: any) => `Bonjour, votre transaction de ${p.amount} ${p.currency} est toujours en attente. Pour la finaliser, verifiez votre solde ou contactez notre support.`,
            en: (p: any) => `Hello, your transaction of ${p.amount} ${p.currency} is still pending. To finalize it, check your balance or contact our support.`,
            sw: (p: any) => `Habari, miamala yako ya ${p.amount} ${p.currency} bado inasubiri. Ili kuikamilisha, angalia salio lako au wasiliana na msaada wetu.`,
            es: (p: any) => `Hola, tu transaccion de ${p.amount} ${p.currency} aun esta pendiente. Para finalizarla, revisa tu saldo o contacta a nuestro soporte.`,
            ar: (p: any) => `مرحباً، معاملتك بقيمة ${p.amount} ${p.currency} لا تزال معلقة. لإتمامها، تحقق من رصيدك أو اتصل بدعمنا.`
        },
        'cron.transaction_reminder.body_multiple': {
            fr: (p: any) => `Bonjour, vous avez ${p.count} transactions en attente. Pour eviter tout retard, finalisez-les des maintenant.`,
            en: (p: any) => `Hello, you have ${p.count} pending transactions. To avoid any delay, finalize them now.`,
            sw: (p: any) => `Habari, una miamala ${p.count} inayosubiri. Ili kuepuka ucheleweshaji, ikamilishe sasa.`,
            es: (p: any) => `Hola, tienes ${p.count} transacciones pendientes. Para evitar retrasos, finalizalas ahora.`,
            ar: (p: any) => `مرحباً، لديك ${p.count} معاملة معلقة. لتجنب أي تأخير، أنهِها الآن.`
        },

        // ==================== RAPPEL SOLDE FAIBLE ====================
        'cron.low_balance.title': {
            fr: 'Solde faible',
            en: 'Low Balance',
            sw: 'Salio Chini',
            es: 'Saldo Bajo',
            ar: 'رصيد منخفض'
        },
        'cron.low_balance.body': {
            fr: (p: any) => `Bonjour, votre solde actuel est de ${p.balance} ${p.currency}. Pensez a recharger votre compte pour continuer a effectuer vos transactions en toute serenite.`,
            en: (p: any) => `Hello, your current balance is ${p.balance} ${p.currency}. Consider topping up your account to continue making your transactions with peace of mind.`,
            sw: (p: any) => `Habari, salio lako la sasa ni ${p.balance} ${p.currency}. Fikiria kuongeza akaunti yako ili kuendelea kufanya miamala yako kwa amani.`,
            es: (p: any) => `Hola, tu saldo actual es de ${p.balance} ${p.currency}. Considera recargar tu cuenta para seguir realizando tus transacciones con tranquilidad.`,
            ar: (p: any) => `مرحباً، رصيدك الحالي هو ${p.balance} ${p.currency}. فكر في شحن حسابك لمواصلة إجراء معاملاتك بكل راحة بال.`
        },

        // ==================== PROMOTION BENIN ====================
        'cron.benin_transfer.title': {
            fr: 'Transferts vers le Benin',
            en: 'Transfers to Benin',
            sw: 'Uhamisho kwenda Benin',
            es: 'Transferencias a Benin',
            ar: 'تحويلات إلى بنين'
        },
        'cron.benin_transfer.body': {
            fr: (p: any) => `Bonjour ${p.name}, avec F-Pay, envoyez de l'argent vers le Benin en quelques clics. Taux attractifs, securite renforcee et service disponible 24h/24.`,
            en: (p: any) => `Hello ${p.name}, with F-Pay, send money to Benin in just a few clicks. Attractive rates, enhanced security and 24/7 service.`,
            sw: (p: any) => `Habari ${p.name}, kwa F-Pay, tuma pesa kwenda Benin kwa kubofya chache. Viwango vya kuvutia, usalama ulioimarishwa na huduma ya 24/7.`,
            es: (p: any) => `Hola ${p.name}, con F-Pay, envia dinero a Benin con solo unos clics. Tarifas atractivas, seguridad reforzada y servicio 24/7.`,
            ar: (p: any) => `مرحباً ${p.name}، مع F-Pay، أرسل الأموال إلى بنين ببضع نقرات فقط. أسعار جذابة، أمان معزز وخدمة على مدار الساعة.`
        },

        // ==================== RAPPEL ENVOI D'ARGENT ====================
        'cron.money_transfer_reminder.title': {
            fr: "Envoyez de l'argent en toute confiance",
            en: 'Send Money with Confidence',
            sw: 'Tuma Pesa kwa Ujasiri',
            es: 'Envia Dinero con Confianza',
            ar: 'أرسل الأموال بثقة'
        },
        'cron.money_transfer_reminder.body': {
            fr: (p: any) => `Bonjour ${p.name}, F-Pay vous permet d'envoyer de l'argent a vos proches en toute securite. Profitez de nos frais reduits et de notre service rapide.`,
            en: (p: any) => `Hello ${p.name}, F-Pay allows you to send money to your loved ones securely. Enjoy our reduced fees and fast service.`,
            sw: (p: any) => `Habari ${p.name}, F-Pay inakuruhusu kutuma pesa kwa wapendwa wako kwa usalama. Furahia ada zetu zilizopunguzwa na huduma yetu ya haraka.`,
            es: (p: any) => `Hola ${p.name}, F-Pay te permite enviar dinero a tus seres queridos de forma segura. Disfruta de nuestras tarifas reducidas y servicio rapido.`,
            ar: (p: any) => `مرحباً ${p.name}، يتيح لك F-Pay إرسال الأموال إلى أحبائك بأمان. استمتع برسومنا المخفضة وخدمتنا السريعة.`
        },

        // ==================== PROMOTION KYC ====================
        'cron.kyc_promotion.title': {
            fr: 'Deverrouillez les transferts internationaux',
            en: 'Unlock International Transfers',
            sw: 'Fungua Uhamisho wa Kimataifa',
            es: 'Desbloquea Transferencias Internacionales',
            ar: 'افتح التحويلات الدولية'
        },
        'cron.kyc_promotion.body': {
            fr: (p: any) => `Bonjour ${p.name}, en finalisant votre verification KYC, vous pourrez envoyer de l'argent vers le Benin, la RDC, le Cameroun et bien d'autres pays. Faites-le maintenant et profitez de nos services.`,
            en: (p: any) => `Hello ${p.name}, by completing your KYC verification, you will be able to send money to Benin, DRC, Cameroon and many other countries. Do it now and enjoy our services.`,
            sw: (p: any) => `Habari ${p.name}, kwa kukamilisha uthibitisho wako wa KYC, utaweza kutuma pesa kwenda Benin, DRC, Cameroon na nchi nyingine nyingi. Fanya sasa na ufurahie huduma zetu.`,
            es: (p: any) => `Hola ${p.name}, al completar tu verificacion KYC, podras enviar dinero a Benin, RDC, Camerun y muchos otros paises. Hazlo ahora y disfruta de nuestros servicios.`,
            ar: (p: any) => `مرحباً ${p.name}، من خلال إكمال التحقق من KYC الخاص بك، ستتمكن من إرسال الأموال إلى بنين وجمهورية الكونغو الديمقراطية والكاميرون والعديد من البلدان الأخرى. افعلها الآن واستمتع بخدماتنا.`
        },

        // ==================== PROMOTION TRANSFERTS GRATUITS ====================
        'cron.free_transfer_promotion.title': {
            fr: 'Transferts internationaux simplifies',
            en: 'Simplified International Transfers',
            sw: 'Uhamisho wa Kimataifa Uliorahisishwa',
            es: 'Transferencias Internacionales Simplificadas',
            ar: 'تحويلات دولية مبسطة'
        },
        'cron.free_transfer_promotion.body': {
            fr: (p: any) => `Bonjour ${p.name}, avec F-Pay, envoyez de l'argent vers le Benin et la RDC en toute simplicite. Frais transparents, securite renforcee et support disponible 24h/24.`,
            en: (p: any) => `Hello ${p.name}, with F-Pay, send money to Benin and DRC with ease. Transparent fees, enhanced security and 24/7 support.`,
            sw: (p: any) => `Habari ${p.name}, kwa F-Pay, tuma pesa kwenda Benin na DRC kwa urahisi. Ada zilizo wazi, usalama ulioimarishwa na msaada wa 24/7.`,
            es: (p: any) => `Hola ${p.name}, con F-Pay, envia dinero a Benin y RDC con facilidad. Tarifas transparentes, seguridad reforzada y soporte 24/7.`,
            ar: (p: any) => `مرحباً ${p.name}، مع F-Pay، أرسل الأموال إلى بنين وجمهورية الكونغو الديمقراطية بسهولة. رسوم شفافة وأمان معزز ودعم على مدار الساعة.`
        }
    };

    // ✅ Définir les promotions mensuelles
    private readonly monthlyPromotions: Record<string, Record<string, string[]>> = {
        // Messages en français par mois
        fr: {
            '1': [
                'Bonne annee ! Envoyez de l\'argent vers le Benin et la RDC des maintenant avec F-Pay.',
                'Janvier, le mois des bonnes resolutions. Faites vos transferts internationaux en toute securite avec F-Pay.',
                'Commencez l\'annee en beauté avec F-Pay. Envoyez de l\'argent vers plus de 15 pays africains.',
                'Nouvelle annee, nouvelles opportunites ! F-Pay vous accompagne pour vos transferts internationaux.'
            ],
            '2': [
                'Mois de l\'amour, envoyez de l\'argent a vos proches avec F-Pay. Benin, RDC, Cameroun...',
                'Fevrier, le mois de la Saint-Valentin. Faites plaisir a vos proches avec un transfert F-Pay.',
                'Envoyez de l\'amour a vos proches en Afrique avec F-Pay. Frais competitifs et securite garantie.'
            ],
            '3': [
                'Mars, le mois du renouveau. F-Pay vous offre des transferts internationaux simplifies.',
                'Le printemps arrive, profitez de nos services de transfert vers le Benin et la RDC.',
                'Mars est le mois des grands projets. F-Pay vous accompagne pour vos transferts vers l\'Afrique.'
            ],
            '4': [
                'Avril, le mois des beaux jours. Envoyez de l\'argent a vos proches en Afrique avec F-Pay.',
                'Les fetes de Paques approchent. Faites un transfert a vos proches avec F-Pay.',
                'Avril, le mois du printemps. Profitez de nos tarifs avantageux pour vos transferts internationaux.'
            ],
            '5': [
                'Mai, le mois de la fete du travail. F-Pay vous facilite les transferts vers l\'international.',
                'Le mois de mai est l\'occasion de penser a vos proches. Envoyez-leur de l\'argent avec F-Pay.',
                'Mai, le mois des ponts et des voyages. F-Pay vous permet d\'envoyer de l\'argent en toute securite.'
            ],
            '6': [
                'Juin, le mois de l\'ete. Envoyez de l\'argent a vos proches en Afrique avec F-Pay.',
                'Les vacances approchent, pensez a faire un transfert a vos proches avec F-Pay.',
                'Juin, le mois des fetes de fin d\'annee scolaire. F-Pay est la pour vous.'
            ],
            '7': [
                'Juillet, le mois des grandes vacances. F-Pay vous accompagne pour vos transferts.',
                'Profitez de l\'ete pour envoyer de l\'argent a vos proches en Afrique avec F-Pay.',
                'Juillet, le mois des reunions familiales. F-Pay facilite vos transferts internationaux.'
            ],
            '8': [
                'Aout, le mois des fetes. Envoyez de l\'argent a vos proches en toute serenite avec F-Pay.',
                'Le mois d\'aout est propice aux retrouvailles. F-Pay est la pour vos transferts.',
                'Aout, le mois des vacances. Faites un transfert a vos proches avec F-Pay.'
            ],
            '9': [
                'Septembre, la rentree. F-Pay vous aide a envoyer de l\'argent a vos proches en Afrique.',
                'La rentree est une periode importante. F-Pay vous propose des transferts internationaux fiables.',
                'Septembre, le mois des nouveaux departs. Envoyez de l\'argent avec F-Pay.'
            ],
            '10': [
                'Octobre, le mois des fetes de fin d\'annee. F-Pay est la pour vos transferts.',
                'Les fetes approchent, pensez a envoyer de l\'argent a vos proches avec F-Pay.',
                'Octobre, le mois des recoltes. F-Pay vous accompagne pour vos transferts internationaux.'
            ],
            '11': [
                'Novembre, le mois des fetes. F-Pay vous facilite les transferts vers l\'international.',
                'Les fetes de fin d\'annee approchent. Envoyez de l\'argent a vos proches avec F-Pay.',
                'Novembre, le mois de la gratitude. Remerciez vos proches avec un transfert F-Pay.'
            ],
            '12': [
                'Decembre, le mois des fêtes. F-Pay vous souhaite de joyeuses fêtes et vous accompagne pour vos transferts.',
                'Les fetes de fin d\'annee sont la ! Envoyez de l\'argent a vos proches avec F-Pay.',
                'Decembre, le mois du partage. F-Pay vous permet d\'envoyer de l\'argent en toute securite.'
            ]
        },
        en: {
            '1': [
                'Happy New Year! Send money to Benin and DRC now with F-Pay.',
                'January, the month of resolutions. Make your international transfers securely with F-Pay.',
                'Start the year in style with F-Pay. Send money to over 15 African countries.',
                'New year, new opportunities! F-Pay supports you for your international transfers.'
            ],
            '2': [
                'Month of love, send money to your loved ones with F-Pay. Benin, DRC, Cameroon...',
                'February, the month of Valentine\'s Day. Make your loved ones happy with an F-Pay transfer.',
                'Send love to your loved ones in Africa with F-Pay. Competitive fees and guaranteed security.'
            ],
            '3': [
                'March, the month of renewal. F-Pay offers you simplified international transfers.',
                'Spring is coming, take advantage of our transfer services to Benin and DRC.',
                'March is the month of big projects. F-Pay supports you for your transfers to Africa.'
            ],
            '4': [
                'April, the month of sunny days. Send money to your loved ones in Africa with F-Pay.',
                'Easter holidays are coming. Make a transfer to your loved ones with F-Pay.',
                'April, the month of spring. Enjoy our competitive rates for international transfers.'
            ],
            '5': [
                'May, the month of Labor Day. F-Pay makes international transfers easier for you.',
                'May is the time to think about your loved ones. Send them money with F-Pay.',
                'May, the month of bridges and travel. F-Pay allows you to send money securely.'
            ],
            '6': [
                'June, the month of summer. Send money to your loved ones in Africa with F-Pay.',
                'Holidays are approaching, think about sending money to your loved ones with F-Pay.',
                'June, the month of school year end celebrations. F-Pay is here for you.'
            ],
            '7': [
                'July, the month of summer holidays. F-Pay supports you for your transfers.',
                'Enjoy the summer by sending money to your loved ones in Africa with F-Pay.',
                'July, the month of family reunions. F-Pay makes your international transfers easier.'
            ],
            '8': [
                'August, the month of celebrations. Send money to your loved ones with peace of mind with F-Pay.',
                'August is the time for reunions. F-Pay is here for your transfers.',
                'August, the month of holidays. Make a transfer to your loved ones with F-Pay.'
            ],
            '9': [
                'September, back to school. F-Pay helps you send money to your loved ones in Africa.',
                'Back to school is an important period. F-Pay offers reliable international transfers.',
                'September, the month of new beginnings. Send money with F-Pay.'
            ],
            '10': [
                'October, the month of end-of-year festivities. F-Pay is here for your transfers.',
                'The holidays are approaching, think about sending money to your loved ones with F-Pay.',
                'October, the month of harvests. F-Pay supports you for your international transfers.'
            ],
            '11': [
                'November, the month of celebrations. F-Pay makes international transfers easier for you.',
                'The end-of-year holidays are approaching. Send money to your loved ones with F-Pay.',
                'November, the month of gratitude. Thank your loved ones with an F-Pay transfer.'
            ],
            '12': [
                'December, the month of festivities. F-Pay wishes you happy holidays and supports you for your transfers.',
                'The end-of-year holidays are here! Send money to your loved ones with F-Pay.',
                'December, the month of sharing. F-Pay allows you to send money securely.'
            ]
        },
        sw: {
            '1': [
                'Heri ya Mwaka Mpya! Tuma pesa kwenda Benin na DRC sasa na F-Pay.',
                'Januari, mwezi wa maazimio. Fanya uhamisho wako wa kimataifa kwa usalama na F-Pay.',
                'Anza mwaka kwa mtindo na F-Pay. Tuma pesa kwenda nchi zaidi ya 15 za Afrika.',
                'Mwaka mpya, fursa mpya! F-Pay inakusaidia kwa uhamisho wako wa kimataifa.'
            ],
            '2': [
                'Mwezi wa upendo, tuma pesa kwa wapendwa wako na F-Pay. Benin, DRC, Cameroon...',
                'Februari, mwezi wa Siku ya Wapendanao. Fanya wapendwa wako wafurahi kwa uhamisho wa F-Pay.',
                'Tuma upendo kwa wapendwa wako barani Afrika kwa F-Pay. Ada za ushindani na usalama uliohakikishwa.'
            ],
            '3': [
                'Machi, mwezi wa kuzaliwa upya. F-Pay inakupa uhamisho wa kimataifa uliorahisishwa.',
                'Masika yanakuja, tumia huduma zetu za uhamisho kwenda Benin na DRC.',
                'Machi ni mwezi wa miradi mikubwa. F-Pay inakusaidia kwa uhamisho wako kwenda Afrika.'
            ],
            '4': [
                'Aprili, mwezi wa siku nzuri. Tuma pesa kwa wapendwa wako barani Afrika kwa F-Pay.',
                'Likizo za Pasaka zinakaribia. Fanya uhamisho kwa wapendwa wako na F-Pay.',
                'Aprili, mwezi wa masika. Furahia viwango vyetu vya ushindani kwa uhamisho wa kimataifa.'
            ],
            '5': [
                'Mei, mwezi wa Sikukuu ya Wafanyakazi. F-Pay inakurahisishia uhamisho wa kimataifa.',
                'Mei ni wakati wa kufikiria wapendwa wako. Tuma pesa kwao na F-Pay.',
                'Mei, mwezi wa daraja na safari. F-Pay inakuruhusu kutuma pesa kwa usalama.'
            ],
            '6': [
                'Juni, mwezi wa kiangazi. Tuma pesa kwa wapendwa wako barani Afrika kwa F-Pay.',
                'Likizo zinakaribia, fikiria kutuma pesa kwa wapendwa wako na F-Pay.',
                'Juni, mwezi wa sherehe za mwisho wa mwaka wa shule. F-Pay iko hapa kwa ajili yako.'
            ],
            '7': [
                'Julai, mwezi wa likizo kubwa. F-Pay inakusaidia kwa uhamisho wako.',
                'Furahia kiangazi kwa kutuma pesa kwa wapendwa wako barani Afrika na F-Pay.',
                'Julai, mwezi wa kukutana familia. F-Pay inarahisisha uhamisho wako wa kimataifa.'
            ],
            '8': [
                'Agosti, mwezi wa sherehe. Tuma pesa kwa wapendwa wako kwa amani na F-Pay.',
                'Agosti ni wakati wa kukutana tena. F-Pay iko hapa kwa uhamisho wako.',
                'Agosti, mwezi wa likizo. Fanya uhamisho kwa wapendwa wako na F-Pay.'
            ],
            '9': [
                'Septemba, kurudi shuleni. F-Pay inakusaidia kutuma pesa kwa wapendwa wako barani Afrika.',
                'Kurudi shuleni ni kipindi muhimu. F-Pay inatoa uhamisho wa kimataifa wa kuaminika.',
                'Septemba, mwezi wa mwanzo mpya. Tuma pesa na F-Pay.'
            ],
            '10': [
                'Oktoba, mwezi wa sherehe za mwisho wa mwaka. F-Pay iko hapa kwa uhamisho wako.',
                'Sherehe zinakaribia, fikiria kutuma pesa kwa wapendwa wako na F-Pay.',
                'Oktoba, mwezi wa mavuno. F-Pay inakusaidia kwa uhamisho wako wa kimataifa.'
            ],
            '11': [
                'Novemba, mwezi wa sherehe. F-Pay inakurahisishia uhamisho wa kimataifa.',
                'Sherehe za mwisho wa mwaka zinakaribia. Tuma pesa kwa wapendwa wako na F-Pay.',
                'Novemba, mwezi wa shukrani. Shukuru wapendwa wako kwa uhamisho wa F-Pay.'
            ],
            '12': [
                'Desemba, mwezi wa sherehe. F-Pay inakutakia sikukuu njema na inakusaidia kwa uhamisho wako.',
                'Sherehe za mwisho wa mwaka zimefika! Tuma pesa kwa wapendwa wako na F-Pay.',
                'Desemba, mwezi wa kushirikiana. F-Pay inakuruhusu kutuma pesa kwa usalama.'
            ]
        },
        es: {
            '1': [
                '¡Feliz Año Nuevo! Envía dinero a Benín y RDC ahora con F-Pay.',
                'Enero, el mes de los propósitos. Haz tus transferencias internacionales de forma segura con F-Pay.',
                'Comienza el año con estilo con F-Pay. Envía dinero a más de 15 países africanos.',
                '¡Año nuevo, nuevas oportunidades! F-Pay te acompaña en tus transferencias internacionales.'
            ],
            '2': [
                'Mes del amor, envía dinero a tus seres queridos con F-Pay. Benín, RDC, Camerún...',
                'Febrero, el mes de San Valentín. Haz felices a tus seres queridos con una transferencia F-Pay.',
                'Envía amor a tus seres queridos en África con F-Pay. Tarifas competitivas y seguridad garantizada.'
            ],
            '3': [
                'Marzo, el mes de la renovación. F-Pay te ofrece transferencias internacionales simplificadas.',
                'La primavera llega, aprovecha nuestros servicios de transferencia a Benín y RDC.',
                'Marzo es el mes de los grandes proyectos. F-Pay te acompaña en tus transferencias a África.'
            ],
            '4': [
                'Abril, el mes de los días soleados. Envía dinero a tus seres queridos en África con F-Pay.',
                'Se acercan las vacaciones de Pascua. Haz una transferencia a tus seres queridos con F-Pay.',
                'Abril, el mes de la primavera. Disfruta de nuestras tarifas competitivas para transferencias internacionales.'
            ],
            '5': [
                'Mayo, el mes del Día del Trabajo. F-Pay te facilita las transferencias internacionales.',
                'Mayo es el momento de pensar en tus seres queridos. Envíales dinero con F-Pay.',
                'Mayo, el mes de los puentes y viajes. F-Pay te permite enviar dinero de forma segura.'
            ],
            '6': [
                'Junio, el mes del verano. Envía dinero a tus seres queridos en África con F-Pay.',
                'Se acercan las vacaciones, piensa en enviar dinero a tus seres queridos con F-Pay.',
                'Junio, el mes de las celebraciones de fin de curso escolar. F-Pay está aquí para ti.'
            ],
            '7': [
                'Julio, el mes de las grandes vacaciones. F-Pay te acompaña en tus transferencias.',
                'Disfruta del verano enviando dinero a tus seres queridos en África con F-Pay.',
                'Julio, el mes de las reuniones familiares. F-Pay facilita tus transferencias internacionales.'
            ],
            '8': [
                'Agosto, el mes de las fiestas. Envía dinero a tus seres queridos con tranquilidad con F-Pay.',
                'Agosto es el momento de los reencuentros. F-Pay está aquí para tus transferencias.',
                'Agosto, el mes de las vacaciones. Haz una transferencia a tus seres queridos con F-Pay.'
            ],
            '9': [
                'Septiembre, la vuelta al cole. F-Pay te ayuda a enviar dinero a tus seres queridos en África.',
                'La vuelta al cole es un período importante. F-Pay ofrece transferencias internacionales fiables.',
                'Septiembre, el mes de los nuevos comienzos. Envía dinero con F-Pay.'
            ],
            '10': [
                'Octubre, el mes de las fiestas de fin de año. F-Pay está aquí para tus transferencias.',
                'Se acercan las fiestas, piensa en enviar dinero a tus seres queridos con F-Pay.',
                'Octubre, el mes de las cosechas. F-Pay te acompaña en tus transferencias internacionales.'
            ],
            '11': [
                'Noviembre, el mes de las fiestas. F-Pay te facilita las transferencias internacionales.',
                'Se acercan las fiestas de fin de año. Envía dinero a tus seres queridos con F-Pay.',
                'Noviembre, el mes de la gratitud. Agradece a tus seres queridos con una transferencia F-Pay.'
            ],
            '12': [
                'Diciembre, el mes de las fiestas. F-Pay te desea felices fiestas y te acompaña en tus transferencias.',
                '¡Las fiestas de fin de año están aquí! Envía dinero a tus seres queridos con F-Pay.',
                'Diciembre, el mes de compartir. F-Pay te permite enviar dinero de forma segura.'
            ]
        },
        ar: {
            '1': [
                'سنة جديدة سعيدة! أرسل الأموال إلى بنين وجمهورية الكونغو الديمقراطية الآن مع F-Pay.',
                'يناير، شهر القرارات. قم بتحويلاتك الدولية بأمان مع F-Pay.',
                'ابدأ العام بأناقة مع F-Pay. أرسل الأموال إلى أكثر من 15 دولة أفريقية.',
                'عام جديد، فرص جديدة! F-Pay يدعمك في تحويلاتك الدولية.'
            ],
            '2': [
                'شهر الحب، أرسل الأموال إلى أحبائك مع F-Pay. بنين، جمهورية الكونغو الديمقراطية، الكاميرون...',
                'فبراير، شهر عيد الحب. أسعد أحبائك مع تحويل F-Pay.',
                'أرسل الحب إلى أحبائك في أفريقيا مع F-Pay. رسوم تنافسية وأمان مضمون.'
            ],
            '3': [
                'مارس، شهر التجديد. F-Pay يقدم لك تحويلات دولية مبسطة.',
                'الربيع قادم، استفد من خدماتنا للتحويل إلى بنين وجمهورية الكونغو الديمقراطية.',
                'مارس هو شهر المشاريع الكبيرة. F-Pay يدعمك في تحويلاتك إلى أفريقيا.'
            ],
            '4': [
                'أبريل، شهر الأيام المشمسة. أرسل الأموال إلى أحبائك في أفريقيا مع F-Pay.',
                'عطلات عيد الفصح تقترب. قم بتحويل إلى أحبائك مع F-Pay.',
                'أبريل، شهر الربيع. استمتع بأسعارنا التنافسية للتحويلات الدولية.'
            ],
            '5': [
                'مايو، شهر عيد العمال. F-Pay يسهل لك التحويلات الدولية.',
                'مايو هو الوقت المناسب للتفكير في أحبائك. أرسل لهم المال مع F-Pay.',
                'مايو، شهر الجسور والسفر. F-Pay يتيح لك إرسال الأموال بأمان.'
            ],
            '6': [
                'يونيو، شهر الصيف. أرسل الأموال إلى أحبائك في أفريقيا مع F-Pay.',
                'العطلات تقترب، فكر في إرسال الأموال إلى أحبائك مع F-Pay.',
                'يونيو، شهر احتفالات نهاية العام الدراسي. F-Pay هنا من أجلك.'
            ],
            '7': [
                'يوليو، شهر العطلات الكبرى. F-Pay يدعمك في تحويلاتك.',
                'استمتع بالصيف بإرسال الأموال إلى أحبائك في أفريقيا مع F-Pay.',
                'يوليو، شهر لم الشمل العائلي. F-Pay يسهل تحويلاتك الدولية.'
            ],
            '8': [
                'أغسطس، شهر الاحتفالات. أرسل الأموال إلى أحبائك بكل راحة بال مع F-Pay.',
                'أغسطس هو وقت اللقاءات. F-Pay هنا لتحويلاتك.',
                'أغسطس، شهر العطلات. قم بتحويل إلى أحبائك مع F-Pay.'
            ],
            '9': [
                'سبتمبر، العودة إلى المدرسة. F-Pay يساعدك في إرسال الأموال إلى أحبائك في أفريقيا.',
                'العودة إلى المدرسة فترة مهمة. F-Pay يقدم تحويلات دولية موثوقة.',
                'سبتمبر، شهر البدايات الجديدة. أرسل الأموال مع F-Pay.'
            ],
            '10': [
                'أكتوبر، شهر احتفالات نهاية العام. F-Pay هنا لتحويلاتك.',
                'الاحتفالات تقترب، فكر في إرسال الأموال إلى أحبائك مع F-Pay.',
                'أكتوبر، شهر الحصاد. F-Pay يدعمك في تحويلاتك الدولية.'
            ],
            '11': [
                'نوفمبر، شهر الاحتفالات. F-Pay يسهل لك التحويلات الدولية.',
                'احتفالات نهاية العام تقترب. أرسل الأموال إلى أحبائك مع F-Pay.',
                'نوفمبر، شهر الامتنان. اشكر أحبائك مع تحويل F-Pay.'
            ],
            '12': [
                'ديسمبر، شهر الاحتفالات. F-Pay يتمنى لك عطلة سعيدة ويدعمك في تحويلاتك.',
                'احتفالات نهاية العام هنا! أرسل الأموال إلى أحبائك مع F-Pay.',
                'ديسمبر، شهر المشاركة. F-Pay يتيح لك إرسال الأموال بأمان.'
            ]
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

    private getMonthPromotions(lang: string): string[] {
        const month = new Date().getMonth() + 1; // 1-12
        const monthKey = month.toString();

        // Récupérer les promotions du mois
        const monthPromotions = this.monthlyPromotions[lang]?.[monthKey];
        if (monthPromotions && monthPromotions.length > 0) {
            return monthPromotions;
        }

        // Fallback: utiliser les promotions génériques en français
        const defaultPromotions = this.monthlyPromotions['fr']?.[monthKey];
        if (defaultPromotions) {
            return defaultPromotions;
        }

        // Fallback ultime: promotions du mois 1
        return this.monthlyPromotions['fr']?.['1'] || [
            'Envoyez de l\'argent vers le Benin et la RDC en toute simplicite avec F-Pay.'
        ];
    }

    constructor(
        private readonly prisma: PrismaService,
        private readonly notificationHelper: NotificationHelper,
        private readonly i18nService: I18nService,
    ) { }

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

                sentCount++;
            }

            this.logger.log(`Rappel KYC envoye a ${sentCount} utilisateurs`);
        } catch (error) {
            this.logger.error('Erreur rappel KYC:', error);
        } finally {
            this.isRunning = false;
        }
    }

    // ==================== RAPPEL KYC POUR TRANSFERTS INTERNATIONAUX (11h) ====================
    @Cron('0 11 * * *')
    async remindKycForInternational() {
        if (this.isRunning) return;
        this.isRunning = true;
        try {
            this.logger.log('Debut rappel KYC pour transferts internationaux');

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

                const title = this.t('cron.kyc_for_international_transfer.title', lang);
                const body = this.t('cron.kyc_for_international_transfer.body', lang, { name: user.full_name || 'Cher client' });

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

                sentCount++;
            }

            this.logger.log(`Rappel KYC international envoye a ${sentCount} utilisateurs`);
        } catch (error) {
            this.logger.error('Erreur rappel KYC international:', error);
        } finally {
            this.isRunning = false;
        }
    }

    // ==================== AVANTAGES KYC INTERNATIONAL (16h) ====================
    @Cron('0 16 * * *')
    async remindKycBenefits() {
        if (this.isRunning) return;
        this.isRunning = true;
        try {
            this.logger.log('Debut rappel avantages KYC international');

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

                const title = this.t('cron.kyc_international_benefits.title', lang);
                const body = this.t('cron.kyc_international_benefits.body', lang, { name: user.full_name || 'Cher client' });

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

                sentCount++;
            }

            this.logger.log(`Rappel avantages KYC international envoye a ${sentCount} utilisateurs`);
        } catch (error) {
            this.logger.error('Erreur rappel avantages KYC international:', error);
        } finally {
            this.isRunning = false;
        }
    }

    // ==================== RAPPEL DESTINATIONS INTERNATIONALES (9h) ====================
    @Cron('0 9 * * *')
    async remindInternationalDestinations() {
        if (this.isRunning) return;
        this.isRunning = true;
        try {
            this.logger.log('Debut rappel destinations internationales');

            const users = await this.prisma.user.findMany({
                where: {
                    kycStatus: 'VERIFIED',
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

                const title = this.t('cron.international_destinations.title', lang);
                const body = this.t('cron.international_destinations.body', lang, { name: user.full_name || 'Cher client' });

                await this.notificationHelper.notify(
                    user.id,
                    NotificationType.TRANSFER,
                    {
                        title,
                        message: body,
                        name: user.full_name || 'Cher client',
                    },
                    'TRANSFER',
                    crypto.randomUUID(),
                    lang,
                );

                sentCount++;
            }

            this.logger.log(`Rappel destinations internationales envoye a ${sentCount} utilisateurs`);
        } catch (error) {
            this.logger.error('Erreur rappel destinations internationales:', error);
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
                const body = this.t('cron.benin_transfer.body', lang, { name: user.full_name || 'Cher client' });

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

            this.logger.log(`Promotion Benin envoyee a ${sentCount} utilisateurs`);
        } catch (error) {
            this.logger.error('Erreur promotion Benin:', error);
        } finally {
            this.isRunning = false;
        }
    }

    // ==================== RAPPEL SOLDE FAIBLE (15h) ====================
    @Cron('0 15 * * *')
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

            this.logger.log(`Rappels solde faible envoyes a ${sentCount} utilisateurs`);
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

            this.logger.log(`Rappels transactions envoyes a ${sentCount} utilisateurs`);
        } catch (error) {
            this.logger.error('Erreur rappel transactions:', error);
        } finally {
            this.isRunning = false;
        }
    }

    // ==================== BIENVENUE NOUVEAUX UTILISATEURS (8h) ====================
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
                const body = this.t('cron.welcome.body', lang, { name: user.full_name || 'Cher client' });

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

            this.logger.log(`Messages de bienvenue envoyes a ${sentCount} nouveaux utilisateurs`);
        } catch (error) {
            this.logger.error('Erreur welcome new users:', error);
        } finally {
            this.isRunning = false;
        }
    }

    // ==================== RAPPEL TRANSFERTS INTERNATIONAUX (13h) ====================
    @Cron('0 13 * * *')
    async remindInternationalTransfers() {
        if (this.isRunning) return;
        this.isRunning = true;
        try {
            this.logger.log('Debut rappel transferts internationaux');

            const users = await this.prisma.user.findMany({
                where: {
                    kycStatus: 'VERIFIED',
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
                    name: user.full_name || 'Cher client',
                    amount: '1000',
                    currency: 'USD',
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

            this.logger.log(`Rappel transferts internationaux envoye a ${sentCount} utilisateurs`);
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

            let sentCount = 0;
            for (const user of users) {
                const settings = user.user_settings && user.user_settings.length > 0 ? user.user_settings[0] : null;
                const lang = settings?.language || 'fr';

                // ✅ Récupérer les promotions du mois en cours
                const monthPromotions = this.getMonthPromotions(lang);
                const randomPromo = monthPromotions[Math.floor(Math.random() * monthPromotions.length)];

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

            this.logger.log(`Promotion hebdomadaire envoyee a ${sentCount} utilisateurs`);
        } catch (error) {
            this.logger.error('Erreur promotion hebdomadaire:', error);
        } finally {
            this.isRunning = false;
        }
    }

    // ==================== RAPPEL ENVOI D'ARGENT (17h) ====================
    @Cron('0 17 * * *')
    async remindMoneyTransfer() {
        if (this.isRunning) return;
        this.isRunning = true;
        try {
            this.logger.log('Debut rappel envoi d\'argent');

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

                const title = this.t('cron.money_transfer_reminder.title', lang);
                const body = this.t('cron.money_transfer_reminder.body', lang, { name: user.full_name || 'Cher client' });

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

            this.logger.log(`Rappel envoi d'argent envoye a ${sentCount} utilisateurs`);
        } catch (error) {
            this.logger.error('Erreur rappel envoi d\'argent:', error);
        } finally {
            this.isRunning = false;
        }
    }

    // ==================== PROMOTION KYC (18h) ====================
    @Cron('0 18 * * *')
    async promoteKyc() {
        if (this.isRunning) return;
        this.isRunning = true;
        try {
            this.logger.log('Debut promotion KYC');

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

                const title = this.t('cron.kyc_promotion.title', lang);
                const body = this.t('cron.kyc_promotion.body', lang, { name: user.full_name || 'Cher client' });

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

            this.logger.log(`Promotion KYC envoyee a ${sentCount} utilisateurs`);
        } catch (error) {
            this.logger.error('Erreur promotion KYC:', error);
        } finally {
            this.isRunning = false;
        }
    }

    // ==================== PROMOTION TRANSFERTS GRATUITS (19h) ====================
    @Cron('0 19 * * *')
    async promoteFreeTransfers() {
        if (this.isRunning) return;
        this.isRunning = true;
        try {
            this.logger.log('Debut promotion transferts gratuits');

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

                const title = this.t('cron.free_transfer_promotion.title', lang);
                const body = this.t('cron.free_transfer_promotion.body', lang, { name: user.full_name || 'Cher client' });

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

            this.logger.log(`Promotion transferts gratuits envoyee a ${sentCount} utilisateurs`);
        } catch (error) {
            this.logger.error('Erreur promotion transferts gratuits:', error);
        } finally {
            this.isRunning = false;
        }
    }
}