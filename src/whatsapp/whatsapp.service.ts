import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client, LocalAuth } from 'whatsapp-web.js';
import { NlpManager } from 'node-nlp';
import puppeteer from 'puppeteer';
import { HttpService } from '@nestjs/axios';
import { PendingConfirmation } from 'src/message/entities/message.entity';
import { v4 as uuidv4 } from 'uuid';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class WhatsappService {
  private clients: Map<string, Client> = new Map();
  private nlpManager: NlpManager;
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(PendingConfirmation)
    private readonly pendingConfirmationRepo: Repository<PendingConfirmation>,
  ) {
    this.nlpManager = new NlpManager({ languages: ['pt'] });
    this.trainNlp();
  }

  /**
   * Gera o QR Code **antes** de inicializar de fato a sessão.
   */
  async getQrCodeUrl(userId: string): Promise<string> {
    // Se já temos cliente autenticado, não gera QR
    if (this.clients.has(userId)) {
      throw new Error('Sessão já aberta para este usuário');
    }

    const dataPath = `./whatsapp-sessions/${userId}`;
    const client = new Client({
      puppeteer: {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--single-process',
          '--disable-gpu',
        ],
        headless: true,
      },
      authStrategy: new LocalAuth({ dataPath }),
    });

    // Anexa listener de QR **antes** do initialize
    const qrPromise = new Promise<string>((resolve, reject) => {
      client.once('qr', qr => {
        const url = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300`;
        resolve(url);
      });
      setTimeout(() => reject(new Error('Timeout ao gerar QR')), 30000);
    });

    // Anexa events básicos
    client.on('ready', () => {
      this.logger.log(`[${userId}] Cliente pronto!`);
      this.clients.set(userId, client);
    });
    client.on('auth_failure', msg =>
      this.logger.error(`[${userId}] Falha na autenticação: ${msg}`),
    );
    client.on('disconnected', reason => {
      this.logger.warn(`[${userId}] Desconectado: ${reason}`);
      this.clients.delete(userId);
    });
    client.on('message', msg => this.handleMessage(userId, msg));

    // Dispara a inicialização
    client.initialize();

    return qrPromise;
  }

  /**
   * Envia mensagem — assume que a sessão já foi inicializada em getQrCodeUrl().
   */
  async sendMessage(
    userId: string,
    to: string,
    text: string,
    appointmentId: number,
  ) {
    const client = this.clients.get(userId);
    if (!client) {
      throw new Error('Sessão não iniciada. Chame primeiro /message/connect');
    }

    const formattedTo = this.formatNumber(to);
    const pending = this.pendingConfirmationRepo.create({
      id: uuidv4(),
      appointmentId,
      phone: formattedTo,
    });
    await this.pendingConfirmationRepo.save(pending);

    try {
      return await client.sendMessage(formattedTo, text);
    } catch (error) {
      this.logger.error('Erro ao enviar mensagem:', error);
      if (error.message.includes('Session closed')) {
        this.logger.warn('Sessão fechada, removendo client e solicitando nova connect...');
        this.clients.delete(userId);
      }
      throw error;
    }
  }

  private async handleMessage(userId: string, message: any) {
    this.logger.log(`[${userId}] Mensagem recebida: ${message.body}`);
    const confirmation = await this.pendingConfirmationRepo.findOne({
      where: { phone: message.from },
    });
    if (!confirmation) return;

    const response = await this.nlpManager.process(
      'pt',
      this.normalizeText(message.body),
    );

    if (response.intent === 'confirmar' && response.score > 0.8) {
      await firstValueFrom(
        this.httpService.patch(
          `http://localhost:3001/appointment/${confirmation.appointmentId}`,
          { appointmentStatus: 'Confirmado' },
          { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
        ),
      );
      await this.clients.get(userId).sendMessage(
        message.from,
        'Confirmei seu atendimento! 😁',
      );
      await this.pendingConfirmationRepo.delete({
        phone: message.from,
      });
    } else if (response.intent === 'cancelar' && response.score > 0.8) {
      await firstValueFrom(
        this.httpService.patch(
          `http://localhost:3001/appointment/${confirmation.appointmentId}`,
          {
            appointmentStatus: 'Cancelado',
            reasonLack: 'Cancelado pelo WhatsApp',
          },
          { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
        ),
      );
      await this.clients.get(userId).sendMessage(
        message.from,
        'Cancelei seu atendimento! 😁',
      );
      await this.pendingConfirmationRepo.delete({
        phone: message.from,
      });
    } else {
      this.logger.log('Resposta não clara. Nenhuma ação tomada.');
    }
  }

  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  private async trainNlp() {
    const confirmExamples = [
      "sim", "confirmo", "está ok", "ok", "certo", "claro", "afirmativo",
      "estou de acordo", "com certeza", "acordo", "isso mesmo", "vou confirmar",
      "confirmar atendimento", "tudo certo", "concordo", "confirmado",
      "sim, pode confirmar", "por favor, confirme", "eu confirmo",
      "afirma sim", "com certeza, confirma", "sem duvidas, confirmo",
      "estou de acordo, pode prosseguir", "confirmado, prossiga", "quero", "desejo", "desejo confirmar"
    ];
    const cancelExamples = [
      "não", "não quero", "cancela", "cancelado", "impossivel", "recuso",
      "negativo", "não concordo", "não aceita", "não posso confirmar",
      "não desejo", "cancela atendimento", "deixa pra lá", "nem pensar",
      "não vou", "cancelar", "não, cancele", "por favor, cancele",
      "não quero confirmar", "cancelar o atendimento", "não, obrigado",
      "não, recuso", "não, não concordo", "cancelado, por favor interrompa", "pare, não quero"
    ];

    confirmExamples.forEach(ex =>
      this.nlpManager.addDocument('pt', this.normalizeText(ex), 'confirmar'),
    );
    cancelExamples.forEach(ex =>
      this.nlpManager.addDocument('pt', this.normalizeText(ex), 'cancelar'),
    );
    this.nlpManager.addDocument('pt', 'não entendi', 'fallback');
    this.nlpManager.addDocument('pt', 'pode repetir', 'fallback');

    this.logger.log('Treinando NLP...');
    await this.nlpManager.train();
    this.nlpManager.save();
    this.logger.log('NLP treinado.');
  }

  private formatNumber(number: string): string {
    return number.replace('+', '') + '@c.us';
  }
}
