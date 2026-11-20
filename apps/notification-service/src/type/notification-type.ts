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

  // TRANSFERTS INTERNATIONAUX
  TRANSFER_PENDING = 'transfer_pending',
  TRANSFER_CONFIRMED = 'transfer_confirmed',
  // ✅ AJOUT
  TRANSFER_FAILED = 'transfer_failed',

  // DÉPÔTS ET RETRAITS
  DEPOSIT_CONFIRMED = 'deposit_confirmed',
  DEPOSIT_REJECTED = 'deposit_rejected',
  WITHDRAWAL_CONFIRMED = 'withdrawal_confirmed',
  WITHDRAWAL_REJECTED = 'withdrawal_rejected',
  // ✅ AJOUT
  CASHOUT_FAILED = 'cashout_failed',

  // KYC
  KYC_VERIFIED = 'kyc_verified',
  KYC_REJECTED = 'kyc_rejected',

  // MAINTENANCE
  MAINTENANCE_FEE = 'maintenance_fee',

  // NOUVEAUX TYPES DE COMMUNICATION AVEC LES UTILISATEURS
  ANNOUNCEMENT = 'announcement',
  PROMOTION = 'promotion',
  SURVEY = 'survey',
  TIP = 'tip',
  UPDATE = 'update',
  ALERT = 'alert',
  REMINDER = 'reminder',
  FEEDBACK_REQUEST = 'feedback_request',
  BIRTHDAY = 'birthday',
  WELCOME = 'welcome',
  ONBOARDING = 'onboarding',
  SECURITY_ALERT = 'security_alert',
  SUSPICIOUS_ACTIVITY = 'suspicious_activity',
  MAINTENANCE_SCHEDULED = 'maintenance_scheduled',

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