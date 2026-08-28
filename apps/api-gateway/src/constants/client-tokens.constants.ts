// apps/api-gateway/src/constants/client-tokens.constants.ts

import * as crypto from 'crypto';

export const CLIENT_TOKENS = {
    WEB: 'fpay_web_8f9a2e1d3c4b5a6f7e8d9c0b1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6d7c8b9a0f1',
    MOBILE: 'fpay_mobile_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7',
    ADMIN: 'fpay_admin_7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0',
    EXTERNAL: 'fpay_ext_5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7',
} as const;

export const CLIENT_TOKEN_MAP = {
    [CLIENT_TOKENS.WEB]: 'web-client',
    [CLIENT_TOKENS.MOBILE]: 'mobile-client',
    [CLIENT_TOKENS.ADMIN]: 'admin-client',
    [CLIENT_TOKENS.EXTERNAL]: 'external-client',
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

// ✅ Fonction pour valider un token client (simple correspondance)
export function validateClientToken(token: string): { valid: boolean; clientId?: string; error?: string } {
    // ✅ Vérification par correspondance exacte avec les tokens statiques
    const clientId = CLIENT_TOKEN_MAP[token as keyof typeof CLIENT_TOKEN_MAP];
    
    if (clientId) {
        return { valid: true, clientId };
    }
    
    return { valid: false, error: 'Token client invalide' };
}

// ✅ Afficher les tokens au démarrage
console.log('🔑 TOKENS CLIENTS STATIQUES');
console.log('=========================================');
console.log('WEB_TOKEN:', CLIENT_TOKENS.WEB);
console.log('MOBILE_TOKEN:', CLIENT_TOKENS.MOBILE);
console.log('ADMIN_TOKEN:', CLIENT_TOKENS.ADMIN);
console.log('EXTERNAL_TOKEN:', CLIENT_TOKENS.EXTERNAL);
console.log('=========================================');
console.log('✅ Ces tokens sont statiques et ne changent pas.');
console.log('✅ Vous pouvez les modifier directement dans le code.');