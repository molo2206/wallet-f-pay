// apps/auth-service/src/dto/oauth/oauth-link-user.dto.ts
import { IsString, IsNotEmpty, IsOptional, IsPhoneNumber } from 'class-validator';

export class OAuthLinkUserDto {
  @IsString()
  @IsPhoneNumber()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsString()
  @IsOptional()
  otpCode?: string;

  @IsString()
  @IsOptional()
  clientId?: string;

  @IsString()
  @IsOptional()
  scope?: string;

  @IsString()
  @IsOptional()
  lang?: string;
}

// ✅ Définir les interfaces pour les types complexes
interface BranchInfo {
  id: string;
  name: string;
  code: string;
  countryId: string;
  status: string;  // ✅ string, pas branch_status | null
}

interface ResourceInfo {
  id: string;
  name: string;
  label: string;
  permissions: {
    canCreate: boolean;
    canRead: boolean;
    canUpdate: boolean;
    canDelete: boolean;
    canManage: boolean;
  };
  grantedAt: Date;
  expiresAt: Date | null;
  branch: BranchInfo | null;
}

interface WalletInfo {
  id: string;
  currency: string;
  balance: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface KycSubmissionInfo {
  id: string;
  documentType: string | null;
  documentNumber: string | null;
  documentFront: string | null;
  documentBack: string | null;
  profileImage: string | null;
  status: string;
  submittedAt: Date;
  reviewedAt: Date | null;
  adminNotes: string | null;
  rejectionReason: string | null;
}

interface KycInfo {
  status: string;
  submission: KycSubmissionInfo | null;
}

interface SessionInfo {
  id: string;
  device_info: string | null;
  ip_address: string | null;
  last_activity: Date | null;
  created_at: Date | null;
  expires_at: Date;
}

export class OAuthLinkUserResponseDto {
  accessToken: string;
  refreshToken: string;
  message: string;
  sessionId?: string;
  data: {
    id: string;
    email: string | null;
    phone: string | null;
    fcmToken: string | null;
    full_name: string | null;
    account_number: string | null;
    branchId: string | null;
    branch: BranchInfo | null;
    role: string;
    passwordStatus: string | null;
    pinstatus: boolean | null;
    merchantCode: string | null;
    businessName: string | null;
    status: string;
    deleted: boolean;
    createdAt: Date;
    updatedAt: Date;
    profileImage: string | null;
    kycStatus: string;
    countryCode: string | null;
    locked_by_admin: boolean;
    sessions: SessionInfo[];
    resources: ResourceInfo[];
    wallets: WalletInfo[];
    kyc: KycInfo;
    accessToken: string;
    refreshToken: string;
    tokenType: string;
    expiresIn: number;
  };
}