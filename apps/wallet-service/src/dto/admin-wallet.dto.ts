// apps/wallet-service/src/dto/admin-wallet.dto.ts
export class AdminTopUpDto {
    userId: string;
    amount: number;
    walletId?: string;
    lang?: string;
    ipAddress?: string;
}

export class AdminCashoutDto {
    userId: string;
    amount: number;
    walletId?: string;
    lang?: string;
    ipAddress?: string;
}

export class AdminSendDto {
    fromUserId: string;
    toUserId: string;
    amount: number;
    description?: string;
    fromWalletId?: string;   // wallet source spécifique
    toWalletId?: string;     // wallet destination spécifique
    lang?: string;
    ipAddress?: string;
}

export class AdminPayDto {
    fromUserId: string;
    toUserId: string;   // commerçant
    amount: number;
    description?: string;
    fromWalletId?: string;   // wallet du payeur
    toWalletId?: string;     // wallet du commerçant
    lang?: string;
    ipAddress?: string;
}