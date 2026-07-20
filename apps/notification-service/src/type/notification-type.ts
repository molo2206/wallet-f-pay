export enum NotificationType {
  // Opérations génériques (selon la demande)
  TRANSACTION = 'transaction', // pour topup et cashout
  TRANSFER = 'transfer', // pour send
  PAYMENT = 'payment', // pour pay
  SECURITY = 'security',
  PROMO = 'promo',
  SYSTEM = 'system',
  WALLET = 'wallet',

  // Anciens types (conservés pour compatibilité si besoin)
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
