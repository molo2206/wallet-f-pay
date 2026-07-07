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
