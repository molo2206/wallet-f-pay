export class CreditWalletDto {
  userId?: string;
  walletId?: string;
  amount: number;
  currency?: string;
  description?: string;
}

export class DebitWalletDto {
  userId?: string;
  walletId?: string;
  amount: number;
  currency?: string;
  description?: string;
}

export class TransferDto {
  fromUserId?: string;
  fromWalletId?: string;
  toUserId?: string;
  toWalletId?: string;
  amount: number;
  description?: string;
}