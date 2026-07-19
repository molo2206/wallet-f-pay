// apps/wallet-service/src/pawapay/dto/update-country.dto.ts
export class UpdateCountryDto {
  name?: string;
  code?: string;
  countryCode?: string;
  flag?: string;
  prefix?: string;
  default_currency?: string;
  transfer_percentage?: number;           // ✅ AJOUTER
  international_transfer_fee?: number;    // ✅ AJOUTER
  international_deposit_fee?: number;     // ✅ AJOUTER
  international_withdrawal_fee?: number;  // ✅ AJOUTER
  maintenance_fee?: number;               // ✅ AJOUTER
  deposit_fee?: number;                   // ✅ AJOUTER
  withdrawal_fee?: number;                // ✅ AJOUTER
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