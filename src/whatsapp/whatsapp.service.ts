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
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  WAMessage,
  WAMessageUpdate,
  WASocket,
  proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { RedisService } from '../redis/redis.service';
import { makeRedisStore } from './baileys-redis-store';
import OpenAI from 'openai';
import moment from 'moment-timezone';

// Timezone padrão do sistema (fallback)
const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

// Interface para a carga útil da mensagem na fila
interface MessagePayload {
  to: string; // Pode ser um número cru ou um JID completo
  text: string;
  isReply: boolean;
  appointmentId?: number;
  skipValidation?: boolean; // Flag para pular a validação em respostas
  createPendingConfirmation?: boolean; // Flag para criar PendingConfirmation após envio efetivo
}

interface PendingDeliveryEntry {
  phone: string;
  jid: string;
  enqueuedAt: number;
  appointmentId?: number;
  recipientPhone?: string;
  messageText?: string;
}

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private sessions = new Map<string, WASocket>();
  private connectingSessions = new Set<string>();
  private syncedSessions = new Set<string>(); // Rastreia sessões que completaram sincronização
  private readonly logger = new Logger(WhatsappService.name);
  private readonly openai?: OpenAI;
  private readonly SESSIONS_DIR = path.join(process.cwd(), '.baileys_auth');
  private readonly DEFAULT_WA_VERSION: [number, number, number] = [2, 3000, 1028401180];
  private cachedWaVersion?: [number, number, number];

  // Gerenciador de filas de mensagens para controlar o fluxo de envio
  private messageQueues = new Map<string, {
    queue: MessagePayload[];
    isProcessing: boolean;
  }>();

  // Duração da janela de resposta do PendingConfirmation (em ms)
  private readonly PENDING_CONFIRMATION_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

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

  // Controla reconexao automatica por sessao
  private reconnectAllowed = new Set<string>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();
  private disabledPhones = new Set<string>();

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

  // Rastreia mensagens enviadas aguardando confirmação de entrega do WhatsApp
  private pendingDelivery = new Map<string, PendingDeliveryEntry>();

  // Health check intervals por sessão
  private healthCheckIntervals = new Map<string, NodeJS.Timeout>();

  // Constantes de health check
  private readonly DELIVERY_TIMEOUT_MS = 3 * 60 * 1000;      // 3 min sem ACK = stale
  private readonly HEALTH_CHECK_INTERVAL_MS = 2 * 60 * 1000;  // Verifica a cada 2 min
  private readonly MAX_STALE_MESSAGES = 2;                     // 2 stale = reconectar

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
        lowerMsg.includes('closing stale open session') ||
        lowerMsg.includes('stream errored out') ||
        lowerMsg.includes('stream:error') ||
        lowerMsg.includes('restart required')
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

  private async getSocketVersion(): Promise<[number, number, number]> {
    if (this.cachedWaVersion) {
      return this.cachedWaVersion;
    }

    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest?.version?.length === 3) {
        this.cachedWaVersion = latest.version as [number, number, number];
        this.logger.log(
          `[WA] Usando versão ${this.cachedWaVersion.join('.')} (isLatest=${latest.isLatest}).`,
        );
        return this.cachedWaVersion;
      }
    } catch (error) {
      this.logger.warn(
        `[WA] Falha ao buscar versão mais recente. Usando fallback ${this.DEFAULT_WA_VERSION.join('.')}: ${error.message}`,
      );
    }

    this.cachedWaVersion = this.DEFAULT_WA_VERSION;
    return this.cachedWaVersion;
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
      this.logger.log(`Restaurando sessao para ${conn.phoneNumber}...`);
      this.reconnectAllowed.add(conn.phoneNumber);
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
    for (const phone of this.healthCheckIntervals.keys()) {
      this.stopHealthCheck(phone);
    }
    this.pendingDelivery.clear();
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

    if (this.disabledPhones.has(phone) && !options?.requestQr) {
      this.logger.warn(`[${phone}] Conexao bloqueada (desativada pelo usuario).`);
      return null;
    }

    if (
      !options?.requestQr &&
      !this.reconnectAllowed.has(phone) &&
      !this.canEmitQr(phone)
    ) {
      this.logger.warn(`[${phone}] Conexao ignorada (sem solicitacao de QR).`);
      return null;
    }


    if (options?.requestQr) {
      this.requestQrForPhone(phone);
      this.disabledPhones.delete(phone);
      // Permite reconexao automatica mesmo antes de chegar em "connection=open".
      this.reconnectAllowed.add(phone);
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
        const socketVersion = await this.getSocketVersion();

        const sock = makeWASocket({
          auth: state,
          browser: Browsers.macOS('Desktop'),
          logger: pino({ level: 'silent' }) as any,
          version: socketVersion,
          syncFullHistory: true,
          keepAliveIntervalMs: 15000,
          connectTimeoutMs: 60000,
          getMessage: async (key) => {
            if (store) {
              try {
                const msg = await store.loadMessage(
                  key.remoteJid,
                  key.id,
                  (key as any)?.remoteJidAlt,
                  key.participant,
                  (key as any)?.participantAlt,
                );
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
            this.reconnectAllowed.delete(phone);
            this.disabledPhones.add(phone);
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

        sock.ev.on('messages.update', (updates: WAMessageUpdate[]) => {
          for (const { key, update } of updates) {
            const status = (update as any)?.status;
            if (key?.id && status !== undefined && status >= 2) {
              // SERVER_ACK ou melhor = WhatsApp recebeu a mensagem
              void this.handleDeliveryAcknowledged(phone, key.id, status);
            }
          }
        });

        sock.ev.on('connection.update', async (update) => {
          const { connection, lastDisconnect, qr } = update;

          if (qr) {
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300`;
            const shouldEmitQr = this.canEmitQr(phone);

            if (!shouldEmitQr) {
              this.logger.warn(`[${phone}] QR recebido sem solicitacao; encerrando sessao.`);
              try {
                sock.end(undefined);
              } catch (e) {
                this.logger.error(`[${phone}] Falha ao encerrar sessao: ${e.message}`);
              }
              this.disabledPhones.add(phone);
              this.reconnectAllowed.delete(phone);
              if (!promiseResolved) {
                promiseResolved = true;
                clearTimeout(timeout);
                resolve(null);
              }
              return;
            }

            this.logger.log(`[${phone}] QR Code recebido.`);
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

            if (!promiseResolved) {
              promiseResolved = true;
              clearTimeout(timeout);
              resolve(qrUrl);
            }
          }

          if (connection === 'open') {
            this.logger.log(`[${phone}] Conexão estabelecida com sucesso!`);
            this.sessions.set(phone, sock);
            this.reconnectAllowed.add(phone);
            this.connectingSessions.delete(phone);
            this.clearQrRequest(phone);
            await this.connRepo.update({ phoneNumber: phone }, { status: 'connected', qrCodeUrl: null });
            await this.notifyFrontendStatus({ phoneNumber: phone, status: 'connected', qrCodeUrl: null });
            this.startHealthCheck(phone);
            const sessionQueue = this.messageQueues.get(phone);
            if (sessionQueue && sessionQueue.queue.length > 0 && !sessionQueue.isProcessing) {
              this.logger.log(
                `[${phone}] Retomando fila apos reconexao com ${sessionQueue.queue.length} mensagens pendentes.`,
              );
              void this.processMessageQueue(phone);
            }

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
            this.syncedSessions.delete(phone); // Limpa estado de sincronizacao
            this.stopHealthCheck(phone);
            await this.connRepo.update({ phoneNumber: phone }, { status: 'disconnected' });
            await this.notifyFrontendStatus({ phoneNumber: phone, status: 'disconnected', qrCodeUrl: null });

            this.logger.warn(
              `[${phone}] connection.close statusCode=${statusCode} reason=${reason || 'n/a'} message=${disconnectMessage || 'n/a'}`,
            );
            const shouldReconnect = this.reconnectAllowed.has(phone) || this.canEmitQr(phone);
            if (this.disabledPhones.has(phone)) {
              this.logger.warn(`[${phone}] Reconexao bloqueada (desativada pelo usuario).`);
              await this.failPendingDeliveryForPhone(
                phone,
                'Sessao desconectada e reconexao desativada antes da confirmacao de entrega.',
              );
              return;
            }


            if (statusCode === 405 || reason === '405') {
              this.logger.warn(`[${phone}] Erro 405 detectado. Limpando sessao completamente...`);

              if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
              }

              if (shouldReconnect) {
                const existingTimer = this.reconnectTimers.get(phone);
                if (existingTimer) {
                  clearTimeout(existingTimer);
                  this.reconnectTimers.delete(phone);
                }
                const timer = setTimeout(() => {
                  this.reconnectTimers.delete(phone);
                  this.logger.log(`[${phone}] Tentando reconectar apos erro 405...`);
                  this.connect(phone).catch(err => {
                    this.logger.error(`[${phone}] Falha na RECONEXAO automatica apos 405: ${err.message}`);
                  });
                }, 5000);
                this.reconnectTimers.set(phone, timer);
              } else {
                this.logger.warn(`[${phone}] Reconexao ignorada (sem solicitacao de QR).`);
              }

              if (!promiseResolved) {
                promiseResolved = true;
                clearTimeout(timeout);
                reject(new Error('Erro 405: Sessao corrompida. Reconexao automatica iniciada.'));
              }
              return;
            }

            if (!shouldReconnect) {
              this.logger.warn(`[${phone}] Reconexao ignorada (sem solicitacao de QR).`);
              await this.failPendingDeliveryForPhone(
                phone,
                'Sessao desconectada sem reconexao antes da confirmacao de entrega.',
              );
              return;
            }

            if (statusCode !== DisconnectReason.loggedOut) {
              const reconnectDelayMs =
                statusCode === DisconnectReason.restartRequired ? 1000 : 5000;
              if (statusCode === DisconnectReason.restartRequired) {
                this.logger.warn(
                  `[${phone}] Stream pediu restartRequired (515). Tentando reconectar rapidamente...`,
                );
              } else {
                this.logger.warn(
                  `[${phone}] Conexao fechada (codigo: ${statusCode}), tentando reconectar em ${reconnectDelayMs / 1000} segundos...`,
                );
              }
              const existingTimer = this.reconnectTimers.get(phone);
              if (existingTimer) {
                clearTimeout(existingTimer);
                this.reconnectTimers.delete(phone);
              }
              const timer = setTimeout(() => {
                this.reconnectTimers.delete(phone);
                this.connect(phone);
              }, reconnectDelayMs);
              this.reconnectTimers.set(phone, timer);
            } else {
              this.logger.warn(
                `[${phone}] Desconectado (logged out). Preservando sessao em disco para diagnostico; QR pode ser solicitado novamente.`,
              );
              const existingTimer = this.reconnectTimers.get(phone);
              if (existingTimer) {
                clearTimeout(existingTimer);
                this.reconnectTimers.delete(phone);
              }
              const timer = setTimeout(() => {
                this.reconnectTimers.delete(phone);
                this.connect(phone);
              }, 5000);
              this.reconnectTimers.set(phone, timer);
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
        this.reconnectAllowed.delete(phone);
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
    this.stopHealthCheck(phone);
    await this.failPendingDeliveryForPhone(
      phone,
      'Sessao desconectada antes da confirmacao de entrega.',
    );
    this.reconnectAllowed.delete(phone);
    const pendingTimer = this.reconnectTimers.get(phone);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.reconnectTimers.delete(phone);
    }
    this.clearQrRequest(phone);
    this.disabledPhones.add(phone);

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

        if (payload.appointmentId) {
          try {
            await this.pendingRepo.update(
              { appointmentId: payload.appointmentId },
              { phone: this.normalizeJidForPending(finalJid) },
            );
          } catch (error) {
            this.logger.warn(
              `[Queue] Falha ao atualizar pendencia ${payload.appointmentId} para JID ${finalJid}: ${error.message}`,
            );
          }
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
        } else {
          if (!sendResult.messageId) {
            if (payload.appointmentId) {
              await this.notifyConfirmationStatus({
                appointmentId: payload.appointmentId,
                status: 'FAILED',
                failedAt: new Date().toISOString(),
                recipientPhone: payload.to,
                errorMessage: 'Mensagem enviada sem ID de provedor.',
              });
              await this.notifyConfirmationEvent({
                appointmentId: payload.appointmentId,
                type: 'FAILED',
                direction: 'OUTGOING',
                messageText: payload.text,
                phone: payload.to,
                errorMessage: 'Mensagem enviada sem ID de provedor.',
                occurredAt: new Date().toISOString(),
              });
            }
            continue;
          }

          this.pendingDelivery.set(sendResult.messageId, {
            phone,
            jid: finalJid,
            enqueuedAt: Date.now(),
            appointmentId: payload.appointmentId,
            recipientPhone: payload.to,
            messageText: payload.text,
          });

          if (payload.appointmentId) {
            this.logger.log(
              `[Queue] Mensagem ${sendResult.messageId} do agendamento ${payload.appointmentId} aguardando ACK do WhatsApp.`,
            );
          }

          // Cria PendingConfirmation APÓS envio efetivo (não no enfileiramento)
          // para que a janela de resposta de 6h comece a contar a partir da entrega real
          if (payload.createPendingConfirmation) {
            await this.createPendingConfirmationAfterSend(
              phone,
              payload.to,
              payload.appointmentId,
            );
          }
        }

        const interval = this.getRandomInterval(payload.isReply);
        const type = payload.isReply ? 'resposta' : 'massa';
        this.logger.log(`[Queue] Aguardando ${interval}ms para a próxima mensagem (tipo: ${type}).`);
        await new Promise(resolve => setTimeout(resolve, interval));

      } catch (error) {
        this.logger.error(`[Queue] Erro ao enviar mensagem da fila para ${payload.to}: ${error.message}`);
        if (payload.appointmentId) {
          await this.notifyConfirmationStatus({
            appointmentId: payload.appointmentId,
            status: 'FAILED',
            failedAt: new Date().toISOString(),
            recipientPhone: payload.to,
            errorMessage: error.message || 'Erro inesperado no processamento da fila.',
          });
          await this.notifyConfirmationEvent({
            appointmentId: payload.appointmentId,
            type: 'FAILED',
            direction: 'OUTGOING',
            messageText: payload.text,
            phone: payload.to,
            errorMessage: error.message || 'Erro inesperado no processamento da fila.',
            occurredAt: new Date().toISOString(),
          });
        }
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

  private normalizeJidForPending(value?: string): string {
    if (!value) return '';
    const trimmed = value.trim();
    if (!trimmed) return '';

    if (trimmed.includes('@')) {
      return trimmed.replace('@s.whatsapp.net', '@c.us');
    }

    return trimmed.replace(/\D/g, '');
  }

  private buildPendingLookupCandidates(values: Array<string | undefined>): string[] {
    const candidates = new Set<string>();

    for (const raw of values) {
      const normalized = this.normalizeJidForPending(raw);
      if (!normalized) continue;

      candidates.add(normalized);

      if (!normalized.includes('@')) {
        for (const variation of this.generatePhoneVariations(normalized)) {
          candidates.add(variation);
        }
        continue;
      }

      const userPart = normalized.split('@')[0];
      if (/^\d+$/.test(userPart)) {
        for (const variation of this.generatePhoneVariations(userPart)) {
          candidates.add(variation);
        }
      }
    }

    return Array.from(candidates);
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
      createPendingConfirmation: true,
    });
    if (!enqueued) {
      this.logger.error(`[${phone}] Enfileiramento falhou para o agendamento ${appointmentId}.`);
      throw new Error('Failed to enqueue message');
    }

    // PendingConfirmation agora é criado APÓS o envio efetivo da mensagem
    // no processMessageQueue(), garantindo que a janela de 6h comece
    // a partir do momento real de entrega, não do enfileiramento.
  }

  /**
   * Cria PendingConfirmation após o envio efetivo da mensagem.
   * Garante que a janela de resposta de 6h comece a contar a partir
   * do momento em que a mensagem foi realmente entregue ao WhatsApp.
   */
  private async createPendingConfirmationAfterSend(
    phone: string,
    to: string,
    appointmentId: number,
  ): Promise<void> {
    const cleanedTo = to.replace(/\D/g, '');
    const normalizedTarget = this.normalizeJidForPending(to);
    const formattedPending = normalizedTarget || `${cleanedTo}@c.us`;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.PENDING_CONFIRMATION_TTL_MS);

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

      this.logger.log(
        `[${phone}] PendingConfirmation criado para appointment ${appointmentId} ` +
        `(phone=${formattedPending}, expiresAt=${expiresAt.toISOString()})`,
      );
    } catch (error) {
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

    const key = message.key;

    if ((key as any).participantAlt) {
      fromJid = (key as any).participantAlt;
    } else if ((key as any).remoteJidAlt) {
      fromJid = (key as any).remoteJidAlt;
    } else if (key.participant) {
      fromJid = key.participant;
    }

    if (!messageContent || !fromJid) return;
    this.logger.log(`[${phone}] Recebido de ${fromJid}: ${messageContent}`);

    const phoneVariations = this.buildPendingLookupCandidates([
      fromJid,
      key.remoteJid,
      key.participant,
      (key as any)?.remoteJidAlt,
      (key as any)?.participantAlt,
    ]);
    const canonicalFrom = this.normalizeJidForPending(fromJid);

    const pending = await this.pendingRepo.findOne({
      where: { phone: In(phoneVariations), expiresAt: MoreThan(new Date()) },
      order: { createdAt: 'DESC' },
    });

    if (!pending) {
      this.logger.warn(
        `[${phone}] Sem pendência ativa para ${canonicalFrom || fromJid}. Variações: ${phoneVariations.join(', ')}`,
      );

      const normalizedWithoutPending = this.normalize(messageContent);
      const confirmKeywords = ['confirmar', 'confirmado', 'confirmo', 'sim', 'ok'];
      const cancelKeywords = ['cancelar', 'cancelado', 'cancelo', 'nao'];
      const threshold = 2;
      const getMinDistance = (text: string, keywords: string[]): number => {
        return Math.min(
          ...keywords.map(kw => {
            const dist = this.levenshtein(text, kw);
            if (kw.length <= 3 && dist > 1) return 99;
            return dist;
          })
        );
      };
      const confirmDistance = getMinDistance(normalizedWithoutPending, confirmKeywords);
      const cancelDistance = getMinDistance(normalizedWithoutPending, cancelKeywords);
      const looksLikeDecisionIntent =
        confirmDistance <= threshold || cancelDistance <= threshold;

      if (looksLikeDecisionIntent) {
        await this.sendMessageSimple(
          phone,
          fromJid,
          'Nao encontramos uma confirmacao pendente para este numero no momento. ' +
          'Isso pode acontecer se a mensagem expirou ou se o atendimento ja foi processado. ' +
          'Por favor, entre em contato com a clinica para validar seu horario.',
        );
      }
      return;
    }

    await this.notifyConfirmationEvent({
      appointmentId: pending.appointmentId,
      type: 'INCOMING',
      direction: 'INCOMING',
      messageText: messageContent,
      phone: canonicalFrom || fromJid,
      occurredAt: new Date().toISOString(),
    });

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
        // Usa timezone da clínica ou fallback para timezone padrão
        const timezone = details.clinic?.timezone || DEFAULT_TIMEZONE;

        const patientName = details.patient.personalInfo.name;
        const professionalName = details.professional.user.name;
        const clinicName = details.clinic.name;
        const appointmentDate = moment(details.date).tz(timezone).format('DD/MM/YYYY');
        const address = details.clinic.address;
        const clinicPhone = details.clinic.phone;
        const responsibleInfo = details.patient.patientResponsible?.[0]?.responsible;
        const recipientName = responsibleInfo?.name || details.patient.personalInfo.name;
        const greeting = responsibleInfo
          ? `Ola, ${recipientName}! O agendamento de ${patientName} com ${professionalName} na clinica ${clinicName} esta confirmado.`
          : `Ola, ${recipientName}! Seu agendamento com ${professionalName} na clinica ${clinicName} esta confirmado.`;

        const blockStartTime = moment(details.blockStartTime).tz(timezone);
        const blockEndTime = moment(details.blockEndTime).tz(timezone);
        const durationMinutes = blockEndTime.diff(blockStartTime, 'minutes');

        confirmationMessage = `CONFIRMADO!

${greeting}

Data: ${appointmentDate}
Horario: Das ${blockStartTime.format('HH:mm')} as ${blockEndTime.format('HH:mm')}
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
    await this.checkAndNotifyNextPendingAppointment(phone, from, conf.appointmentId);
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
        // Usa timezone da clínica ou fallback para timezone padrão
        const timezone = details.clinic?.timezone || DEFAULT_TIMEZONE;

        const patientName = details.patient.personalInfo.name;
        const professionalName = details.professional.user.name;
        const appointmentDate = moment(details.date).tz(timezone).format('DD/MM/YYYY');
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
    await this.checkAndNotifyNextPendingAppointment(phone, from, conf.appointmentId);
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

  private async postInternalApiWithRetry(
    endpoint: string,
    payload: unknown,
    contextLabel: string,
    logMeta: Record<string, unknown>,
    maxAttempts = 3,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.logApiCall('POST', endpoint, {
          ...logMeta,
          attempt,
          maxAttempts,
        });
        await firstValueFrom(
          this.httpService.post(endpoint, payload, {
            headers: { 'x-internal-api-secret': process.env.API_SECRET },
            timeout: this.HTTP_TIMEOUT,
          }),
        );
        return true;
      } catch (error) {
        const baseMessage = `${contextLabel} (tentativa ${attempt}/${maxAttempts})`;
        if (attempt === maxAttempts) {
          this.logger.error(`${baseMessage}: ${error.message}`);
          return false;
        }
        this.logger.warn(`${baseMessage}: ${error.message}. Tentando novamente...`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
    return false;
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
    await this.postInternalApiWithRetry(
      'http://localhost:3001/appointment/confirmation-message/status',
      payload,
      `Falha ao atualizar status de confirmacao do agendamento ${payload.appointmentId}`,
      {
        appointmentId: payload.appointmentId,
        status: payload.status,
        providerMessageId: payload.providerMessageId || null,
      },
    );
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
    await this.postInternalApiWithRetry(
      'http://localhost:3001/appointment/confirmation-message/events',
      payload,
      `Falha ao registrar evento de confirmacao do agendamento ${payload.appointmentId}`,
      {
        appointmentId: payload.appointmentId,
        type: payload.type,
        direction: payload.direction || null,
      },
    );
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
    // Usa timezone da clínica ou fallback para timezone padrão
    const timezone = details.clinic?.timezone || DEFAULT_TIMEZONE;

    const blockStartTime = moment(details.blockStartTime).tz(timezone);
    const blockEndTime = moment(details.blockEndTime).tz(timezone);

    // Formata período do bloco
    const dateFormatted = blockStartTime.format('DD/MM/YYYY');
    const startTimeFormatted = blockStartTime.format('HH:mm');
    const endTimeFormatted = blockEndTime.format('HH:mm');
    const formattedBlockPeriod = `${dateFormatted}, das ${startTimeFormatted} às ${endTimeFormatted}`;

    // Calcula duração
    const durationMinutes = blockEndTime.diff(blockStartTime, 'minutes');

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
    if (!normalizedPhone) return [phone];

    const withoutNine = normalizedPhone.replace(/^(\d{4})(9?)(\d{8})$/, '$1$3');
    const withNine = normalizedPhone.replace(/^(\d{4})(\d{8})$/, '$19$2');

    return Array.from(new Set([
      `${withoutNine}@c.us`,
      `${withNine}@c.us`,
      `${withoutNine}@s.whatsapp.net`,
      `${withNine}@s.whatsapp.net`,
      `${withoutNine}@lid`,
      `${withNine}@lid`,
      withoutNine,
      withNine,
      phone,
    ]));
  }

  private isSameBlock(detailsA: any, detailsB: any): boolean {
    const startA = moment(detailsA?.blockStartTime);
    const endA = moment(detailsA?.blockEndTime);
    const startB = moment(detailsB?.blockStartTime);
    const endB = moment(detailsB?.blockEndTime);
    const dateA = moment(detailsA?.date);
    const dateB = moment(detailsB?.date);

    if (!startA.isValid() || !endA.isValid() || !startB.isValid() || !endB.isValid()) {
      return false;
    }

    if (!dateA.isValid() || !dateB.isValid()) {
      return false;
    }

    const sameClinic = detailsA?.clinic?.id && detailsB?.clinic?.id
      ? detailsA.clinic.id === detailsB.clinic.id
      : true;
    const sameDay = dateA.isSame(dateB, 'day');
    const sameWindow = startA.valueOf() === startB.valueOf() && endA.valueOf() === endB.valueOf();

    return sameClinic && sameDay && sameWindow;
  }

  private async checkAndNotifyNextPendingAppointment(
    phone: string,
    from: string,
    processedAppointmentId?: number,
  ) {
    const phoneVariations = this.buildPendingLookupCandidates([from]);

    const pendingForPhone = await this.pendingRepo.find({
      where: { phone: In(phoneVariations), expiresAt: MoreThan(new Date()) },
      order: { createdAt: 'ASC' },
    });

    if (!pendingForPhone.length) {
      return;
    }

    let processedDetails: any = null;
    if (processedAppointmentId) {
      try {
        processedDetails = await this.getAppointmentDetails(processedAppointmentId);
      } catch (error) {
        this.logger.warn(
          `Nao foi possivel carregar detalhes do appointment ${processedAppointmentId} para filtro de bloco: ${error.message}`,
        );
      }
    }

    for (const nextPending of pendingForPhone) {
      if (processedAppointmentId && nextPending.appointmentId === processedAppointmentId) {
        continue;
      }

      try {
        const details = await this.getAppointmentDetails(nextPending.appointmentId);

        // Nao envia follow-up se a pendencia for do mesmo bloco do appointment ja processado.
        if (processedDetails && this.isSameBlock(processedDetails, details)) {
          await this.pendingRepo.delete({ id: nextPending.id });
          this.logger.log(
            `PendingConfirmation ${nextPending.id} removida (appt ${nextPending.appointmentId}) por pertencer ao mesmo bloco do appointment ${processedAppointmentId}.`,
          );
          continue;
        }

        // Usa timezone da clinica ou fallback para timezone padrao
        const timezone = details.clinic?.timezone || DEFAULT_TIMEZONE;

        const patientName = details.patient.personalInfo.name;
        const professionalName = details.professional.user.name;
        const appointmentDate = moment(details.date).tz(timezone).format('DD/MM/YYYY');
        const appointmentTime = moment(details.blockStartTime).tz(timezone).format('HH:mm');

        const followUpMessage = `Obrigado, ${patientName}! Notamos que voce tambem tem um agendamento com o(a) profissional ${professionalName} no dia ${appointmentDate} as ${appointmentTime} que ainda nao foi respondido.

Deseja tambem *confirmar* ou *cancelar* este horario?`;

        await this.sendMessageSimple(
          phone,
          from,
          followUpMessage,
          nextPending.appointmentId,
        );
        this.logger.log(`Enviada mensagem de acompanhamento para o agendamento ${nextPending.appointmentId} para o numero ${from}.`);
        return;
      } catch (error) {
        this.logger.error(`Falha ao notificar proxima pendencia para ${from} (appt ${nextPending.appointmentId}): ${error.message}`);
      }
    }
  }
  private async handleDeliveryAcknowledged(
    phone: string,
    messageId: string,
    status: number,
  ) {
    const delivery = this.pendingDelivery.get(messageId);
    if (!delivery) {
      return;
    }

    this.pendingDelivery.delete(messageId);
    this.logger.debug(
      `[${phone}] Mensagem ${messageId} confirmada pelo servidor (status=${status}).`,
    );

    if (!delivery.appointmentId) {
      return;
    }

    await this.notifyConfirmationStatus({
      appointmentId: delivery.appointmentId,
      status: 'SENT',
      sentAt: new Date().toISOString(),
      recipientPhone: delivery.recipientPhone,
      providerMessageId: messageId,
    });

    await this.notifyConfirmationEvent({
      appointmentId: delivery.appointmentId,
      type: 'SENT',
      direction: 'OUTGOING',
      messageText: delivery.messageText,
      phone: delivery.recipientPhone,
      providerMessageId: messageId,
      occurredAt: new Date().toISOString(),
    });
  }

  private async failPendingDeliveryForPhone(phone: string, reason: string) {
    const entries = Array.from(this.pendingDelivery.entries());
    for (const [messageId, entry] of entries) {
      if (entry.phone !== phone) continue;

      if (entry.appointmentId) {
        await this.notifyConfirmationStatus({
          appointmentId: entry.appointmentId,
          status: 'FAILED',
          failedAt: new Date().toISOString(),
          recipientPhone: entry.recipientPhone,
          providerMessageId: messageId,
          errorMessage: reason,
        });

        await this.notifyConfirmationEvent({
          appointmentId: entry.appointmentId,
          type: 'FAILED',
          direction: 'OUTGOING',
          messageText: entry.messageText,
          phone: entry.recipientPhone,
          providerMessageId: messageId,
          errorMessage: reason,
          occurredAt: new Date().toISOString(),
        });
      }

      this.pendingDelivery.delete(messageId);
    }
  }

  private startHealthCheck(phone: string) {
    this.stopHealthCheck(phone);
    const interval = setInterval(() => {
      void this.checkSessionHealth(phone);
    }, this.HEALTH_CHECK_INTERVAL_MS);
    this.healthCheckIntervals.set(phone, interval);
    this.logger.log(`[${phone}] Health check de entrega iniciado (a cada ${this.HEALTH_CHECK_INTERVAL_MS / 1000}s).`);
  }

  private stopHealthCheck(phone: string) {
    const existing = this.healthCheckIntervals.get(phone);
    if (existing) {
      clearInterval(existing);
      this.healthCheckIntervals.delete(phone);
    }
  }

  private async checkSessionHealth(phone: string) {
    const now = Date.now();
    let staleCount = 0;

    for (const [msgId, entry] of this.pendingDelivery) {
      if (entry.phone !== phone) continue;
      const age = now - entry.enqueuedAt;

      if (age > this.DELIVERY_TIMEOUT_MS) {
        staleCount++;
      }
      // Limpar entradas muito antigas (>10min) para evitar memory leak
      if (age > 10 * 60 * 1000) {
        if (entry.appointmentId) {
          await this.notifyConfirmationStatus({
            appointmentId: entry.appointmentId,
            status: 'FAILED',
            failedAt: new Date().toISOString(),
            recipientPhone: entry.recipientPhone,
            providerMessageId: msgId,
            errorMessage: 'Timeout aguardando confirmacao de entrega do WhatsApp.',
          });
          await this.notifyConfirmationEvent({
            appointmentId: entry.appointmentId,
            type: 'FAILED',
            direction: 'OUTGOING',
            messageText: entry.messageText,
            phone: entry.recipientPhone,
            providerMessageId: msgId,
            errorMessage: 'Timeout aguardando confirmacao de entrega do WhatsApp.',
            occurredAt: new Date().toISOString(),
          });
        }
        this.pendingDelivery.delete(msgId);
      }
    }

    if (staleCount >= this.MAX_STALE_MESSAGES) {
      this.logger.warn(
        `[${phone}] Health check: ${staleCount} mensagens sem confirmação de entrega há mais de ${this.DELIVERY_TIMEOUT_MS / 60000}min. Forçando reconexão...`
      );
      this.forceReconnect(phone);
    }
  }

  private forceReconnect(phone: string) {
    this.stopHealthCheck(phone);
    const sock = this.sessions.get(phone);
    if (sock) {
      try {
        sock.end(undefined);
        // Dispara connection.update → close → auto-reconnect existente
        // Auth state preservado em disco = não precisa QR code
      } catch (e) {
        this.logger.error(`[${phone}] Erro ao forçar reconexão: ${e.message}`);
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
