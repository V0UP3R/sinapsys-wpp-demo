import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { MessageModule } from './message/message.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [AuthModule, MessageModule, WhatsappModule],
})
export class AppModule {}