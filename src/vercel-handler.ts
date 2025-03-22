import { VercelApiHandler } from '@vercel/node';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

let cachedApp: any = null;

async function bootstrap() {
  if (!cachedApp) {
    const app = await NestFactory.create(AppModule);
    await app.init();
    cachedApp = app.getHttpAdapter().getInstance();
  }
  return cachedApp;
}

export const handler: VercelApiHandler = async (req, res) => {
  const app = await bootstrap();
  return app(req, res);
};

export default handler;
