import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthServiceModule } from './auth-service.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), AuthServiceModule],
})
export class AppModule {}
