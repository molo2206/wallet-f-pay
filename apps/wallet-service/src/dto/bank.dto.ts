// apps/wallet-service/src/dto/bank.dto.ts
export class BankLinkingDto {
  accountNumber: string;
  requestId: string;
}

export class BankTopupDto {
  requestId: string;
  accountNumber: string;
  amount: number;
}

export class BankCashoutDto {
  requestId: string;
  accountNumber: string;
  amount: number;
}

export interface BankResponse {
  success?: boolean;
  error?: string;
  code?: number;
  message?: string;
  requestId: string;
  accountNumber?: string;
  balance?: string;
  phone?: string;
  customerName?: string;
  currency?: string;
}
