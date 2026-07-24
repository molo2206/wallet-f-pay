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
  // ============================================
  // 1. RÉCUPÉRATION DE LA LANGUE
  // ============================================
  let userLang = 'fr';
  try {
    userLang = await getUserLanguage(user.id);
  } catch (error) {
    console.warn(`[notifyTransaction] ⚠️ Impossible de récupérer la langue pour l'utilisateur ${user.id}, utilisation de 'fr' par défaut`);
  }

  console.log(`[notifyTransaction] 📢 === DÉBUT NOTIFICATION ===`);
  console.log(`[notifyTransaction] 📢 Type: ${type}, User: ${user.id}, Lang: ${userLang}`);
  console.log(`[notifyTransaction] 📢 Transaction: ${transaction?.id}, Amount: ${transaction?.amount}`);
  console.log(`[notifyTransaction] 📢 Wallet: ${wallet?.id}, Currency: ${wallet?.currency}`);

  // ============================================
  // 2. VALEURS PAR DÉFAUT
  // ============================================
  const defaultName = user?.full_name || 'Client';
  const defaultAmount = transaction?.amount || 0;
  const defaultCurrency = wallet?.currency || 'CDF';
  const defaultBalance = wallet?.balance || 0;

  // ============================================
  // 3. VÉRIFICATION DES PRÉFÉRENCES UTILISATEUR
  // ============================================
  let canSendSms = false;
  let canSendPush = false;

  try {
    canSendSms = await shouldSendSms(user.id);
    canSendPush = await shouldSendPush(user.id);
    console.log(`[notifyTransaction] 📋 Préférences: SMS=${canSendSms}, Push=${canSendPush}`);
  } catch (error) {
    console.error(`[notifyTransaction] ❌ Erreur lors de la vérification des préférences:`, error);
    // Par défaut, on tente d'envoyer quand même
    canSendSms = true;
    canSendPush = true;
  }

  // ============================================
  // 4. 📱 SMS
  // ============================================
  if (user?.phone && canSendSms) {
    const cleanPhone = user.phone.replace(/[^0-9+]/g, '');
    console.log(`[notifyTransaction] 📱 Tentative d'envoi SMS à ${cleanPhone}`);

    let smsKey: string;
    const params: any = {
      full_name: defaultName,
      amount: defaultAmount,
      currency: defaultCurrency,
      balance: defaultBalance,
    };

    // ✅ Déterminer la clé SMS
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
        break;

      case 'send_confirmed':
        smsKey = 'wallet.transfer_confirmed_sms';
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
        break;
    }

    // ✅ Envoyer le SMS si une clé est définie
    if (smsKey) {
      try {
        console.log(`[notifyTransaction] 📝 Clé SMS: ${smsKey}`);
        console.log(`[notifyTransaction] 📝 Paramètres:`, params);

        let smsText = i18nService.translate(smsKey, userLang, params);
        console.log(`[notifyTransaction] 📝 SMS traduit: ${smsText}`);

        // ✅ Vérifier que le SMS n'est pas vide ou que la traduction a fonctionné
        if (!smsText || smsText === smsKey) {
          console.warn(`[notifyTransaction] ⚠️ Traduction manquante pour ${smsKey}, utilisation du fallback`);

          // ✅ Fallback: construire un message manuellement
          const fallbackMessages: Record<string, string> = {
            'topup': `Bonjour ${defaultName}, Recharge ${defaultAmount} ${defaultCurrency}. Solde: ${defaultBalance} ${defaultCurrency}. Merci.`,
            'cashout': `Bonjour ${defaultName}, Retrait ${defaultAmount} ${defaultCurrency}. Solde: ${defaultBalance} ${defaultCurrency}.`,
            'send_sent': `Bonjour ${defaultName}, Envoi ${defaultAmount} ${defaultCurrency} à ${params.toPhone}. Solde: ${defaultBalance} ${defaultCurrency}.`,
            'send_received': `Bonjour ${defaultName}, Réception ${defaultAmount} ${defaultCurrency} de ${params.fromPhone}. Solde: ${defaultBalance} ${defaultCurrency}.`,
            'send_pending': `Bonjour ${defaultName}, votre envoi international de ${defaultAmount} ${defaultCurrency} est en attente de validation. Vous recevrez une confirmation une fois approuvé.`,
            'send_confirmed': `Bonjour ${defaultName}, votre envoi international de ${defaultAmount} ${defaultCurrency} a été validé. Le destinataire a été notifié.`,
            'pay_sent': `Bonjour ${defaultName}, Paiement ${defaultAmount} ${defaultCurrency} à ${params.merchantName}. Solde: ${defaultBalance} ${defaultCurrency}.`,
            'pay_received': `Bonjour ${defaultName}, Réception ${defaultAmount} ${defaultCurrency} de ${params.payerName}. Solde: ${defaultBalance} ${defaultCurrency}.`,
          };

          smsText = fallbackMessages[type] || `Bonjour ${defaultName}, Transaction de ${defaultAmount} ${defaultCurrency}.`;
        }

        // ✅ Envoyer le SMS
        await smsService.sendSms(cleanPhone, smsText);
        console.log(`[notifyTransaction] ✅ SMS envoyé avec succès à ${cleanPhone}`);

      } catch (error) {
        console.error(`[notifyTransaction] ❌ Erreur lors de l'envoi du SMS à ${cleanPhone}:`, error);
      }
    }
  } else {
    console.log(`[notifyTransaction] ⚠️ SMS non envoyé: phone=${!!user?.phone}, canSendSms=${canSendSms}`);
    if (!user?.phone) {
      console.warn(`[notifyTransaction] ⚠️ L'utilisateur ${user?.id} n'a pas de numéro de téléphone`);
    }
  }

  // ============================================
  // 5. 🔔 PUSH NOTIFICATION
  // ============================================
  if (canSendPush) {
    console.log(`[notifyTransaction] 🔔 Tentative d'envoi Push à ${user.id}`);

    let pushType: NotificationType | null = null;
    let pushData: any = {
      amount: defaultAmount,
      currency: defaultCurrency,
      operationType: type,
      status: transaction?.status || 'SUCCESS',
      balance: defaultBalance,
      full_name: defaultName,
      timestamp: new Date().toISOString(),
    };

    // ✅ Déterminer le type et les données Push
    switch (type) {
      case 'topup':
        pushType = NotificationType.TOP_UP_SUCCESS;
        pushData = {
          amount: defaultAmount,
          currency: defaultCurrency,
          balance: defaultBalance,
          full_name: defaultName,
        };
        break;

      case 'cashout':
        pushType = NotificationType.CASHOUT_SUCCESS;
        pushData = {
          amount: defaultAmount,
          currency: defaultCurrency,
          balance: defaultBalance,
          full_name: defaultName,
        };
        break;

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

      case 'pay_sent':
        pushType = NotificationType.PAYMENT_SENT;
        pushData = {
          amount: defaultAmount,
          currency: defaultCurrency,
          balance: defaultBalance,
          merchantName: counterparty?.name || 'Commerçant', // ✅ Correspond à {{merchantName}}
          merchantPhone: counterparty?.phone || '',
          full_name: defaultName,
        };
        break;

      case 'pay_received':
        pushType = NotificationType.PAYMENT_RECEIVED;
        pushData = {
          amount: defaultAmount,
          currency: defaultCurrency,
          balance: defaultBalance,
          customerName: counterparty?.name || 'Client', // ✅ Changé payerName → customerName
          customerPhone: counterparty?.phone || '',
          full_name: defaultName,
        };
        break;

      default:
        console.warn(`[notifyTransaction] ⚠️ Type Push non reconnu: ${type}`);
        break;
    }

    // ✅ Envoyer la notification Push
    if (pushType) {
      try {
        console.log(`[notifyTransaction] 🔔 Type Push: ${pushType}`);
        console.log(`[notifyTransaction] 🔔 Données Push:`, pushData);

        await notificationHelper.notify(
          user.id,
          pushType,
          pushData,
          'TRANSACTION',
          transaction?.id || crypto.randomUUID(),
          userLang,
        );

        console.log(`[notifyTransaction] ✅ Push envoyé avec succès à ${user.id} (${pushType})`);

      } catch (error) {
        console.error(`[notifyTransaction] ❌ Erreur lors de l'envoi du Push à ${user.id}:`, error);

        if (user?.email) {
          try {
            console.log(`[notifyTransaction] 📧 Tentative d'envoi par email à ${user.email}`);
          } catch (emailError) {
            console.error(`[notifyTransaction] ❌ Erreur envoi email fallback:`, emailError);
          }
        }
      }
    }
  } else {
    console.log(`[notifyTransaction] ⚠️ Push non envoyé: canSendPush=${canSendPush}`);
  }

  console.log(`[notifyTransaction] 📢 === FIN NOTIFICATION ===`);
}