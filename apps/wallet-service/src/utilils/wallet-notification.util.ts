/* eslint-disable prefer-const */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// apps/wallet-service/src/utils/wallet-notification.util.ts
import { NotificationHelper } from 'apps/notification-service/src/helpers/NotificationHelper';
import { NotificationType } from 'apps/notification-service/src/type/notification-type';
import { SmsService } from 'apps/auth-service/src/sms/sms.service';
import { I18nService } from '@app/common';

export async function notifyTransaction(
  smsService: SmsService,
  notificationHelper: NotificationHelper,
  i18nService: I18nService,
  shouldSendSms: (userId: string) => Promise<boolean>,
  shouldSendPush: (userId: string) => Promise<boolean>,
  getUserLanguage: (userId: string) => Promise<string>,
  transaction: any,
  user: any,
  wallet: any,
  type: string,
  counterparty?: { name?: string; phone?: string; accountNumber?: string; status?: string },
) {
  let userLang = 'fr';
  try {
    userLang = await getUserLanguage(user.id);
  } catch (error) {
    console.warn(`Impossible de récupérer la langue pour l'utilisateur ${user.id}, utilisation de 'fr' par défaut`);
  }

  // ✅ Valeurs par défaut
  const defaultName = user?.full_name || 'Client';
  const defaultAmount = transaction?.amount || 0;
  const defaultCurrency = wallet?.currency || 'CDF';
  const defaultBalance = wallet?.balance || 0;

  // --- SMS ---
  if (user?.phone && (await shouldSendSms(user.id))) {
    const cleanPhone = user.phone.replace(/[^0-9+]/g, '');

    let smsKey: string;
    const params: any = {
      full_name: defaultName,
      amount: defaultAmount,
      currency: defaultCurrency,
      balance: defaultBalance,
    };

    switch (type) {
      case 'topup':
        smsKey = 'wallet.top_up_sms';
        break;
      case 'cashout':
        smsKey = 'wallet.cashout_sms';
        break;
      case 'send_sent':
        smsKey = 'wallet.transfer_sender_sms';
        params.toPhone = counterparty?.phone || 'Destinataire';
        params.toName = counterparty?.name || 'Destinataire';
        break;
      case 'send_received':
        smsKey = 'wallet.transfer_receiver_sms';
        params.fromPhone = counterparty?.phone || 'Expéditeur';
        params.fromName = counterparty?.name || 'Expéditeur';
        break;
      case 'send_pending':
        smsKey = 'wallet.transfer_pending_sms';
        params.toPhone = counterparty?.phone || 'Destinataire';
        params.toName = counterparty?.name || 'Destinataire';
        params.status = 'PENDING';
        break;
      case 'send_confirmed':
        smsKey = 'wallet.transfer_confirmed_sms';
        params.toPhone = counterparty?.phone || 'Destinataire';
        params.toName = counterparty?.name || 'Destinataire';
        params.status = 'COMPLETED';
        break;
      case 'pay_sent':
        smsKey = 'wallet.payment_payer_sms';
        params.merchantName = counterparty?.name || 'Commerçant';
        params.merchantPhone = counterparty?.phone || '';
        break;
      case 'pay_received':
        smsKey = 'wallet.payment_merchant_sms';
        params.payerAccount = counterparty?.accountNumber || '';
        params.payerName = counterparty?.name || 'Client';
        break;
      default:
        return;
    }

    const smsText = i18nService.translate(smsKey, userLang, params);
    await smsService.sendSms(cleanPhone, smsText);
  }

  // --- Push notification ---
  if (await shouldSendPush(user.id)) {
    let pushType = NotificationType.TRANSACTION;
    let pushData: any = {
      amount: defaultAmount,
      currency: defaultCurrency,
      operationType: type,
      status: transaction?.status || 'SUCCESS',
    };

    switch (type) {
      case 'send_sent':
        pushType = NotificationType.TRANSFER;
        pushData.direction = 'sent';
        pushData.toName = counterparty?.name || 'Destinataire';
        pushData.status = transaction?.status;
        break;
      case 'send_received':
        pushType = NotificationType.TRANSFER;
        pushData.direction = 'received';
        pushData.fromName = counterparty?.name || 'Expéditeur';
        pushData.status = transaction?.status;
        break;
      case 'send_pending':
        pushType = NotificationType.TRANSFER_PENDING;
        pushData.direction = 'sent';
        pushData.toName = counterparty?.name || 'Destinataire';
        pushData.status = 'PENDING';
        pushData.messageKey = 'wallet.transfer_pending_push';
        break;
      case 'send_confirmed':
        pushType = NotificationType.TRANSFER_CONFIRMED;
        pushData.direction = 'sent';
        pushData.toName = counterparty?.name || 'Destinataire';
        pushData.status = 'COMPLETED';
        pushData.messageKey = 'wallet.transfer_confirmed_push';
        break;
      case 'pay_sent':
        pushType = NotificationType.PAYMENT;
        pushData.direction = 'sent';
        pushData.merchantName = counterparty?.name || 'Commerçant';
        break;
      case 'pay_received':
        pushType = NotificationType.PAYMENT;
        pushData.direction = 'received';
        pushData.customerName = counterparty?.name || 'Client';
        break;
      default:
        break;
    }

    await notificationHelper.notify(
      user.id,
      pushType,
      pushData,
      'TRANSACTION',
      transaction?.id || crypto.randomUUID(),
      userLang,
    );
  }
}