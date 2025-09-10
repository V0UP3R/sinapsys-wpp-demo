import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository, In } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { PendingConfirmation } from '../message/entities/message.entity';
import { v4 as uuidv4 } from 'uuid';
import { firstValueFrom } from 'rxjs';
import { WhatsappConnection } from './entities/whatsapp-connection.entity';
import * as fs from 'fs';
import * as path from 'path';

// ALTERAÇÃO: Importações do whatsapp-web.js
import { Client, LocalAuth, Message } from 'whatsapp-web.js';

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  // ALTERAÇÃO: O tipo do Map agora é o Client do whatsapp-web.js
  private sessions = new Map<string, Client>();
  private connectingSessions = new Set<string>();
  private readonly logger = new Logger(WhatsappService.name);

  // Paths para Chrome/Chromium cross-platform (mantido)
  private readonly defaultChromeLinux = '/usr/bin/google-chrome-stable';
  private readonly defaultChromeWin =
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(PendingConfirmation)
    private readonly pendingRepo: Repository<PendingConfirmation>,
    @InjectRepository(WhatsappConnection)
    private readonly connRepo: Repository<WhatsappConnection>,
  ) {
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
    this.logger.log('Destroying all active sessions...');
    for (const sessionId of this.sessions.keys()) {
      await this.disconnect(sessionId, false); // false para não deletar do DB ao desligar
    }
  }

  // ALTERAÇÃO: Opções ajustadas para o formato do puppeteer do whatsapp-web.js
  private getSessionOptions(sessionName: string) {
    return {
      authStrategy: new LocalAuth({ clientId: sessionName }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-zygote',
        ],
        executablePath:
          process.platform === 'win32' ? undefined : this.defaultChromeLinux,
      },
    };
  }

  // ALTERAÇÃO: Lógica de restauração adaptada
  private async restoreSession(phone: string) {
    this.logger.log(`Attempting to restore session for ${phone}...`);
    try {
      const client = new Client(this.getSessionOptions(phone));

      client.on('ready', () => {
        this.logger.log(`Session for ${phone} restored and ready!`);
        this.sessions.set(phone, client);
      });

      // Se a sessão estiver perdida, ele vai emitir um QR, o que não deveria acontecer.
      // A lógica de desconexão cuidará da limpeza se a restauração falhar.
      client.on('disconnected', (reason) =>
        this.handleDisconnect(phone, reason),
      );
      client.on('message', (msg) => this.handleIncoming(phone, msg));

      await client.initialize();
    } catch (err) {
      this.logger.error(
        `Failed to restore session for ${phone}: ${err.message}`,
      );
    }
  }

  // ALTERAÇÃO: Lógica de conexão completamente reescrita para whatsapp-web.js
 async connect(phone: string): Promise<string> {
    if (this.connectingSessions.has(phone)) {
        this.logger.warn(`[${phone}] Connection attempt rejected: another connection is already in progress.`);
        throw new Error('A connection for this number is already in progress.');
    }

    // Garante que qualquer cliente ativo na memória seja desconectado primeiro.
    if (this.sessions.has(phone)) {
        this.logger.log(`[${phone}] Disconnecting existing in-memory session before creating a new one.`);
        await this.disconnect(phone, false); // false para não deletar do DB ainda
    }
    
    // --- LÓGICA DE LIMPEZA DA PASTA DA SESSÃO ---
    try {
        const sessionPath = path.join(process.cwd(), '.wwebjs_auth', `session-${phone}`);
        if (fs.existsSync(sessionPath)) {
            this.logger.log(`[${phone}] Existing session folder found. Deleting for a clean start...`);
            fs.rmSync(sessionPath, { recursive: true, force: true });
            this.logger.log(`[${phone}] Session folder deleted successfully.`);
        }
    } catch (e) {
        this.logger.error(`[${phone}] Error deleting session folder: ${e.message}`);
        // Se a limpeza falhar, é melhor parar para evitar estado inconsistente.
        throw new Error(`Failed to clear session folder for ${phone}. Please check permissions.`);
    }
    // --- FIM DA LÓGICA DE LIMPEZA ---

    try {
        this.connectingSessions.add(phone);

        // O resto da sua função `connect` permanece exatamente o mesmo...
        // ... (código do new Promise, client.on('qr'), etc.)

        let conn = await this.connRepo.findOne({ where: { phoneNumber: phone } });
        if (!conn) {
            conn = this.connRepo.create({ phoneNumber: phone });
            conn = await this.connRepo.save(conn);
            
        }
        const qrPromise = new Promise<string>((resolve, reject) => {
            const client = new Client(this.getSessionOptions(phone));

            const rejectWithCleanup = (err) => {
                client.destroy().catch(e => this.logger.error(`Error destroying client on cleanup: ${e.message}`));
                this.connRepo.update({ phoneNumber: phone }, { status: 'failed' });
                reject(err);
            };

            client.on('qr', async (qr) => {
                this.logger.log(`[${phone}] QR Code received.`);
                const url = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(
                    qr,
                )}&size=300x300`;
                resolve(url);
            });

            client.on('authenticated', async () => {
                this.logger.log(`[${phone}] Authenticated successfully.`);
                await this.connRepo.update(
                    { phoneNumber: phone },
                    { status: 'connecting', qrCodeUrl: null },
                );
            });

            client.on('ready', async () => {
                this.logger.log(`[${phone}] Client is ready!`);
                this.sessions.set(phone, client);
                await this.connRepo.update(
                    { phoneNumber: phone },
                    { status: 'connected', qrCodeUrl: null },
                );
                await firstValueFrom(
                    this.httpService.post(
                        'http://localhost:3001/whatsapp/status-update',
                        { phoneNumber: phone },
                        { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
                    ),
                );
            });

            client.on('disconnected', (reason) => this.handleDisconnect(phone, reason));
            client.on('message', (message) => this.handleIncoming(phone, message));

            client.initialize().catch(err => {
                this.logger.error(`[${phone}] Client initialization failed:`, err);
                rejectWithCleanup(err);
            });
        });

        return qrPromise;

    } catch (err) {
        this.logger.error(`Error creating session for ${phone}: ${err.message}`, err.stack);
        throw err;
    } finally {
        this.connectingSessions.delete(phone);
    }
}

  private gracefulShutdown() {
    this.logger.warn('Graceful shutdown initiated...');
    this.onModuleDestroy()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  }

  // ALTERAÇÃO: Nova função para lidar com desconexões
  private async handleDisconnect(phone: string, reason: any) {
    this.logger.warn(`[${phone}] Client disconnected. Reason: ${reason}`);
    const client = this.sessions.get(phone);
    if (client) {
        try {
            await client.destroy(); // Encerra a instância do puppeteer
        } catch (e) {
            this.logger.error(`Error destroying client for ${phone}: ${e.message}`);
        }
    }
    this.sessions.delete(phone);
    await this.connRepo.delete({ phoneNumber: phone });
    // Notificar o frontend que a conexão caiu
    await firstValueFrom(
      this.httpService.post(
        'http://localhost:3001/whatsapp/status-update',
        { phoneNumber: phone },
        { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
      ),
    );
  }

  // ALTERAÇÃO: Lógica de desconexão adaptada
  async disconnect(phone: string, deleteFromDb = true) {
    const client = this.sessions.get(phone);
    if (client) {
        try {
            await client.destroy();
            this.logger.log(`[${phone}] Client instance destroyed.`);
        } catch (e) {
            this.logger.warn(`Destroy failed for ${phone}: ${e.message}`);
        }
        // Removendo a chamada ao logout(), pois destroy() já encerra a conexão
        // e o objetivo principal do logout() aqui (limpar a pasta) já será feito
        // de forma mais controlada na função connect().
    }
    
    // Remove da memória imediatamente após o destroy
    this.sessions.delete(phone);

    if (deleteFromDb) {
        await this.connRepo.delete({ phoneNumber: phone });
    }

    try {
        await firstValueFrom(
            this.httpService.post(
                'http://localhost:3001/whatsapp/status-update',
                { phoneNumber: phone },
                { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
            ),
        );
    } catch (e) {
        this.logger.error(`[${phone}] Failed to notify frontend about disconnection: ${e.message}`);
    }
}

  async getStatus(phone: string): Promise<string> {
    const conn = await this.connRepo.findOne({ where: { phoneNumber: phone } });
    return conn?.status || 'not-found';
  }

  // ALTERAÇÃO: client.sendText -> client.sendMessage
  async sendMessage(
    phone: string,
    to: string,
    text: string,
    appointmentId: number,
  ) {
    const client = this.sessions.get(phone);
    if (!client) throw new Error('Client not connected');
    const formatted = to.replace('+', '') + '@c.us';

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    const pending = this.pendingRepo.create({
      id: uuidv4(),
      appointmentId,
      phone: formatted,
      createdAt: now,
      expiresAt,
    });
    await this.pendingRepo.save(pending);
    return client.sendMessage(formatted, text);
  }

  // ALTERAÇÃO: Tipagem da mensagem e chamada de envio
  private async handleIncoming(phone: string, message: Message) {
    if (!message.body || typeof message.body !== 'string') return;
    this.logger.log(`[${phone}] Received from ${message.from}: ${message.body}`);

    const phoneVariations = this.generatePhoneVariations(message.from);

    const pending = await this.pendingRepo.findOne({
      where: {
        phone: In(phoneVariations),
        expiresAt: MoreThan(new Date()),
      },
      order: { createdAt: 'DESC' },
    });

    if (!pending) return;

    const normalizedText = this.normalize(message.body);

    if (normalizedText === 'confirmar' || normalizedText === 'confirmado') {
      return this.confirm(pending, phone, message.from);
    }

    if (normalizedText === 'cancelar' || normalizedText === 'cancelado') {
      return this.cancel(pending, phone, message.from);
    }

    await this.sessions
      .get(phone)
      ?.sendMessage( // ALTERADO: sendText -> sendMessage
        message.from,
        'Desculpe, não entendi. Por favor, responda apenas com a palavra *confirmar* ou *cancelar*.',
      );
  }

  private async confirm(conf: any, phone: string, from: string) {
    try {
      await firstValueFrom(
        this.httpService.patch(
          `http://localhost:3001/appointment/block/${conf.appointmentId}`,
          { status: 'Confirmado' },
          { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
        ),
      );
    } catch (error) {
       this.logger.error(`Falha ao atualizar bloco para CONFIRMADO para o appt ID ${conf.appointmentId}: ${error.message}`);
       await this.sessions.get(phone)?.sendMessage(from, 'Ocorreu um erro ao processar sua confirmação. Por favor, tente novamente ou contate a clínica.');
       return;
    }

    try {
      const details = await this.getAppointmentDetails(conf.appointmentId);
      const patientName = details.patient.personalInfo.name;
      const professionalName = details.professional.user.name;
      const clinicName = details.clinic.name;
      const appointmentDate = new Date(details.date).toLocaleDateString('pt-BR');
      const address = details.clinic.address;
      const clinicPhone = details.clinic.phone;
      const responsibleInfo = details.patient.patientResponsible?.[0]?.responsible;
      const recipientName = responsibleInfo?.name || details.patient.personalInfo.name;
      const greeting = responsibleInfo 
            ? `Olá, ${recipientName}! O agendamento de ${patientName} com ${professionalName} na clínica ${clinicName} está confirmado.`
            : `Olá, ${recipientName}! Seu agendamento com ${professionalName} na clínica ${clinicName} está confirmado.`;

      const blockStartTime = new Date(details.blockStartTime);
      const blockEndTime = new Date(details.blockEndTime);
      const durationMinutes = (blockEndTime.getTime() - blockStartTime.getTime()) / (1000 * 60);

      const confirmationMessage = `✅ *Confirmado!*

${greeting}

🗓️ *Data:* ${appointmentDate}
⏰ *Horário:* Das ${blockStartTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} às ${blockEndTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
⏳ *Duração Estimada:* ${durationMinutes} minutos
📍 *Local:* ${address}

Por favor, chegue com alguns minutos de antecedência. Em caso de dúvidas ou se precisar reagendar, entre em contato.
📞 *Contato da Clínica:* ${clinicPhone}

Até lá!
---
_Esta é uma mensagem automática. Por favor, não responda._`;

      await this.sessions.get(phone)?.sendMessage(from, confirmationMessage);
    } catch (error) {
      this.logger.error(`Erro ao enviar confirmação detalhada: ${error.message}`);
      await this.sessions.get(phone)?.sendMessage(from, 'Seu agendamento foi confirmado com sucesso!');
    }

    await this.pendingRepo.delete({ id: conf.id });
    await this.checkAndNotifyNextPendingAppointment(phone, from);
  }

  private async cancel(conf: any, phone: string, from: string) {
    try {
      await firstValueFrom(
        this.httpService.patch(
          `http://localhost:3001/appointment/block/${conf.appointmentId}`,
          { status: 'Cancelado', reasonLack: 'Cancelado pelo WhatsApp' },
          { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
        ),
      );
    } catch (error) {
      this.logger.error(`Falha ao atualizar bloco para CANCELADO para o appt ID ${conf.appointmentId}: ${error.message}`);
      await this.sessions.get(phone)?.sendMessage(from, 'Ocorreu um erro ao processar seu cancelamento. Por favor, tente novamente ou contate a clínica.');
      return;
    }

    try {
      const details = await this.getAppointmentDetails(conf.appointmentId);
      const patientName = details.patient.personalInfo.name;
      const professionalName = details.professional.user.name;
      const appointmentDate = new Date(details.date).toLocaleDateString('pt-BR');
      const clinicPhone = details.clinic.phone;
      const responsibleInfo = details.patient.patientResponsible?.[0]?.responsible;
      const recipientName = responsibleInfo?.name || details.patient.personalInfo.name;
      const greeting = responsibleInfo 
            ? `Olá, ${recipientName}. Conforme sua solicitação, o agendamento de ${patientName} com ${professionalName} no dia ${appointmentDate} foi cancelado com sucesso.`
            : `Olá, ${recipientName}. Conforme sua solicitação, o agendamento com ${professionalName} no dia ${appointmentDate} foi cancelado com sucesso.`;

      const cancellationMessage = `❌ *Agendamento Cancelado*

${greeting}

Se desejar remarcar, por favor, entre em contato diretamente com a clínica.
📞 *Contato:* ${clinicPhone}

Esperamos vê-lo em breve.
---
_Esta é uma mensagem automática._`;

      await this.sessions.get(phone)?.sendMessage(from, cancellationMessage);
    } catch (error) {
      this.logger.error(`Erro ao enviar cancelamento detalhado: ${error.message}`);
      const fallbackMessage = 'Seu agendamento foi cancelado conforme solicitado. Caso deseje remarcar, por favor, entre em contato diretamente com a clínica.';
      await this.sessions.get(phone)?.sendMessage(from, fallbackMessage);
    }

    await this.pendingRepo.delete({ id: conf.id });
    await this.checkAndNotifyNextPendingAppointment(phone, from);
  }

  private async getUserId(id: number) {
    const response = await firstValueFrom(
      this.httpService.get(
        `http://localhost:3001/appointment/find/user/appointment/${id}`,
        { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
      ),
    );
    this.logger.log(`Response from API: ${response.status} - ${response.statusText}`);
    return response;
  }

  private normalize(text: string) {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\s]/gi, '')
      .trim();
  }

  private async getAppointmentDetails(id: number): Promise<any> {
    const endpoint = `http://localhost:3001/appointment/details/${id}`;
    this.logger.log(`Buscando detalhes do agendamento ID ${id} em ${endpoint}`);
    try {
      const response = await firstValueFrom(
        this.httpService.get(endpoint, {
          headers: { 'x-internal-api-secret': process.env.API_SECRET },
        }),
      );
      return response.data;
    } catch (error) {
      this.logger.error(`Falha ao buscar detalhes do agendamento ${id}:`, error.message);
      throw new Error('Não foi possível obter os detalhes do agendamento.');
    }
  }
  
  private generatePhoneVariations(phone: string): string[] {
    const normalizedPhone = phone.replace(/\D/g, '');
    if (normalizedPhone.length < 11) return [phone, `${phone}@c.us`];
    const withoutNine = normalizedPhone.replace(/^(\d{4})(9?)(\d{8})$/, '$1$3');
    const withNine = normalizedPhone.replace(/^(\d{4})(\d{8})$/, '$19$2');
    return [`${withoutNine}@c.us`, `${withNine}@c.us`, withoutNine, withNine];
  }

  private async checkAndNotifyNextPendingAppointment(phone: string, from: string) {
    const phoneVariations = this.generatePhoneVariations(from);
    const nextPending = await this.pendingRepo.findOne({
      where: { phone: In(phoneVariations), expiresAt: MoreThan(new Date()) },
      order: { createdAt: 'ASC' },
    });

    if (nextPending) {
      try {
        const details = await this.getAppointmentDetails(nextPending.appointmentId);
        const patientName = details.patient.personalInfo.name;
        const professionalName = details.professional.user.name;
        const appointmentDate = new Date(details.date).toLocaleDateString('pt-BR');
        const appointmentTime = new Date(details.date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

        const followUpMessage = `Obrigado, ${patientName}! Notamos que você também tem um agendamento com o(a) profissional ${professionalName} no dia ${appointmentDate} às ${appointmentTime} que ainda não foi respondido.

Deseja também *confirmar* ou *cancelar* este horário?`;

        await this.sessions.get(phone)?.sendMessage(from, followUpMessage);
        this.logger.log(`Enviada mensagem de acompanhamento para o agendamento ${nextPending.appointmentId} para o número ${from}.`);
      } catch (error) {
        this.logger.error(`Falha ao notificar próxima pendência para ${from}: ${error.message}`);
      }
    }
  }
}