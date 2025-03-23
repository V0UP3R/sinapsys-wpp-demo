import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { MessageModule } from './message/message.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { ScheduleModule } from '@nestjs/schedule';
import { KeepAliveService } from './KeepAliveService';

@Module({
  imports: [AuthModule, MessageModule, WhatsappModule,ScheduleModule.forRoot()],
  providers: [KeepAliveService],
})
export class AppModule {}