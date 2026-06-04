import { Module } from '@nestjs/common';
import { SettingsModule } from './settings.module';
import { SettingsServiceController } from './settings-service.controller';

@Module({
  imports: [SettingsModule],
  controllers: [SettingsServiceController],
})
export class SettingsServiceModule {}
