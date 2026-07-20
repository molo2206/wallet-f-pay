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

  // ✅ NOUVEAUX TYPES POUR TRANSFERTS INTERNATIONAUX
  TRANSFER_PENDING = 'transfer_pending',
  TRANSFER_CONFIRMED = 'transfer_confirmed',

  // Anciens types (conservés pour compatibilité)
  TOP_UP_SUCCESS = 'topup_success',
  CASHOUT_SUCCESS = 'cashout_success',
  TRANSFER_SENT = 'transfer_sent',
  TRANSFER_RECEIVED = 'transfer_received',
  PAYMENT_SENT = 'payment_sent',
  PAYMENT_RECEIVED = 'payment_received',
  WALLET_CREDITED = 'wallet_credited',
  WALLET_DEBITED = 'wallet_debited',
  MAINTENANCE_FEE = 'maintenance_fee',
}