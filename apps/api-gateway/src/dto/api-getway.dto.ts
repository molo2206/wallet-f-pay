// dto/register-request.dto.ts
export class RegisterRequestDto {
  account_number: string;
  full_name: string;
  phone: string;
  branch?: string;
  deviceInfo?: string;
  fcmToken?: string;
  platform?: string;
  otpCode?: string;
  email?: string;
  lang?: string;
  countryCode?: string;
  password: string;
}

// api-gateway/src/dto/api-getway.dto.ts
export class LoginRequestDto {
  identifier?: string;
  email?: string;
  phone?: string;
  password: string;
  deviceInfo?: string;
  fcmToken?: string;
  platform?: string;
  lang?: string;
}

// dto/create-user.dto.ts
export class CreateUserDto {
  email?: string;
  phone?: string;
  password?: string;
  full_name?: string;
  account_number?: string;
  branch?: string;
  role?: string;
  merchantCode?: string;
  lang?: string;
  businessName?: string;
  countryCode?: string;
}

// dto/create-transaction.dto.ts
export class CreateTransactionDto {
  userId: string;
  walletId: string;
  amount: number;
  type: string;
  reference: string;
  description?: string;
  lang?: string;
}

// dto/create-payment.dto.ts
export class CreatePaymentDto {
  amount: number;
  currency: string;
  userId: string;
  description?: string;
  lang?: string;
}
