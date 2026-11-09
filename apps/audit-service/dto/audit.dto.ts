export class CreateAuditLogDto {
  userId?: string | null;
  action: string;
  details?: any;
  ipAddress?: string | null;
}

export class GetAuditLogsDto {
  page?: number;
  limit?: number;
  userId?: string;
  action?: string;
  startDate?: Date;
  endDate?: Date;
}
