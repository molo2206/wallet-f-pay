// apps/auth-service/src/utility/interfaces/jwt-payload.interface.ts
export interface JwtPayload {
  id: string;
  email?: string;
  phone?: string;
  full_name?: string;
  role: string; // Champ requis
  status: string; // Champ requis
  account_number: string;
  iat?: number;
  exp?: number;
}
