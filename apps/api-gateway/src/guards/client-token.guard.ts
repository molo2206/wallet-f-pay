// apps/api-gateway/src/guards/client-token.guard.ts

import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { validateClientToken } from '../constants/client-tokens.constants';

@Injectable()
export class ClientTokenGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest();

        // ✅ Récupérer le token depuis le header ou le query param
        let clientToken = request.headers['x-client-token'] ||
            request.query.client_token ||
            request.headers['authorization']?.replace('Bearer ', '');

        // ✅ Si le token est dans le header Authorization avec préfixe "Client "
        if (!clientToken && request.headers['authorization']?.startsWith('Client ')) {
            clientToken = request.headers['authorization'].replace('Client ', '');
        }

        if (!clientToken) {
            throw new HttpException(
                {
                    statusCode: HttpStatus.BAD_REQUEST,
                    message: 'Client token est requis',
                    error: 'MISSING_CLIENT_TOKEN'
                },
                HttpStatus.BAD_REQUEST
            );
        }

        // ✅ Vérifier le format du token (doit commencer par eyJ pour JWT base64)
        if (!clientToken.includes('.')) {
            throw new HttpException(
                {
                    statusCode: HttpStatus.UNAUTHORIZED,
                    message: 'Format de token client invalide',
                    error: 'INVALID_TOKEN_FORMAT'
                },
                HttpStatus.UNAUTHORIZED
            );
        }

        // ✅ Valider le token
        const result = validateClientToken(clientToken);

        if (!result.valid) {
            throw new HttpException(
                {
                    statusCode: HttpStatus.UNAUTHORIZED,
                    message: result.error || 'Token client invalide',
                    error: 'INVALID_CLIENT_TOKEN'
                },
                HttpStatus.UNAUTHORIZED
            );
        }

        // ✅ Ajouter le client_id à la requête
        request.clientId = result.clientId;
        request.clientToken = clientToken;

        // ✅ Logger pour audit
        console.log(`[ClientTokenGuard] ✅ Client authentifié: ${result.clientId}`);

        return true;
    }
}