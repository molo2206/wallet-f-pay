// apps/notification-service/src/type/notification-type.ts

export enum NotificationType {
  // Opérations génériques
  TRANSACTION = 'transaction',
  TRANSFER = 'transfer',
  PAYMENT = 'payment',
  SECURITY = 'security',
  PROMO = 'promo',
  SYSTEM = 'system',
  WALLET = 'wallet',

  // ✅ TRANSFERTS INTERNATIONAUX
  TRANSFER_PENDING = 'transfer_pending',
  TRANSFER_CONFIRMED = 'transfer_confirmed',

  // ✅ KYC
  KYC_VERIFIED = 'kyc_verified',
  KYC_REJECTED = 'kyc_rejected',

  // ✅ MAINTENANCE
  MAINTENANCE_FEE = 'maintenance_fee',

  // ✅ NOUVEAUX TYPES DE COMMUNICATION AVEC LES UTILISATEURS
  ANNOUNCEMENT = 'announcement',           // Annonce générale
  PROMOTION = 'promotion',                  // Offre promotionnelle
  SURVEY = 'survey',                        // Sondage/Questionnaire
  TIP = 'tip',                              // Astuce/Conseil
  UPDATE = 'update',                        // Mise à jour système
  ALERT = 'alert',                          // Alerte importante
  REMINDER = 'reminder',                    // Rappel
  FEEDBACK_REQUEST = 'feedback_request',    // Demande d'avis
  BIRTHDAY = 'birthday',                    // Anniversaire
  WELCOME = 'welcome',                      // Message de bienvenue
  ONBOARDING = 'onboarding',                // Guide d'utilisation
  SECURITY_ALERT = 'security_alert',        // Alerte de sécurité
  SUSPICIOUS_ACTIVITY = 'suspicious_activity', // Activité suspecte
  MAINTENANCE_SCHEDULED = 'maintenance_scheduled', // Maintenance planifiée

  // Anciens types (conservés pour compatibilité)
  TOP_UP_SUCCESS = 'topup_success',
  CASHOUT_SUCCESS = 'cashout_success',
  TRANSFER_SENT = 'transfer_sent',
  TRANSFER_RECEIVED = 'transfer_received',
  PAYMENT_SENT = 'payment_sent',
  PAYMENT_RECEIVED = 'payment_received',
  WALLET_CREDITED = 'wallet_credited',
  WALLET_DEBITED = 'wallet_debited',
}