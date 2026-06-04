export interface AccountInfo {
  id: string;
  full_name: string;
  account_number: string | null;
  phone: string;
  branch: string | null;
  email: string | null;
  status: string;
  kyc_status: string;
  balance: number;
  currency: string;
  address: string | null;
  city: string | null;
  country: string | null;
  account_type: string;
  account_tier: string;
  opening_date: Date;
  createdAt: Date;
  updatedAt: Date;
  fcmToken: string | null;
  pin: string | null;
  passwordStatus: string | null;
  pinstatus: string | null;
  merchantCode: string | null;
  businessName: string | null;
}

export interface AccountResponseDto {
  success: boolean;
  data: AccountInfo;
}
