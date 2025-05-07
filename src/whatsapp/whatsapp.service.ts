import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { create, Whatsapp } from 'venom-bot';
import { HttpService } from '@nestjs/axios';
import { PendingConfirmation } from 'src/message/entities/message.entity';
import { v4 as uuidv4 } from 'uuid';
import { firstValueFrom } from 'rxjs';
import { confirmExamples, cancelExamples } from './nlp.train';
import { WhatsappConnection } from './entities/whatsapp-connection.entity';
import { NlpManager } from 'node-nlp';

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private sessions = new Map<string, Whatsapp>();
  private nlpManager = new NlpManager({ languages: ['pt'] });
  private readonly logger = new Logger(WhatsappService.name);

  // Paths para Chrome/Chromium cross-platform
  private readonly defaultChromeLinux = '/usr/bin/google-chrome-stable';
  private readonly defaultChromeWin = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(PendingConfirmation)
    private readonly pendingRepo: Repository<PendingConfirmation>,
    @InjectRepository(WhatsappConnection)
    private readonly connRepo: Repository<WhatsappConnection>,
  ) {
    this.trainNlp();
    if (process.env.NODE_ENV === 'development') {
      this.logger.debug('Dev mode - special controls enabled');
      process.on('SIGINT', () => this.gracefulShutdown());
    }
  }

  async onModuleInit() {
    const conns = await this.connRepo.find({ where: { status: 'connected' } });
    for (const conn of conns) {
      await this.restoreSession(conn.phoneNumber);
    }
  }

  async onModuleDestroy() {
    for (const sessionId of this.sessions.keys()) {
      await this.disconnect(sessionId);
    }
  }

  private getSessionOptions(sessionName: string) {
    const options: Record<string, any> = {
      headless: 'new',
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-zygote',
      ],
      session: sessionName,
    };
    if (process.platform !== 'win32') {
      options.executablePath = this.defaultChromeLinux;
    }
    return options;
  }

  private async restoreSession(phone: string) {
    const sessionName = phone;
    try {
      const client = await create(
        sessionName,
        () => {}, 
        async (statusSession) => {
          if (statusSession === 'successChat') {
            this.logger.log(`Reconnected session for ${phone}`);
          }
        },
        this.getSessionOptions(sessionName),
      );
      client.onStateChange(state => this.handleState(phone, state));
      client.onStreamChange(stream => this.logger.log(`Stream: ${stream}`));
      client.onMessage(msg => this.handleIncoming(phone, msg));
      this.sessions.set(phone, client);
      this.logger.log(`Session restored for ${phone}`);
    } catch (err) {
      this.logger.error(`Erro ao restaurar sessão ${phone}: ${err.message}`);
    }
  }

  async connect(phone: string): Promise<string> {
    let conn = await this.connRepo.findOne({ where: { phoneNumber: phone } });
    if (!conn) {
      conn = this.connRepo.create({ phoneNumber: phone });
      conn = await this.connRepo.save(conn);
    }
    if (this.sessions.has(phone)) {
      await this.disconnect(phone);
    }

    const sessionName = phone;
    const qrPromise = new Promise<string>(async (resolve, reject) => {
      try {
        const client = await create(
          sessionName,
          async (base64Qr, asciiQR, attempt, urlCode) => {
            const qrData = urlCode || asciiQR;
            const url = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qrData)}&size=300x300`;
            await this.connRepo.update(conn.id, { qrCodeUrl: url });
            resolve(url);
          },
          async (statusSession, session) => {
            if (statusSession === 'successChat') {
              await this.connRepo.update(
                { phoneNumber: phone },
                { status: 'connected', qrCodeUrl: null },
              );
            }
          },
          this.getSessionOptions(sessionName),
        );

        client.onStateChange((state) => this.handleState(phone, state));
        client.onStreamChange((status) => this.logger.log(`Stream: ${status}`));
        client.onMessage((message) => this.handleIncoming(phone, message));
        this.sessions.set(phone, client);
      } catch (err) {
        this.logger.error(`Erro ao criar sessão Venom para ${phone}: ${err.message}`, err.stack);
        reject(err);
      }
    });

    return qrPromise;
  }

  private gracefulShutdown() {
    this.logger.warn('Graceful shutdown...');
    this.onModuleDestroy()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  }

  private async handleState(phone: string, state: string) {
    this.logger.log(`[${phone}] State: ${state}`);
    const cleanupStates = ['DISCONNECTED', 'SYNC_CLOSED', 'UNPAIRED', 'CONFLICT'];
    if (cleanupStates.includes(state)) {
      this.logger.log(`Estado ${state} detectado para ${phone}, removendo sessão e DB`);
      await this.disconnect(phone);
      await this.connRepo.delete({ phoneNumber: phone });
    }
  }

  async disconnect(phone: string) {
    const client = this.sessions.get(phone);
    if (client) {
      try { await client.logout(); } catch (e) { this.logger.warn(`Logout failed for ${phone}: ${e.message}`); }
      await client.close();
    }
    this.sessions.delete(phone);
    await this.connRepo.delete({ phoneNumber: phone });
  }

  async getStatus(phone: string): Promise<string> {
    const conn = await this.connRepo.findOne({ where: { phoneNumber: phone } });
    return conn?.status || 'not-found';
  }

  async sendMessage(phone: string, to: string, text: string, appointmentId: number) {
    const client = this.sessions.get(phone);
    if (!client) throw new Error('Client not connected');
    const formatted = to.replace('+', '') + '@c.us';
    const pending = this.pendingRepo.create({ id: uuidv4(), appointmentId, phone: formatted });
    await this.pendingRepo.save(pending);
    return client.sendText(formatted, text);
  }

  private async handleIncoming(phone: string, message: any) {
    this.logger.log(`[${phone}] Received: ${message.body}`);
    const confirmation = await this.pendingRepo.findOne({ where: { phone: message.from } });
    if (!confirmation) return;
    const normalized = this.normalize(message.body);
    const response = await this.nlpManager.process('pt', normalized);
    if (response.intent === 'confirmar' && response.score > 0.8) {
      await this.confirm(confirmation, phone, message.from);
    } else if (response.intent === 'cancelar' && response.score > 0.8) {
      await this.cancel(confirmation, phone, message.from);
    }
  }

  private async confirm(conf: any, phone: string, from: string) {
    const { data } = await this.getUserId(conf.appointmentId);
    await firstValueFrom(
      this.httpService.patch(
        `http://localhost:3001/appointment/${conf.appointmentId}`,
        { appointmentStatus: 'Confirmado', userId: data.userId },
        { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
      ),
    );
    await this.sessions.get(phone)?.sendText(from, 'Confirmei seu atendimento! 😁');
    await this.pendingRepo.delete({ id: conf.id });
  }

  private async cancel(conf: any, phone: string, from: string) {
    const { data } = await this.getUserId(conf.appointmentId);
    await firstValueFrom(
      this.httpService.patch(
        `http://localhost:3001/appointment/${conf.appointmentId}`,
        { appointmentStatus: 'Cancelado', reasonLack: 'Cancelado pelo WhatsApp', userId: data.userId },
        { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
      ),
    );
    await this.sessions.get(phone)?.sendText(from, 'Cancelei seu atendimento! 😁');
    await this.pendingRepo.delete({ id: conf.id });
  }

  private async getUserId(id:number){
    return await firstValueFrom(
      this.httpService.get(
        `http://localhost:3001/appointment/find/user/appointment/${id}`,
        { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
      ),
    );
  }

  private normalize(text: string) {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-\u036f]/g, '')
      .replace(/[^\w\s]/gi, '')
      .trim();
  }

  private async trainNlp() {
    confirmExamples.forEach(ex => this.nlpManager.addDocument('pt', this.normalize(ex), 'confirmar'));
    cancelExamples.forEach(ex => this.nlpManager.addDocument('pt', this.normalize(ex), 'cancelar'));
    this.nlpManager.addDocument('pt', 'não entendi', 'fallback');
    this.nlpManager.addDocument('pt', 'pode repetir', 'fallback');
    this.logger.log('Training NLP...');
    await this.nlpManager.train();
    this.nlpManager.save();
    this.logger.log('NLP trained');
  }
}
