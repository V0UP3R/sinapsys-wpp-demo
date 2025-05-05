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

  await app.listen(3002);
  console.log('API rodando na porta 3002');
}
bootstrap();