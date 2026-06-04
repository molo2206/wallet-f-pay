/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// permissions.guard.ts
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from 'apps/user-service/src/prisma/prisma.service';
import { Permission, PERMISSION_METADATA } from './permissions.guard';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSION_METADATA,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true; // aucune permission requise
    }

    const request = context.switchToHttp().getRequest();
    const user = request.currentUser; // ou request.user selon votre guard d'authentification

    if (!user) {
      throw new UnauthorizedException('Utilisateur non authentifié');
    }

    // Si l'utilisateur est SUPER_ADMIN, on bypass (optionnel)
    if (user.role === 'SUPER_ADMIN') {
      return true;
    }

    // Pour chaque permission requise, vérifier dans user_has_resources
    for (const perm of requiredPermissions) {
      await this.checkPermission(user.id, perm.resource, perm.action);
    }

    return true;
  }

  private async checkPermission(
    userId: string,
    resourceName: string,
    action: string,
  ): Promise<void> {
    // Récupérer la ressource par son nom
    const resource = await this.prisma.resources.findUnique({
      where: { name: resourceName },
    });

    if (!resource) {
      throw new ForbiddenException(`Ressource "${resourceName}" inexistante.`);
    }

    // Récupérer l'association user_has_resources avec les permissions
    const userResource = await this.prisma.user_has_resources.findUnique({
      where: {
        userId_resourceId: {
          userId,
          resourceId: resource.id,
        },
      },
    });

    if (!userResource) {
      throw new ForbiddenException(
        `Aucune permission pour la ressource "${resourceName}".`,
      );
    }

    // Vérifier si la permission est expirée
    if (userResource.expiresAt && userResource.expiresAt < new Date()) {
      throw new ForbiddenException(
        `La permission pour "${resourceName}" a expiré.`,
      );
    }

    // canManage donne tous les droits
    if (userResource.canManage) return;

    let allowed = false;
    switch (action) {
      case 'canCreate':
        allowed = userResource.canCreate;
        break;
      case 'canRead':
        allowed = userResource.canRead;
        break;
      case 'canUpdate':
        allowed = userResource.canUpdate;
        break;
      case 'canDelete':
        allowed = userResource.canDelete;
        break;
      case 'canManage':
        allowed = userResource.canManage;
        break;
    }

    if (!allowed) {
      throw new ForbiddenException(
        `Action "${action}" non autorisée sur la ressource "${resourceName}".`,
      );
    }
  }
}
