// apps/wallet-service/src/dto/admin-wallet.dto.ts
export class AdminTopUpDto {
    walletId: string;          // REQUIS
    amount: number;            // REQUIS
    lang?: string;
    ipAddress?: string;
}

export class AdminCashoutDto {
    walletId: string;          // REQUIS
    amount: number;            // REQUIS
    lang?: string;
    ipAddress?: string;
}

export class AdminSendDto {
    fromWalletId: string;      // REQUIS - wallet source
    toWalletId: string;        // REQUIS - wallet destination
    amount: number;
    description?: string;
    lang?: string;
    ipAddress?: string;
}

export class AdminPayDto {
    fromWalletId: string;      // REQUIS - wallet du payeur
    merchantCode: string;      // REQUIS - code marchand du commerçant
    amount: number;
    description?: string;
    lang?: string;
    ipAddress?: string;
}