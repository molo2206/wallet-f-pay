/* eslint-disable prettier/prettier */
import { IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class ConvertCurrencyDto {
  @IsNotEmpty()
  @IsString()
  fromWalletId: string;

  @IsNotEmpty()
  @IsString()
  toWalletId: string;

  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsNotEmpty()
  @IsString()
  pin: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  lang?: string;
}

export class ExchangeRateDto {
  @IsNotEmpty()
  @IsString()
  from_currency: string;

  @IsNotEmpty()
  @IsString()
  to_currency: string;

  @IsNumber()
  rate: number;
}