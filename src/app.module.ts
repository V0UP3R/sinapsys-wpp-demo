import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { MessageModule } from './message/message.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PendingConfirmation } from './message/entities/message.entity';
import { ConfigModule } from '@nestjs/config';

function isDatabaseSslEnabled() {
  const rawValue = process.env.DATABASE_SSL?.trim().toLowerCase();

  if (rawValue === 'true' || rawValue === '1' || rawValue === 'require') {
    return true;
  }

  if (rawValue === 'false' || rawValue === '0' || rawValue === 'disable') {
    return false;
  }

  return process.env.NODE_ENV === 'production';
}

const databaseSsl = isDatabaseSslEnabled()
  ? {
      rejectUnauthorized: false,
    }
  : undefined;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    AuthModule, 
    MessageModule, 
    WhatsappModule, 
    ScheduleModule.forRoot(),
    HttpModule,
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      ssl: databaseSsl,
      extra: databaseSsl
        ? {
            ssl: databaseSsl,
          }
        : undefined,
      autoLoadEntities: true,
      synchronize: false,
    }),
    TypeOrmModule.forFeature([PendingConfirmation]),
  ],
  controllers: [AppController], // Adicionando o AppController
  providers: [AppService], // AppService também precisa ser registrado
})
export class AppModule {}
