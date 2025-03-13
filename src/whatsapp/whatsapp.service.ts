// src/whatsapp/whatsapp.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Client, LocalAuth } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import { NlpManager } from 'node-nlp';

@Injectable()
export class WhatsappService implements OnModuleInit {
  private client: Client;
  private nlpManager: NlpManager;

  constructor() {
    // Inicializa o NLP Manager para o idioma português
    this.nlpManager = new NlpManager({ languages: ['pt'] });
    this.trainNlp();
    // Inicializa o cliente do WhatsApp com autenticação local (salva a sessão)
    this.client = new Client({
      puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
      authStrategy: new LocalAuth(),
    });
  }

  async onModuleInit() {
    // Exibe o QR code para autenticação
    this.client.on('qr', (qr) => {
      const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300`;
      console.log('Acesse o QR Code via o link:', qrCodeUrl);
    });

    this.client.on('ready', () => {
      console.log('Cliente do WhatsApp pronto!');
    });

    // Ao receber uma mensagem, processa a resposta com NLP
    this.client.on('message', async (message) => {
      console.log('Mensagem recebida:', message.body);
      const response = await this.nlpManager.process('pt', message.body);

      // Verifica o intent identificado e a confiança da resposta
      if (response.intent === 'confirmar' && response.score > 0.7) {
        await this.client.sendMessage(message.from, 'Ação confirmada!');
      } else if (response.intent === 'cancelar' && response.score > 0.7) {
        await this.client.sendMessage(message.from, 'Ação cancelada!');
      } else {
        await this.client.sendMessage(message.from, 'Não entendi sua resposta. Por favor, responda com "sim" para confirmar ou "não" para cancelar.');
      }
    });

    this.client.initialize();
  }

  // Treinamento simples do NLP com exemplos para confirmar ou cancelar
  private async trainNlp() {
    // Intenção de confirmação
    this.nlpManager.addDocument('pt', 'sim', 'confirmar');
    this.nlpManager.addDocument('pt', 'confirmo', 'confirmar');
    this.nlpManager.addDocument('pt', 'está ok', 'confirmar');

    // Intenção de cancelamento
    this.nlpManager.addDocument('pt', 'não', 'cancelar');
    this.nlpManager.addDocument('pt', 'cancela', 'cancelar');
    this.nlpManager.addDocument('pt', 'erro', 'cancelar');

    // Treina o modelo
    await this.nlpManager.train();
    this.nlpManager.save();
  }
  formatNumber(number: string): string {
    return number.replace('+', '') + '@c.us';
  }
  
  async sendMessage(to: string, message: string) {
    const formattedTo = this.formatNumber(to);
    return this.client.sendMessage(formattedTo, message);
  }
}
