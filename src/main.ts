import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    snapshot: process.env.NODE_ENV === 'development' ? false : true,
    abortOnError: false,
  });

  // Configuração específica para desenvolvimento
  if (process.env.NODE_ENV === 'development') {
    app.enableShutdownHooks();
    app.use((req, res, next) => {
      res.header('X-Dev-Mode', 'active');
      next();
    });
  }

  process.on('uncaughtException', (err: Error) => {
    if (err.message.includes('EBUSY')) {
      Logger.warn(`Ignorado uncaughtException EBUSY: ${err.message}`);
      return;
    }
    Logger.error('Uncaught Exception:', err.stack || err);
    process.exit(1);
  });
  
  process.on('unhandledRejection', (reason: any) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (message.includes('EBUSY')) {
      Logger.warn(`Ignorado unhandledRejection EBUSY: ${message}`);
      return;
    }
    Logger.error('Unhandled Rejection:', reason);
    process.exit(1);
  });
  await app.listen(3002);
  console.log('API rodando na porta 3002');
}
bootstrap();