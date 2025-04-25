import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client, LocalAuth } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import { NlpManager } from 'node-nlp';
import puppeteer from 'puppeteer';
import { HttpService } from '@nestjs/axios';
import { PendingConfirmation } from 'src/message/entities/message.entity';
import { v4 as uuidv4 } from 'uuid';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class WhatsappService implements OnModuleInit {
  private clients: Map<string, Client> = new Map();
  private nlpManager: NlpManager;
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(PendingConfirmation)
    private readonly pendingConfirmationRepo: Repository<PendingConfirmation>,
  ) {
    // Inicializa NLP
    this.nlpManager = new NlpManager({ languages: ['pt'] });
    this.trainNlp();
  }

  /** Inicialização apenas para implementar OnModuleInit */
  onModuleInit() {
    this.logger.log('WhatsappService carregado.');
  }

  /** Obtém ou cria um Client para o usuário */
  private async getClient(userId: string): Promise<Client> {
    if (this.clients.has(userId)) {
      return this.clients.get(userId);
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

    client.on('qr', qr => {
      this.logger.log(`[${userId}] QR gerado: ${qr}`);
    });
    client.on('ready', () => {
      this.logger.log(`[${userId}] Cliente pronto!`);
    });
    client.on('auth_failure', msg => {
      this.logger.error(`[${userId}] Falha na autenticação: ${msg}`);
    });
    client.on('disconnected', reason => {
      this.logger.warn(`[${userId}] Desconectado: ${reason}`);
      this.clients.delete(userId);
    });
    client.on('message', message => this.handleMessage(userId, message));

    await client.initialize();
    this.clients.set(userId, client);
    return client;
  }

  /** Gera a URL do QR code para o front */
  async getQrCodeUrl(userId: string): Promise<string> {
    const client = await this.getClient(userId);
    return new Promise((resolve, reject) => {
      client.once('qr', qr => {
        const url = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300`;
        resolve(url);
      });
      setTimeout(() => reject(new Error('Timeout ao gerar QR')), 30000);
    });
  }

  /** Envia mensagem e registra confirmação */
  async sendMessage(
    userId: string,
    to: string,
    text: string,
    appointmentId: number,
  ) {
    const client = await this.getClient(userId);
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
        this.logger.warn('Reinicializando cliente...');
        this.clients.delete(userId);
        await this.getClient(userId);
      }
    }
  }

  /** Processa mensagens recebidas */
  private async handleMessage(userId: string, message: any) {
    this.logger.log(`[${userId}] Mensagem recebida: ${message.body}`);
    const confirmation = await this.pendingConfirmationRepo.findOne({
      where: { phone: message.from },
    });
    if (!confirmation) return;

    const response = await this.nlpManager.process('pt', this.normalizeText(message.body));
    if (response.intent === 'confirmar' && response.score > 0.8) {
      await firstValueFrom(
        this.httpService.patch(
          `http://localhost:3001/appointment/${confirmation.appointmentId}`,
          { appointmentStatus: 'Confirmado' },
          { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
        ),
      );
      await this.clients.get(userId).sendMessage(message.from, 'Confirmei seu atendimento! 😁');
      await this.pendingConfirmationRepo.delete({ phone: message.from });
    } else if (response.intent === 'cancelar' && response.score > 0.8) {
      await firstValueFrom(
        this.httpService.patch(
          `http://localhost:3001/appointment/${confirmation.appointmentId}`,
          { appointmentStatus: 'Cancelado', reasonLack: 'Cancelado pelo WhatsApp' },
          { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
        ),
      );
      await this.clients.get(userId).sendMessage(message.from, 'Cancelei seu atendimento!');
      await this.pendingConfirmationRepo.delete({ phone: message.from });
    } else {
      this.logger.log('Resposta não clara. Nenhuma ação tomada.');
    }
  }

  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-\u036f]/g, '')
      .trim();
  }

  private async trainNlp() {
    const confirmExamples = [/* ... */];
    confirmExamples.forEach(ex => this.nlpManager.addDocument('pt', this.normalizeText(ex), 'confirmar'));
    const cancelExamples = [/* ... */];
    cancelExamples.forEach(ex => this.nlpManager.addDocument('pt', this.normalizeText(ex), 'cancelar'));
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
