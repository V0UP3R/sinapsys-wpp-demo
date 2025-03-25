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

@Module({
  imports: [
    AuthModule, 
    MessageModule, 
    WhatsappModule, 
    ScheduleModule.forRoot(),
    HttpModule,
    TypeOrmModule.forRoot({
      type: 'postgres', // ou outro banco suportado
      url: process.env.DATABASE_URL, // Connection string aqui
      autoLoadEntities: true,
      synchronize: false, // Mantenha false em produção
    }),
    TypeOrmModule.forFeature([PendingConfirmation]),
  ],
  controllers: [AppController], // Adicionando o AppController
  providers: [AppService], // AppService também precisa ser registrado
})
export class AppModule {}
