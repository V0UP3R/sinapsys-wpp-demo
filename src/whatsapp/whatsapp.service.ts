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

// Importações da biblioteca Baileys
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  // O Map agora armazena o socket (WASocket) do Baileys para cada sessão
  private sessions = new Map<string, WASocket>();
  private connectingSessions = new Set<string>();
  private readonly logger = new Logger(WhatsappService.name);

  // Diretório para salvar os arquivos de autenticação da sessão
  private readonly SESSIONS_DIR = path.join(process.cwd(), '.baileys_auth');

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(PendingConfirmation)
    private readonly pendingRepo: Repository<PendingConfirmation>,
    @InjectRepository(WhatsappConnection)
    private readonly connRepo: Repository<WhatsappConnection>,
  ) {
    // Garante que o diretório de sessões exista
    if (!fs.existsSync(this.SESSIONS_DIR)) {
      fs.mkdirSync(this.SESSIONS_DIR, { recursive: true });
    }
    // Habilita o desligamento gracioso em ambiente de desenvolvimento
    if (process.env.NODE_ENV === 'development') {
      this.logger.debug('Modo de desenvolvimento - Controles especiais ativados');
      process.on('SIGINT', () => this.gracefulShutdown());
    }
  }

  // Método executado quando o módulo é inicializado
  async onModuleInit() {
    const conns = await this.connRepo.find({ where: { status: 'connected' } });
    for (const conn of conns) {
      this.logger.log(`Restaurando sessão para ${conn.phoneNumber}...`);
      // A restauração no Baileys é feita tentando conectar-se com as credenciais salvas
      await this.connect(conn.phoneNumber);
    }
  }

  // Método executado quando o módulo é destruído
  async onModuleDestroy() {
    this.logger.log('Destruindo todas as sessões ativas...');
    for (const sessionId of this.sessions.keys()) {
      await this.disconnect(sessionId, false); // false para não deletar do DB ao desligar
    }
  }

  // Retorna o caminho para a pasta de uma sessão específica
  private getSessionPath(phone: string): string {
    return path.join(this.SESSIONS_DIR, `session-${phone}`);
  }

  // Lógica principal de conexão com o Baileys
  async connect(phone: string): Promise<string | null> {
    if (this.sessions.has(phone)) {
      this.logger.warn(`[${phone}] Conexão já estabelecida.`);
      return null;
    }
    if (this.connectingSessions.has(phone)) {
      this.logger.warn(`[${phone}] Conexão já está em progresso.`);
      // Retorna nulo para indicar ao controller que não há um novo QR code
      return null;
    }

    this.connectingSessions.add(phone);
    const sessionPath = this.getSessionPath(phone);

    return new Promise(async (resolve, reject) => {
      try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        const sock = makeWASocket({
          auth: state,
          // Adiciona uma identificação de navegador para evitar erros de conexão 401
          browser: Browsers.macOS('Desktop'),
          logger: pino({ level: 'silent' }) as any,
        });

        let promiseResolved = false;

        const timeout = setTimeout(() => {
          if (!promiseResolved) {
            promiseResolved = true;
            this.connectingSessions.delete(phone);
            reject(new Error(`[${phone}] Tempo esgotado para conectar.`));
          }
        }, 60000); // 60 segundos de timeout

        // Listener para salvar as credenciais
        sock.ev.on('creds.update', saveCreds);

        // Listener para novas mensagens
        sock.ev.on('messages.upsert', async (m) => {
          const msg = m.messages[0];
          if (!msg.message || msg.key.fromMe) return;
          await this.handleIncoming(phone, msg);
        });

        // Listener para eventos de conexão
        sock.ev.on('connection.update', async (update) => {
          const { connection, lastDisconnect, qr } = update;

          if (qr) {
            this.logger.log(`[${phone}] QR Code recebido.`);
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300`;

            let conn = await this.connRepo.findOne({ where: { phoneNumber: phone } });
            if (!conn) {
              conn = this.connRepo.create({ phoneNumber: phone });
              await this.connRepo.save(conn);
            }
            await this.connRepo.update({ phoneNumber: phone }, { qrCodeUrl: qrUrl });

            if (!promiseResolved) {
              promiseResolved = true;
              clearTimeout(timeout);
              resolve(qrUrl);
            }
          }

          if (connection === 'open') {
            this.logger.log(`[${phone}] Conexão estabelecida com sucesso!`);
            this.sessions.set(phone, sock);
            this.connectingSessions.delete(phone);
            await this.connRepo.update({ phoneNumber: phone }, { status: 'connected', qrCodeUrl: null });
            await this.notifyFrontendStatus(phone);

            if (!promiseResolved) {
              promiseResolved = true;
              clearTimeout(timeout);
              resolve(null); // Conectado sem QR code (restauração de sessão)
            }
          }

          if (connection === 'close') {
            const statusCode = (lastDisconnect.error as Boom)?.output?.statusCode;
            
            this.connectingSessions.delete(phone);
            this.sessions.delete(phone);
            await this.connRepo.update({ phoneNumber: phone }, { status: 'disconnected' });

            // LÓGICA DE RECONEXÃO SUGERIDA
            if (statusCode !== DisconnectReason.loggedOut) {
              this.logger.warn(`[${phone}] Conexão fechada (código: ${statusCode}), tentando reconectar em 5 segundos...`);
              setTimeout(() => this.connect(phone), 5000);
            } else {
              this.logger.warn(`[${phone}] Desconectado (logged out). Removendo sessão permanentemente.`);
              if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
              }
            }
            
            if (!promiseResolved) {
              promiseResolved = true;
              clearTimeout(timeout);
              reject(lastDisconnect.error || new Error(`Connection closed with status code: ${statusCode}`));
            }
          }
        });
      } catch (err) {
        this.connectingSessions.delete(phone);
        reject(err);
      }
    });
  }

  // Lógica para desconectar uma sessão
  async disconnect(phone: string, deleteFromDb = true) {
    const sock = this.sessions.get(phone);
    if (sock) {
      await sock.logout();
    }

    this.sessions.delete(phone);

    const sessionPath = this.getSessionPath(phone);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }

    if (deleteFromDb) {
      await this.connRepo.delete({ phoneNumber: phone });
    }
    await this.notifyFrontendStatus(phone);
    this.logger.log(`[${phone}] Sessão desconectada e arquivos limpos.`);
  }

  // ALTERAÇÃO: Nova função para garantir o formato correto do número
  private normalizePhoneNumber(number: string): string {
    // Remove todos os caracteres não numéricos
    const cleaned = number.replace(/\D/g, '');
    
    // Verifica se é um número de celular brasileiro (55 + DDD + 8 dígitos) sem o 9
    if (cleaned.startsWith('55') && cleaned.length === 12) {
      // Insere o '9' após o DDD (que tem 2 dígitos)
      return `${cleaned.slice(0, 4)}9${cleaned.slice(4)}`;
    }
    
    // Retorna o número limpo para outros casos
    return cleaned;
  }

  // Lógica para enviar uma mensagem de confirmação inicial
  async sendMessage(
    phone: string,
    to: string,
    text: string,
    appointmentId: number,
  ) {
    const sock = this.sessions.get(phone);
    if (!sock || !sock.user) {
      this.logger.error(`[${phone}] Tentativa de envio falhou: cliente não conectado.`);
      throw new Error('Client not connected');
    }

    // ALTERAÇÃO: Usa a nova função de normalização
    const normalizedTo = this.normalizePhoneNumber(to);
    const formattedTo = `${normalizedTo}@s.whatsapp.net`;
    const formattedPending = `${normalizedTo}@c.us`;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    const pending = this.pendingRepo.create({
      id: uuidv4(),
      appointmentId,
      phone: formattedPending,
      createdAt: now,
      expiresAt,
    });
    await this.pendingRepo.save(pending);

    this.logger.log(`[${phone}] Enviando mensagem para ${formattedTo}`);
    return sock.sendMessage(formattedTo, { text });
  }

  // Lógica para tratar mensagens recebidas
  private async handleIncoming(phone: string, message: WAMessage) {
    const messageContent = message.message?.conversation || message.message?.extendedTextMessage?.text;
    const fromJid = message.key.remoteJid;

    if (!messageContent || !fromJid) return;
    this.logger.log(`[${phone}] Recebido de ${fromJid}: ${messageContent}`);

    const fromAsCus = fromJid.replace('@s.whatsapp.net', '@c.us');
    const phoneVariations = this.generatePhoneVariations(fromAsCus);

    const pending = await this.pendingRepo.findOne({
      where: { phone: In(phoneVariations), expiresAt: MoreThan(new Date()) },
      order: { createdAt: 'DESC' },
    });

    if (!pending) return;

    const normalizedText = this.normalize(messageContent);

    if (normalizedText === 'confirmar' || normalizedText === 'confirmado') {
      return this.confirm(pending, phone, fromJid);
    }
    if (normalizedText === 'cancelar' || normalizedText === 'cancelado') {
      return this.cancel(pending, phone, fromJid);
    }

    await this.sendMessageSimple(
      phone,
      fromJid,
      'Desculpe, não entendi. Por favor, responda apenas com a palavra *confirmar* ou *cancelar*.'
    );
  }

  // Lógica para confirmar um agendamento
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
      await this.sendMessageSimple(phone, from, 'Ocorreu um erro ao processar sua confirmação. Por favor, tente novamente ou contate a clínica.');
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
      await this.sendMessageSimple(phone, from, confirmationMessage);
    } catch (error) {
      this.logger.error(`Erro ao enviar confirmação detalhada: ${error.message}`);
      await this.sendMessageSimple(phone, from, 'Seu agendamento foi confirmado com sucesso!');
    }

    await this.pendingRepo.delete({ id: conf.id });
    await this.checkAndNotifyNextPendingAppointment(phone, from);
  }

  // Lógica para cancelar um agendamento
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
      await this.sendMessageSimple(phone, from, 'Ocorreu um erro ao processar seu cancelamento. Por favor, tente novamente ou contate a clínica.');
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
      await this.sendMessageSimple(phone, from, cancellationMessage);
    } catch (error) {
      this.logger.error(`Erro ao enviar cancelamento detalhado: ${error.message}`);
      const fallbackMessage = 'Seu agendamento foi cancelado conforme solicitado. Caso deseje remarcar, por favor, entre em contato diretamente com a clínica.';
      await this.sendMessageSimple(phone, from, fallbackMessage);
    }

    await this.pendingRepo.delete({ id: conf.id });
    await this.checkAndNotifyNextPendingAppointment(phone, from);
  }

  // Função auxiliar para simplificar o envio de mensagens de texto
  private async sendMessageSimple(phone: string, to: string, text: string) {
    const sock = this.sessions.get(phone);
    if (sock) {
      // ALTERAÇÃO: Usa a nova função de normalização
      const normalizedTo = this.normalizePhoneNumber(to);
      const formattedTo = `${normalizedTo}@s.whatsapp.net`;
      await sock.sendMessage(formattedTo, { text });
    }
  }

  // Notifica o frontend sobre uma mudança de status da conexão
  private async notifyFrontendStatus(phone: string) {
    try {
      await firstValueFrom(
        this.httpService.post(
          'http://localhost:3001/whatsapp/status-update',
          { phoneNumber: phone },
          { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
        ),
      );
    } catch (e) {
      this.logger.error(`[${phone}] Falha ao notificar o frontend sobre desconexão: ${e.message}`);
    }
  }

  // Lida com o sinal de interrupção (CTRL+C) para fechar as sessões
  private gracefulShutdown() {
    this.logger.warn('Desligamento gracioso iniciado...');
    this.onModuleDestroy()
      .then(() => process.exit(0))
      .catch((err) => {
        this.logger.error(`Erro no desligamento gracioso: ${err.message}`);
        process.exit(1);
      });
  }

  // Retorna o status de uma conexão a partir do banco de dados
  async getStatus(phone: string): Promise<string> {
    const conn = await this.connRepo.findOne({ where: { phoneNumber: phone } });
    return conn?.status || 'not-found';
  }

  // Normaliza o texto (remove acentos, pontuação, etc.)
  private normalize(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\s]/gi, '')
      .trim();
  }

  // Busca detalhes de um agendamento na sua outra API
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

  // Gera variações de um número de telefone para busca no banco de dados
  private generatePhoneVariations(phone: string): string[] {
    const normalizedPhone = phone.replace(/\D/g, '');
    if (normalizedPhone.length < 11) return [phone, `${phone}@c.us`];

    const withoutNine = normalizedPhone.replace(/^(\d{4})(9?)(\d{8})$/, '$1$3');
    const withNine = normalizedPhone.replace(/^(\d{4})(\d{8})$/, '$19$2');

    return [
      `${withoutNine}@c.us`,
      `${withNine}@c.us`,
      withoutNine,
      withNine,
      phone, // Adiciona o formato original também
    ];
  }

  // Verifica se existe outro agendamento pendente para o mesmo número e notifica
  private async checkAndNotifyNextPendingAppointment(phone: string, from: string) {
    const fromAsCus = from.replace('@s.whatsapp.net', '@c.us');
    const phoneVariations = this.generatePhoneVariations(fromAsCus);

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
        const appointmentTime = new Date(details.blockStartTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

        const followUpMessage = `Obrigado, ${patientName}! Notamos que você também tem um agendamento com o(a) profissional ${professionalName} no dia ${appointmentDate} às ${appointmentTime} que ainda não foi respondido.

Deseja também *confirmar* ou *cancelar* este horário?`;

        await this.sendMessageSimple(phone, from, followUpMessage);
        this.logger.log(`Enviada mensagem de acompanhamento para o agendamento ${nextPending.appointmentId} para o número ${from}.`);
      } catch (error) {
        this.logger.error(`Falha ao notificar próxima pendência para ${from}: ${error.message}`);
      }
    }
  }
}
