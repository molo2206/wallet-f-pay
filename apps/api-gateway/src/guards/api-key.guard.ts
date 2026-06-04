/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable prettier/prettier */
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from 'apps/user-service/src/prisma/prisma.service';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class ApiKeyGuard implements CanActivate {
    constructor(private prisma: PrismaService, private reflector: Reflector) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const apiKey = request.headers['x-api-key'];

        if (!apiKey) {
            throw new UnauthorizedException('API key required');
        }

        let userId: string | undefined;
        let permissionsArray: string[] = [];
        let isJwt = false;

        // 1️⃣ Essayer de valider comme JWT
        try {
            const secret = process.env.JWT_API_KEY_SECRET || 'your-secret-key-at-least-32-chars';
            const payload = jwt.verify(apiKey, secret) as any;
            userId = payload.sub;
            permissionsArray = payload.permissions || [];
            isJwt = true;
            request.user = { id: userId };
        } catch (err) {
            // Ce n'est pas un JWT valide, on continue
        }

        // 2️⃣ Si ce n'est pas un JWT, rechercher dans la base
        if (!isJwt) {
            const keyRecord = await this.prisma.api_key.findUnique({
                where: { key: apiKey },
                include: { user: true },
            });

            if (!keyRecord || !keyRecord.isActive) {
                throw new UnauthorizedException('Invalid API key');
            }

            if (keyRecord.expiresAt && keyRecord.expiresAt < new Date()) {
                throw new UnauthorizedException('API key expired');
            }

            // Mettre à jour la date de dernière utilisation
            await this.prisma.api_key.update({
                where: { id: keyRecord.id },
                data: { lastUsedAt: new Date() },
            });

            userId = keyRecord.userId;
            // Extraire les permissions
            if (typeof keyRecord.permissions === 'string') {
                try {
                    permissionsArray = JSON.parse(keyRecord.permissions);
                } catch {
                    permissionsArray = [];
                }
            } else if (Array.isArray(keyRecord.permissions)) {
                permissionsArray = keyRecord.permissions;
            }

            request.user = keyRecord.user;
        }

        if (!userId) {
            throw new UnauthorizedException('Unable to identify user');
        }

        // 3️⃣ Vérifier les permissions requises
        const requiredPermissions = this.reflector.get<string[]>('permissions', context.getHandler());
        if (requiredPermissions && requiredPermissions.length) {
            const hasPermission = requiredPermissions.some(p => permissionsArray.includes(p));
            if (!hasPermission) {
                throw new ForbiddenException('Insufficient permissions');
            }
        }

        return true;
    }
}