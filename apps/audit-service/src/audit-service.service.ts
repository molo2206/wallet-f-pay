import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAuditLogDto, GetAuditLogsDto } from '../dto/audit.dto';
import { audit_log } from '@prisma/client';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly DEFAULT_LIMIT = 20;
  private readonly MAX_LIMIT = 100;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Crée une entrée d'audit
   * @param data Données du log d'audit
   * @returns Le log créé
   */
  async log(data: CreateAuditLogDto): Promise<audit_log> {
    try {
      const logEntry = await this.prisma.audit_log.create({
        data: {
          userId: data.userId ?? null,
          action: data.action,
          details: data.details ?? null,
          ipAddress: data.ipAddress ?? null,
          createdAt: new Date(),
        },
      });
      this.logger.debug(
        `Audit log created: ${data.action} for user ${data.userId}`,
      );
      return logEntry;
    } catch (error) {
      this.logger.error(`Failed to create audit log: ${error.message}`);
      throw error;
    }
  }

  /**
   * Récupère un audit log par son ID
   * @param id Identifiant du log
   * @returns Le log d'audit avec les informations utilisateur (si existant)
   * @throws NotFoundException si le log n'existe pas
   */
  async getLogById(id: string): Promise<
    audit_log & {
      user?: { full_name: string | null; account_number: string | null };
    }
  > {
    if (!id) {
      throw new BadRequestException('Audit log ID is required');
    }

    const log = await this.prisma.audit_log.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            full_name: true,
            account_number: true,
          },
        },
      },
    });

    if (!log) {
      throw new NotFoundException(`Audit log with ID ${id} not found`);
    }

    // Convertir `null` en `undefined` pour correspondre au type déclaré
    return {
      ...log,
      user: log.user ?? undefined,
    };
  }

  async logWithDebounce(
    data: CreateAuditLogDto,
    debounceMs: number = 2000,
  ): Promise<audit_log | null> {
    // Vérifier le dernier audit pour ce user/action dans la fenêtre de temps
    const lastAudit = await this.prisma.audit_log.findFirst({
      where: {
        userId: data.userId ?? null,
        action: data.action,
        createdAt: { gte: new Date(Date.now() - debounceMs) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (lastAudit) {
      this.logger.debug(
        `[Audit] Ignored duplicate ${data.action} for user ${data.userId}`,
      );
      return null;
    }
    // Sinon, créer l'audit
    return this.log(data);
  }
  /**
   * Supprime un audit log par son ID
   * @param id Identifiant du log
   * @returns Message de confirmation
   * @throws NotFoundException si le log n'existe pas
   */
  async deleteLogById(id: string): Promise<{ message: string }> {
    if (!id) {
      throw new BadRequestException('Audit log ID is required');
    }

    // Vérifier si le log existe avant suppression
    const existingLog = await this.prisma.audit_log.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!existingLog) {
      throw new NotFoundException(`Audit log with ID ${id} not found`);
    }

    await this.prisma.audit_log.delete({
      where: { id },
    });

    this.logger.log(`Audit log ${id} deleted successfully`);
    return { message: `Audit log ${id} deleted successfully` };
  }

  /**
   * Récupère les logs d'audit avec filtres et pagination
   * @param query Paramètres de filtrage et pagination
   * @returns Logs paginés avec métadonnées
   */
  async getLogs(query: GetAuditLogsDto) {
    // 1. Pagination : valeurs par défaut et limites
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(
      this.MAX_LIMIT,
      Math.max(1, query.limit ?? this.DEFAULT_LIMIT),
    );
    const skip = (page - 1) * limit;

    // 2. Filtres
    const where: any = {};
    if (query.userId) where.userId = query.userId;
    if (query.action) where.action = query.action;

    if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) {
        const start = new Date(query.startDate);
        if (isNaN(start.getTime()))
          throw new BadRequestException('Invalid startDate');
        where.createdAt.gte = start;
      }
      if (query.endDate) {
        const end = new Date(query.endDate);
        if (isNaN(end.getTime()))
          throw new BadRequestException('Invalid endDate');
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }

    // 3. Requêtes parallèles
    const [logs, total] = await Promise.all([
      this.prisma.audit_log.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: {
            select: {
              full_name: true,
              account_number: true,
            },
          },
        },
      }),
      this.prisma.audit_log.count({ where }),
    ]);

    // 4. Formatage des dates
    const formattedLogs = logs.map((log) => ({
      ...log,
      date: log.createdAt.toISOString(),
    }));

    const totalPages = Math.ceil(total / limit);

    // 5. Retour avec structure plate
    return {
      message: 'Audit logs retrieved successfully',
      data: {
        data: formattedLogs,
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }
  /**
   * Récupère les actions disponibles (utile pour les filtres UI)
   * @returns Liste des actions uniques
   */
  async getDistinctActions(): Promise<string[]> {
    const actions = await this.prisma.audit_log.findMany({
      distinct: ['action'],
      select: { action: true },
    });
    return actions.map((a) => a.action);
  }

  /**
   * Supprime les logs plus anciens qu'une certaine date (nettoyage)
   * @param olderThan Date limite (ex: 90 jours)
   * @returns Nombre de logs supprimés
   */
  async cleanupLogs(olderThan: Date): Promise<number> {
    const { count } = await this.prisma.audit_log.deleteMany({
      where: {
        createdAt: { lt: olderThan },
      },
    });
    this.logger.log(
      `Cleaned up ${count} audit logs older than ${olderThan.toISOString()}`,
    );
    return count;
  }
}
