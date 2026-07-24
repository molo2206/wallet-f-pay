import { Injectable, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { NotificationType } from '../type/notification-type';
import { lastValueFrom, timeout } from 'rxjs';
import { I18nService } from '@app/common';

@Injectable()
export class NotificationHelper {
  constructor(
    @Inject('NOTIFICATION_CLIENT') private notificationClient: ClientProxy,
    private readonly i18nService: I18nService,
  ) { }

  async notify(
    userId: string,
    type: NotificationType,
    data?: any,
    entity?: string,
    entityId?: string,
    lang: string = 'fr',
  ) {
    const { title, body } = this.getTranslatedContent(type, data, lang);
    const pushData: Record<string, string> = {};
    if (entity) pushData.entity = entity;
    if (entityId) pushData.entityId = entityId;

    console.log(`📤 Envoi notification à ${userId}, type=${type}, title=${title}, body=${body}`);

    try {
      await lastValueFrom(
        this.notificationClient.send('send_notification', {
          userId,
          title,
          body,
          type,
          data: pushData,
        }).pipe(timeout(10000))
      );
      console.log(`✅ Notification envoyée avec succès pour user ${userId}`);
    } catch (err) {
      console.error(`❌ Échec envoi notification pour ${userId}:`, err);
    }
  }

  private getTranslatedContent(
    type: NotificationType,
    data: any,
    lang: string,
  ) {
    let titleKey: string, bodyKey: string;

    // ✅ Si des clés personnalisées sont fournies, les utiliser directement
    if (data?.titleKey && data?.bodyKey) {
      titleKey = data.titleKey;
      bodyKey = data.bodyKey;
    } else {
      // ✅ Sinon, mapper selon le type de notification
      switch (type) {
        // ============================================
        // ✅ OPÉRATIONS WALLET
        // ============================================

        case NotificationType.TOP_UP_SUCCESS:
          titleKey = 'notifications.top_up_success.title';
          bodyKey = 'notifications.top_up_success.body';
          break;

        case NotificationType.CASHOUT_SUCCESS:
          titleKey = 'notifications.cashout_success.title';
          bodyKey = 'notifications.cashout_success.body';
          break;

        case NotificationType.TRANSFER_SENT:
          titleKey = 'notifications.transfer_sent.title';
          bodyKey = 'notifications.transfer_sent.body';
          break;

        case NotificationType.TRANSFER_RECEIVED:
          titleKey = 'notifications.transfer_received.title';
          bodyKey = 'notifications.transfer_received.body';
          break;

        case NotificationType.PAYMENT_SENT:
          titleKey = 'notifications.payment_sent.title';
          bodyKey = 'notifications.payment_sent.body';
          break;

        case NotificationType.PAYMENT_RECEIVED:
          titleKey = 'notifications.payment_received.title';
          bodyKey = 'notifications.payment_received.body';
          break;

        case NotificationType.WALLET_CREDITED:
          titleKey = 'notifications.wallet_credited.title';
          bodyKey = 'notifications.wallet_credited.body';
          break;

        case NotificationType.WALLET_DEBITED:
          titleKey = 'notifications.wallet_debited.title';
          bodyKey = 'notifications.wallet_debited.body';
          break;

        // ============================================
        // ✅ TRANSFERTS INTERNATIONAUX
        // ============================================

        case NotificationType.TRANSFER_PENDING:
          titleKey = 'notifications.transfer_pending.title';
          bodyKey = 'notifications.transfer_pending.body';
          break;

        case NotificationType.TRANSFER_CONFIRMED:
          titleKey = 'notifications.transfer_confirmed.title';
          bodyKey = 'notifications.transfer_confirmed.body';
          break;

        // ============================================
        // ✅ KYC
        // ============================================

        case NotificationType.KYC_VERIFIED:
          titleKey = 'notifications.kyc_verified.title';
          bodyKey = 'notifications.kyc_verified.body';
          break;

        case NotificationType.KYC_REJECTED:
          titleKey = 'notifications.kyc_rejected.title';
          bodyKey = 'notifications.kyc_rejected.body';
          break;

        // ============================================
        // ✅ MAINTENANCE
        // ============================================

        case NotificationType.MAINTENANCE_FEE:
          titleKey = 'notifications.maintenance_fee.title';
          bodyKey = 'notifications.maintenance_fee.body';
          break;

        case NotificationType.MAINTENANCE_SCHEDULED:
          titleKey = 'notifications.maintenance_scheduled.title';
          bodyKey = 'notifications.maintenance_scheduled.body';
          break;

        // ============================================
        // ✅ TRANSACTION (Générique)
        // ============================================

        case NotificationType.TRANSACTION:
          if (data?.operationType === 'topup') {
            titleKey = 'notifications.top_up_success.title';
            bodyKey = 'notifications.top_up_success.body';
          } else if (data?.operationType === 'cashout') {
            titleKey = 'notifications.cashout_success.title';
            bodyKey = 'notifications.cashout_success.body';
          } else if (data?.direction === 'sent') {
            titleKey = 'notifications.transfer_sent.title';
            bodyKey = 'notifications.transfer_sent.body';
          } else if (data?.direction === 'received') {
            titleKey = 'notifications.transfer_received.title';
            bodyKey = 'notifications.transfer_received.body';
          } else {
            titleKey = 'notifications.transaction.title';
            bodyKey = 'notifications.transaction.body';
          }
          break;

        // ============================================
        // ✅ TRANSFER (Générique)
        // ============================================

        case NotificationType.TRANSFER:
          if (data?.status === 'PENDING') {
            titleKey = 'notifications.transfer_pending.title';
            bodyKey = 'notifications.transfer_pending.body';
          } else if (data?.status === 'COMPLETED' || data?.isConfirmed) {
            titleKey = 'notifications.transfer_confirmed.title';
            bodyKey = 'notifications.transfer_confirmed.body';
          } else if (data?.direction === 'sent') {
            titleKey = 'notifications.transfer_sent.title';
            bodyKey = 'notifications.transfer_sent.body';
          } else if (data?.direction === 'received') {
            titleKey = 'notifications.transfer_received.title';
            bodyKey = 'notifications.transfer_received.body';
          } else {
            titleKey = 'notifications.transfer.title';
            bodyKey = 'notifications.transfer.body';
          }
          break;

        // ============================================
        // ✅ PAYMENT (Générique)
        // ============================================

        case NotificationType.PAYMENT:
          if (data?.direction === 'sent') {
            titleKey = 'notifications.payment_sent.title';
            bodyKey = 'notifications.payment_sent.body';
          } else if (data?.direction === 'received') {
            titleKey = 'notifications.payment_received.title';
            bodyKey = 'notifications.payment_received.body';
          } else {
            titleKey = 'notifications.payment.title';
            bodyKey = 'notifications.payment.body';
          }
          break;

        // ============================================
        // ✅ WALLET (Générique)
        // ============================================

        case NotificationType.WALLET:
          if (data?.operation === 'credited') {
            titleKey = 'notifications.wallet_credited.title';
            bodyKey = 'notifications.wallet_credited.body';
          } else if (data?.operation === 'debited') {
            titleKey = 'notifications.wallet_debited.title';
            bodyKey = 'notifications.wallet_debited.body';
          } else {
            titleKey = 'notifications.default.title';
            bodyKey = 'notifications.default.body';
          }
          break;

        // ============================================
        // ✅ COMMUNICATION / PROMOTION
        // ============================================

        case NotificationType.ANNOUNCEMENT:
          titleKey = data?.titleKey || 'notifications.announcement.title';
          bodyKey = data?.bodyKey || 'notifications.announcement.body';
          break;

        case NotificationType.PROMOTION:
          titleKey = data?.titleKey || 'notifications.promotion.title';
          bodyKey = data?.bodyKey || 'notifications.promotion.body';
          break;

        case NotificationType.PROMO:
          titleKey = data?.titleKey || 'notifications.promo.title';
          bodyKey = data?.bodyKey || 'notifications.promo.body';
          break;

        case NotificationType.SURVEY:
          titleKey = data?.titleKey || 'notifications.survey.title';
          bodyKey = data?.bodyKey || 'notifications.survey.body';
          break;

        case NotificationType.TIP:
          titleKey = data?.titleKey || 'notifications.tip.title';
          bodyKey = data?.bodyKey || 'notifications.tip.body';
          break;

        case NotificationType.UPDATE:
          titleKey = data?.titleKey || 'notifications.update.title';
          bodyKey = data?.bodyKey || 'notifications.update.body';
          break;

        case NotificationType.REMINDER:
          titleKey = data?.titleKey || 'notifications.reminder.title';
          bodyKey = data?.bodyKey || 'notifications.reminder.body';
          break;

        case NotificationType.FEEDBACK_REQUEST:
          titleKey = 'notifications.feedback_request.title';
          bodyKey = 'notifications.feedback_request.body';
          break;

        // ============================================
        // ✅ SECURITY
        // ============================================

        case NotificationType.SECURITY_ALERT:
          titleKey = 'notifications.security_alert.title';
          bodyKey = 'notifications.security_alert.body';
          break;

        case NotificationType.SUSPICIOUS_ACTIVITY:
          titleKey = 'notifications.suspicious_activity.title';
          bodyKey = 'notifications.suspicious_activity.body';
          break;

        case NotificationType.SECURITY:
          titleKey = 'notifications.security.title';
          bodyKey = 'notifications.security.body';
          break;

        // ============================================
        // ✅ ONBOARDING / WELCOME
        // ============================================

        case NotificationType.WELCOME:
          titleKey = 'notifications.welcome.title';
          bodyKey = 'notifications.welcome.body';
          break;

        case NotificationType.ONBOARDING:
          titleKey = 'notifications.onboarding.title';
          bodyKey = 'notifications.onboarding.body';
          break;

        case NotificationType.BIRTHDAY:
          titleKey = 'notifications.birthday.title';
          bodyKey = 'notifications.birthday.body';
          break;

        // ============================================
        // ✅ ALERT / SYSTEM
        // ============================================

        case NotificationType.ALERT:
          titleKey = data?.titleKey || 'notifications.alert.title';
          bodyKey = data?.bodyKey || 'notifications.alert.body';
          break;

        case NotificationType.SYSTEM:
          titleKey = data?.titleKey || 'notifications.system.title';
          bodyKey = data?.bodyKey || 'notifications.system.body';
          break;

        // ============================================
        // ✅ DEFAULT
        // ============================================

        default:
          titleKey = 'notifications.default.title';
          bodyKey = 'notifications.default.body';
      }
    }

    // ✅ Préparer les paramètres pour la traduction
    const params = {
      amount: data?.amount,
      currency: data?.currency || 'CDF',
      balance: data?.balance,
      full_name: data?.full_name,
      name: data?.name,
      toName: data?.toName || data?.name,
      toPhone: data?.toPhone,
      fromName: data?.fromName || data?.name,
      fromPhone: data?.fromPhone,
      merchantName: data?.merchantName || data?.name,
      merchantPhone: data?.merchantPhone,
      customerName: data?.customerName || data?.name,
      customerAccount: data?.customerAccount,
      payerName: data?.payerName || data?.name,
      payerPhone: data?.payerPhone,
      status: data?.status,
      count: data?.count,
      total: data?.total,
      users: data?.users,
      merchants: data?.merchants,
      country: data?.country,
      role: data?.role,
    };

    // ✅ Traduction
    let title = data?.title || this.i18nService.translate(titleKey, lang, params);
    let body = data?.message || this.i18nService.translate(bodyKey, lang, params);

    // ✅ Si le body est vide, utiliser un message par défaut
    if (!body || body === bodyKey) {
      body = this.i18nService.translate('notifications.default.body', lang, params);
    }

    console.log(`📝 Notification traduite: title="${title}", body="${body}"`);

    return { title, body };
  }
}