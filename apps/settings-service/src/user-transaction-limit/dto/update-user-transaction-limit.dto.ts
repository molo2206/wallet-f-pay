export class UpdateUserTransactionLimitDto {
  daily_limit?: number;
  monthly_limit?: number;
  yearly_limit?: number;
  per_transaction_limit?: number;
  monthly_transaction_count?: number;
}
