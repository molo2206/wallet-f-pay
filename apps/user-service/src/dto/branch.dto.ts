// apps/user-service/src/dto/branch.dto.ts
export class CreateBranchDto {
  name: string;
  code: string;
  address?: string;
  phone?: string;
  email?: string;
  countryId: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
}

export class UpdateBranchDto {
  name?: string;
  code?: string;
  address?: string;
  phone?: string;
  email?: string;
  countryId?: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
}

export class GetBranchesDto {
  page?: number;
  limit?: number;
  countryId?: string;
  status?: string;
}