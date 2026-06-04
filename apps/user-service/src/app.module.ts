import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UserServiceModule } from './user-service.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    UserServiceModule,
  ],
})
export class AppModule {}
