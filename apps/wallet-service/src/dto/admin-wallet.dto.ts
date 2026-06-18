// apps/wallet-service/src/dto/admin-wallet.dto.ts
export class AdminTopUpDto {
    adminId: string;           // REQUIS - ID de l'admin qui fait l'opération
    walletId: string;          // REQUIS
    amount: number;            // REQUIS
    pin: string;               // REQUIS
    lang?: string;
    ipAddress?: string;
}

export class AdminCashoutDto {
    adminId: string;           // REQUIS
    walletId: string;          // REQUIS
    amount: number;
    pin: string;
    lang?: string;
    ipAddress?: string;
}

export class AdminSendDto {
    adminId: string;           // REQUIS
    fromWalletId: string;
    toWalletId: string;
    amount: number;
    pin: string;
    description?: string;
    lang?: string;
    ipAddress?: string;
}

export class AdminPayDto {
    adminId: string;           // REQUIS
    fromWalletId: string;
    merchantCode: string;
    amount: number;
    pin: string;
    description?: string;
    lang?: string;
    ipAddress?: string;
}