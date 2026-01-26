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
import * as util from 'util';

// Importações da biblioteca Baileys
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  WAMessage,
  WASocket,
  proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { RedisService } from '../redis/redis.service';
import { makeRedisStore } from './baileys-redis-store';
import OpenAI from 'openai';

// Interface para a carga útil da mensagem na fila
interface MessagePayload {
  to: string; // Pode ser um número cru ou um JID completo
  text: string;
  isReply: boolean;
  appointmentId?: number;
  skipValidation?: boolean; // NOVO: Flag para pular a validação em respostas
}

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private sessions = new Map<string, WASocket>();
  private connectingSessions = new Set<string>();
  private syncedSessions = new Set<string>(); // Rastreia sessões que completaram sincronização
  private readonly logger = new Logger(WhatsappService.name);
  private readonly openai?: OpenAI;
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

  // Cache de mensagens processadas para evitar duplicidade
  private processedMessages = new Set<string>();

  // Controla quando o QR pode ser emitido para o frontend
  private qrRequests = new Map<string, number>();
  private readonly QR_REQUEST_TTL_MS = 5 * 60 * 1000;

  // Cache de status para evitar spam de notificacoes ao frontend
  private lastFrontendStatus = new Map<string, {
    status?: string;
    qrCodeUrl?: string | null;
    lastSentAt: number;
  }>();

  private readonly FRONTEND_STATUS_DEDUP_MS = 30000;

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(PendingConfirmation)
    private readonly pendingRepo: Repository<PendingConfirmation>,
    @InjectRepository(WhatsappConnection)
    private readonly connRepo: Repository<WhatsappConnection>,
    private readonly redisService: RedisService,
  ) {
    if (!fs.existsSync(this.SESSIONS_DIR)) {
      fs.mkdirSync(this.SESSIONS_DIR, { recursive: true });
    }
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    } else {
      this.logger.warn('OPENAI_API_KEY ausente. Classificacao GPT desativada.');
    }
    if (process.env.NODE_ENV === 'development') {
      this.logger.debug('Modo de desenvolvimento - Controles especiais ativados');
      process.on('SIGINT', () => this.gracefulShutdown());
    }

    // Override console methods to suppress specific libsignal/baileys logs
    const originalConsoleError = console.error;
    const originalConsoleLog = console.log;
    const originalConsoleWarn = console.warn;

    const shouldSuppress = (args: any[]) => {
      const msg = args.map(arg => {
        if (typeof arg === 'string') return arg;
        return util.inspect(arg, { depth: null, colors: false, breakLength: Infinity });
      }).join(' ');

      const lowerMsg = msg.toLowerCase();
      return (
        lowerMsg.includes('bad mac') ||
        lowerMsg.includes('no session found') ||
        lowerMsg.includes('failed to decrypt') ||
        lowerMsg.includes('session error') ||
        lowerMsg.includes('no matching sessions found') ||
        lowerMsg.includes('sessionentry') ||
        lowerMsg.includes('closing session') ||
        lowerMsg.includes('closing open session') ||
        lowerMsg.includes('stream errored out') ||
        lowerMsg.includes('stream:error') ||
        lowerMsg.includes('Closing stale')
      );
    };

    console.error = (...args) => {
      if (shouldSuppress(args)) return;
      originalConsoleError.apply(console, args);
    };

    console.log = (...args) => {
      if (shouldSuppress(args)) return;
      originalConsoleLog.apply(console, args);
    };

    console.warn = (...args) => {
      if (shouldSuppress(args)) return;
      originalConsoleWarn.apply(console, args);
    };

    console.info = (...args) => {
      if (shouldSuppress(args)) return;
      originalConsoleWarn.apply(console, args);
    };

    console.debug = (...args) => {
      if (shouldSuppress(args)) return;
      originalConsoleWarn.apply(console, args);
    };
  }

  private logApiCall(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    meta?: Record<string, unknown>,
  ) {
    const metaSuffix = meta ? ` ${JSON.stringify(meta)}` : '';
    this.logger.debug(`[API:${method}] ${url}${metaSuffix}`);
  }

  private requestQrForPhone(phone: string) {
    this.qrRequests.set(phone, Date.now() + this.QR_REQUEST_TTL_MS);
  }

  private canEmitQr(phone: string): boolean {
    const expiresAt = this.qrRequests.get(phone);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
      this.qrRequests.delete(phone);
      return false;
    }
    return true;
  }

  private clearQrRequest(phone: string) {
    this.qrRequests.delete(phone);
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
    for (const [phone, sock] of this.sessions) {
      try {
        sock.end(undefined);
        this.logger.log(`[${phone}] Sessão encerrada (sem logout).`);
      } catch (e) {
        this.logger.error(`[${phone}] Erro ao encerrar sessão: ${e.message}`);
      }
    }
    this.sessions.clear();
    this.connectingSessions.clear();
    this.messageQueues.clear();
    this.syncedSessions.clear();
  }

  private getSessionPath(phone: string): string {
    // Sanitiza o número para evitar path traversal
    const sanitizedPhone = phone.replace(/[^0-9]/g, '');
    if (!sanitizedPhone || sanitizedPhone.length < 8) {
      throw new Error('Número de telefone inválido');
    }
    return path.join(this.SESSIONS_DIR, `session-${sanitizedPhone}`);
  }

  async connect(phone: string, options?: { requestQr?: boolean }): Promise<string | null> {
    if (this.sessions.has(phone) || this.connectingSessions.has(phone)) {
      this.logger.warn(`[${phone}] Conexão já estabelecida ou em progresso.`);
      return null;
    }

    if (options?.requestQr) {
      this.requestQrForPhone(phone);
    }

    this.connectingSessions.add(phone);
    const sessionPath = this.getSessionPath(phone);

    // Ensure the session directory exists before attempting to write credentials
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    return new Promise(async (resolve, reject) => {
      try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        const store = makeRedisStore({
          redis: this.redisService.client,
          logger: this.logger,
          prefix: `wa:${phone}:`,
        });

        const sock = makeWASocket({
          auth: state,
          browser: Browsers.macOS('Desktop'),
          logger: pino({ level: 'silent' }) as any,
          version: [2, 3000, 1028401180] as [number, number, number],
          syncFullHistory: true,
          getMessage: async (key) => {
            if (store) {
              try {
                const msg = await store.loadMessage(key.remoteJid, key.id);
                return msg?.message || undefined;
              } catch (error) {
                return undefined;
              }
            }
            return undefined;
          },
          cachedGroupMetadata: async (jid) => {
            try {
              const metadata = await store.fetchGroupMetadata(jid);
              if (metadata) {
                return metadata;
              }
            } catch (error) { }
            return null;
          }
        });

        store.bind(sock.ev);

        let promiseResolved = false;

        const timeout = setTimeout(() => {
          if (!promiseResolved) {
            promiseResolved = true;
            this.connectingSessions.delete(phone);
            this.clearQrRequest(phone);
            reject(new Error(`[${phone}] Tempo esgotado para conectar.`));
          }
        }, 30000); // 30 segundos de timeout

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async ({ messages }) => {
          for (const msg of messages || []) {
            if (!msg?.message) {
              continue;
            }
            if (msg?.key?.fromMe) {
              continue;
            }
            await this.handleIncoming(phone, msg);
          }
        });
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
            const shouldEmitQr = this.canEmitQr(phone);

            if (shouldEmitQr) {
            let conn = await this.connRepo.findOne({ where: { phoneNumber: phone } });
            if (!conn) {
              conn = this.connRepo.create({ phoneNumber: phone });
              await this.connRepo.save(conn);
            }
            await this.connRepo.update({ phoneNumber: phone }, { qrCodeUrl: qrUrl });
            await this.notifyFrontendStatus({
              phoneNumber: phone,
              status: 'connecting',
              qrCodeUrl: qrUrl,
            });
            } else {
              this.logger.debug(`[${phone}] QR recebido, mas nao solicitado; ignorando envio ao frontend.`);
            }

            if (!promiseResolved) {
              promiseResolved = true;
              clearTimeout(timeout);
              resolve(shouldEmitQr ? qrUrl : null);
            }
          }

          if (connection === 'open') {
            this.logger.log(`[${phone}] Conexão estabelecida com sucesso!`);
            this.sessions.set(phone, sock);
            this.connectingSessions.delete(phone);
            this.clearQrRequest(phone);
            await this.connRepo.update({ phoneNumber: phone }, { status: 'connected', qrCodeUrl: null });
            await this.notifyFrontendStatus({ phoneNumber: phone, status: 'connected', qrCodeUrl: null });

            if (!promiseResolved) {
              promiseResolved = true;
              clearTimeout(timeout);
              resolve(null); // Conectado sem QR code (restauração de sessão)
            }
          }

          if (connection === 'close') {
            const statusCode = (lastDisconnect.error as Boom)?.output?.statusCode;
            const reason = (lastDisconnect?.error as any)?.data?.reason;
            const disconnectMessage = (lastDisconnect?.error as any)?.message;

            this.connectingSessions.delete(phone);
            this.sessions.delete(phone);
            this.syncedSessions.delete(phone); // Limpa estado de sincronização
            await this.connRepo.update({ phoneNumber: phone }, { status: 'disconnected' });
            await this.notifyFrontendStatus({ phoneNumber: phone, status: 'disconnected', qrCodeUrl: null });

            this.logger.warn(
              `[${phone}] connection.close statusCode=${statusCode} reason=${reason || 'n/a'} message=${disconnectMessage || 'n/a'}`,
            );

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
              this.logger.warn(
                `[${phone}] Desconectado (logged out). Preservando sessão em disco para diagnóstico; QR pode ser solicitado novamente.`,
              );
              setTimeout(() => this.connect(phone), 5000);
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
    this.clearQrRequest(phone);

    const sessionPath = this.getSessionPath(phone);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    if (deleteFromDb) {
      await this.connRepo.delete({ phoneNumber: phone });
    }
    await this.notifyFrontendStatus({ phoneNumber: phone, status: 'disconnected', qrCodeUrl: null });
    this.logger.log(`[${phone}] Sessão desconectada e arquivos limpos.`);
  }

  private async enqueueMessage(phone: string, payload: MessagePayload) {
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
  ): Promise<{ success: boolean; messageId?: string; errorMessage?: string }> {
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Verifica se a sessão ainda está ativa antes de cada tentativa
      const sock = this.sessions.get(phone);
      if (!sock) {
        this.logger.error(`[SendRetry] Sessao ${phone} nao esta mais ativa. Abortando.`);
        return { success: false, errorMessage: 'Sessao nao esta ativa.' };
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
          return { success: true, messageId: result.key.id };
        }

        this.logger.warn(`[SendRetry] Resultado inesperado na tentativa ${attempt}: ${JSON.stringify(result)}`);
      } catch (error) {
        lastError = error.message;
        this.logger.error(`[SendRetry] Erro na tentativa ${attempt}/${maxRetries}: ${error.message}`);

        // Se for erro de Bad MAC, aguarda mais tempo
        if (error.message?.includes('Bad MAC')) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }
    return { success: false, errorMessage: lastError };
  }

  private async processMessageQueue(phone: string) {
    const sessionQueue = this.messageQueues.get(phone);
    if (!sessionQueue || sessionQueue.isProcessing) {
      return;
    }

    sessionQueue.isProcessing = true;
    this.logger.log(`[${phone}] Iniciando processamento da fila de mensagens.`);

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
        // Só espera sincronização para envios em massa; respostas devem ser rápidas
        if (!payload.isReply && !this.syncedSessions.has(phone)) {
          this.logger.log(`[${phone}] Aguardando sincronização da sessão antes de enviar mensagens...`);
          await this.waitForSync(phone, 30000);
        }
        let finalJid: string | null = null;

        if (payload.skipValidation) {
          finalJid = payload.to;
        } else {
          finalJid = await this.validatePhoneNumber(sock, payload.to);
        }

        if (!finalJid) {
          this.logger.error(`[Queue] Numero ${payload.to} invalido ou nao encontrado no WhatsApp. Mensagem descartada.`);
          if (payload.appointmentId) {
            await this.notifyConfirmationStatus({
              appointmentId: payload.appointmentId,
              status: 'FAILED',
              failedAt: new Date().toISOString(),
              recipientPhone: payload.to,
              errorMessage: 'Numero invalido ou nao encontrado no WhatsApp.',
            });
            await this.notifyConfirmationEvent({
              appointmentId: payload.appointmentId,
              type: 'FAILED',
              direction: 'OUTGOING',
              messageText: payload.text,
              phone: payload.to,
              errorMessage: 'Numero invalido ou nao encontrado no WhatsApp.',
              occurredAt: new Date().toISOString(),
            });
          }
          continue;
        }

        this.logger.log(`[Queue] Enviando mensagem para ${finalJid} a partir da fila.`);

        const sendResult = await this.sendMessageWithRetry(phone, finalJid, payload.text, 3);

        if (!sendResult.success) {
          this.logger.error(`[Queue] Falha ao enviar mensagem para ${finalJid} apos todas as tentativas.`);
          if (payload.appointmentId) {
            await this.notifyConfirmationStatus({
              appointmentId: payload.appointmentId,
              status: 'FAILED',
              failedAt: new Date().toISOString(),
              recipientPhone: payload.to,
              errorMessage: sendResult.errorMessage || 'Falha ao enviar mensagem.',
            });
            await this.notifyConfirmationEvent({
              appointmentId: payload.appointmentId,
              type: 'FAILED',
              direction: 'OUTGOING',
              messageText: payload.text,
              phone: payload.to,
              errorMessage: sendResult.errorMessage || 'Falha ao enviar mensagem.',
              occurredAt: new Date().toISOString(),
            });
          }
        } else if (payload.appointmentId) {
          await this.notifyConfirmationStatus({
            appointmentId: payload.appointmentId,
            status: 'SENT',
            sentAt: new Date().toISOString(),
            recipientPhone: payload.to,
            providerMessageId: sendResult.messageId,
          });
          await this.notifyConfirmationEvent({
            appointmentId: payload.appointmentId,
            type: 'SENT',
            direction: 'OUTGOING',
            messageText: payload.text,
            phone: payload.to,
            providerMessageId: sendResult.messageId,
            occurredAt: new Date().toISOString(),
          });
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

    const enqueued = await this.enqueueMessage(phone, {
      to,
      text,
      isReply: false,
      skipValidation: false,
      appointmentId,
    });
    if (!enqueued) {
      this.logger.error(`[${phone}] Enfileiramento falhou para o agendamento ${appointmentId}.`);
      throw new Error('Failed to enqueue message');
    }

    // Salva a pendência somente após o enfileiramento ter sucesso
    const cleanedTo = to.replace(/\D/g, '');
    const formattedPending = `${cleanedTo}@c.us`;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 6 * 60 * 60 * 1000);

    try {
      // Remove registros anteriores do mesmo appointment para evitar duplicatas
      await this.pendingRepo.delete({ appointmentId });

      const pending = this.pendingRepo.create({
        id: uuidv4(),
        appointmentId,
        phone: formattedPending,
        createdAt: now,
        expiresAt,
      });
      await this.pendingRepo.save(pending);
    } catch (error) {
      // Evita retentativas que poderiam duplicar envio; registra apenas.
      this.logger.error(
        `[${phone}] Falha ao salvar pendência para o agendamento ${appointmentId}: ${error.message}`,
      );
    }
  }

  private async handleIncoming(phone: string, message: WAMessage) {
    if (!message.key.id) return;

    // Deduplicação de mensagens
    if (this.processedMessages.has(message.key.id)) {
      this.logger.debug(`[${phone}] Mensagem ${message.key.id} ignorada (duplicada).`);
      return;
    }
    this.processedMessages.add(message.key.id);
    setTimeout(() => this.processedMessages.delete(message.key.id), 5000); // Limpa após 5 segundos

    const messageContent =
      message.message?.conversation ||
      message.message?.extendedTextMessage?.text ||
      message.message?.ephemeralMessage?.message?.conversation ||
      message.message?.ephemeralMessage?.message?.extendedTextMessage?.text;

    let fromJid = message.key.remoteJid;

    const key = message.key

    if (key.senderPn) {
      fromJid = key.senderPn;
    } else if (key.participant) {
      fromJid = key.participant;
    }

    if (!messageContent || !fromJid) return;
    this.logger.log(`[${phone}] Recebido de ${fromJid}: ${messageContent}`);

    const fromAsCus = fromJid.replace('@s.whatsapp.net', '@c.us');
    const phoneVariations = this.generatePhoneVariations(fromAsCus);

    const pending = await this.pendingRepo.findOne({
      where: { phone: In(phoneVariations), expiresAt: MoreThan(new Date()) },
      order: { createdAt: 'DESC' },
    });

    if (!pending) {
      this.logger.warn(
        `[${phone}] Sem pendência ativa para ${fromAsCus}. Variações: ${phoneVariations.join(', ')}`,
      );
      return;
    }

    await this.notifyConfirmationEvent({
      appointmentId: pending.appointmentId,
      type: 'INCOMING',
      direction: 'INCOMING',
      messageText: messageContent,
      phone: fromAsCus,
      occurredAt: new Date().toISOString(),
    });

    const normalizedText = this.normalize(messageContent);

    const confirmKeywords = ['confirmar', 'confirmado', 'confirmo', 'sim', 'ok'];
    const cancelKeywords = ['cancelar', 'cancelado', 'cancelo', 'nao'];

    const hasConfirmKeyword = confirmKeywords.some((kw) => normalizedText.includes(kw));
    const hasCancelKeyword = cancelKeywords.some((kw) => normalizedText.includes(kw));

    if (hasConfirmKeyword && !hasCancelKeyword) {
      this.logger.log(`[${phone}] Intenção 'Confirmar' detectada por palavra-chave em "${normalizedText}"`);
      return this.confirm(pending, phone, fromJid);
    }

    if (hasCancelKeyword && !hasConfirmKeyword) {
      this.logger.log(`[${phone}] Intenção 'Cancelar' detectada por palavra-chave em "${normalizedText}"`);
      return this.cancel(pending, phone, fromJid);
    }

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

    const gptIntent = await this.classifyIntentWithGpt(messageContent);
    if (gptIntent === 'confirmar') {
      this.logger.log(`[${phone}] Intenção 'Confirmar' detectada via GPT para "${messageContent}"`);
      return this.confirm(pending, phone, fromJid);
    }

    if (gptIntent === 'cancelar') {
      this.logger.log(`[${phone}] Intenção 'Cancelar' detectada via GPT para "${messageContent}"`);
      return this.cancel(pending, phone, fromJid);
    }

    await this.sendMessageSimple(
      phone,
      fromJid,
      'Desculpe, não entendi. Por favor, responda novamente para eu entender melhor.',
      pending.appointmentId,
    );
  }


  private async updateAppointmentStatusWithRetry(
    appointmentId: number,
    status: 'Confirmado' | 'Cancelado',
    reasonLack?: string,
  ): Promise<boolean> {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.logApiCall('PATCH', `http://localhost:3001/appointment/block/${appointmentId}`, {
          status,
          reasonLack: reasonLack || null,
          attempt,
        });
        await firstValueFrom(
          this.httpService.patch(
            `http://localhost:3001/appointment/block/${appointmentId}`,
            reasonLack ? { status, reasonLack } : { status },
            {
              headers: { 'x-internal-api-secret': process.env.API_SECRET },
              timeout: this.HTTP_TIMEOUT,
            },
          ),
        );
        return true;
      } catch (error) {
        this.logger.error(
          `Falha ao atualizar bloco para ${status} (tentativa ${attempt}/${maxAttempts}) para o appt ID ${appointmentId}: ${error.message}`,
        );
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    }
    return false;
  }


  private async confirm(conf: any, phone: string, from: string) {
    const updated = await this.updateAppointmentStatusWithRetry(conf.appointmentId, 'Confirmado');
    if (!updated) {
      await this.sendMessageSimple(
        phone,
        from,
        'Ocorreu um erro ao processar sua confirmacao. Por favor, tente novamente ou contate a clinica.',
        conf.appointmentId,
      );
      return;
    }

    await this.notifyConfirmationEvent({
      appointmentId: conf.appointmentId,
      type: 'CONFIRMED',
      direction: 'SYSTEM',
      occurredAt: new Date().toISOString(),
    });

    try {
      const details = await this.getAppointmentDetails(conf.appointmentId);

      // Determina se é paciente menor (tem responsável)
      const responsibleInfo = details.patient.patientResponsible?.[0]?.responsible;
      const isMinor = !!responsibleInfo;
      const variant = isMinor ? 'MINOR' : 'ADULT';

      // Tenta buscar template customizado
      const template = await this.getMessageTemplate(conf.appointmentId, 'CONFIRMATION', variant);

      let confirmationMessage: string;

      if (template && template.content) {
        // Usa template customizado
        const templateData = this.prepareTemplateData(details);
        confirmationMessage = this.renderTemplate(template.content, templateData);
        this.logger.log(`[${phone}] Usando template customizado de CONFIRMATION (${variant})`);
      } else {
        // Fallback para mensagem hardcoded
        const patientName = details.patient.personalInfo.name;
        const professionalName = details.professional.user.name;
        const clinicName = details.clinic.name;
        const appointmentDate = new Date(details.date).toLocaleDateString('pt-BR');
        const address = details.clinic.address;
        const clinicPhone = details.clinic.phone;
        const responsibleInfo = details.patient.patientResponsible?.[0]?.responsible;
        const recipientName = responsibleInfo?.name || details.patient.personalInfo.name;
        const greeting = responsibleInfo
          ? `Ola, ${recipientName}! O agendamento de ${patientName} com ${professionalName} na clinica ${clinicName} esta confirmado.`
          : `Ola, ${recipientName}! Seu agendamento com ${professionalName} na clinica ${clinicName} esta confirmado.`;

        const blockStartTime = new Date(details.blockStartTime);
        const blockEndTime = new Date(details.blockEndTime);
        const durationMinutes = (blockEndTime.getTime() - blockStartTime.getTime()) / (1000 * 60);

        confirmationMessage = `CONFIRMADO!

${greeting}

Data: ${appointmentDate}
Horario: Das ${blockStartTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} as ${blockEndTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
Duracao Estimada: ${durationMinutes} minutos
Local: ${address}

Por favor, chegue com alguns minutos de antecedencia. Em caso de duvidas ou se precisar reagendar, entre em contato.
Contato da Clinica: ${clinicPhone}

Ate la!
---
Esta e uma mensagem automatica. Por favor, nao responda.`;
      }

      await this.sendMessageSimple(
        phone,
        from,
        confirmationMessage,
        conf.appointmentId,
      );
    } catch (error) {
      this.logger.error(`Erro ao enviar confirmacao detalhada: ${error.message}`);
      await this.sendMessageSimple(
        phone,
        from,
        'Seu agendamento foi confirmado com sucesso!',
        conf.appointmentId,
      );
    }

    // Deleta TODOS os registros pendentes deste appointment (evita duplicatas órfãs)
    await this.pendingRepo.delete({ appointmentId: conf.appointmentId });
    await this.checkAndNotifyNextPendingAppointment(phone, from);
  }

  private async cancel(conf: any, phone: string, from: string) {
    const updated = await this.updateAppointmentStatusWithRetry(
      conf.appointmentId,
      'Cancelado',
      'Cancelado pelo WhatsApp',
    );
    if (!updated) {
      await this.sendMessageSimple(
        phone,
        from,
        'Ocorreu um erro ao processar seu cancelamento. Por favor, tente novamente ou contate a clinica.',
        conf.appointmentId,
      );
      return;
    }

    await this.notifyConfirmationEvent({
      appointmentId: conf.appointmentId,
      type: 'CANCELED',
      direction: 'SYSTEM',
      occurredAt: new Date().toISOString(),
    });

    try {
      const details = await this.getAppointmentDetails(conf.appointmentId);

      // Determina se é paciente menor (tem responsável)
      const responsibleInfo = details.patient.patientResponsible?.[0]?.responsible;
      const isMinor = !!responsibleInfo;
      const variant = isMinor ? 'MINOR' : 'ADULT';

      // Tenta buscar template customizado
      const template = await this.getMessageTemplate(conf.appointmentId, 'CANCELLATION', variant);

      let cancellationMessage: string;

      if (template && template.content) {
        // Usa template customizado
        const templateData = this.prepareTemplateData(details);
        cancellationMessage = this.renderTemplate(template.content, templateData);
        this.logger.log(`[${phone}] Usando template customizado de CANCELLATION (${variant})`);
      } else {
        // Fallback para mensagem hardcoded
        const patientName = details.patient.personalInfo.name;
        const professionalName = details.professional.user.name;
        const appointmentDate = new Date(details.date).toLocaleDateString('pt-BR');
        const clinicPhone = details.clinic.phone;
        const responsibleInfo = details.patient.patientResponsible?.[0]?.responsible;
        const recipientName = responsibleInfo?.name || details.patient.personalInfo.name;
        const greeting = responsibleInfo
          ? `Ola, ${recipientName}. Conforme sua solicitacao, o agendamento de ${patientName} com ${professionalName} no dia ${appointmentDate} foi cancelado com sucesso.`
          : `Ola, ${recipientName}. Conforme sua solicitacao, o agendamento com ${professionalName} no dia ${appointmentDate} foi cancelado com sucesso.`;

        cancellationMessage = `Agendamento Cancelado

${greeting}

Se desejar remarcar, por favor, entre em contato diretamente com a clinica.
Contato: ${clinicPhone}

Esperamos ve-lo em breve.
---
Esta e uma mensagem automatica.`;
      }

      await this.sendMessageSimple(
        phone,
        from,
        cancellationMessage,
        conf.appointmentId,
      );
    } catch (error) {
      this.logger.error(`Erro ao enviar cancelamento detalhado: ${error.message}`);
      const fallbackMessage = 'Seu agendamento foi cancelado conforme solicitado. Caso deseje remarcar, por favor, entre em contato diretamente com a clinica.';
      await this.sendMessageSimple(
        phone,
        from,
        fallbackMessage,
        conf.appointmentId,
      );
    }

    // Deleta TODOS os registros pendentes deste appointment (evita duplicatas órfãs)
    await this.pendingRepo.delete({ appointmentId: conf.appointmentId });
    await this.checkAndNotifyNextPendingAppointment(phone, from);
  }

  private async sendMessageSimple(
    phone: string,
    to: string,
    text: string,
    appointmentId?: number,
  ) {
    // Como 'to' aqui e um JID de uma mensagem recebida, ele ja e valido.
    await this.enqueueMessage(phone, {
      to: to,
      text,
      isReply: true,
      skipValidation: true,
      appointmentId,
    });
  }

  private async notifyConfirmationStatus(payload: {
    appointmentId: number;
    status: 'SENT' | 'FAILED';
    sentAt?: string;
    failedAt?: string;
    providerMessageId?: string;
    recipientPhone?: string;
    errorMessage?: string;
  }) {
    try {
      this.logApiCall('POST', 'http://localhost:3001/appointment/confirmation-message/status', {
        appointmentId: payload.appointmentId,
        status: payload.status,
        providerMessageId: payload.providerMessageId || null,
      });
      await firstValueFrom(
        this.httpService.post(
          'http://localhost:3001/appointment/confirmation-message/status',
          payload,
          {
            headers: { 'x-internal-api-secret': process.env.API_SECRET },
            timeout: this.HTTP_TIMEOUT,
          },
        ),
      );
    } catch (error) {
      this.logger.error(
        `Falha ao atualizar status de confirmacao do agendamento ${payload.appointmentId}: ${error.message}`,
      );
    }
  }

  private async notifyConfirmationEvent(payload: {
    appointmentId: number;
    type: 'QUEUED' | 'SENT' | 'FAILED' | 'INCOMING' | 'CONFIRMED' | 'CANCELED';
    direction?: 'INCOMING' | 'OUTGOING' | 'SYSTEM';
    messageText?: string;
    providerMessageId?: string;
    phone?: string;
    errorMessage?: string;
    occurredAt?: string;
  }) {
    try {
      this.logApiCall('POST', 'http://localhost:3001/appointment/confirmation-message/events', {
        appointmentId: payload.appointmentId,
        type: payload.type,
        direction: payload.direction || null,
      });
      await firstValueFrom(
        this.httpService.post(
          'http://localhost:3001/appointment/confirmation-message/events',
          payload,
          {
            headers: { 'x-internal-api-secret': process.env.API_SECRET },
            timeout: this.HTTP_TIMEOUT,
          },
        ),
      );
    } catch (error) {
      this.logger.error(
        `Falha ao registrar evento de confirmacao do agendamento ${payload.appointmentId}: ${error.message}`,
      );
    }
  }




  private async notifyFrontendStatus(payload: {
    phoneNumber: string;
    status?: string;
    qrCodeUrl?: string | null;
  }) {
    try {
      const now = Date.now();
      const last = this.lastFrontendStatus.get(payload.phoneNumber);
      const isSameStatus = last?.status === payload.status;
      const isSameQr = last?.qrCodeUrl === payload.qrCodeUrl;
      const tooSoon = last ? now - last.lastSentAt < this.FRONTEND_STATUS_DEDUP_MS : false;

      if (last && isSameStatus && isSameQr && tooSoon) {
        this.logger.debug(
          `[${payload.phoneNumber}] Ignorando status duplicado para frontend (status=${payload.status || 'n/a'}).`,
        );
        return;
      }

      this.lastFrontendStatus.set(payload.phoneNumber, {
        status: payload.status,
        qrCodeUrl: payload.qrCodeUrl,
        lastSentAt: now,
      });

      this.logApiCall('POST', 'http://localhost:3001/whatsapp/status-update', {
        phoneNumber: payload.phoneNumber,
        status: payload.status || null,
        hasQrCode: Boolean(payload.qrCodeUrl),
      });
      await firstValueFrom(
        this.httpService.post(
          'http://localhost:3001/whatsapp/status-update',
          payload,
          {
            headers: { 'x-internal-api-secret': process.env.API_SECRET },
            timeout: this.HTTP_TIMEOUT,
          },
        ),
      );
    } catch (e) {
      this.logger.error(`[${payload.phoneNumber}] Falha ao notificar o frontend sobre desconex?o: ${e.message}`);
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

  private async classifyIntentWithGpt(
    messageText: string,
  ): Promise<'confirmar' | 'cancelar' | 'inconclusivo'> {
    if (!this.openai) return 'inconclusivo';

    const systemPrompt =
      'Você classifica mensagens de confirmação de agendamento no WhatsApp. ' +
      'Responda somente com uma palavra: confirmar, cancelar, ou inconclusivo. ' +
      'Interprete erros de digitação e variações como se fossem a intenção original.';
    const userPrompt =
      `Mensagem do paciente/responsável: "${messageText}"
` +
      'Classifique se confirma o atendimento ou se cancela. Emojis contam (ex: 👍 confirma). ' +
      'Considere que respostas como "da sim", "da s*", "pode sim", "pode confirmar" e suas variáveis com tipos indicam confirmar.';

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4.1-nano',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'classify_intent',
              description: 'Classifica a intenção da mensagem do paciente.',
              parameters: {
                type: 'object',
                properties: {
                  intent: {
                    type: 'string',
                    enum: ['confirmar', 'cancelar', 'inconclusivo'],
                  },
                },
                required: ['intent'],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: {
          type: 'function',
          function: { name: 'classify_intent' },
        },
        temperature: 0,
        max_tokens: 50,
      });

      const toolCall = response.choices?.[0]?.message?.tool_calls?.[0];
      const args = toolCall?.function?.arguments;
      if (!args) return 'inconclusivo';
      try {
        const parsed = JSON.parse(args) as { intent?: string };
        this.logger.log(`Resposta do GPT para classificação: ${parsed.intent || 'inconclusivo'}`);
        if (parsed.intent === 'confirmar' || parsed.intent === 'cancelar') return parsed.intent;
        return 'inconclusivo';
      } catch (parseError) {
        const argsLower = args.toLowerCase();
        this.logger.warn(`Falha ao parsear JSON do GPT: ${parseError.message}. Args: ${args}`);
        if (argsLower.includes('confirm')) return 'confirmar';
        if (argsLower.includes('cancel')) return 'cancelar';
        return 'inconclusivo';
      }
    } catch (error) {
      this.logger.error(`Erro ao classificar com GPT: ${error.message}`);
      return 'inconclusivo';
    }
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

  /**
   * Busca template de mensagem customizado da API
   * @param appointmentId ID do agendamento
   * @param type Tipo do template: CONFIRMATION ou CANCELLATION
   * @param variant Variante do template: ADULT ou MINOR
   */
  private async getMessageTemplate(
    appointmentId: number,
    type: 'CONFIRMATION' | 'CANCELLATION',
    variant: 'ADULT' | 'MINOR' = 'ADULT',
  ): Promise<{ content: any[] } | null> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `http://localhost:3001/message-template/internal/${appointmentId}/${type}?variant=${variant}`,
          {
            headers: { 'x-internal-api-secret': process.env.API_SECRET },
            timeout: 5000,
          },
        ),
      );
      return response.data;
    } catch (error) {
      this.logger.warn(`Template ${type} (${variant}) não encontrado para agendamento ${appointmentId}, usando fallback: ${error.message}`);
      return null;
    }
  }

  /**
   * Mapa de emojis disponíveis para renderização de templates
   */
  private readonly EMOJI_MAP: Record<string, string> = {
    wave: '👋',
    check: '✅',
    warning: '⚠️',
    star: '⭐',
    heart: '❤️',
    thumbsUp: '👍',
    thumbsDown: '👎',
    clap: '👏',
    pray: '🙏',
    muscle: '💪',
    doctor: '🧑‍⚕️',
    nurse: '👨‍⚕️',
    hospital: '🏥',
    pill: '💊',
    syringe: '💉',
    stethoscope: '🩺',
    thermometer: '🌡️',
    bandage: '🩹',
    heartPulse: '💓',
    tooth: '🦷',
    calendar: '🗓️',
    clock: '⏰',
    hourglass: '⏳',
    alarm: '⏰',
    watch: '⌚',
    calendarCheck: '📅',
    soon: '🔜',
    timer: '⏱️',
    phone: '📞',
    cellphone: '📱',
    email: '📧',
    chat: '💬',
    speech: '🗣️',
    bell: '🔔',
    megaphone: '📢',
    envelope: '✉️',
    location: '📍',
    house: '🏠',
    building: '🏢',
    mapPin: '📌',
    compass: '🧭',
    globe: '🌍',
    clipboard: '📋',
    document: '📄',
    folder: '📁',
    pencil: '✏️',
    key: '🔑',
    gift: '🎁',
    camera: '📷',
    lightbulb: '💡',
    book: '📖',
    money: '💰',
    arrow: '➡️',
    arrowDown: '⬇️',
    arrowUp: '⬆️',
    checkMark: '✔️',
    crossMark: '❌',
    exclamation: '❗',
    question: '❓',
    info: 'ℹ️',
    sparkles: '✨',
    fire: '🔥',
    hundred: '💯',
    new: '🆕',
    free: '🆓',
    sos: '🆘',
    smile: '😊',
    grin: '😁',
    wink: '😉',
    love: '😍',
    thinking: '🤔',
    worried: '😟',
    sad: '😢',
    happy: '😃',
    cool: '😎',
    party: '🥳',
    robot: '🤖',
  };

  /**
   * Renderiza template de mensagem com dados do agendamento
   * @param elements Array de elementos do template
   * @param data Dados para preenchimento dos campos
   */
  private renderTemplate(
    elements: any[],
    data: Record<string, string>,
  ): string {
    if (!elements || !Array.isArray(elements)) {
      return '';
    }

    return elements
      .map((el) => {
        switch (el.type) {
          case 'text':
            return el.value || '';
          case 'field':
            if (!el.fieldKey) return '';
            return data[el.fieldKey] || '';
          case 'emoji':
            if (!el.emoji) return '';
            return this.EMOJI_MAP[el.emoji] || '';
          case 'linebreak':
            return '\n';
          default:
            return '';
        }
      })
      .join('');
  }

  /**
   * Prepara dados para renderização de template
   */
  private prepareTemplateData(details: any): Record<string, string> {
    const blockStartTime = new Date(details.blockStartTime);
    const blockEndTime = new Date(details.blockEndTime);
    const appointmentDate = new Date(details.date);

    // Formata período do bloco
    const dateFormatted = appointmentDate.toLocaleDateString('pt-BR');
    const startTimeFormatted = blockStartTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const endTimeFormatted = blockEndTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const formattedBlockPeriod = `${dateFormatted}, das ${startTimeFormatted} às ${endTimeFormatted}`;

    // Calcula duração
    const durationMinutes = Math.round((blockEndTime.getTime() - blockStartTime.getTime()) / (1000 * 60));

    // Prepara dados do responsável
    const responsibleInfo = details.patient.patientResponsible?.[0]?.responsible;
    const patientName = details.patient.personalInfo.name;
    const nameResponsible = responsibleInfo?.name || patientName;

    return {
      patientName,
      nameResponsible,
      clinicName: details.clinic.name,
      professionalName: details.professional.user.name,
      formattedBlockPeriod,
      address: details.clinic.address || '',
      location: details.location || '',
      clinicPhone: details.clinic.phone,
      appointmentDate: dateFormatted,
      appointmentTime: startTimeFormatted,
      duration: `${durationMinutes} minutos`,
    };
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

        await this.sendMessageSimple(
          phone,
          from,
          followUpMessage,
          nextPending.appointmentId,
        );
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
