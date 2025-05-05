import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';

import { WhatsappService } from './whatsapp.service';
import { PendingConfirmation } from 'src/message/entities/message.entity';
import { WhatsappConnection } from './entities/whatsapp-connection.entity';

@Module({
  imports: [
    HttpModule,                                      
    TypeOrmModule.forFeature([
      PendingConfirmation,
      WhatsappConnection,                           
    ]),
  ],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}