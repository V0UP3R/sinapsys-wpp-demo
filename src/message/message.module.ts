import { Module } from '@nestjs/common';
import { MessageController } from './message.controller';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [WhatsappModule],
  controllers: [MessageController],
})
export class MessageModule {}