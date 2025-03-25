import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { MessageModule } from './message/message.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    AuthModule, 
    MessageModule, 
    WhatsappModule, 
    ScheduleModule.forRoot(),
    HttpModule,
  ],
  controllers: [AppController], // Adicionando o AppController
  providers: [AppService], // AppService também precisa ser registrado
})
export class AppModule {}
