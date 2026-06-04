import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ApiGatewayController } from './api-gateway.controller';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IpInterceptor } from './inrceptor/ip.interceptor';
import { JwtAuthGuard } from 'apps/auth-service/src/utility/guards/jwt-auth.guard';
import { I18nModule } from '@app/common';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'AUTH_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'auth_queue',
          queueOptions: { durable: false },
        },
      },
      {
        name: 'USER_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'user_queue',
          queueOptions: { durable: false },
        },
      },
      {
        name: 'WALLET_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'wallet_queue',
          queueOptions: { durable: false },
        },
      },
      {
        name: 'TRANSACTION_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'transaction_queue',
          queueOptions: { durable: false },
        },
      },
      {
        name: 'PAYMENT_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'payment_queue',
          queueOptions: { durable: false },
        },
      },
      {
        name: 'ACCESPAY_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'accespay_queue',
          queueOptions: { durable: false },
        },
      },
      {
        name: 'SETTINGS_CLIENT',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'settings_queue',
          queueOptions: { durable: false },
        },
      },
    ]),
    I18nModule,
  ],
  controllers: [ApiGatewayController],
  providers: [
    JwtAuthGuard,
    {
      provide: APP_INTERCEPTOR,
      useClass: IpInterceptor,
    },
  ],
})
export class ApiGatewayModule {}
