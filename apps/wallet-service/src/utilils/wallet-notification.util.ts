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
    console.log(`[notifyTransaction] Préférences: SMS=${canSendSms}, Push=${canSendPush}`);
  } catch (error) {
    console.error(`[notifyTransaction] Erreur lors de la vérification des préférences:`, error);
    canSendSms = true;
    canSendPush = true;
  }

  // ============================================
  // 4. 📱 SMS
  // ============================================
  if (user?.phone && canSendSms) {
    const cleanPhone = user.phone.replace(/[^0-9+]/g, '');
    console.log(`[notifyTransaction] 📱 Tentative d'envoi SMS à ${cleanPhone}`);

    // ✅ MAP DES TYPES VERS LES CLÉS SMS
    const smsKeyMap: Record<string, string> = {
      'topup': 'wallet.top_up_sms',
      'cashout': 'wallet.cashout_sms',
      'send_sent': 'wallet.transfer_sender_sms',
      'send_received': 'wallet.transfer_receiver_sms',
      'send_pending': 'wallet.transfer_pending_sms',
      'send_confirmed': 'wallet.transfer_confirmed_sms',
      'pay_sent': 'wallet.payment_payer_sms',
      'pay_received': 'wallet.payment_merchant_sms',
      'convert': 'wallet.conversion_sms',
      'failed': 'wallet.failed_sms',
    };

    const smsKey = smsKeyMap[type];
    if (!smsKey) {
      console.warn(`[notifyTransaction] ⚠️ Type SMS non reconnu: ${type}`);
      return;
    }

    // ✅ CONSTRUIRE LES PARAMÈTRES
    const params: any = {
      full_name: defaultName,
      amount: defaultAmount,
      currency: defaultCurrency,
      balance: defaultBalance,
      reference: transaction?.reference || 'N/A',
    };

    // ✅ AJOUTER LES PARAMÈTRES SPÉCIFIQUES
    switch (type) {
      case 'send_sent':
        params.recipient = counterparty?.name || 'Destinataire';
        break;
      case 'send_received':
        params.sender = counterparty?.name || 'Expéditeur';
        break;
      case 'send_pending':
        params.recipient = counterparty?.name || 'Destinataire';
        break;
      case 'send_confirmed':
        params.recipient = counterparty?.name || 'Destinataire';
        break;
      case 'pay_sent':
        params.merchantName = counterparty?.name || 'Commerçant';
        break;
      case 'pay_received':
        params.payerName = counterparty?.name || 'Client';
        break;
      case 'convert':
        params.fromCurrency = transaction?.fromCurrency || 'CDF';
        params.convertedAmount = transaction?.convertedAmount || defaultAmount;
        break;
      default:
        break;
    }

    try {
      console.log(`[notifyTransaction] 📝 Clé SMS: ${smsKey}`);
      console.log(`[notifyTransaction] 📝 Paramètres:`, params);

      // ✅ TRADUIRE LE SMS
      let smsText = i18nService.translate(smsKey, userLang, params);
      console.log(`[notifyTransaction] 📝 SMS traduit: ${smsText}`);

      // ✅ VÉRIFIER SI LA TRADUCTION A FONCTIONNÉ
      if (!smsText || smsText === smsKey || smsText.includes('{{')) {
        console.warn(`[notifyTransaction] ⚠️ Traduction manquante pour ${smsKey}, utilisation du fallback en français`);

        // ✅ FALLBACK EN FRANÇAIS
        const fallbackMessages: Record<string, string> = {
          'wallet.top_up_sms': `Votre portefeuille a été crédité de ${defaultAmount} ${defaultCurrency}. Solde: ${defaultBalance} ${defaultCurrency}. Ref: ${transaction?.reference || 'N/A'}. Merci pour votre confiance.`,
          'wallet.cashout_sms': `Retrait de ${defaultAmount} ${defaultCurrency} effectué avec succès. Solde: ${defaultBalance} ${defaultCurrency}. Ref: ${transaction?.reference || 'N/A'}. Merci d'utiliser F-Pay.`,
          'wallet.transfer_sender_sms': `Vous avez envoyé ${defaultAmount} ${defaultCurrency} à ${params.recipient || 'destinataire'}. Solde: ${defaultBalance} ${defaultCurrency}. Ref: ${transaction?.reference || 'N/A'}.`,
          'wallet.transfer_receiver_sms': `Vous avez reçu ${defaultAmount} ${defaultCurrency} de ${params.sender || 'expéditeur'}. Solde disponible: ${defaultBalance} ${defaultCurrency}. Ref: ${transaction?.reference || 'N/A'}.`,
          'wallet.transfer_pending_sms': `Votre envoi international de ${defaultAmount} ${defaultCurrency} est en attente de validation. Ref: ${transaction?.reference || 'N/A'}. Vous recevrez une confirmation une fois approuvé.`,
          'wallet.transfer_confirmed_sms': `Votre envoi international de ${defaultAmount} ${defaultCurrency} a été validé. Ref: ${transaction?.reference || 'N/A'}. Le destinataire a été notifié.`,
          'wallet.payment_payer_sms': `Paiement de ${defaultAmount} ${defaultCurrency} effectué chez ${params.merchantName || 'commerçant'}. Solde: ${defaultBalance} ${defaultCurrency}. Ref: ${transaction?.reference || 'N/A'}.`,
          'wallet.payment_merchant_sms': `Vous avez reçu ${defaultAmount} ${defaultCurrency} de ${params.payerName || 'client'}. Solde: ${defaultBalance} ${defaultCurrency}. Ref: ${transaction?.reference || 'N/A'}.`,
          'wallet.conversion_sms': `Conversion réussie: ${defaultAmount} ${params.fromCurrency || 'CDF'} = ${params.convertedAmount || defaultAmount} ${defaultCurrency}. Ref: ${transaction?.reference || 'N/A'}. Solde mis à jour.`,
          'wallet.failed_sms': `Votre transaction de ${defaultAmount} ${defaultCurrency} n'a pas abouti. Ref: ${transaction?.reference || 'N/A'}. Vérifiez vos informations ou contactez le support.`,
        };

        smsText = fallbackMessages[smsKey] || `Bonjour ${defaultName}, Transaction de ${defaultAmount} ${defaultCurrency}. Ref: ${transaction?.reference || 'N/A'}.`;
      }

      // ✅ ENVOYER LE SMS
      const countryCode = user?.countryCode || 'CD';
      console.log(`[notifyTransaction] 📱 CountryCode pour SMS: ${countryCode}`);

      await smsService.sendSms(cleanPhone, smsText, countryCode);
      console.log(`[notifyTransaction] ✅ SMS envoyé avec succès à ${cleanPhone}`);

    } catch (error) {
      console.error(`[notifyTransaction] ❌ Erreur lors de l'envoi du SMS à ${cleanPhone}:`, error);
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

    // ✅ MAP DES TYPES VERS LES NOTIFICATIONS PUSH
    const pushTypeMap: Record<string, NotificationType> = {
      'topup': NotificationType.TOP_UP_SUCCESS,
      'cashout': NotificationType.CASHOUT_SUCCESS,
      'send_sent': NotificationType.TRANSFER_SENT,
      'send_received': NotificationType.TRANSFER_RECEIVED,
      'send_pending': NotificationType.TRANSFER_PENDING,
      'send_confirmed': NotificationType.TRANSFER_CONFIRMED,
      'pay_sent': NotificationType.PAYMENT_SENT,
      'pay_received': NotificationType.PAYMENT_RECEIVED,
    };

    pushType = pushTypeMap[type] || null;

    if (pushType) {
      // ✅ CONSTRUIRE LES DONNÉES PUSH
      switch (type) {
        case 'topup':
        case 'cashout':
          pushData = {
            amount: defaultAmount,
            currency: defaultCurrency,
            balance: defaultBalance,
            full_name: defaultName,
          };
          break;
        case 'send_sent':
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
          pushData = {
            amount: defaultAmount,
            currency: defaultCurrency,
            balance: defaultBalance,
            merchantName: counterparty?.name || 'Commerçant',
            merchantPhone: counterparty?.phone || '',
            full_name: defaultName,
          };
          break;
        case 'pay_received':
          pushData = {
            amount: defaultAmount,
            currency: defaultCurrency,
            balance: defaultBalance,
            customerName: counterparty?.name || 'Client',
            customerPhone: counterparty?.phone || '',
            full_name: defaultName,
          };
          break;
        default:
          break;
      }

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
      }
    } else {
      console.warn(`[notifyTransaction] ⚠️ Type Push non reconnu: ${type}`);
    }
  } else {
    console.log(`[notifyTransaction] ⚠️ Push non envoyé: canSendPush=${canSendPush}`);
  }

  console.log(`[notifyTransaction] 📢 === FIN NOTIFICATION ===`);
}