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

    console.log(`📤 Envoi notification à ${userId}, type=${type}, title=${title}`);

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

  private mapTypeToString(type: NotificationType): string {
    return String(type).toUpperCase();
  }

  private getTranslatedContent(
    type: NotificationType,
    data: any,
    lang: string,
  ) {
    let titleKey: string, bodyKey: string;

    // ✅ Vérifier si c'est un transfert international en attente
    const isPending = data?.isPending === true || data?.status === 'PENDING';
    const isConfirmed = data?.isConfirmed === true || data?.status === 'COMPLETED';

    switch (type) {
      // ✅ NOUVEAUX CAS POUR TRANSFERTS INTERNATIONAUX
      case NotificationType.TRANSFER_PENDING:
        titleKey = 'notifications.transfer_pending.title';
        bodyKey = 'notifications.transfer_pending.body';
        break;

      case NotificationType.TRANSFER_CONFIRMED:
        titleKey = 'notifications.transfer_confirmed.title';
        bodyKey = 'notifications.transfer_confirmed.body';
        break;

      case NotificationType.TRANSACTION:
        if (data?.operationType === 'topup') {
          titleKey = 'notifications.top_up_success.title';
          bodyKey = 'notifications.top_up_success.body';
        } else if (data?.operationType === 'cashout') {
          titleKey = 'notifications.cashout_success.title';
          bodyKey = 'notifications.cashout_success.body';
        } else {
          titleKey = 'notifications.transaction.title';
          bodyKey = 'notifications.transaction.body';
        }
        break;

      case NotificationType.TRANSFER:
        // ✅ Gestion des transferts internationaux en attente
        if (isPending) {
          titleKey = 'notifications.transfer_pending.title';
          bodyKey = 'notifications.transfer_pending.body';
        }
        // ✅ Gestion des transferts internationaux confirmés
        else if (isConfirmed) {
          titleKey = 'notifications.transfer_confirmed.title';
          bodyKey = 'notifications.transfer_confirmed.body';
        }
        // Transferts nationaux normaux
        else if (data?.direction === 'sent') {
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

      default:
        titleKey = 'notifications.default.title';
        bodyKey = 'notifications.default.body';
    }

    const title = this.i18nService.translate(titleKey, lang);
    const body = this.i18nService.translate(bodyKey, lang, {
      amount: data?.amount,
      currency: data?.currency || 'CDF',
      toName: data?.toName,
      toPhone: data?.toPhone,
      fromName: data?.fromName,
      fromAccount: data?.fromAccount,
      merchantName: data?.merchantName,
      merchantPhone: data?.merchantPhone,
      customerName: data?.customerName,
      customerAccount: data?.customerAccount,
      status: data?.status,
      balance: data?.balance,
    });

    return { title, body };
  }
}