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

        // ✅ Récupérer la clé API du header Authorization
        const authHeader = request.headers['authorization'];

        if (!authHeader) {
            throw new UnauthorizedException('API key required in Authorization header');
        }

        // ✅ Extraire le token du header (format: "Bearer <api_key>")
        const parts = authHeader.split(' ');
        if (parts.length !== 2 || parts[0] !== 'Bearer') {
            throw new UnauthorizedException('Invalid Authorization header format. Expected: Bearer <api_key>');
        }

        const apiKey = parts[1];

        if (!apiKey) {
            throw new UnauthorizedException('API key required');
        }

        let userId: string | undefined;
        let permissionsArray: string[] = [];
        let isJwt = false;
        let apiKeyRecord: any = null;

        // 1️⃣ Essayer de valider comme JWT
        try {
            const secret = process.env.JWT_API_KEY_SECRET || 'your-secret-key-at-least-32-chars';
            const payload = jwt.verify(apiKey, secret) as any;
            userId = payload.sub || payload.userId;
            permissionsArray = payload.permissions || [];
            isJwt = true;

            // ✅ Récupérer l'utilisateur complet depuis la base (sans userIdFpay)
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: {
                    id: true,
                    full_name: true,
                    phone: true,
                    email: true,
                    role: true,
                    status: true,
                    merchantCode: true,
                    merchantType: true,
                    businessName: true,
                    businessCategory: true,
                    businessAddress: true,
                    kycStatus: true,
                    countryCode: true,
                    wallets: {
                        where: { isActive: true },
                        select: {
                            id: true,
                            currency: true,
                            balance: true,
                            isActive: true,
                        }
                    }
                }
            });

            if (!user) {
                throw new UnauthorizedException('User not found');
            }

            // ✅ Ajouter l'utilisateur complet à la requête
            request.user = user;

            // ✅ Vérifier les permissions
            const requiredPermissions = this.reflector.get<string[]>('permissions', context.getHandler());
            if (requiredPermissions && requiredPermissions.length) {
                const hasPermission = requiredPermissions.some(p => permissionsArray.includes(p));
                if (!hasPermission) {
                    throw new ForbiddenException(`Insufficient permissions. Required: ${requiredPermissions.join(', ')}`);
                }
            }

            console.log('[ApiKeyGuard] ✅ Utilisateur trouvé (JWT):', {
                id: user.id,
                full_name: user.full_name,
                phone: user.phone,
                merchantCode: user.merchantCode,
                role: user.role,
            });

            return true;
        } catch (err) {
            // Ce n'est pas un JWT valide, on continue avec la recherche en base
            console.log('[ApiKeyGuard] ⚠️ JWT invalide, recherche en base...');
        }

        // 2️⃣ Si ce n'est pas un JWT, rechercher dans la base
        if (!isJwt) {
            const keyRecord = await this.prisma.api_key.findFirst({
                where: {
                    key: apiKey,
                    isActive: true,
                    expiresAt: {
                        gt: new Date(),
                    },
                },
                include: {
                    user: {
                        select: {
                            id: true,
                            full_name: true,
                            phone: true,
                            email: true,
                            role: true,
                            status: true,
                            merchantCode: true,
                            merchantType: true,
                            businessName: true,
                            businessCategory: true,
                            businessAddress: true,
                            kycStatus: true,
                            countryCode: true,
                            wallets: {
                                where: { isActive: true },
                                select: {
                                    id: true,
                                    currency: true,
                                    balance: true,
                                    isActive: true,
                                }
                            }
                        }
                    },
                },
            });

            if (!keyRecord) {
                throw new UnauthorizedException('Invalid or expired API key');
            }

            // Mettre à jour la date de dernière utilisation
            await this.prisma.api_key.update({
                where: { id: keyRecord.id },
                data: { lastUsedAt: new Date() },
            });

            userId = keyRecord.userId;
            apiKeyRecord = keyRecord;

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

            // ✅ Ajouter l'utilisateur complet à la requête (keyRecord.user existe car include: { user: true })
            request.user = keyRecord.user;
            request.apiKey = apiKeyRecord;

            // ✅ Vérifier les permissions
            const requiredPermissions = this.reflector.get<string[]>('permissions', context.getHandler());
            if (requiredPermissions && requiredPermissions.length) {
                const hasPermission = requiredPermissions.some(p => permissionsArray.includes(p));
                if (!hasPermission) {
                    throw new ForbiddenException(`Insufficient permissions. Required: ${requiredPermissions.join(', ')}`);
                }
            }

            console.log('[ApiKeyGuard] ✅ Utilisateur trouvé (Base de données):', {
                id: keyRecord.user.id,
                full_name: keyRecord.user.full_name,
                phone: keyRecord.user.phone,
                merchantCode: keyRecord.user.merchantCode,
                role: keyRecord.user.role,
            });
        }

        if (!userId) {
            throw new UnauthorizedException('Unable to identify user');
        }

        return true;
    }
}