// apps/api-gateway/src/constants/client-tokens.constants.ts

import * as crypto from 'crypto';

// ✅ VOS TOKENS STATIQUES PERSONNALISÉS
// 🔑 Définissez ici vos propres tokens
export const CLIENT_TOKENS = {
    WEB: 'fpay_web_token_2024_secure_static',           // ✅ Votre token WEB
    MOBILE: 'fpay_mobile_token_2024_secure_static',     // ✅ Votre token MOBILE
    ADMIN: 'fpay_admin_token_2024_secure_static',       // ✅ Votre token ADMIN
    EXTERNAL: 'fpay_external_token_2024_secure_static', // ✅ Votre token EXTERNAL
} as const;

// ✅ Mapping token -> client_id
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