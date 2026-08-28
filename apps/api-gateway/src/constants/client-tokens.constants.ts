// apps/api-gateway/src/constants/client-tokens.constants.ts

import * as crypto from 'crypto';

// ✅ Clés secrètes pour signer les tokens (à mettre dans .env)
export const CLIENT_SECRETS = {
    WEB: process.env.CLIENT_SECRET_WEB || 'web_super_secret_key_2024_fpay_xyz_789',
    MOBILE: process.env.CLIENT_SECRET_MOBILE || 'mobile_super_secret_key_2024_fpay_xyz_789',
    ADMIN: process.env.CLIENT_SECRET_ADMIN || 'admin_super_secret_key_2024_fpay_xyz_789',
    EXTERNAL: process.env.CLIENT_SECRET_EXTERNAL || 'external_super_secret_key_2024_fpay_xyz_789',
} as const;

// ✅ Clients autorisés
export const CLIENTS = {
    WEB: {
        id: 'web-client',
        name: 'Web Application',
        type: 'web',
        allowedRedirects: [
            'https://favorhelp.com',
            'https://fpay.com',
            'https://f-pay.favorhelp.com',
            'https://api-prod.f-pay.app',
            'http://localhost:3000',
            'http://localhost:4200'
        ]
    },
    MOBILE: {
        id: 'mobile-client',
        name: 'Mobile Application',
        type: 'mobile',
        allowedRedirects: ['fpay://callback']
    },
    ADMIN: {
        id: 'admin-client',
        name: 'Admin Panel',
        type: 'admin',
        allowedRedirects: [
            'https://admin.fpay.com',
            'http://localhost:3001'
        ]
    },
    EXTERNAL: {
        id: 'external-client',
        name: 'External API',
        type: 'external',
        allowedRedirects: ['https://api.fpay.com']
    },
} as const;

export type ClientType = keyof typeof CLIENTS;

// ✅ Fonction pour générer un token client sécurisé
export function generateClientToken(clientType: ClientType): string {
    const secret = CLIENT_SECRETS[clientType];
    const client = CLIENTS[clientType];

    // Créer un payload avec expiration
    const payload = {
        clientId: client.id,
        type: client.type,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 jours
        nonce: crypto.randomBytes(16).toString('hex'),
    };

    // Signer le payload avec HMAC-SHA256
    const payloadStr = JSON.stringify(payload);
    const signature = crypto
        .createHmac('sha256', secret)
        .update(payloadStr)
        .digest('hex');

    // Encoder en base64
    const encodedPayload = Buffer.from(payloadStr).toString('base64');
    const encodedSignature = Buffer.from(signature).toString('base64');

    return `${encodedPayload}.${encodedSignature}`;
}

// ✅ Fonction pour valider un token client
export function validateClientToken(token: string): { valid: boolean; clientId?: string; error?: string } {
    try {
        // Décoder le token
        const parts = token.split('.');
        if (parts.length !== 2) {
            return { valid: false, error: 'Format de token invalide' };
        }

        const [encodedPayload, encodedSignature] = parts;
        const payloadStr = Buffer.from(encodedPayload, 'base64').toString('utf-8');
        const payload = JSON.parse(payloadStr);

        // Vérifier l'expiration
        const now = Math.floor(Date.now() / 1000);
        if (payload.exp && payload.exp < now) {
            return { valid: false, error: 'Token client expiré' };
        }

        // Trouver le client
        const clientEntry = Object.entries(CLIENTS).find(([key, value]) => value.id === payload.clientId);
        if (!clientEntry) {
            return { valid: false, error: 'Client non autorisé' };
        }

        const [clientType] = clientEntry;
        const secret = CLIENT_SECRETS[clientType as ClientType];

        // Vérifier la signature
        const expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(payloadStr)
            .digest('hex');

        const providedSignature = Buffer.from(encodedSignature, 'base64').toString('hex');

        if (providedSignature !== expectedSignature) {
            return { valid: false, error: 'Signature invalide' };
        }

        return { valid: true, clientId: payload.clientId };

    } catch (error) {
        return { valid: false, error: 'Token invalide' };
    }
}

// ✅ Générer les tokens statiques (à exécuter une fois)
console.log('🔑 GÉNÉRATION DES TOKENS CLIENTS STATIQUES');
console.log('=========================================');
console.log('WEB_TOKEN:', generateClientToken('WEB'));
console.log('MOBILE_TOKEN:', generateClientToken('MOBILE'));
console.log('ADMIN_TOKEN:', generateClientToken('ADMIN'));
console.log('EXTERNAL_TOKEN:', generateClientToken('EXTERNAL'));