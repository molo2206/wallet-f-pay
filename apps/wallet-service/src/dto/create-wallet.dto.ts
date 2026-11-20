export class CreateWalletDto {
  userId: string;
  currency?: string;
}

export class WalletResponseDto {
  id: string;
  userId: string;
  balance: number;
  currency: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}