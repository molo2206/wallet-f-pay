// create-country.dto.ts
export class CreateCountryDto {
  name!: string;
  code!: string;
  flag?: string;
  prefix?: string;
  default_currency?: string;
  currencies?: {
    currency_code: string;
    currency_name?: string;  // ✅ AJOUTER - nom de la devise
    currency_symbol?: string; // ✅ AJOUTER - symbole de la devise
    is_default?: boolean;
    min_transaction_amount?: number;
    max_transaction_amount?: number;
    daily_limit?: number;
    monthly_limit?: number;
  }[];
}

// apps/wallet-service/src/pawapay/dto/update-country.dto.ts
export class UpdateCountryDto {
  name?: string;
  code?: string;
  countryCode?: string;
  flag?: string;
  prefix?: string;
  default_currency?: string;
  currencies?: {
    currency_code: string;
    currency_name?: string;   // ✅ AJOUTER
    currency_symbol?: string; // ✅ AJOUTER
    is_default?: boolean;
    min_transaction_amount?: number;
    max_transaction_amount?: number;
    daily_limit?: number;
    monthly_limit?: number;
  }[];
}

// apps/wallet-service/src/pawapay/dto/country-response.dto.ts
export class CountryResponseDto {
  id: string;
  code: string;
  countryCode: string;
  name: string;
  flag?: string;
  prefix?: string;
  default_currency?: string;
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

