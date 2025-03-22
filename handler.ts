// handler.ts
import { NestFactory } from '@nestjs/core';
import * as serverless from 'serverless-http';
import { ExpressAdapter } from '@nestjs/platform-express';
import * as express from 'express';
import { AppModule } from './src/app.module';

const expressApp = express();
let cachedHandler: any = null;

async function bootstrapServer() {
  if (!cachedHandler) {
    // Cria a aplicação NestJS utilizando o adaptador do Express
    const app = await NestFactory.create(AppModule, new ExpressAdapter(expressApp));
    await app.init();
    // Converte o app Express em um handler serverless
    cachedHandler = serverless(expressApp);
  }
  return cachedHandler;
}

export const handler = async (event: any, context: any) => {
  const server = await bootstrapServer();
  return server(event, context);
};