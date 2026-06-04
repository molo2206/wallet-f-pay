import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateGeneralSettingsDto } from './dto/update-general-settings.dto';

@Injectable()
export class GeneralSettingsService implements OnModuleInit {
  private readonly logger = new Logger(GeneralSettingsService.name);
  private readonly SINGLETON_ID = '1';

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    // Crée l'enregistrement par défaut s'il n'existe pas
    await this.prisma.general_settings.upsert({
      where: { id: this.SINGLETON_ID },
      update: {},
      create: {
        id: this.SINGLETON_ID,
        platform_name: 'MoneyXchange',
        timezone: 'Africa/Lubumbashi',
        date_format: 'DD/MM/YYYY',
        time_format: '24h',
        maintenance_mode: false,
      },
    });
    this.logger.log('General settings initialized');
  }

  async getSettings() {
    return this.prisma.general_settings.findUnique({
      where: { id: this.SINGLETON_ID },
    });
  }

  async updateSettings(dto: UpdateGeneralSettingsDto) {
    this.logger.log(`Updating settings: ${JSON.stringify(dto)}`);
    // Utiliser upsert pour garantir l'existence de l'enregistrement
    const result = await this.prisma.general_settings.upsert({
      where: { id: this.SINGLETON_ID },
      update: dto,
      create: {
        id: this.SINGLETON_ID,
        ...dto,
        platform_name: dto.platform_name ?? 'MoneyXchange',
        timezone: dto.timezone ?? 'Africa/Lubumbashi',
        date_format: dto.date_format ?? 'DD/MM/YYYY',
        time_format: dto.time_format ?? '24h',
        maintenance_mode: dto.maintenance_mode ?? false,
      },
    });
    this.logger.log(`Settings updated: ${JSON.stringify(result)}`);
    return result;
  }
}
