// apps/wallet-service/src/pawapay/dto/create-country.dto.ts

// ✅ Assurez-vous que cette classe est exportée
export class CountryResponseDto {
  id: string;
  code: string;
  countryCode: string;
  name: string;
  flag?: string;
  prefix?: string;
  default_currency?: string;
  status?: string;
  transfer_percentage?: number;
  international_transfer_fee?: number;
  international_deposit_fee?: number;
  international_withdrawal_fee?: number;
  maintenance_fee?: number;
  deposit_fee?: number;
  withdrawal_fee?: number;
  cash_percentage?: number;
  momo_percentage?: number;
  currencies: {
    currency_code: string;
    currency_name: string;
    currency_symbol?: string;
    is_default: boolean;
    min_transaction_amount?: number;
    max_transaction_amount?: number;
    daily_limit?: number;
    monthly_limit?: number;
  }[];
  network_providers?: any[];
  created_at: Date;
  updated_at: Date;
}

export class CreateCountryDto {
  name!: string;
  code!: string;
  flag?: string;
  prefix?: string;
  default_currency?: string;
  transfer_percentage?: number;
  international_transfer_fee?: number;
  international_deposit_fee?: number;
  international_withdrawal_fee?: number;
  maintenance_fee?: number;
  deposit_fee?: number;
  withdrawal_fee?: number;
  cash_percentage?: number;
  momo_percentage?: number;
  currencies?: {
    currency_code: string;
    currency_name?: string;
    currency_symbol?: string;
    is_default?: boolean;
    min_transaction_amount?: number;
    max_transaction_amount?: number;
    daily_limit?: number;
    monthly_limit?: number;
  }[];
}