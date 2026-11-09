// user-service/src/utils/upload.util.ts
import { RpcException } from '@nestjs/microservices';

export interface UploadOptions {
    folder?: string;
    timeout?: number;
}

export async function uploadFile(
    file: Express.Multer.File,
    options: UploadOptions = {}
): Promise<string> {
    const folder = options.folder || 'kyc';
    const timeout = options.timeout || 30000;

    console.log(`[Upload] Uploading file to ${folder}: ${file.originalname}`);

    try {
        const formData = new FormData();
        const buffer = Buffer.from(file.buffer);
        const blob = new Blob([buffer], { type: file.mimetype });
        formData.append('file', blob, file.originalname);

        const baseUrl = process.env.FILE_SERVICE_URL || 'https://api-prod.favorhelp.com/api/v1/files/upload';
        const uploadUrl = `${baseUrl}/${folder}/single`;

        console.log(`[Upload] URL: ${uploadUrl}`);
        console.log(`[Upload] File: ${file.originalname} (${file.size} bytes)`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
            const response = await fetch(uploadUrl, {
                method: 'POST',
                body: formData,
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            const responseText = await response.text();

            if (!response.ok) {
                let errorMessage = `Upload failed: ${response.status}`;
                try {
                    const errorJson = JSON.parse(responseText);
                    errorMessage = errorJson.message || errorJson.error || errorMessage;
                } catch {
                    errorMessage = responseText || errorMessage;
                }
                throw new Error(errorMessage);
            }

            let result;
            try {
                result = JSON.parse(responseText);
            } catch {
                throw new Error('Invalid JSON response from upload service');
            }

            const fileUrl = result.data || result.url || result.fileUrl;

            if (!fileUrl) {
                throw new Error('No URL returned from upload service');
            }

            console.log(`[Upload] ✅ File uploaded: ${fileUrl}`);
            return fileUrl;

        } finally {
            clearTimeout(timeoutId);
        }

    } catch (error) {
        console.error(`[Upload] ❌ Error:`, error.message);

        if (error.name === 'AbortError' || error.name === 'TimeoutError') {
            throw new RpcException({
                status: 'error',
                message: 'L\'upload du fichier a expiré. Veuillez réessayer.',
                statusCode: 504,
            });
        }

        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            throw new RpcException({
                status: 'error',
                message: 'Le service de fichiers est temporairement indisponible. Veuillez réessayer plus tard.',
                statusCode: 503,
            });
        }

        throw new RpcException({
            status: 'error',
            message: error.message || 'Erreur lors de l\'upload du fichier',
            statusCode: 500,
        });
    }
}

/**
 * Upload de plusieurs fichiers
 */
export async function uploadMultipleFiles(
    files: Express.Multer.File[],
    options: UploadOptions = {}
): Promise<string[]> {
    console.log(`[Upload] Uploading ${files.length} files...`);
    const results = await Promise.all(files.map(f => uploadFile(f, options)));
    console.log(`[Upload] ✅ All ${files.length} files uploaded`);
    return results;
}

/**
 * Upload d'un fichier en base64
 */
export async function uploadBase64(
    base64: string,
    fileName: string,
    options: UploadOptions = {}
): Promise<string> {
    console.log(`[Upload] Uploading base64 file: ${fileName}`);

    const matches = base64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
        throw new RpcException({
            status: 'error',
            message: 'Format base64 invalide',
            statusCode: 400,
        });
    }

    const mimeType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');

    const file: Express.Multer.File = {
        buffer,
        originalname: fileName,
        mimetype: mimeType,
        size: buffer.length,
        fieldname: 'file',
        encoding: '7bit',
        stream: null as any,
        destination: '',
        filename: fileName,
        path: '',
    };

    return uploadFile(file, options);
}