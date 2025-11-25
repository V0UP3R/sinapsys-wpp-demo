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

// Interface para a carga útil da mensagem na fila
interface MessagePayload {
  to: string; // Pode ser um número cru ou um JID completo
  text: string;
  isReply: boolean;
  skipValidation?: boolean; // NOVO: Flag para pular a validação em respostas
}

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private sessions = new Map<string, WASocket>();
  private connectingSessions = new Set<string>();
  private syncedSessions = new Set<string>(); // Rastreia sessões que completaram sincronização
  private readonly logger = new Logger(WhatsappService.name);
  private readonly SESSIONS_DIR = path.join(process.cwd(), '.baileys_auth');

  // Gerenciador de filas de mensagens para controlar o fluxo de envio
  private messageQueues = new Map<string, {
    queue: MessagePayload[];
    isProcessing: boolean;
  }>();

  // Constantes para o intervalo de envio de RESPOSTAS INTERATIVAS
  private readonly MIN_REPLY_INTERVAL = 2000; // 2 segundos
  private readonly MAX_REPLY_INTERVAL = 5000; // 5 segundos

  // Constantes para o intervalo de envio EM MASSA (bom cidadão)
  private readonly MIN_BULK_INTERVAL = 30000; // 30 segundos
  private readonly MAX_BULK_INTERVAL = 60000; // 1 minuto

  // Limite máximo de mensagens na fila por sessão
  private readonly MAX_QUEUE_SIZE = 100;

  // Timeout para chamadas HTTP (em ms)
  private readonly HTTP_TIMEOUT = 30000;

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(PendingConfirmation)
    private readonly pendingRepo: Repository<PendingConfirmation>,
    @InjectRepository(WhatsappConnection)
    private readonly connRepo: Repository<WhatsappConnection>,
  ) {
    if (!fs.existsSync(this.SESSIONS_DIR)) {
      fs.mkdirSync(this.SESSIONS_DIR, { recursive: true });
    }
    if (process.env.NODE_ENV === 'development') {
      this.logger.debug('Modo de desenvolvimento - Controles especiais ativados');
      process.on('SIGINT', () => this.gracefulShutdown());
    }
  }

  async onModuleInit() {
    const conns = await this.connRepo.find({ where: { status: 'connected' } });
    for (const conn of conns) {
      this.logger.log(`Restaurando sessão para ${conn.phoneNumber}...`);
      await this.connect(conn.phoneNumber);
    }
  }

  async onModuleDestroy() {
    this.logger.log('Destruindo todas as sessões ativas...');
    for (const sessionId of this.sessions.keys()) {
      await this.disconnect(sessionId, false);
    }
  }

  private getSessionPath(phone: string): string {
    // Sanitiza o número para evitar path traversal
    const sanitizedPhone = phone.replace(/[^0-9]/g, '');
    if (!sanitizedPhone || sanitizedPhone.length < 8) {
      throw new Error('Número de telefone inválido');
    }
    return path.join(this.SESSIONS_DIR, `session-${sanitizedPhone}`);
  }

  async connect(phone: string): Promise<string | null> {
    if (this.sessions.has(phone) || this.connectingSessions.has(phone)) {
        this.logger.warn(`[${phone}] Conexão já estabelecida ou em progresso.`);
        return null;
    }

    this.connectingSessions.add(phone);
    const sessionPath = this.getSessionPath(phone);

    return new Promise(async (resolve, reject) => {
        try {
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
            const sock = makeWASocket({
              auth: state,
              browser: Browsers.macOS('Desktop'),
              logger: pino({ level: 'silent' }) as any,
              version: [2, 3000, 1028401180] as [number, number, number],
            });
    
            let promiseResolved = false;
    
            const timeout = setTimeout(() => {
              if (!promiseResolved) {
                promiseResolved = true;
                this.connectingSessions.delete(phone);
                reject(new Error(`[${phone}] Tempo esgotado para conectar.`));
              }
            }, 60000); // 60 segundos de timeout
    
            sock.ev.on('creds.update', saveCreds);
    
            sock.ev.on('messages.upsert', async (m) => {
              const msg = m.messages[0];
              if (!msg.message || msg.key.fromMe) return;
              await this.handleIncoming(phone, msg);
            });

            // Evento que indica que a sincronização inicial foi concluída
            sock.ev.on('messaging-history.set', ({ isLatest }) => {
              if (isLatest) {
                this.logger.log(`[${phone}] Sincronização de histórico concluída.`);
                this.syncedSessions.add(phone);
              }
            });
    
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
                const reason = (lastDisconnect?.error as any)?.data?.reason;

                this.connectingSessions.delete(phone);
                this.sessions.delete(phone);
                this.syncedSessions.delete(phone); // Limpa estado de sincronização
                await this.connRepo.update({ phoneNumber: phone }, { status: 'disconnected' });

                if (statusCode === 405 || reason === '405') {
                  this.logger.warn(`[${phone}] Erro 405 detectado. Limpando sessão completamente...`);

                  if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                  }
                  
                  setTimeout(() => {
                    this.logger.log(`[${phone}] Tentando reconectar após erro 405...`);
                    this.connect(phone).catch(err => {
                      this.logger.error(`[${phone}] Falha na RECONEXÃO automática após 405: ${err.message}`);
                    });
                  }, 5000);

                  if (!promiseResolved) {
                    promiseResolved = true;
                    clearTimeout(timeout);
                    reject(new Error('Erro 405: Sessão corrompida. Reconexão automática iniciada.'));
                  }
                  return;
                }
    
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
                  reject(lastDisconnect?.error || new Error(`Connection closed with status code: ${statusCode}`));
                }
              }
            });
          } catch (err) {
            this.connectingSessions.delete(phone);
            this.logger.error(`[${phone}] Erro ao conectar: ${err.message}`);
            reject(err);
          }
    });
  }

  async disconnect(phone: string, deleteFromDb = true) {
    const sock = this.sessions.get(phone);
    if (sock) {
      await sock.logout();
    }
    this.sessions.delete(phone);
    this.messageQueues.delete(phone);
    this.syncedSessions.delete(phone); // Limpa o estado de sincronização

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

  private async enqueueMessage(phone: string, payload: MessagePayload): Promise<boolean> {
    if (!this.sessions.has(phone)) {
      this.logger.error(`[${phone}] Tentativa de enfileirar mensagem falhou: cliente não conectado.`);
      return false;
    }

    if (!this.messageQueues.has(phone)) {
      this.messageQueues.set(phone, { queue: [], isProcessing: false });
    }

    const sessionQueue = this.messageQueues.get(phone);

    // Verifica limite de tamanho da fila
    if (sessionQueue.queue.length >= this.MAX_QUEUE_SIZE) {
      this.logger.error(`[${phone}] Fila de mensagens cheia (${this.MAX_QUEUE_SIZE}). Mensagem descartada.`);
      return false;
    }

    sessionQueue.queue.push(payload);
    this.logger.log(`[${phone}] Mensagem para ${payload.to} adicionada à fila. Tamanho atual: ${sessionQueue.queue.length}`);

    if (!sessionQueue.isProcessing) {
      this.processMessageQueue(phone);
    }
    return true;
  }

  // NOVO: Método para validar o número de telefone antes de enviar
  private async validatePhoneNumber(sock: WASocket, number: string): Promise<string | null> {
    try {
        const cleaned = number.replace(/\D/g, '');
        
        // Lógica específica para números do Brasil para tratar o 9º dígito
        if (cleaned.startsWith('55') && cleaned.length >= 10) {
            const ddd = cleaned.substring(2, 4);
            const body = cleaned.substring(4);

            let withNine = '';
            let withoutNine = '';

            if (body.length === 9 && body.startsWith('9')) { // Formato: 55XX9XXXXXXXX
                withNine = cleaned;
                withoutNine = `55${ddd}${body.substring(1)}`;
            } else if (body.length === 8) { // Formato: 55XX_XXXXXXXX
                withNine = `55${ddd}9${body}`;
                withoutNine = cleaned;
            } else {
                // Não é um formato de celular padrão, verifica o número como está
                const [result] = await sock.onWhatsApp(cleaned);
                return result?.exists ? result.jid : null;
            }
            
            // Verifica a versão com '9' primeiro, que é a mais comum
            const [resultWithNine] = await sock.onWhatsApp(withNine);
            if (resultWithNine?.exists) {
                this.logger.log(`[Validation] JID validado para ${number}: ${resultWithNine.jid}`);
                return resultWithNine.jid;
            }
            
            // Se falhar, verifica a versão sem '9'
            const [resultWithoutNine] = await sock.onWhatsApp(withoutNine);
            if (resultWithoutNine?.exists) {
                this.logger.log(`[Validation] JID validado para ${number}: ${resultWithoutNine.jid}`);
                return resultWithoutNine.jid;
            }
        } else {
            // Para números não brasileiros, apenas verifica o número limpo
            const [result] = await sock.onWhatsApp(cleaned);
            if (result?.exists) {
                return result.jid;
            }
        }

        this.logger.warn(`[Validation] Nenhuma conta do WhatsApp encontrada para ${number}`);
        return null;
    } catch (error) {
        this.logger.error(`[Validation] Erro ao validar o número ${number}: ${error.message}`);
        return null;
    }
  }

  /**
   * Aguarda até que a sessão esteja sincronizada ou timeout
   */
  private async waitForSync(phone: string, timeoutMs: number = 30000): Promise<boolean> {
    const startTime = Date.now();
    while (!this.syncedSessions.has(phone)) {
      if (Date.now() - startTime > timeoutMs) {
        this.logger.warn(`[${phone}] Timeout aguardando sincronização. Prosseguindo mesmo assim.`);
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return true;
  }

  /**
   * Envia mensagem com retry e verificação de entrega
   */
  private async sendMessageWithRetry(
    phone: string,
    jid: string,
    text: string,
    maxRetries: number = 3
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Verifica se a sessão ainda está ativa antes de cada tentativa
      const sock = this.sessions.get(phone);
      if (!sock) {
        this.logger.error(`[SendRetry] Sessão ${phone} não está mais ativa. Abortando.`);
        return false;
      }

      try {
        // Aguarda um pouco antes de cada tentativa (exceto a primeira)
        if (attempt > 1) {
          const delay = attempt * 2000; // 2s, 4s, 6s
          this.logger.log(`[SendRetry] Tentativa ${attempt}/${maxRetries} em ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        const result = await sock.sendMessage(jid, { text });

        // Verifica se a mensagem foi enviada com sucesso
        if (result?.key?.id) {
          this.logger.log(`[SendRetry] Mensagem enviada com sucesso (ID: ${result.key.id})`);
          return true;
        }

        this.logger.warn(`[SendRetry] Resultado inesperado na tentativa ${attempt}: ${JSON.stringify(result)}`);
      } catch (error) {
        this.logger.error(`[SendRetry] Erro na tentativa ${attempt}/${maxRetries}: ${error.message}`);

        // Se for erro de Bad MAC, aguarda mais tempo
        if (error.message?.includes('Bad MAC')) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }
    return false;
  }

  private async processMessageQueue(phone: string) {
    const sessionQueue = this.messageQueues.get(phone);
    if (!sessionQueue || sessionQueue.isProcessing) {
      return;
    }

    sessionQueue.isProcessing = true;
    this.logger.log(`[${phone}] Iniciando processamento da fila de mensagens.`);

    // Aguarda a sincronização antes de processar mensagens em massa
    if (!this.syncedSessions.has(phone)) {
      this.logger.log(`[${phone}] Aguardando sincronização da sessão antes de enviar mensagens...`);
      await this.waitForSync(phone, 30000);
    }

    while (sessionQueue.queue.length > 0) {
      // Verifica se a sessão ainda existe antes de processar cada mensagem
      const sock = this.sessions.get(phone);
      if (!sock) {
        this.logger.warn(`[${phone}] Sessão desconectada durante processamento da fila. Abortando.`);
        break;
      }

      const payload = sessionQueue.queue.shift();
      if (!payload) continue;

      try {
        let finalJid: string | null = null;

        if (payload.skipValidation) {
          finalJid = payload.to;
        } else {
          finalJid = await this.validatePhoneNumber(sock, payload.to);
        }

        if (!finalJid) {
          this.logger.error(`[Queue] Número ${payload.to} inválido ou não encontrado no WhatsApp. Mensagem descartada.`);
          continue;
        }

        this.logger.log(`[Queue] Enviando mensagem para ${finalJid} a partir da fila.`);

        const success = await this.sendMessageWithRetry(phone, finalJid, payload.text, 3);

        if (!success) {
          this.logger.error(`[Queue] Falha ao enviar mensagem para ${finalJid} após todas as tentativas.`);
        }

        const interval = this.getRandomInterval(payload.isReply);
        const type = payload.isReply ? 'resposta' : 'massa';
        this.logger.log(`[Queue] Aguardando ${interval}ms para a próxima mensagem (tipo: ${type}).`);
        await new Promise(resolve => setTimeout(resolve, interval));

      } catch (error) {
        this.logger.error(`[Queue] Erro ao enviar mensagem da fila para ${payload.to}: ${error.message}`);
      }
    }

    sessionQueue.isProcessing = false;
    this.logger.log(`[${phone}] Fila de mensagens processada.`);
  }

  private getRandomInterval(isReply: boolean): number {
    const min = isReply ? this.MIN_REPLY_INTERVAL : this.MIN_BULK_INTERVAL;
    const max = isReply ? this.MAX_REPLY_INTERVAL : this.MAX_BULK_INTERVAL;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // A função normalizePhoneNumber não é mais usada para envio, mas pode ser mantida para outros propósitos.
  private normalizePhoneNumber(number: string): string {
    const cleaned = number.replace(/\D/g, '');
    if (cleaned.startsWith('55') && cleaned.length === 12) {
      return `${cleaned.slice(0, 4)}9${cleaned.slice(4)}`;
    }
    return cleaned;
  }

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

    // Salva a pendência com o número "cru", a validação e formatação acontecerão na fila
    const cleanedTo = to.replace(/\D/g, '');
    const formattedPending = `${cleanedTo}@c.us`;

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

    // Esta é a mensagem inicial, enviada em massa, então isReply é false e a validação é necessária
    await this.enqueueMessage(phone, { to: to, text, isReply: false, skipValidation: false });
  }

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

    const confirmKeywords = ['confirmar', 'confirmado', 'confirmo', 'sim', 'ok'];
    const cancelKeywords = ['cancelar', 'cancelado', 'cancelo', 'nao'];

    const threshold = 2; 

    // Função auxiliar para encontrar a menor distância em uma lista de palavras
    const getMinDistance = (text: string, keywords: string[]): number => {
      return Math.min(
        ...keywords.map(kw => {
            const dist = this.levenshtein(text, kw);
            if (kw.length <= 3 && dist > 1) return 99; 
            return dist;
        })
      );
    };

    // Calculo da distância mínima para cada intenção
    const confirmDistance = getMinDistance(normalizedText, confirmKeywords);
    const cancelDistance = getMinDistance(normalizedText, cancelKeywords);

    this.logger.log(`[${phone}] Distâncias para "${normalizedText}": Confirmar=${confirmDistance}, Cancelar=${cancelDistance}`);

    // Intenção de CONFIRMAR é clara e está dentro do limite
    if (confirmDistance <= threshold && confirmDistance < cancelDistance) {
      this.logger.log(`[${phone}] Intenção 'Confirmar' detectada para "${normalizedText}"`);
      return this.confirm(pending, phone, fromJid);
    }

    // Intenção de CANCELAR é clara e está dentro do limite
    if (cancelDistance <= threshold && cancelDistance < confirmDistance) {
      this.logger.log(`[${phone}] Intenção 'Cancelar' detectada para "${normalizedText}"`);
      return this.cancel(pending, phone, fromJid);
    }
    
    await this.sendMessageSimple(
      phone,
      fromJid,
      'Desculpe, não entendi. Por favor, responda apenas com a palavra *confirmar* ou *cancelar*.'
    );
  }

  private async confirm(conf: any, phone: string, from: string) {
    try {
      await firstValueFrom(
        this.httpService.patch(
          `http://localhost:3001/appointment/block/${conf.appointmentId}`,
          { status: 'Confirmado' },
          {
            headers: { 'x-internal-api-secret': process.env.API_SECRET },
            timeout: this.HTTP_TIMEOUT,
          },
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

  private async cancel(conf: any, phone: string, from: string) {
    try {
      await firstValueFrom(
        this.httpService.patch(
          `http://localhost:3001/appointment/block/${conf.appointmentId}`,
          { status: 'Cancelado', reasonLack: 'Cancelado pelo WhatsApp' },
          {
            headers: { 'x-internal-api-secret': process.env.API_SECRET },
            timeout: this.HTTP_TIMEOUT,
          },
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

  private async sendMessageSimple(phone: string, to: string, text: string) {
    // Como 'to' aqui é um JID de uma mensagem recebida, ele já é válido.
    await this.enqueueMessage(phone, { to: to, text, isReply: true, skipValidation: true });
  }

  private async notifyFrontendStatus(phone: string) {
    try {
      await firstValueFrom(
        this.httpService.post(
          'http://localhost:3001/whatsapp/status-update',
          { phoneNumber: phone },
          {
            headers: { 'x-internal-api-secret': process.env.API_SECRET },
            timeout: this.HTTP_TIMEOUT,
          },
        ),
      );
    } catch (e) {
      this.logger.error(`[${phone}] Falha ao notificar o frontend sobre desconexão: ${e.message}`);
    }
  }

  private gracefulShutdown() {
    this.logger.warn('Desligamento gracioso iniciado...');
    this.onModuleDestroy()
      .then(() => process.exit(0))
      .catch((err) => {
        this.logger.error(`Erro no desligamento gracioso: ${err.message}`);
        process.exit(1);
      });
  }

  async getStatus(phone: string): Promise<string> {
    const conn = await this.connRepo.findOne({ where: { phoneNumber: phone } });
    return conn?.status || 'not-found';
  }

  private normalize(text: string): string {
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
          timeout: this.HTTP_TIMEOUT,
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

    return [
      `${withoutNine}@c.us`,
      `${withNine}@c.us`,
      withoutNine,
      withNine,
      phone,
    ];
  }

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
  
  /**
   * Calcula a distância Levenshtein entre duas strings (a e b).
   * Mede o número de edições (inserções, deleções, substituições)
   * para transformar 'a' em 'b'.
  */
  private levenshtein(a: string, b: string): number {
    const matrix = [];

    // Incrementa ao longo da primeira coluna de todas as linhas
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    // Incrementa ao longo da primeira linha de todas as colunas
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    // Preenche o resto da matriz
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) == a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substituição
            matrix[i][j - 1] + 1,     // inserção
            matrix[i - 1][j] + 1,     // deleção
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }
}
