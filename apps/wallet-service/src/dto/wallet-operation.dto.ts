// apps/wallet-service/src/dto/wallet-operation.dto.ts
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class TopUpDto {
  @IsOptional()
  @IsString()
  accountNumber?: string; // optionnel si provider est fourni (MOMO)

  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsNotEmpty()
  @IsString()
  pin!: string;

  @IsOptional()
  @IsString()
  walletId?: string; // pour cibler un wallet spécifique

  @IsNotEmpty()
  @IsString()
  provider!: string; // pour PawaPay (ex: "MTN_MOMO_COD")

  @IsOptional()
  @IsString()
  phone?: string; // pour PawaPay

  @IsOptional()
  @IsString()
  lang?: string;
}

export class CashoutDto {
  @IsOptional()
  @IsString()
  accountNumber?: string; // optionnel si provider est fourni (MOMO)

  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsNotEmpty()
  @IsString()
  pin!: string; // ✅ ajouté (manquait)

  @IsOptional()
  @IsString()
  walletId?: string; // pour cibler un wallet spécifique

  @IsOptional()
  @IsString()
  provider?: string; // pour PawaPay (ex: "MTN_MOMO_COD")

  @IsOptional()
  @IsString()
  phone?: string; // pour PawaPay

  @IsOptional()
  @IsString()
  lang?: string;
}

export class SendDto {
  @IsOptional()
  @IsString()
  fromAccountNumber?: string;

  @IsOptional()
  @IsString()
  fromWalletId?: string;

  @IsNotEmpty()
  @IsString()
  toPhone!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsNotEmpty()
  @IsString()
  pin!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  lang?: string;

  @IsOptional()
  countryCode?: string;

  @IsOptional()
  feeIncluded?: boolean;
}

export class PayDto {
  @IsNotEmpty()
  @IsString()
  fromWalletId!: string;  // ✅ REQUIS - wallet source

  @IsOptional()
  @IsString()
  toPhone?: string;

  @IsOptional()
  @IsString()
  merchantCode?: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsNotEmpty()
  @IsString()
  pin!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  lang?: string;

  @IsOptional()
  skipPinCheck?: boolean;
}

export class SendFidelityDto {
  @IsOptional()
  @IsString()
  fromAccountNumber?: string;

  @IsOptional()
  @IsString()
  fromWalletId?: string;

  @IsNotEmpty()
  @IsString()
  toPhone!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  lang?: string;

  @IsOptional()
  countryCode?: string;
}

// ✅ DTO dédié Paiement Taxi
export class SendTaxiDto {
  @IsNotEmpty()
  @IsString()
  fromWalletId!: string;

  @IsNotEmpty()
  @IsString()
  toWalletId!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  countryCode?: string;

  @IsOptional()
  @IsIn(['MOBILE_MONEY', 'CASH', 'BANK_TRANSFER', 'CARD'])
  paymentMethod?: string;

  @IsOptional()
  @IsString()
  lang?: string;

  @IsOptional()
  @IsString()
  ipAddress?: string;
}

export class SendSalaryDto {
  @IsOptional()
  @IsString()
  fromAccountNumber?: string;

  @IsOptional()
  @IsString()
  fromWalletId?: string;

  @IsNotEmpty()
  @IsString()
  toPhone!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  lang?: string;

  @IsOptional()
  countryCode?: string;
}


// Dans SendParrainageDto
export class SendParrainageDto {
  fromWalletId: string;
  toWalletId: string;  // ✅ Changé : toWalletId au lieu de toPhone
  amount: number;
  description?: string;
  countryCode?: string;
  paymentMethod?: string;
}

function IsIn(arg0: string[]): (target: SendTaxiDto, propertyKey: "paymentMethod") => void {
  throw new Error('Function not implemented.');
}
