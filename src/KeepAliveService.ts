import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';

@Injectable()
export class KeepAliveService {
  private readonly logger = new Logger(KeepAliveService.name);

  constructor(private readonly httpService: HttpService) {}

  @Cron('*/10 * * * * *') // Executa a cada 10 segundos
  async keepServerAlive() {
    try {
      const url = 'http://localhost:3000/health'; // Ajuste a URL se necessário
      await lastValueFrom(this.httpService.get(url));
      this.logger.log(`Keep-alive request sent to ${url}`);
    } catch (error) {
      this.logger.error('Failed to send keep-alive request', error);
    }
  }
}