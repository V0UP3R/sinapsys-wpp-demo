import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  public client: Redis;

  onModuleInit() {
    const connectionString = process.env.URL_REDIS;
    if (!connectionString) {
      this.logger.error('A variável de ambiente URL_REDIS não está definida.');
      // Não lançar erro aqui para não quebrar a aplicação se o Redis não estiver configurado,
      // mas o serviço não funcionará corretamente.
      return;
    }

    const useTls = process.env.REDIS_TLS === 'true';
    const protocol = useTls ? 'rediss://' : 'redis://';

    const finalConnectionString =
      !connectionString.startsWith('redis://') &&
        !connectionString.startsWith('rediss://')
        ? `${protocol}${connectionString}`
        : connectionString;

    try {
      const redisUrl = new URL(finalConnectionString);

      const options: any = {
        host: redisUrl.hostname,
        port: parseInt(redisUrl.port, 10) || 6379,
        password: redisUrl.password || undefined,
        retryStrategy: (times) => {
          // Retry connection logic
          const delay = Math.min(times * 50, 2000);
          return delay;
        }
      };

      if (useTls) {
        options.tls = { rejectUnauthorized: false };
      }

      this.logger.log(`Conectando ao Redis em ${options.host}:${options.port} (TLS: ${useTls})`);
      this.client = new Redis(options);

      this.client.on('connect', () => {
        this.logger.log('Conectado ao Redis com sucesso!');
      });

      this.client.on('error', (err) => {
        this.logger.error('Erro na conexão com Redis:', err);
      });
    } catch (error) {
      this.logger.error(`Erro ao configurar conexão Redis: ${error.message}`);
    }
  }

  onModuleDestroy() {
    if (this.client) {
      this.client.disconnect();
    }
  }
}
