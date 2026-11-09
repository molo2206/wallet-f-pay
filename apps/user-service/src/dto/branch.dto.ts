// apps/user-service/src/dto/branch.dto.ts
export class CreateBranchDto {
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  countryId: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  // ❌ PAS DE CODE - Généré automatiquement
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


export class DeleteBranchDto {
  id: string;
  permanent?: boolean; // false par défaut (soft delete)
}