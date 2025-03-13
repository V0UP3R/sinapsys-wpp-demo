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
        await this.client.sendMessage(
          message.from,
          'Não entendi sua resposta. Por favor, responda com "sim" para confirmar ou "não" para cancelar.'
        );
      }
    });

    this.client.initialize();
  }

  // Treinamento robusto do NLP com exemplos variados para confirmar ou cancelar
  private async trainNlp() {
    // Exemplos para intenção de confirmação
    const confirmExamples = [
      "sim",
      "confirmo",
      "está ok",
      "ok",
      "certo",
      "claro",
      "afirmativo",
      "estou de acordo",
      "com certeza",
      "acordo",
      "isso mesmo",
      "vou confirmar",
      "confirmar atendimento",
      "tudo certo",
      "concordo",
      "confirmado"
    ];
    confirmExamples.forEach(example => {
      this.nlpManager.addDocument('pt', example, 'confirmar');
    });

    // Exemplos para intenção de cancelamento
    const cancelExamples = [
      "não",
      "não quero",
      "cancela",
      "cancelado",
      "impossível",
      "recuso",
      "negativo",
      "não concordo",
      "não aceita",
      "não posso confirmar",
      "não desejo",
      "cancela atendimento",
      "deixa pra lá",
      "nem pensar",
      "não vou",
      "cancelar"
    ];
    cancelExamples.forEach(example => {
      this.nlpManager.addDocument('pt', example, 'cancelar');
    });

    // Intenção fallback para respostas ambíguas
    this.nlpManager.addDocument('pt', 'não entendi', 'fallback');
    this.nlpManager.addDocument('pt', 'pode repetir', 'fallback');

    // Treina o modelo
    console.log('Treinando o modelo NLP...');
    await this.nlpManager.train();
    this.nlpManager.save();
    console.log('Treinamento concluído.');
  }

  // Formata o número para o padrão do WhatsApp
  formatNumber(number: string): string {
    return number.replace('+', '') + '@c.us';
  }
  
  // Envia uma mensagem via WhatsApp
  async sendMessage(to: string, message: string) {
    const formattedTo = this.formatNumber(to);
    return this.client.sendMessage(formattedTo, message);
  }
}
