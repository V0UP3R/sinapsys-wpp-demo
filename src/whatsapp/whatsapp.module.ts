import { Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { HttpModule, HttpService } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PendingConfirmation } from 'src/message/entities/message.entity';

@Module({
  imports: [
    HttpModule.register({
      timeout: 60000
    }),
    TypeOrmModule.forFeature([PendingConfirmation]),
  ],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
