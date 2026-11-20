// apps/wallet-service/src/dto/failed-transaction.dto.ts
export class FailedTransactionLogDto {
  transactionId: string;
  userId: string;
  walletId: string;
  amount: number;
  type: string;
  movement: string;
  reference: string;
  description?: string;
  failure_reason: string;
  failure_code?: string;
  failure_details?: string;
  ip_address?: string;
  user_agent?: string;
  original_created_at?: Date;
}
