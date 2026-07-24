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

  console.log(`[notifyTransaction] 📢 Type: ${type}, User: ${user.id}, Lang: ${userLang}`);

  // ✅ Valeurs par défaut
  const defaultName = user?.full_name || 'Client';
  const defaultAmount = transaction?.amount || 0;
  const defaultCurrency = wallet?.currency || 'CDF';
  const defaultBalance = wallet?.balance || 0;

  // ============================================
  // 📱 SMS
  // ============================================
  if (user?.phone && (await shouldSendSms(user.id))) {
    const cleanPhone = user.phone.replace(/[^0-9+]/g, '');
    console.log(`[notifyTransaction] 📱 Envoi SMS à ${cleanPhone}`);

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
        break;

      case 'send_received':
        smsKey = 'wallet.transfer_receiver_sms';
        params.fromPhone = counterparty?.phone || 'Expéditeur';
        break;

      case 'send_pending':
        smsKey = 'wallet.transfer_pending_sms';
        params.toPhone = counterparty?.phone || 'Destinataire';
        break;

      case 'send_confirmed':
        smsKey = 'wallet.transfer_confirmed_sms';
        params.toPhone = counterparty?.phone || 'Destinataire';
        break;

      case 'pay_sent':
        smsKey = 'wallet.payment_payer_sms';
        params.merchantName = counterparty?.name || 'Commerçant';
        break;

      case 'pay_received':
        smsKey = 'wallet.payment_merchant_sms';
        params.payerName = counterparty?.name || 'Client';
        break;

      default:
        console.warn(`[notifyTransaction] ⚠️ Type SMS non reconnu: ${type}`);
        return;
    }

    try {
      const smsText = i18nService.translate(smsKey, userLang, params);
      console.log(`[notifyTransaction] 📝 SMS: ${smsText}`);
      await smsService.sendSms(cleanPhone, smsText);
      console.log(`[notifyTransaction] ✅ SMS envoyé à ${cleanPhone}`);
    } catch (error) {
      console.error(`[notifyTransaction] ❌ Erreur envoi SMS:`, error);
    }
  } else {
    console.log(`[notifyTransaction] ⚠️ SMS non envoyé: phone=${!!user?.phone}, shouldSendSms=${await shouldSendSms(user?.id)}`);
  }

  // ============================================
  // 🔔 PUSH NOTIFICATION
  // ============================================
  if (await shouldSendPush(user.id)) {
    console.log(`[notifyTransaction] 🔔 Envoi Push à ${user.id}`);

    let pushType: NotificationType;
    let pushData: any = {
      amount: defaultAmount,
      currency: defaultCurrency,
      operationType: type,
      status: transaction?.status || 'SUCCESS',
      balance: defaultBalance,
    };

    switch (type) {
      // ===== TOPUP =====
      case 'topup':
        pushType = NotificationType.TOP_UP_SUCCESS;
        pushData = {
          amount: defaultAmount,
          currency: defaultCurrency,
          balance: defaultBalance,
          full_name: defaultName,
        };
        break;

      // ===== CASHOUT =====
      case 'cashout':
        pushType = NotificationType.CASHOUT_SUCCESS;
        pushData = {
          amount: defaultAmount,
          currency: defaultCurrency,
          balance: defaultBalance,
          full_name: defaultName,
        };
        break;

      // ===== TRANSFERT ENVOYÉ =====
      case 'send_sent':
        pushType = NotificationType.TRANSFER_SENT;
        pushData = {
          amount: defaultAmount,
          currency: defaultCurrency,
          balance: defaultBalance,
          toName: counterparty?.name || 'Destinataire',
          toPhone: counterparty?.phone || '',
          full_name: defaultName,
        };
        break;

      // ===== TRANSFERT REÇU =====
      case 'send_received':
        pushType = NotificationType.TRANSFER_RECEIVED;
        pushData = {
          amount: defaultAmount,
          currency: defaultCurrency,
          balance: defaultBalance,
          fromName: counterparty?.name || 'Expéditeur',
          fromPhone: counterparty?.phone || '',
          full_name: defaultName,
        };
        break;

      // ===== TRANSFERT INTERNATIONAL EN ATTENTE =====
      case 'send_pending':
        pushType = NotificationType.TRANSFER_PENDING;
        pushData = {
          amount: defaultAmount,
          currency: defaultCurrency,
          toName: counterparty?.name || 'Destinataire',
          toPhone: counterparty?.phone || '',
          full_name: defaultName,
          status: 'PENDING',
        };
        break;

      // ===== TRANSFERT INTERNATIONAL CONFIRMÉ =====
      case 'send_confirmed':
        pushType = NotificationType.TRANSFER_CONFIRMED;
        pushData = {
          amount: defaultAmount,
          currency: defaultCurrency,
          balance: defaultBalance,
          toName: counterparty?.name || 'Destinataire',
          toPhone: counterparty?.phone || '',
          full_name: defaultName,
          status: 'COMPLETED',
        };
        break;

      // ===== PAIEMENT ENVOYÉ =====
      case 'pay_sent':
        pushType = NotificationType.PAYMENT_SENT;
        pushData = {
          amount: defaultAmount,
          currency: defaultCurrency,
          balance: defaultBalance,
          merchantName: counterparty?.name || 'Commerçant',
          merchantPhone: counterparty?.phone || '',
          full_name: defaultName,
        };
        break;

      // ===== PAIEMENT REÇU =====
      case 'pay_received':
        pushType = NotificationType.PAYMENT_RECEIVED;
        pushData = {
          amount: defaultAmount,
          currency: defaultCurrency,
          balance: defaultBalance,
          payerName: counterparty?.name || 'Client',
          payerPhone: counterparty?.phone || '',
          full_name: defaultName,
        };
        break;

      default:
        console.warn(`[notifyTransaction] ⚠️ Type Push non reconnu: ${type}`);
        return;
    }

    try {
      await notificationHelper.notify(
        user.id,
        pushType,
        pushData,
        'TRANSACTION',
        transaction?.id || crypto.randomUUID(),
        userLang,
      );
      console.log(`[notifyTransaction] ✅ Push envoyé à ${user.id} (${pushType})`);
    } catch (error) {
      console.error(`[notifyTransaction] ❌ Erreur envoi Push:`, error);
    }
  } else {
    console.log(`[notifyTransaction] ⚠️ Push non envoyé: shouldSendPush=${await shouldSendPush(user?.id)}`);
  }
}