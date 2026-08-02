// api-gateway/src/dto/user.dto.ts

export class UserResponseDto {
  id: string;
  email: string | null;
  phone: string | null;
  full_name: string | null;
  account_number: string | null;
  branchId: string | null;
  branch?: {
    id: string;
    name: string;
    code: string;
    countryId: string;
    status: string;
  } | null;
  role: string;
  status: string;
  deleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  // ✅ AJOUTER CES PROPRIÉTÉS
  fcmToken?: string | null;
  passwordStatus?: string | null;
  pinstatus?: boolean | null;
  merchantCode?: string | null;
  businessName?: string | null;
  countryCode?: string | null;
  merchantType?: string | null;
  businessCategory?: string | null;
  businessAddress?: string | null;
  profileImage?: string | null;
  kycStatus?: string | null;
  failed_login_attempts?: number | null;
  locked_until?: Date | null;
}