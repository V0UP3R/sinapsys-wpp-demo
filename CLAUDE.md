# CLAUDE.md

Este arquivo fornece orientação ao Claude Code (claude.ai/code) ao trabalhar com código neste repositório.

## Visão Geral do Projeto

Este é um serviço de integração com WhatsApp construído com NestJS que fornece funcionalidade de confirmação de agendamentos via WhatsApp. O serviço utiliza Baileys (WhatsApp Web.js) para conectividade com WhatsApp e inclui NLP (node-nlp) para classificação de intenções de mensagens.

Este projeto funciona como um **microsserviço complementar** ao **sinapsys-api** (sistema principal de gestão de clínicas), sendo responsável exclusivamente pelo gerenciamento de conexões WhatsApp e envio/recebimento de mensagens.

## Comandos

### Desenvolvimento
```bash
npm run start:dev          # Iniciar em modo desenvolvimento com watch
npm run start:debug        # Iniciar em modo debug com watch
npm run start              # Iniciar normalmente
npm run start:prod         # Iniciar em modo produção
```

### Build
```bash
npm run build              # Build de produção
npm run vercel-build       # Build para deploy no Vercel (inclui criação de diretórios)
npm run create-dirs        # Criar diretórios necessários (tmp/.wwebjs_auth/session)
```

### Testes
```bash
npm run test               # Executar testes unitários
npm run test:watch         # Executar testes em modo watch
npm run test:cov           # Executar testes com cobertura
npm run test:debug         # Executar testes em modo debug
npm run test:e2e           # Executar testes end-to-end
```

### Qualidade de Código
```bash
npm run lint               # Executar ESLint com auto-fix
npm run format             # Formatar código com Prettier
```

### Comandos Especiais
```bash
npm run train-model        # Treinar o modelo NLP (usa WhatsappService.trainModel())
```

## Arquitetura

### Módulos Principais

A aplicação está organizada em três módulos principais:

1. **WhatsappModule** (`src/whatsapp/`)
   - Gerencia conexões WhatsApp usando biblioteca Baileys
   - Lida com gerenciamento multi-sessão (Map de sessões por número de telefone)
   - Implementa fila de mensagens com rate limiting:
     - Respostas interativas: intervalos de 2-5 segundos
     - Mensagens em massa: intervalos de 30-60 segundos
   - Armazena autenticação de sessão no diretório `.baileys_auth/`
   - Lógica de auto-reconexão com tratamento especial para erro 405 (sessão corrompida)
   - Geração de QR code para conexão inicial
   - Entidades: `WhatsappConnection` (rastreia status de conexão, QR codes, dados de sessão)

2. **MessageModule** (`src/message/`)
   - Gerencia confirmações de agendamento pendentes
   - Expõe endpoints de API para integração com sinapsys-api
   - Entidade: `PendingConfirmation` (appointmentId, phone, createdAt, expiresAt)
   - MessageService contém apenas operações CRUD placeholder

3. **AuthModule** (`src/auth/`)
   - Autenticação baseada em JWT com Passport
   - `InternalApiGuard` customizado usando headers de data criptografada (x-encrypted-date)
   - Validação baseada em tempo (janela de expiração de 5 minutos)
   - Usa decorator `@Public()` para ignorar autenticação em endpoints específicos
   - Credenciais demo hardcoded (username: 'user', password: 'password')

### Banco de Dados

- **TypeORM** com PostgreSQL
- Conexão via variável de ambiente `DATABASE_URL`
- SSL habilitado com `rejectUnauthorized: false`
- `synchronize: false` - schema do banco deve ser gerenciado manualmente
- Entidades: `PendingConfirmation`, `WhatsappConnection`
- **Sem diretório de migrations** - mudanças no schema requerem SQL manual ou TypeORM synchronize

### Arquitetura do WhatsApp Service

O `WhatsappService` é o núcleo da aplicação:

- **Gerenciamento de Sessões**: Cada número de telefone tem seu próprio socket Baileys armazenado em um Map
- **Ciclo de Vida da Conexão**:
  - `onModuleInit`: Restaura todas as sessões 'connected' do banco de dados
  - `onModuleDestroy`: Desconecta graciosamente todas as sessões ativas
  - `connect(phone)`: Cria nova conexão, gera QR code, lida com reconexão
  - `disconnect(phone)`: Fecha sessão e limpa recursos

- **Sistema de Fila de Mensagens**:
  - Cada sessão tem sua própria fila de mensagens
  - Processamento sequencial para evitar rate limiting
  - Intervalos diferentes para respostas vs mensagens em massa
  - Flag `skipValidation` para ignorar validação em respostas

- **Event Handlers**:
  - `messages.upsert`: Processa mensagens recebidas via `handleIncoming()`
  - `connection.update`: Lida com QR codes, status de conexão, desconexões
  - `creds.update`: Salva credenciais de autenticação

- **Tratamento de Erros**:
  - Erro 405 (bad MAC): Deleta sessão completamente e auto-reconecta
  - Outras razões de desconexão: Auto-reconexão após 5 segundos
  - Logout: Remoção permanente da sessão

### Integração NLP

- Usa `node-nlp` para classificação de intenções
- Dados de treinamento em `src/whatsapp/nlp.train.ts`:
  - `confirmExamples`: Intenções de confirmação de agendamento
  - `cancelExamples`: Intenções de cancelamento de agendamento
  - `greetExamples`: Intenções de saudação
  - `thanksExamples`: Intenções de agradecimento
- Treinar modelo com: `npm run train-model`
- **Algoritmo de Levenshtein**: Usa distância de edição (threshold de 2 caracteres) para detectar intenções mesmo com erros de digitação

### Bootstrap da Aplicação

- Executa na porta **3002**
- Recursos do modo desenvolvimento:
  - Habilita shutdown hooks
  - Adiciona header `X-Dev-Mode: active` às respostas
  - Define `snapshot: false`
- Níveis de logging: error, warn, log, debug, verbose
- `abortOnError: false` para tratamento gracioso de erros

## Integração com sinapsys-api

O sinapsys-wpp-demo funciona como um **serviço satélite** do sinapsys-api, comunicando-se através de requisições HTTP autenticadas.

### API URL
- **Base URL**: `http://localhost:3001` (sinapsys-api)
- **Porta deste serviço**: `3002`

### Autenticação entre Serviços

Todas as requisições entre os serviços usam o header `x-internal-api-secret` com o valor de `process.env.API_SECRET`.

### Endpoints Expostos (sinapsys-api → sinapsys-wpp-demo)

Este serviço expõe endpoints que são chamados pelo sinapsys-api:

#### 1. `POST /message/connect`
**Propósito**: Iniciar nova sessão WhatsApp e obter QR code
**Body**: `{ phone: string }`
**Response**: `{ qrCodeUrl: string }`
**Autenticação**: `InternalApiGuard` (x-encrypted-date)
**Comportamento**:
- Cria socket Baileys para o número fornecido
- Gera QR code via api.qrserver.com
- Salva conexão no banco com status inicial
- Retorna URL do QR code para o frontend exibir

#### 2. `POST /message/send`
**Propósito**: Enviar mensagem de confirmação de agendamento
**Body**: `{ phone: string, to: string, message: string, appointmentId: number }`
**Response**: `{ status: 'Mensagem enviada!' }`
**Autenticação**: `InternalApiGuard` (x-encrypted-date)
**Comportamento**:
- Valida que existe sessão ativa para o número `phone`
- Cria registro `PendingConfirmation` no banco (expira em 6 horas)
- Enfileira mensagem para envio com validação de número WhatsApp
- Processa fila respeitando rate limits (30-60s para mensagens em massa)

#### 3. `POST /message/disconnect`
**Propósito**: Desconectar sessão WhatsApp
**Body**: `{ phone: string }`
**Response**: `{ success: boolean }`
**Autenticação**: `InternalApiGuard` (x-encrypted-date)
**Comportamento**:
- Faz logout da sessão Baileys
- Remove sessão do Map em memória
- Deleta arquivos de autenticação em `.baileys_auth/`
- Remove registro do banco de dados

#### 4. `POST /auth/login`
**Propósito**: Autenticação JWT (não usado pela integração interna)
**Body**: `{ username: string, password: string }`
**Response**: `{ access_token: string }`
**Autenticação**: Pública
**Nota**: Credenciais hardcoded para demo

### Chamadas de API (sinapsys-wpp-demo → sinapsys-api)

Este serviço faz as seguintes chamadas para o sinapsys-api:

#### 1. `PATCH /appointment/block/:appointmentId` (Confirmação)
**Quando**: Usuário responde com intenção de confirmar
**Body**: `{ status: 'Confirmado' }`
**Headers**: `{ 'x-internal-api-secret': process.env.API_SECRET }`
**Localização**: `whatsapp.service.ts:477-483` (método `confirm()`)
**Comportamento**:
- Atualiza status do bloco de agendamento no sinapsys-api
- Se sucesso, busca detalhes e envia mensagem de confirmação formatada
- Se erro, informa ao usuário

#### 2. `PATCH /appointment/block/:appointmentId` (Cancelamento)
**Quando**: Usuário responde com intenção de cancelar
**Body**: `{ status: 'Cancelado', reasonLack: 'Cancelado pelo WhatsApp' }`
**Headers**: `{ 'x-internal-api-secret': process.env.API_SECRET }`
**Localização**: `whatsapp.service.ts:535-541` (método `cancel()`)
**Comportamento**:
- Atualiza status do bloco de agendamento para cancelado
- Se sucesso, busca detalhes e envia mensagem de cancelamento formatada
- Se erro, informa ao usuário

#### 3. `GET /appointment/details/:appointmentId`
**Quando**: Após confirmação/cancelamento para buscar dados completos
**Headers**: `{ 'x-internal-api-secret': process.env.API_SECRET }`
**Localização**: `whatsapp.service.ts:624-637` (método `getAppointmentDetails()`)
**Response esperada**:
```typescript
{
  patient: {
    personalInfo: { name: string },
    patientResponsible: [{ responsible: { name: string } }]
  },
  professional: {
    user: { name: string }
  },
  clinic: {
    name: string,
    address: string,
    phone: string
  },
  date: string,
  blockStartTime: string,
  blockEndTime: string
}
```
**Comportamento**:
- Busca informações detalhadas para montar mensagens personalizadas
- Usado para confirmar/cancelar agendamentos e notificar próximas pendências

#### 4. `POST /whatsapp/status-update`
**Quando**: Sempre que status de conexão muda (conectado/desconectado)
**Body**: `{ phoneNumber: string }`
**Headers**: `{ 'x-internal-api-secret': process.env.API_SECRET }`
**Localização**: `whatsapp.service.ts:586-598` (método `notifyFrontendStatus()`)
**Comportamento**:
- Notifica o sinapsys-api sobre mudanças de status
- Permite que frontend atualize UI em tempo real
- Falhas são logadas mas não impedem funcionamento

### Fluxo de Interação Completo

**Fluxo de Envio de Mensagem (Agendamento Criado)**:
1. Usuário cria agendamento no sinapsys-api
2. sinapsys-api → `POST /message/send` (sinapsys-wpp-demo)
3. sinapsys-wpp-demo valida número, enfileira mensagem
4. Mensagem enviada via WhatsApp respeitando rate limit
5. `PendingConfirmation` criado com expiração de 6 horas

**Fluxo de Resposta do Paciente**:
1. Paciente responde via WhatsApp
2. Baileys dispara evento `messages.upsert`
3. `handleIncoming()` processa mensagem
4. Busca `PendingConfirmation` correspondente (com variações de número)
5. Algoritmo de Levenshtein detecta intenção (confirmar/cancelar)
6. sinapsys-wpp-demo → `PATCH /appointment/block/:id` (sinapsys-api)
7. sinapsys-wpp-demo → `GET /appointment/details/:id` (sinapsys-api)
8. Mensagem de confirmação/cancelamento enviada ao paciente
9. `PendingConfirmation` removido do banco
10. Verifica próximas pendências do mesmo paciente (`checkAndNotifyNextPendingAppointment`)

**Fluxo de Conexão WhatsApp**:
1. Usuário clica em "Conectar WhatsApp" no sinapsys-api frontend
2. sinapsys-api → `POST /message/connect` (sinapsys-wpp-demo)
3. sinapsys-wpp-demo cria socket Baileys, gera QR code
4. QR code retornado para exibição
5. Usuário escaneia QR code no celular
6. Baileys dispara evento `connection.update` (status: 'open')
7. sinapsys-wpp-demo → `POST /whatsapp/status-update` (sinapsys-api)
8. Frontend atualiza status para "Conectado"

### Validação de Números

O serviço implementa lógica sofisticada para números brasileiros:
- Testa variações com/sem 9º dígito (55XX9XXXXXXXX vs 55XXXXXXXXX)
- Usa método `sock.onWhatsApp()` para validar existência da conta
- Armazena múltiplas variações do número em `PendingConfirmation` para matching
- Evita erros de envio para números inválidos

## Variáveis de Ambiente

Variáveis de ambiente necessárias (criar arquivo `.env`):

```
DATABASE_URL=postgresql://user:password@host:port/database
JWT_SECRET=your-jwt-secret
INTERNAL_KEY=your-internal-encryption-key
API_SECRET=shared-secret-with-sinapsys-api
NODE_ENV=development|production
```

**Importante**: `API_SECRET` deve ser o mesmo valor configurado no sinapsys-api.

## Estrutura de Arquivos

```
src/
├── auth/               # Autenticação e autorização
│   ├── guards/         # JwtAuthGuard, InternalApiGuard
│   ├── decorators/     # Decorator @Public()
│   └── jwt.strategy.ts
├── message/            # Gerenciamento de confirmações de agendamento
│   ├── entities/       # Entidade PendingConfirmation
│   └── message.controller.ts # Endpoints de API
├── whatsapp/           # Integração WhatsApp
│   ├── entities/       # Entidade WhatsappConnection
│   ├── nlp.train.ts    # Dados de treinamento NLP
│   └── whatsapp.service.ts # Lógica core do WhatsApp
└── main.ts             # Ponto de entrada da aplicação
```

## Notas Importantes de Implementação

1. **Estado de Sessão WhatsApp**: Sessões são armazenadas em `.baileys_auth/session-{phone}/` - nunca commitar este diretório

2. **Schema do Banco**: Não há migrations. Schema deve corresponder às entities ou usar `synchronize: true` em desenvolvimento

3. **Fluxo de Autenticação**:
   - Chamadas de API internas usam validação de header de data criptografada
   - Rotas públicas precisam do decorator `@Public()`
   - Autenticação JWT está disponível mas InternalApiGuard tem precedência

4. **Rate Limiting**: O sistema de fila de mensagens previne banimentos do WhatsApp. Sempre usar a fila, nunca enviar mensagens diretamente

5. **Modo Desenvolvimento**: Handlers de graceful shutdown são habilitados em desenvolvimento. Use SIGINT (Ctrl+C) para shutdown limpo

6. **Configuração TypeScript**: Modo strict desabilitado (`strictNullChecks: false`, `noImplicitAny: false`)

7. **Validação de Telefone**: Para números brasileiros, o sistema automaticamente testa variações com/sem 9º dígito

8. **Matching de Números**: `PendingConfirmation` usa array de variações para matching robusto de números

## Armadilhas Comuns

- A opção `synchronize` está `false` em produção - mudanças no schema requerem intervenção manual
- Sessões WhatsApp podem corromper (erro 405) - serviço lida com isso via auto-limpeza e reconexão
- Filas de mensagem processam sequencialmente por sessão - não esperar entrega imediata
- Modelo NLP precisa de treinamento antes do primeiro uso com `npm run train-model`
- InternalApiGuard verifica freshness de timestamp (janela de 5 minutos) - relógios dos clientes devem estar sincronizados
- URLs da API estão hardcoded como `localhost:3001` - ajustar para produção
- O header `x-internal-api-secret` deve corresponder ao valor no sinapsys-api
- `PendingConfirmation` expira em 6 horas - respostas após esse período são ignoradas
- Algoritmo de Levenshtein com threshold=2 pode aceitar palavras muito similares - ajustar se necessário
