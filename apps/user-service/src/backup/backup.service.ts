// apps/user-service/src/backup/backup.service.ts
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import * as mysql from 'mysql2/promise';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { PrismaService } from '../prisma/prisma.service';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export interface BackupHistoryItem {
    fileName: string;
    size: number;
    sizeFormatted: string;
    isCompressed: boolean;
    createdAt: string;
}

export interface BackupResult {
    fileName: string;
    filePath: string;
    size: number;
}

@Injectable()
export class BackupService {
    private readonly logger = new Logger(BackupService.name);
    private readonly backupDir: string;
    private readonly tempDir: string;
    private readonly maxBackups: number = 10;

    constructor(private readonly prisma: PrismaService) {
        this.backupDir = path.join(process.cwd(), 'backups');
        this.tempDir = path.join(process.cwd(), 'temp');
        this.ensureDirectories();
    }

    private ensureDirectories() {
        if (!fs.existsSync(this.backupDir)) {
            fs.mkdirSync(this.backupDir, { recursive: true });
        }
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    private getDbConfig() {
        return {
            host: process.env.DATABASE_HOST || 'localhost',
            port: parseInt(process.env.DATABASE_PORT || '3306'),
            user: process.env.DATABASE_USER || 'root',
            password: process.env.DATABASE_PASSWORD || '',
            database: process.env.DATABASE_NAME || '',
        };
    }

    // ⭐ NETTOYER LA BASE DE DONNÉES
    private async cleanDatabase(connection: mysql.Connection): Promise<void> {
        this.logger.log('🧹 Nettoyage de la base de données avant restauration...');

        try {
            const [tables] = await connection.execute('SHOW TABLES');
            const tableRows = tables as any[];
            const tableNames = tableRows.map(row => Object.values(row)[0] as string);

            this.logger.log(`📋 ${tableNames.length} tables trouvées`);

            await connection.execute('SET FOREIGN_KEY_CHECKS = 0');
            await connection.execute('SET UNIQUE_CHECKS = 0');

            let truncatedCount = 0;
            for (const tableName of tableNames) {
                try {
                    await connection.execute(`TRUNCATE TABLE \`${tableName}\``);
                    truncatedCount++;
                    this.logger.debug(`Table vidée: ${tableName}`);
                } catch (truncateErr) {
                    try {
                        await connection.execute(`DELETE FROM \`${tableName}\``);
                        truncatedCount++;
                        this.logger.debug(`Table vidée avec DELETE: ${tableName}`);
                    } catch (deleteErr) {
                        this.logger.warn(`⚠️ Impossible de vider la table ${tableName}: ${deleteErr.message}`);
                    }
                }
            }

            await connection.execute('SET FOREIGN_KEY_CHECKS = 1');
            await connection.execute('SET UNIQUE_CHECKS = 1');

            this.logger.log(`✅ Base de données nettoyée: ${truncatedCount}/${tableNames.length} tables vidées`);

        } catch (error) {
            this.logger.error(`❌ Erreur lors du nettoyage de la base: ${error.message}`);
            throw error;
        }
    }

    // Restaurer à partir d'un fichier uploadé
    async restoreFromUpload(file: Express.Multer.File): Promise<{ success: boolean; message: string; details?: any }> {
        const timestamp = Date.now();
        const tempFilePath = path.join(this.tempDir, `restore-${timestamp}-${file.originalname}`);

        try {
            this.logger.log(`📥 Début de la restauration depuis: ${file.originalname}`);

            fs.writeFileSync(tempFilePath, file.buffer);

            let sqlContent: string;
            let isCompressed = false;

            if (file.originalname.endsWith('.gz')) {
                isCompressed = true;
                const compressed = fs.readFileSync(tempFilePath);
                const decompressed = await gunzip(compressed);
                sqlContent = decompressed.toString('utf-8');
            } else {
                sqlContent = fs.readFileSync(tempFilePath, 'utf-8');
            }

            if (!sqlContent.includes('CREATE TABLE') && !sqlContent.includes('INSERT INTO')) {
                throw new BadRequestException('Fichier SQL invalide ou corrompu');
            }

            this.logger.log('🔄 Création d\'un backup de sécurité avant restauration...');
            const safetyBackup = await this.createBackup();
            this.logger.log(`✅ Backup de sécurité créé: ${safetyBackup.fileName}`);

            await this.executeRestore(sqlContent);

            fs.unlinkSync(tempFilePath);

            return {
                success: true,
                message: 'Base de données restaurée avec succès',
                details: {
                    fileName: file.originalname,
                    fileSize: this.formatBytes(file.size),
                    isCompressed,
                    safetyBackup: safetyBackup.fileName,
                    restoredAt: new Date().toISOString(),
                },
            };
        } catch (error) {
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }

            this.logger.error(`❌ Erreur lors de la restauration: ${error.message}`);
            throw new BadRequestException(`Restauration échouée: ${error.message}`);
        }
    }

    // ⭐ Exécuter la restauration SQL AVEC nettoyage
    private async executeRestore(sqlContent: string): Promise<void> {
        const dbConfig = this.getDbConfig();
        this.logger.log(`🔌 Connexion à la base: ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
        const connection = await mysql.createConnection(dbConfig);

        try {
            await this.cleanDatabase(connection);

            await connection.execute('SET FOREIGN_KEY_CHECKS = 0');
            await connection.execute('SET UNIQUE_CHECKS = 0');
            await connection.execute('SET AUTOCOMMIT = 0');

            const queries = this.splitSqlQueries(sqlContent);
            this.logger.log(`📊 Nombre de requêtes à exécuter: ${queries.length}`);

            let successCount = 0;
            let errorCount = 0;
            const errors: string[] = [];

            for (const query of queries) {
                if (query.trim() && !query.trim().startsWith('--')) {
                    try {
                        await connection.execute(query);
                        successCount++;
                    } catch (err) {
                        errorCount++;
                        errors.push(`Erreur: ${err.message.substring(0, 100)}`);
                        if (errorCount % 50 === 0) {
                            this.logger.warn(`⚠️ ${errorCount} requêtes échouées...`);
                        }
                    }
                }
            }

            await connection.execute('COMMIT');
            await connection.execute('SET FOREIGN_KEY_CHECKS = 1');
            await connection.execute('SET UNIQUE_CHECKS = 1');

            this.logger.log(`✅ Restauration terminée: ${successCount} requêtes réussies, ${errorCount} échouées`);

        } catch (error) {
            this.logger.error(`❌ Erreur critique lors de la restauration: ${error.message}`);
            throw error;
        } finally {
            await connection.end();
        }
    }

    // Diviser le fichier SQL en requêtes individuelles
    private splitSqlQueries(sqlContent: string): string[] {
        const queries: string[] = [];
        let currentQuery = '';
        let inString = false;
        let stringChar = '';

        for (let i = 0; i < sqlContent.length; i++) {
            const char = sqlContent[i];
            const nextChar = sqlContent[i + 1];

            if ((char === "'" || char === '"') && (i === 0 || sqlContent[i - 1] !== '\\')) {
                if (!inString) {
                    inString = true;
                    stringChar = char;
                } else if (char === stringChar) {
                    inString = false;
                }
            }

            currentQuery += char;

            if (!inString && char === ';' && (i + 1 === sqlContent.length || sqlContent[i + 1] === '\n')) {
                if (currentQuery.trim()) {
                    queries.push(currentQuery.trim());
                }
                currentQuery = '';
            }
        }

        if (currentQuery.trim()) {
            queries.push(currentQuery.trim());
        }

        return queries;
    }

    // Backup automatique tous les jours à 02:00
    @Cron(CronExpression.EVERY_DAY_AT_2AM)
    async autoBackup() {
        this.logger.log('🔄 Démarrage du backup automatique...');
        try {
            const result = await this.createBackup();
            this.logger.log(`✅ Backup automatique réussi: ${result.fileName}`);
            await this.cleanOldBackups();
        } catch (error) {
            this.logger.error(`❌ Backup automatique échoué: ${error.message}`);
        }
    }

    async createBackup(): Promise<BackupResult> {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `backup-${timestamp}.sql`;
        const filePath = path.join(this.backupDir, fileName);

        try {
            const dbConfig = this.getDbConfig();
            const connection = await mysql.createConnection(dbConfig);

            const [tables] = await connection.execute('SHOW TABLES');
            const tableRows = tables as any[];

            let sqlContent = `-- Backup created at ${new Date().toISOString()}\n`;
            sqlContent += `-- Database: ${dbConfig.database}\n\n`;
            sqlContent += `SET FOREIGN_KEY_CHECKS = 0;\n\n`;

            for (const table of tableRows) {
                const tableName = Object.values(table)[0] as string;

                const [createTable] = await connection.execute(`SHOW CREATE TABLE \`${tableName}\``);
                const createStatement = (createTable as any[])[0]['Create Table'];
                sqlContent += `${createStatement};\n\n`;

                const [data] = await connection.execute(`SELECT * FROM \`${tableName}\``);
                const rows = data as any[];

                if (rows.length > 0) {
                    for (const row of rows) {
                        const columns = Object.keys(row).map(k => `\`${k}\``).join(',');
                        const values = Object.values(row).map(v => {
                            if (v === null) return 'NULL';
                            if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
                            if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
                            if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
                            return v;
                        }).join(',');

                        sqlContent += `INSERT INTO \`${tableName}\` (${columns}) VALUES (${values});\n`;
                    }
                    sqlContent += `\n`;
                }
            }

            sqlContent += `\nSET FOREIGN_KEY_CHECKS = 1;\n`;

            fs.writeFileSync(filePath, sqlContent);
            const stats = fs.statSync(filePath);

            await this.saveBackupHistory(fileName, stats.size);
            await connection.end();

            return {
                fileName,
                filePath,
                size: stats.size,
            };
        } catch (error) {
            this.logger.error(`❌ Erreur lors du backup: ${error.message}`);
            throw new BadRequestException(`Backup échoué: ${error.message}`);
        }
    }

    async createCompressedBackup(): Promise<BackupResult> {
        const backup = await this.createBackup();
        const gzipFileName = backup.fileName.replace('.sql', '.gz');
        const gzipFilePath = path.join(this.backupDir, gzipFileName);

        const sqlContent = fs.readFileSync(backup.filePath);
        const compressed = await gzip(sqlContent);

        fs.writeFileSync(gzipFilePath, compressed);
        const stats = fs.statSync(gzipFilePath);

        fs.unlinkSync(backup.filePath);
        await this.saveBackupHistory(gzipFileName, stats.size, true);

        return {
            fileName: gzipFileName,
            filePath: gzipFilePath,
            size: stats.size,
        };
    }

    private async saveBackupHistory(fileName: string, size: number, isCompressed: boolean = false) {
        const historyFile = path.join(this.backupDir, 'backup-history.json');
        let history: BackupHistoryItem[] = [];

        if (fs.existsSync(historyFile)) {
            try {
                const content = fs.readFileSync(historyFile, 'utf-8');
                history = JSON.parse(content);
            } catch (error) {
                this.logger.warn(`⚠️ Impossible de lire l'historique: ${error.message}`);
                history = [];
            }
        }

        history.unshift({
            fileName,
            size,
            sizeFormatted: this.formatBytes(size),
            isCompressed,
            createdAt: new Date().toISOString(),
        });

        history = history.slice(0, 50);
        fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
    }

    private async cleanOldBackups() {
        const files = fs.readdirSync(this.backupDir)
            .filter(f => f.endsWith('.sql') || f.endsWith('.gz'))
            .filter(f => f !== 'backup-history.json')
            .map(f => ({
                name: f,
                path: path.join(this.backupDir, f),
                mtime: fs.statSync(path.join(this.backupDir, f)).mtime,
            }))
            .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

        for (let i = this.maxBackups; i < files.length; i++) {
            fs.unlinkSync(files[i].path);
            this.logger.log(`Ancien backup supprimé: ${files[i].name}`);
        }
    }

    async getBackupsList(): Promise<{ success: boolean; data: BackupHistoryItem[]; total: number; backupDir: string }> {
        const historyFile = path.join(this.backupDir, 'backup-history.json');
        let history: BackupHistoryItem[] = [];

        if (fs.existsSync(historyFile)) {
            try {
                const content = fs.readFileSync(historyFile, 'utf-8');
                history = JSON.parse(content);
            } catch (error) {
                this.logger.warn(`⚠️ Impossible de lire l'historique: ${error.message}`);
                history = [];
            }
        }

        return {
            success: true,
            data: history,
            total: history.length,
            backupDir: this.backupDir,
        };
    }

    async restoreBackup(fileName: string): Promise<{ success: boolean; message: string }> {
        let filePath = path.join(this.backupDir, fileName);

        if (!fs.existsSync(filePath)) {
            throw new BadRequestException('Fichier de backup non trouvé');
        }

        let sqlContent: string;

        if (fileName.endsWith('.gz')) {
            const compressed = fs.readFileSync(filePath);
            const decompressed = await gunzip(compressed);
            sqlContent = decompressed.toString('utf-8');
        } else {
            sqlContent = fs.readFileSync(filePath, 'utf-8');
        }

        await this.executeRestore(sqlContent);

        return {
            success: true,
            message: 'Base de données restaurée avec succès',
        };
    }

    async downloadBackup(fileName: string): Promise<{ filePath: string; fileName: string }> {
        const filePath = path.join(this.backupDir, fileName);

        if (!fs.existsSync(filePath)) {
            throw new BadRequestException('Fichier non trouvé');
        }

        return { filePath, fileName };
    }

    async deleteBackup(fileName: string): Promise<{ success: boolean; message: string }> {
        const filePath = path.join(this.backupDir, fileName);

        if (!fs.existsSync(filePath)) {
            throw new BadRequestException('Fichier non trouvé');
        }

        fs.unlinkSync(filePath);

        const historyFile = path.join(this.backupDir, 'backup-history.json');
        if (fs.existsSync(historyFile)) {
            let history: BackupHistoryItem[] = [];
            try {
                const content = fs.readFileSync(historyFile, 'utf-8');
                history = JSON.parse(content);
            } catch (error) {
                this.logger.warn(`⚠️ Impossible de lire l'historique: ${error.message}`);
            }

            history = history.filter((h: BackupHistoryItem) => h.fileName !== fileName);
            fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
        }

        return {
            success: true,
            message: 'Backup supprimé avec succès',
        };
    }

    private formatBytes(bytes: number): string {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}