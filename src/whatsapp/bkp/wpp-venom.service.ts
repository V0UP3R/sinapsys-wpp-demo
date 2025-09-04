// import {
//   Injectable,
//   Logger,
//   OnModuleDestroy,
//   OnModuleInit,
// } from '@nestjs/common';
// import { InjectRepository } from '@nestjs/typeorm';
// import { MoreThan, Repository } from 'typeorm';
// import { create, Whatsapp } from 'venom-bot';
// import { HttpService } from '@nestjs/axios';
// import { PendingConfirmation } from '../message/entities/message.entity';
// import { v4 as uuidv4 } from 'uuid';
// import { firstValueFrom } from 'rxjs';
// // import { confirmExamples, cancelExamples, greetExamples, thanksExamples } from './nlp.train'; // REMOVIDO
// import { WhatsappConnection } from './entities/whatsapp-connection.entity';
// // import { NlpManager } from 'node-nlp'; // REMOVIDO
// import { In } from 'typeorm';

// @Injectable()
// export class WhatsappService implements OnModuleInit, OnModuleDestroy {
//   private sessions = new Map<string, Whatsapp>();
//   // private nlpManager = new NlpManager({ languages: ['pt'] }); // REMOVIDO
//   private readonly logger = new Logger(WhatsappService.name);
//   // private readonly highThreshold = 0.9; // REMOVIDO
//   // private readonly lowThreshold = 0.7; // REMOVIDO

//   // Paths para Chrome/Chromium cross-platform
//   private readonly defaultChromeLinux = '/usr/bin/google-chrome-stable';
//   private readonly defaultChromeWin =
//     'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

//   constructor(
//     private readonly httpService: HttpService,
//     @InjectRepository(PendingConfirmation)
//     private readonly pendingRepo: Repository<PendingConfirmation>,
//     @InjectRepository(WhatsappConnection)
//     private readonly connRepo: Repository<WhatsappConnection>,
//   ) {
//     // this.trainNlp(); // REMOVIDO
//     if (process.env.NODE_ENV === 'development') {
//       this.logger.debug('Dev mode - special controls enabled');
//       process.on('SIGINT', () => this.gracefulShutdown());
//     }
//   }

//   async onModuleInit() {
//     const conns = await this.connRepo.find({ where: { status: 'connected' } });
//     for (const conn of conns) {
//       await this.restoreSession(conn.phoneNumber);
//     }
//   }

//   async onModuleDestroy() {
//     for (const sessionId of this.sessions.keys()) {
//       await this.disconnect(sessionId);
//     }
//   }

//   private getSessionOptions(sessionName: string) {
//     const options: Record<string, any> = {
//       headless: 'new',
//       browserArgs: [
//         '--no-sandbox',
//         '--disable-setuid-sandbox',
//         '--disable-dev-shm-usage',
//         '--no-first-run',
//         '--no-zygote',
//       ],
//       session: sessionName,
//     };
//     if (process.platform !== 'win32') {
//       options.executablePath = this.defaultChromeLinux;
//     }
//     return options;
//   }

//   private async restoreSession(phone: string) {
//     const sessionName = phone;
//     try {
//       const client = await create(
//         sessionName,
//         () => {},
//         async (statusSession) => {
//           if (statusSession === 'successChat') {
//             this.logger.log(`Reconnected session for ${phone}`);
//           }
//         },
//         this.getSessionOptions(sessionName),
//       );
//       client.onStateChange((state) => this.handleState(phone, state));
//       client.onStreamChange((stream) => this.logger.log(`Stream: ${stream}`));
//       client.onMessage((msg) => this.handleIncoming(phone, msg));
//       this.sessions.set(phone, client);
//       this.logger.log(`Session restored for ${phone}`);
//     } catch (err) {
//       this.logger.error(`Erro ao restaurar sessão ${phone}: ${err.message}`);
//     }
//   }

//   async connect(phone: string): Promise<string> {
//     let conn = await this.connRepo.findOne({ where: { phoneNumber: phone } });
//     if (!conn) {
//       conn = this.connRepo.create({ phoneNumber: phone });
//       conn = await this.connRepo.save(conn);
//     }
//     if (this.sessions.has(phone)) {
//       await this.disconnect(phone);
//     }

//     const sessionName = phone;
//     const qrPromise = new Promise<string>(async (resolve, reject) => {
//       try {
//         const client = await create(
//           sessionName,
//           async (base64Qr, asciiQR, attempt, urlCode) => {
//             const qrData = urlCode || asciiQR;
//             const url = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qrData)}&size=300x300`;
//             await this.connRepo.update(conn.id, { qrCodeUrl: url });
//             resolve(url);
//           },
//           async (statusSession, session) => {
//             if (statusSession === 'qrReadSuccess') {
//               await this.connRepo.update(
//                 { phoneNumber: phone },
//                 { status: 'connecting', qrCodeUrl: null },
//               );
//               await firstValueFrom(
//                 this.httpService.post(
//                   'http://localhost:3001/whatsapp/status-update',
//                   { phoneNumber: phone },
//                   {
//                     headers: {
//                       'x-internal-api-secret': process.env.API_SECRET,
//                     },
//                   },
//                 ),
//               );
//             }
//             if (statusSession === 'successChat') {
//               await this.connRepo.update(
//                 { phoneNumber: phone },
//                 { status: 'connected', qrCodeUrl: null },
//               );
//               await firstValueFrom(
//                 this.httpService.post(
//                   'http://localhost:3001/whatsapp/status-update',
//                   { phoneNumber: phone },
//                   {
//                     headers: {
//                       'x-internal-api-secret': process.env.API_SECRET,
//                     },
//                   },
//                 ),
//               );
//             }
//           },
//           this.getSessionOptions(sessionName),
//         );

//         client.onStateChange((state) => this.handleState(phone, state));
//         client.onStreamChange((status) => this.logger.log(`Stream: ${status}`));
//         client.onMessage((message) => this.handleIncoming(phone, message));
//         this.sessions.set(phone, client);
//       } catch (err) {
//         this.logger.error(
//           `Erro ao criar sessão Venom para ${phone}: ${err.message}`,
//           err.stack,
//         );
//         reject(err);
//       }
//     });

//     return qrPromise;
//   }

//   private gracefulShutdown() {
//     this.logger.warn('Graceful shutdown...');
//     this.onModuleDestroy()
//       .then(() => process.exit(0))
//       .catch(() => process.exit(1));
//   }

//   private async handleState(phone: string, state: string) {
//     this.logger.log(`[${phone}] State: ${state}`);
//     const cleanupStates = [
//       'DISCONNECTED',
//       'SYNC_CLOSED',
//       'UNPAIRED',
//       'CONFLICT',
//     ];
//     if (cleanupStates.includes(state)) {
//       this.logger.log(
//         `Estado ${state} detectado para ${phone}, removendo sessão e DB`,
//       );
//       await this.disconnect(phone);
//       await this.connRepo.delete({ phoneNumber: phone });
//     }
//   }

//   async disconnect(phone: string) {
//     await firstValueFrom(
//       this.httpService.post(
//         'http://localhost:3001/whatsapp/status-update',
//         { phoneNumber: phone },
//         { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
//       ),
//     );
//     const client = this.sessions.get(phone);
//     if (client) {
//       try {
//         await client.logout();
//       } catch (e) {
//         this.logger.warn(`Logout failed for ${phone}: ${e.message}`);
//       }
//       await client.close();
//     }
//     this.sessions.delete(phone);
//     await this.connRepo.delete({ phoneNumber: phone });
//   }

//   async getStatus(phone: string): Promise<string> {
//     const conn = await this.connRepo.findOne({ where: { phoneNumber: phone } });
//     return conn?.status || 'not-found';
//   }

//   async sendMessage(
//     phone: string,
//     to: string,
//     text: string,
//     appointmentId: number,
//   ) {
//     const client = this.sessions.get(phone);
//     if (!client) throw new Error('Client not connected');
//     const formatted = to.replace('+', '') + '@c.us';
//     const now = new Date();
//     const expiresAt = new Date(now.getTime() + 6 * 60 * 60 * 1000);
//     const pending = this.pendingRepo.create({
//       id: uuidv4(),
//       appointmentId,
//       phone: formatted,
//       createdAt: now,
//       expiresAt,
//     });
//     await this.pendingRepo.save(pending);
//     return client.sendText(formatted, text);
//   }

//   // MÉTODO PRINCIPAL ALTERADO
//   private async handleIncoming(phone: string, message: any) {
//     if (!message.body || typeof message.body !== 'string') return;
//     this.logger.log(`[${phone}] Received: ${message.body}`);

//     // Só processa quem tem pendência (lógica mantida)
//     const phoneVariations = this.generatePhoneVariations(message.from);

//     const pending = await this.pendingRepo.findOne({
//       where: {
//         phone: In(phoneVariations),
//         expiresAt: MoreThan(new Date())
//       },
//       order: { createdAt: 'DESC' },
//     });

//     if (!pending) return;

//     const normalizedText = this.normalize(message.body);

//     if (normalizedText === 'confirmar' || normalizedText === 'confirmado') {
//       return this.confirm(pending, phone, message.from);
//     }

//     if (normalizedText === 'cancelar'|| normalizedText === 'cancelado') {
//       return this.cancel(pending, phone, message.from);
//     }

//     // Se não for nenhuma das opções, envia uma mensagem de ajuda.
//     await this.sessions
//       .get(phone)
//       ?.sendText(
//         message.from,
//         'Desculpe, não entendi. Por favor, responda apenas com a palavra *confirmar* ou *cancelar*.',
//       );
//   }

//   private async confirm(conf: any, phone: string, from: string) {
//     // 1. Atualiza o status na API (como já fazia)
//     const { data: userData } = await this.getUserId(conf.appointmentId);
//     try {
//       await firstValueFrom(
//         this.httpService.patch(
//           `http://localhost:3001/appointment/block/${conf.appointmentId}`, // <- ROTA MODIFICADA
//           { status: 'Confirmado' }, // <- Corpo da requisição com o novo status
//           { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
//         ),
//       );
//     } catch (error) {
//        this.logger.error(`Falha ao atualizar bloco para CONFIRMADO para o appt ID ${conf.appointmentId}: ${error.message}`);
//        await this.sessions.get(phone)?.sendText(from, 'Ocorreu um erro ao processar sua confirmação. Por favor, tente novamente ou contate a clínica.');
//        return;
//     }

//     try {
//       // 2. Busca os detalhes completos do agendamento
//       const details = await this.getAppointmentDetails(conf.appointmentId);

//       const patientName = details.patient.personalInfo.name;
//       const professionalName = details.professional.user.name;
//       const clinicName = details.clinic.name;
//       const appointmentDate = new Date(details.date).toLocaleDateString(
//         'pt-BR',
//       ); // Formata a data
//       const address = details.clinic.address;
//       const clinicPhone = details.clinic.phone;

//       // Adicionado: Lógica para identificar o responsável
//       const responsibleInfo = details.patient.patientResponsible?.[0]?.responsible;
//       const recipientName = responsibleInfo?.name || details.patient.personalInfo.name;

//       // Adicionado: Identifica o tipo de saudação com base no destinatário
//       const greeting = responsibleInfo 
//             ? `Olá, ${recipientName}! O agendamento de ${patientName} com ${professionalName} na clínica ${clinicName} está confirmado.`
//             : `Olá, ${recipientName}! Seu agendamento com ${professionalName} na clínica ${clinicName} está confirmado.`;

//       const blockStartTime = new Date(details.blockStartTime);
//       const blockEndTime = new Date(details.blockEndTime);
//       const durationMinutes = (blockEndTime.getTime() - blockStartTime.getTime()) / (1000 * 60);

//       // 3. Monta a mensagem detalhada de confirmação
//       const confirmationMessage = `✅ *Confirmado!*

// ${greeting}

// 🗓️ *Data:* ${appointmentDate}
// ⏰ *Horário:* Das ${blockStartTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} às ${blockEndTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
// ⏳ *Duração Estimada:* ${durationMinutes} minutos
// 📍 *Local:* ${address}

// Por favor, chegue com alguns minutos de antecedência. Em caso de dúvidas ou se precisar reagendar, entre em contato.
// 📞 *Contato da Clínica:* ${clinicPhone}

// Até lá!
// ---
// _Esta é uma mensagem automática. Por favor, não responda._`;

//       await this.sessions.get(phone)?.sendText(from, confirmationMessage);
//     } catch (error) {
//       this.logger.error(
//         `Erro ao enviar confirmação detalhada: ${error.message}`,
//       );
//       // Fallback: envia uma mensagem simples se não conseguir buscar os detalhes
//       await this.sessions
//         .get(phone)
//         ?.sendText(from, 'Seu agendamento foi confirmado com sucesso!');
//     }

//     await this.pendingRepo.delete({ id: conf.id });

//     await this.checkAndNotifyNextPendingAppointment(phone, from);
//   }

//   private async cancel(conf: any, phone: string, from: string) {
//     // 1. Atualiza o status na API (como já fazia)
//     const { data: userData } = await this.getUserId(conf.appointmentId);
//     try {
//       await firstValueFrom(
//         this.httpService.patch(
//           `http://localhost:3001/appointment/block/${conf.appointmentId}`, // <- ROTA MODIFICADA
//           {
//             status: 'Cancelado', // <- Corpo da requisição
//             reasonLack: 'Cancelado pelo WhatsApp',
//           },
//           { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
//         ),
//       );
//     } catch (error) {
//       this.logger.error(`Falha ao atualizar bloco para CANCELADO para o appt ID ${conf.appointmentId}: ${error.message}`);
//       await this.sessions.get(phone)?.sendText(from, 'Ocorreu um erro ao processar seu cancelamento. Por favor, tente novamente ou contate a clínica.');
//       return;
//     }

//     try {
//       // 2. Busca os detalhes completos do agendamento
//       const details = await this.getAppointmentDetails(conf.appointmentId);

//       const patientName = details.patient.personalInfo.name;
//       const professionalName = details.professional.user.name;
//       const appointmentDate = new Date(details.date).toLocaleDateString(
//         'pt-BR',
//       );
//       const clinicPhone = details.clinic.phone;

//       // Adicionado: Lógica para identificar o responsável
//       const responsibleInfo = details.patient.patientResponsible?.[0]?.responsible;
//       const recipientName = responsibleInfo?.name || details.patient.personalInfo.name;

//       // Adicionado: Identifica o tipo de saudação com base no destinatário
//       const greeting = responsibleInfo 
//             ? `Olá, ${recipientName}. Conforme sua solicitação, o agendamento de ${patientName} com ${professionalName} no dia ${appointmentDate} foi cancelado com sucesso.`
//             : `Olá, ${recipientName}. Conforme sua solicitação, o agendamento com ${professionalName} no dia ${appointmentDate} foi cancelado com sucesso.`;

//       // 3. Monta a mensagem detalhada de cancelamento
//       const cancellationMessage = `❌ *Agendamento Cancelado*

// ${greeting}

// Se desejar remarcar, por favor, entre em contato diretamente com a clínica.
// 📞 *Contato:* ${clinicPhone}

// Esperamos vê-lo em breve.
// ---
// _Esta é uma mensagem automática._`;

//       await this.sessions.get(phone)?.sendText(from, cancellationMessage);
//     } catch (error) {
//       this.logger.error(
//         `Erro ao enviar cancelamento detalhado: ${error.message}`,
//       );
//       // Fallback: envia uma mensagem simples
//       const fallbackMessage =
//         'Seu agendamento foi cancelado conforme solicitado. Caso deseje remarcar, por favor, entre em contato diretamente com a clínica.';
//       await this.sessions.get(phone)?.sendText(from, fallbackMessage);
//     }

//     await this.pendingRepo.delete({ id: conf.id });

//     await this.checkAndNotifyNextPendingAppointment(phone, from);
//   }

//   private async getUserId(id: number) {
//     const response = await firstValueFrom(
//       this.httpService.get(
//         `http://localhost:3001/appointment/find/user/appointment/${id}`,
//         { headers: { 'x-internal-api-secret': process.env.API_SECRET } },
//       ),
//     );

//     this.logger.log(
//       `Response from API: ${response.status} - ${response.statusText}`,
//     );
//     return response;
//   }

//   // Função de normalização mantida, pois é muito útil
//   private normalize(text: string) {
//     return text
//       .toLowerCase()
//       .normalize('NFD')
//       .replace(/[\u0300-\u036f]/g, '') // remove acentos
//       .replace(/[^\w\s]/gi, '') // remove pontuação
//       .trim();
//   }

//   private async getAppointmentDetails(id: number): Promise<any> {
//     // ATENÇÃO: Verifique se este endpoint está correto conforme sua API.
//     const endpoint = `http://localhost:3001/appointment/details/${id}`;
//     this.logger.log(`Buscando detalhes do agendamento ID ${id} em ${endpoint}`);

//     try {
//       const response = await firstValueFrom(
//         this.httpService.get(endpoint, {
//           headers: { 'x-internal-api-secret': process.env.API_SECRET },
//         }),
//       );
//       return response.data; // Retorna os dados do agendamento
//     } catch (error) {
//       this.logger.error(
//         `Falha ao buscar detalhes do agendamento ${id}:`,
//         error.message,
//       );
//       throw new Error('Não foi possível obter os detalhes do agendamento.');
//     }
//   }
  
//   private generatePhoneVariations(phone: string): string[] {
//     const normalizedPhone = phone.replace(/\D/g, ''); // Remove caracteres não numéricos
//     if (normalizedPhone.length < 11) return [phone, `${phone}@c.us`];

//     const withoutNine = normalizedPhone.replace(/^(\d{4})(9?)(\d{8})$/, '$1$3');
//     const withNine = normalizedPhone.replace(/^(\d{4})(\d{8})$/, '$19$2');

//     return [
//       `${withoutNine}@c.us`,
//       `${withNine}@c.us`,
//       withoutNine,
//       withNine,
//     ];
//   }

//   private async checkAndNotifyNextPendingAppointment(phone: string, from: string) {
//     const phoneVariations = this.generatePhoneVariations(from);
//     const nextPending = await this.pendingRepo.findOne({
//       where: { phone: In(phoneVariations), expiresAt: MoreThan(new Date()) },
//       order: { createdAt: 'ASC' },
//     });

//     // Se encontrar outra pendência, notifica o paciente
//     if (nextPending) {
//       try {
//         const details = await this.getAppointmentDetails(nextPending.appointmentId);
//         const patientName = details.patient.personalInfo.name;
//         const professionalName = details.professional.user.name;
//         const appointmentDate = new Date(details.date).toLocaleDateString('pt-BR');
//         const appointmentTime = new Date(details.date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

//         const followUpMessage = `Obrigado, ${patientName}! Notamos que você também tem um agendamento com o(a) profissional ${professionalName} no dia ${appointmentDate} às ${appointmentTime} que ainda não foi respondido.

// Deseja também *confirmar* ou *cancelar* este horário?`;

//         await this.sessions.get(phone)?.sendText(from, followUpMessage);
//         this.logger.log(`Enviada mensagem de acompanhamento para o agendamento ${nextPending.appointmentId} para o número ${from}.`);
//       } catch (error) {
//         this.logger.error(`Falha ao notificar próxima pendência para ${from}: ${error.message}`);
//       }
//     }
//   }
// }
