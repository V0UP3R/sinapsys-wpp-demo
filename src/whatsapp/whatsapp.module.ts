import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';

import { WhatsappService } from './whatsapp.service';
import { PendingConfirmation } from '../message/entities/message.entity';
import { WhatsappConnection } from './entities/whatsapp-connection.entity';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    HttpModule,
    TypeOrmModule.forFeature([
      PendingConfirmation,
      WhatsappConnection,
    ]),
    RedisModule,
  ],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule { }