import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import { NlpManager } from 'node-nlp';
import { HttpService } from '@nestjs/axios';
import { PendingConfirmation } from 'src/message/entities/message.entity';
import { v4 as uuidv4 } from 'uuid';
import { firstValueFrom } from 'rxjs';
import { confirmExamples, cancelExamples } from './nlp.train';
import { WhatsappConnection } from './entities/whatsapp-connection.entity';
import { rm } from 'fs/promises';
import { join } from 'path';

@Injectable()
export class WhatsappService implements OnModuleDestroy {
  private clients = new Map<string, Client>();
  private nlpManager = new NlpManager({ languages: ['pt'] });
  private readonly logger = new Logger(WhatsappService.name);
  private readonly SESSION_TIMEOUT = 30000;
  private qrTimeouts = new Map<string, NodeJS.Timeout>();
  private cleaningLocks = new Set<string>();
  private sessionWatcher: NodeJS.Timeout;

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(PendingConfirmation)
    private readonly pendingConfirmationRepo: Repository<PendingConfirmation>,
    @InjectRepository(WhatsappConnection)
    private readonly connectionRepo: Repository<WhatsappConnection>,
  ) {
    this.trainNlp();
    this.initSessionWatcher();

    if (process.env.NODE_ENV === 'development') {
      this.logger.debug('Modo desenvolvimento - Controles especiais ativados');
      process.on('SIGINT', () => this.gracefulShutdown());
    }
  }

  private initSessionWatcher() {
    this.sessionWatcher = setInterval(async () => {
      for (const [phone, client] of this.clients.entries()) {
        try {
          if (client.pupPage?.isClosed()) {
            await this.disconnectSingleSession(phone);
          }
        } catch (err) {
          this.logger.error(`Erro no sessionWatcher ao desconectar ${phone}:`, err);
        }
      }
    }, 5000);
  }

  async onModuleDestroy() {
    clearInterval(this.sessionWatcher);
    await this.cleanupAllConnections();
  }

  private async cleanupAllConnections() {
    const cleanupPromises = Array.from(this.clients.keys()).map(phone => 
      this.cleanupConnection(phone)
    );
    await Promise.allSettled(cleanupPromises);
  }

  private gracefulShutdown() {
    this.logger.warn('Iniciando desligamento gracioso...');
    this.onModuleDestroy()
      .then(() => process.exit(0))
      .catch(err => {
        this.logger.error('Erro no desligamento gracioso', err);
        process.exit(1);
      });
  }

  async connect(phone: string): Promise<string | null> {
    if (this.cleaningLocks.has(phone)) {
      throw new Error(`Sessão ${phone} está em processo de limpeza`);
    }

    let conn = await this.connectionRepo.findOne({ where: { phoneNumber: phone } });
    if (!conn) {
      conn = this.connectionRepo.create({ phoneNumber: phone });
      await this.connectionRepo.save(conn);
    }

    await this.disconnectSingleSession(phone);

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: phone, dataPath: `./.wwebjs_auth/${phone}` }),
      puppeteer: { 
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process'
        ]
      },
    });

    return this.initializeClient(phone, client, conn);
  }

  private async initializeClient(phone: string, client: Client, conn: WhatsappConnection): Promise<string | null> {
    try {
      this.clients.set(phone, client);
      const qrPromise = new Promise<string | null>((resolve, reject) => {
        const resetTimeout = () => {
          if (this.qrTimeouts.has(phone)) {
            clearTimeout(this.qrTimeouts.get(phone));
          }
          const timeout = setTimeout(() => {
            this.logger.error(`Timeout na conexão para ${phone}`);
            this.cleanupConnection(phone);
            reject(new Error('Timeout ao aguardar QR Code'));
          }, this.SESSION_TIMEOUT);
          this.qrTimeouts.set(phone, timeout);
        };

        client.on('qr', async (qr) => this.handleQrEvent(phone, qr, conn, resolve, resetTimeout));
        client.on('authenticated', (session) => this.handleAuthEvent(phone, session, conn));
        client.on('ready', () => this.handleReadyEvent(phone, conn, resolve, resetTimeout));
        client.on('auth_failure', (msg) => this.handleAuthFailure(phone, msg, reject));
        client.on('disconnected', (reason) => {
          this.handleDisconnect(phone, reason)
            .catch(err => {
              this.logger.error(`Erro no listener de 'disconnected' para ${phone}:`, err);
            });
        });
        client.on('error', (error) => this.handleError(phone, error));
        client.on('message', msg => this.handleIncoming(phone, msg));

        resetTimeout();
        client.initialize();
      });

      return await qrPromise;
    } catch (error) {
      this.logger.error(`Erro na inicialização: ${phone} - ${error.message}`);
      await this.cleanupConnection(phone);
      throw error;
    }
  }

  private async handleQrEvent(phone: string, qr: string, conn: WhatsappConnection, resolve: Function, resetTimeout: Function) {
    this.logger.log(`Novo QR gerado para ${phone}`);
    resetTimeout();
    try {
      const url = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300`;
      await this.connectionRepo.update(conn.id, { qrCodeUrl: url });
      resolve(url);
    } catch (err) {
      this.logger.error(`Erro ao atualizar QR: ${phone}`, err);
      resolve(null);
    }
  }

  private async handleAuthEvent(phone: string, session: any, conn: WhatsappConnection) {
    this.logger.log(`Autenticado: ${phone}`);
    try {
      await this.connectionRepo.update(conn.id, {
        sessionData: JSON.stringify(session),
        status: 'connected',
        qrCodeUrl: null,
      });
    } catch (err) {
      this.logger.error(`Erro ao salvar sessão: ${phone}`, err);
    }
  }

  private async handleReadyEvent(phone: string, conn: WhatsappConnection, resolve: Function, resetTimeout: Function) {
    this.logger.log(`Pronto: ${phone}`);
    clearTimeout(this.qrTimeouts.get(phone));
    
    try {
      const client = this.clients.get(phone);
      if (!client) {
        throw new Error('Cliente não encontrado no ready');
      }
  
      if (!conn.sessionData) {
        const state = await client.getState(); // Use a instância direta
        await this.connectionRepo.update(conn.id, {
          sessionData: JSON.stringify(state),
          status: 'connected',
          qrCodeUrl: null,
        });
      }
      
      resolve(null);
    } catch (err) {
      this.logger.error(`Erro no ready: ${phone}`, err);
      resolve(null);
    }
  }

  private async handleAuthFailure(phone: string, msg: string, reject: Function) {
    this.logger.error(`Falha de autenticação: ${phone} - ${msg}`);
    await this.cleanupConnection(phone);
    reject(new Error(`Falha na autenticação: ${msg}`));
  }

  private async handleDisconnect(phone: string, reason: string) {
    this.logger.warn(`Desconectado: ${phone} - ${reason}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await this.cleanupConnection(phone);
  }

  private async handleError(phone: string, error: Error) {
    this.logger.error(`Erro crítico: ${phone}`, error.stack);
    await this.cleanupConnection(phone);
  }

  async disconnectSingleSession(phone: string) {
    if (this.cleaningLocks.has(phone)) return;
    this.cleaningLocks.add(phone);
  
    try {
      const client = this.clients.get(phone);
      if (client?.pupPage && !client.pupPage.isClosed()) {
        try {
          await client.logout();
        } catch (err) {
          this.logger.warn(`Não foi possível fazer logout de ${phone}: ${err.message}`);
        }
      }
      // só atualiza o status — a limpeza já vai rolar em cleanupConnection depois
      await this.updateConnectionStatus(phone, 'disconnected');
    } catch (error) {
      this.logger.error(`Disconexão seletiva falhou: ${phone}`, error.stack);
    } finally {
      // chama cleanup e libera lock
      await this.cleanupConnection(phone);
      this.cleaningLocks.delete(phone);
    }
  }
  
  private async cleanupConnection(phone: string) {
    if (this.cleaningLocks.has(phone)) return;
    this.cleaningLocks.add(phone);
  
    try {
      const client = this.clients.get(phone);
      if (!client) return;
  
      // 1) remova TUDO primeiro
      client.removeAllListeners();
  
      // 2) depois feche página
      if (client.pupPage && !client.pupPage.isClosed()) {
        await client.pupPage.close().catch(() => {});
      }
  
      // 3) feche o browser inteiro
      if (client.pupBrowser && client.pupBrowser.isConnected()) {
        await client.pupBrowser.close().catch(() => {});
      }
  
      // 4) destrua o client
      await client.destroy().catch(() => {});
  
      // 5) remova pasta de sessão com retry...
      await this.removeSessionFolder(phone);
  
      // 6) delete do DB
      const deleteConnection = await this.connectionRepo.delete({ phoneNumber: phone });
  
      return deleteConnection
    } finally {
      this.clients.delete(phone);
      this.qrTimeouts.delete(phone);
      this.cleaningLocks.delete(phone);
    }

  }
  

  private async removeSessionFolder(phone: string) {
    const folder = join(process.cwd(), '.wwebjs_auth', phone);
    const maxTries = 5;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        await rm(folder, { recursive: true, force: true });
        this.logger.log(`Pasta de sessão removida: ${folder}`);
        break;
      } catch (err: any) {
        if (err.code === 'EBUSY' && attempt < maxTries) {
          this.logger.warn(`EBUSY ao remover pasta (tentativa ${attempt}), retry em 200ms`);
          await new Promise(res => setTimeout(res, 200));
          continue;
        }
        this.logger.error(`Falha ao remover pasta de sessão ${folder}: ${err.message}`);
        break;
      }
    }
  }

  private async updateConnectionStatus(phone: string, status: string) {
    await this.connectionRepo.manager.transaction(async (manager) => {
      await manager.update(
        WhatsappConnection,
        { phoneNumber: phone },
        { 
          status,
          sessionData: status === 'disconnected' ? null : undefined,
          qrCodeUrl: null
        }
      );
    });
  }

  // Restante dos métodos mantidos com melhorias
  async getConnectionStatus(phone: string) {
    const conn = await this.connectionRepo.findOne({ where: { phoneNumber: phone } });
    return conn?.status || 'not-found';
  }

  async sendMessage(phone: string, to: string, text: string, appointmentId: number) {
    const client = this.clients.get(phone);
    if (!client) throw new Error('Cliente não conectado');

    const formattedTo = to.replace('+', '') + '@c.us';
    const pending = this.pendingConfirmationRepo.create({ 
      id: uuidv4(),
      appointmentId,
      phone: formattedTo
    });
    
    await this.pendingConfirmationRepo.save(pending);

    try {
      return await client.sendMessage(formattedTo, text);
    } catch (error) {
      this.logger.error('Erro ao enviar mensagem:', error);
      if (error.message.includes('Session closed')) this.cleanupConnection(phone);
      throw error;
    }
  }

  private async handleIncoming(phone: string, message: Message) {
    this.logger.log(`[${phone}] Mensagem recebida: ${message.body}`);
    const confirmation = await this.pendingConfirmationRepo.findOne({ 
      where: { phone: message.from } 
    });
    if (!confirmation) return;

    try {
      const normalized = this.normalizeText(message.body);
      const response = await this.nlpManager.process('pt', normalized);

      if (response.intent === 'confirmar' && response.score > 0.8) {
        await this.confirmAppointment(phone, confirmation, message.from);
      } else if (response.intent === 'cancelar' && response.score > 0.8) {
        await this.cancelAppointment(phone, confirmation, message.from);
      }
    } catch (error) {
      this.logger.error(`Erro no processamento: ${phone}`, error);
    }
  }

  private async confirmAppointment(phone: string, confirmation: PendingConfirmation, from: string) {
    await firstValueFrom(
      this.httpService.patch(
        `http://localhost:3001/appointment/${confirmation.appointmentId}`,
        { appointmentStatus: 'Confirmado' },
        { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
      )
    );
    await this.sendConfirmationResponse(phone, from, 'Confirmei seu atendimento! 😁');
    await this.pendingConfirmationRepo.delete({ phone: from });
  }

  private async cancelAppointment(phone: string, confirmation: PendingConfirmation, from: string) {
    await firstValueFrom(
      this.httpService.patch(
        `http://localhost:3001/appointment/${confirmation.appointmentId}`,
        { appointmentStatus: 'Cancelado', reasonLack: 'Cancelado pelo WhatsApp' },
        { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
      )
    );
    await this.sendConfirmationResponse(phone, from, 'Cancelei seu atendimento! 😁');
    await this.pendingConfirmationRepo.delete({ phone: from });
  }

  private async sendConfirmationResponse(phone: string, to: string, message: string) {
    try {
      const client = this.clients.get(phone);
      if (client) {
        await client.sendMessage(to, message);
      }
    } catch (error) {
      this.logger.error(`Erro ao enviar confirmação: ${phone}`, error);
    }
  }

  private normalizeText(text: string): string {
    return text.toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\s]/gi, '')
      .trim();
  }

  private async trainNlp() {
    try {
      confirmExamples.forEach(ex => 
        this.nlpManager.addDocument('pt', this.normalizeText(ex), 'confirmar'));
      cancelExamples.forEach(ex => 
        this.nlpManager.addDocument('pt', this.normalizeText(ex), 'cancelar'));
      
      this.nlpManager.addDocument('pt', 'não entendi', 'fallback');
      this.nlpManager.addDocument('pt', 'pode repetir', 'fallback');
      
      this.logger.log('Iniciando treinamento NLP...');
      await this.nlpManager.train();
      this.nlpManager.save();
      this.logger.log('NLP treinado com sucesso');
    } catch (error) {
      this.logger.error('Erro no treinamento NLP', error);
    }
  }
}