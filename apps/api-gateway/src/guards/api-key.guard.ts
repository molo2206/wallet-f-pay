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
    private static warned = false;

    constructor(private prisma: PrismaService, private reflector: Reflector) {
        // ⚠️ Sans JWT_API_KEY_SECRET, les clés sont signées avec le secret par défaut écrit dans le code :
        //    une clé pourrait être fabriquée. La vérification en base (API_KEY_JWT_REQUIRE_DB) bloque ces clés.
        if (!process.env.JWT_API_KEY_SECRET && !ApiKeyGuard.warned) {
            ApiKeyGuard.warned = true;
            console.warn('[ApiKeyGuard] ⚠️ JWT_API_KEY_SECRET non défini : secret par défaut utilisé. Définissez-le puis régénérez les clés API.');
        }
    }

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
        // ✅ CORRECTION SÉCURITÉ : seule la vérification de la signature est dans le try/catch.
        //    Avant, les erreurs « permissions insuffisantes » / « utilisateur introuvable » levées plus bas
        //    étaient avalées par ce catch : comme isJwt était déjà true, la requête était ACCEPTÉE quand même.
        let jwtPayload: any = null;
        try {
            const secret = process.env.JWT_API_KEY_SECRET || 'your-secret-key-at-least-32-chars';
            jwtPayload = jwt.verify(apiKey, secret) as any;
        } catch (err) {
            // Ce n'est pas un JWT valide (ou expiré), on continue avec la recherche en base
            console.log('[ApiKeyGuard] ⚠️ JWT invalide, recherche en base...');
        }

        if (jwtPayload) {
            userId = jwtPayload.sub || jwtPayload.userId;
            permissionsArray = jwtPayload.permissions || [];
            isJwt = true;

            // ✅ La clé JWT doit toujours exister en base, active et non expirée :
            //    une clé désactivée / supprimée / régénérée n'est plus acceptée (révocation).
            //    API_KEY_JWT_REQUIRE_DB=false : accepte encore les anciennes clés JWT jamais enregistrées en base.
            const stored = await this.prisma.api_key.findFirst({
                where: { key: apiKey },
                select: { id: true, isActive: true, expiresAt: true, permissions: true, userId: true },
            });
            const requireDb = String(process.env.API_KEY_JWT_REQUIRE_DB ?? 'true').toLowerCase() !== 'false';
            if (stored) {
                if (!stored.isActive || (stored.expiresAt && stored.expiresAt <= new Date())) {
                    throw new UnauthorizedException('API key revoked or expired');
                }
                if (stored.userId && userId && stored.userId !== userId) {
                    throw new UnauthorizedException('API key does not match its owner');
                }
                // Les permissions enregistrées en base font foi (modifiables sans régénérer la clé)
                try {
                    const fromDb = typeof stored.permissions === 'string' ? JSON.parse(stored.permissions) : stored.permissions;
                    if (Array.isArray(fromDb)) permissionsArray = fromDb;
                } catch {
                    // permissions illisibles en base : on garde celles du JWT
                }
                await this.prisma.api_key
                    .update({ where: { id: stored.id }, data: { lastUsedAt: new Date() } })
                    .catch(() => undefined);
                request.apiKey = stored;
            } else if (requireDb) {
                throw new UnauthorizedException('Unknown API key');
            }

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
            // ✅ Compte bloqué : sa clé API ne fonctionne plus
            if (user.status === 'BLOCKED') {
                throw new ForbiddenException('Account blocked');
            }

            // ✅ Ajouter l'utilisateur complet à la requête
            request.user = user;

            // ✅ Vérifier les permissions (avant la correction, ce refus était avalé et la requête acceptée)
            //    API_KEY_PERMISSIONS_MODE=enforce : refus 403 ; warn (défaut, transition) : accepté mais journalisé.
            const requiredPermissions = this.reflector.get<string[]>('permissions', context.getHandler());
            if (requiredPermissions && requiredPermissions.length) {
                const hasPermission = requiredPermissions.some(p => permissionsArray.includes(p));
                if (!hasPermission) {
                    const mode = String(process.env.API_KEY_PERMISSIONS_MODE || 'warn').toLowerCase();
                    if (mode === 'enforce') {
                        throw new ForbiddenException(`Insufficient permissions. Required: ${requiredPermissions.join(', ')}`);
                    }
                    console.warn(
                        `[ApiKeyGuard] ⚠️ PERMISSION MANQUANTE (mode warn, requête acceptée) : clé « ${jwtPayload.name || '?'} » ` +
                        `(utilisateur ${user.id}) sur ${request.method} ${request.originalUrl || request.url} — ` +
                        `requis : ${requiredPermissions.join(', ')} ; accordé : ${permissionsArray.join(', ') || 'aucune'}. ` +
                        `Ajoutez la permission à la clé puis passez API_KEY_PERMISSIONS_MODE=enforce.`,
                    );
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

            // ✅ Correction: userId = keyRecord.userId (string | null)
            userId = keyRecord.userId ?? undefined;
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

            // ✅ Correction: Vérifier que keyRecord.user existe avant de l'utiliser
            if (keyRecord.user && keyRecord.user.status === 'BLOCKED') {
                throw new ForbiddenException('Account blocked');
            }
            if (keyRecord.user) {
                // ✅ Ajouter l'utilisateur complet à la requête
                request.user = keyRecord.user;
                request.apiKey = apiKeyRecord;

                console.log('[ApiKeyGuard] ✅ Utilisateur trouvé (Base de données):', {
                    id: keyRecord.user.id,
                    full_name: keyRecord.user.full_name,
                    phone: keyRecord.user.phone,
                    merchantCode: keyRecord.user.merchantCode,
                    role: keyRecord.user.role,
                });
            } else {
                throw new UnauthorizedException('User not found for this API key');
            }

            // ✅ Vérifier les permissions
            const requiredPermissions = this.reflector.get<string[]>('permissions', context.getHandler());
            if (requiredPermissions && requiredPermissions.length) {
                const hasPermission = requiredPermissions.some(p => permissionsArray.includes(p));
                if (!hasPermission) {
                    throw new ForbiddenException(`Insufficient permissions. Required: ${requiredPermissions.join(', ')}`);
                }
            }
        }

        if (!userId) {
            throw new UnauthorizedException('Unable to identify user');
        }

        return true;
    }
}