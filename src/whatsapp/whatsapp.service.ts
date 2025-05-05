import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import venom, { create, Whatsapp } from 'venom-bot';
import { HttpService } from '@nestjs/axios';
import { PendingConfirmation } from 'src/message/entities/message.entity';
import { v4 as uuidv4 } from 'uuid';
import { firstValueFrom } from 'rxjs';
import { confirmExamples, cancelExamples } from './nlp.train';
import { WhatsappConnection } from './entities/whatsapp-connection.entity';
import { NlpManager } from 'node-nlp';

@Injectable()
export class WhatsappService implements OnModuleDestroy {
  private sessions = new Map<string, Whatsapp>();
  private nlpManager = new NlpManager({ languages: ['pt'] });
  private readonly logger = new Logger(WhatsappService.name);

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

  async onModuleDestroy() {
    for (const sessionId of this.sessions.keys()) {
      await this.disconnect(sessionId);
    }
  }

  async onModuleInit() {
    const conns = await this.connRepo.find({ where: { status: 'connected' } });
    for (const conn of conns) {
      await this.restoreSession(conn.phoneNumber);
    }
  }

  private async restoreSession(phone: string) {
    const sessionName = phone;
    try {
      const client = await create(
        sessionName,
        // --- QR callback (não vai ser chamado, pois já existe token) ---
        () => {},
        // --- status callback só para registrar reconexão ---
        async (statusSession) => {
          if (statusSession === 'successChat') {
            this.logger.log(`Reconnected session for ${phone}`);
          }
        },
        {
          headless: 'new',
          browserArgs: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-zygote',
          ],
          session: sessionName,
        },
      );
      // Re-registrar seus handlers de mensagens/estado
      client.onStateChange(state => this.handleState(phone, state));
      client.onStreamChange(stream => this.logger.log(`Stream: ${stream}`));
      client.onMessage(msg => this.handleIncoming(phone, msg));
      // Finalmente, armazenar na memória
      this.sessions.set(phone, client);
      this.logger.log(`Session restored for ${phone}`);
    } catch (err) {
      this.logger.error(`Erro ao restaurar sessão ${phone}: ${err.message}`);
    }
  }

  private gracefulShutdown() {
    this.logger.warn('Graceful shutdown...');
    this.onModuleDestroy()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  }

  /**
   * Conecta e retorna a URL do QR Code para escaneamento
   */
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
          /**
           * base64Qr: base64 PNG image; asciiQR: raw QR data string
           */
          async (base64Qr, asciiQR, attempt, urlCode) => {
            // Usa raw QR data para gerar URL no api.qrserver
            const qrData = urlCode || asciiQR;
            const url = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qrData)}&size=300x300`;
            await this.connRepo.update(conn.id, { qrCodeUrl: url });
            resolve(url);
          },
          async (statusSession, session) => {
            console.log('Status Session: ', statusSession); //return isLogged || notLogged || browserClose || qrReadSuccess || qrReadFail || autocloseCalled || desconnectedMobile || deleteToken || chatsAvailable || deviceNotConnected || serverWssNotConnected || noOpenBrowser || initBrowser || openBrowser || connectBrowserWs || initWhatsapp || erroPageWhatsapp || successPageWhatsapp || waitForLogin || waitChat || successChat
            //Create session wss return "serverClose" case server for close
            if (statusSession === 'successChat') {
              await this.connRepo.update(
                { phoneNumber: phone },
                { status: 'connected', qrCodeUrl: null },
              );
            }
            console.log('Session name: ', session);
          },
          {
            headless: 'new',      // formato aceito pelo Venom
            browserArgs: [        // argumentos do Chromium
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--no-first-run',
              '--no-zygote',
            ],
            session: sessionName,
          },
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

  private async handleState(phone: string, state: string) {
    this.logger.log(`[${phone}] State: ${state}`);
    // Estados que indicam desconexão ou remoção de pareamento
    const cleanupStates = [
      'DISCONNECTED',
      'SYNC_CLOSED',
      'UNPAIRED',
      'CONFLICT',
    ];
    if (cleanupStates.includes(state)) {
      this.logger.log(
        `Estado ${state} detectado para ${phone}, removendo sessão e registro no DB`,
      );
      // Remove sessão em memória e registro no banco
      await this.disconnect(phone);
      await this.connRepo.delete({ phoneNumber: phone });
    }
    if (['DISCONNECTED', 'SYNC_CLOSED'].includes(state)) {
      await this.disconnect(phone);
    }
  }

  async disconnect(phone: string) {
    const client = this.sessions.get(phone);
    if (client) {
      try {
        await client.logout();
      } catch (e) {
        this.logger.warn(`Logout failed for ${phone}: ${e.message}`);
      }
      await client.close();
    }
    this.sessions.delete(phone);
    await this.connRepo.delete({ phoneNumber: phone });
  }

  async getStatus(phone: string): Promise<string> {
    const conn = await this.connRepo.findOne({ where: { phoneNumber: phone } });
    return conn?.status || 'not-found';
  }

  async sendMessage(
    phone: string,
    to: string,
    text: string,
    appointmentId: number,
  ) {
    const client = this.sessions.get(phone);
    if (!client) throw new Error('Client not connected');
    const formatted = to.replace('+', '') + '@c.us';
    const pending = this.pendingRepo.create({
      id: uuidv4(),
      appointmentId,
      phone: formatted,
    });
    await this.pendingRepo.save(pending);
    return client.sendText(formatted, text);
  }

  private async handleIncoming(phone: string, message: venom.Message) {
    this.logger.log(`[${phone}] Received: ${message.body}`);
    const confirmation = await this.pendingRepo.findOne({
      where: { phone: message.from },
    });
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
    await firstValueFrom(
      this.httpService.patch(
        `http://localhost:3001/appointment/${conf.appointmentId}`,
        { appointmentStatus: 'Confirmado' },
        { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
      ),
    );
    await this.sessions
      .get(phone)
      ?.sendText(from, 'Confirmei seu atendimento! 😁');
    await this.pendingRepo.delete({ id: conf.id });
  }

  private async cancel(conf: any, phone: string, from: string) {
    await firstValueFrom(
      this.httpService.patch(
        `http://localhost:3001/appointment/${conf.appointmentId}`,
        {
          appointmentStatus: 'Cancelado',
          reasonLack: 'Cancelado pelo WhatsApp',
        },
        { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
      ),
    );
    await this.sessions
      .get(phone)
      ?.sendText(from, 'Cancelei seu atendimento! 😁');
    await this.pendingRepo.delete({ id: conf.id });
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
    confirmExamples.forEach((ex) =>
      this.nlpManager.addDocument('pt', this.normalize(ex), 'confirmar'),
    );
    cancelExamples.forEach((ex) =>
      this.nlpManager.addDocument('pt', this.normalize(ex), 'cancelar'),
    );
    this.nlpManager.addDocument('pt', 'não entendi', 'fallback');
    this.nlpManager.addDocument('pt', 'pode repetir', 'fallback');
    this.logger.log('Training NLP...');
    await this.nlpManager.train();
    this.nlpManager.save();
    this.logger.log('NLP trained');
  }
}
