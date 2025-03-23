import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { MessageModule } from './message/message.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { ScheduleModule } from '@nestjs/schedule';
import { KeepAliveService } from './KeepAliveService';
import { HttpModule } from '@nestjs/axios';

@Module({
  imports: [AuthModule, MessageModule, WhatsappModule,ScheduleModule.forRoot(),HttpModule.register({}),],
  providers: [KeepAliveService],
})
export class AppModule {}