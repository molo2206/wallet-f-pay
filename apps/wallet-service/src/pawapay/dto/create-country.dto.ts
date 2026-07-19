// create-country.dto.ts
export class CreateCountryDto {
  name!: string;
  code!: string;
  flag?: string;
  prefix?: string;
  default_currency?: string;
  transfer_percentage?: number;        // ✅ AJOUTÉ
  international_transfer_fee?: number; // ✅ AJOUTÉ
  international_deposit_fee?: number;  // ✅ AJOUTÉ
  international_withdrawal_fee?: number; // ✅ AJOUTÉ
  maintenance_fee?: number;            // ✅ AJOUTÉ
  deposit_fee?: number;                // ✅ AJOUTÉ
  withdrawal_fee?: number;             // ✅ AJOUTÉ
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

// update-country.dto.ts
export class UpdateCountryDto {
  name?: string;
  code?: string;
  countryCode?: string;
  flag?: string;
  prefix?: string;
  default_currency?: string;
  transfer_percentage?: number;        // ✅ AJOUTÉ
  international_transfer_fee?: number; // ✅ AJOUTÉ
  international_deposit_fee?: number;  // ✅ AJOUTÉ
  international_withdrawal_fee?: number; // ✅ AJOUTÉ
  maintenance_fee?: number;            // ✅ AJOUTÉ
  deposit_fee?: number;                // ✅ AJOUTÉ
  withdrawal_fee?: number;             // ✅ AJOUTÉ
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

// country-response.dto.ts
export class CountryResponseDto {
  id: string;
  code: string;
  countryCode: string;
  name: string;
  flag?: string;
  prefix?: string;
  default_currency?: string;
  status?: string;
  transfer_percentage?: number;        // ✅ AJOUTÉ
  international_transfer_fee?: number; // ✅ AJOUTÉ
  international_deposit_fee?: number;  // ✅ AJOUTÉ
  international_withdrawal_fee?: number; // ✅ AJOUTÉ
  maintenance_fee?: number;            // ✅ AJOUTÉ
  deposit_fee?: number;                // ✅ AJOUTÉ
  withdrawal_fee?: number;             // ✅ AJOUTÉ
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