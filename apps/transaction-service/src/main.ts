import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { TransactionServiceModule } from './transaction-service.module';
import * as dotenv from 'dotenv';

dotenv.config();

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    TransactionServiceModule,
    {
      transport: Transport.TCP,
      options: {
        host: 'localhost',
        port: parseInt(process.env.TRANSACTION_SERVICE_PORT || '3004', 10),
      },
    },
  );

  await app.listen();
  console.log(
    `Transaction Service running on TCP port ${process.env.TRANSACTION_SERVICE_PORT || 3004}`,
  );
}

bootstrap();
