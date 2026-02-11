import { Test, TestingModule } from '@nestjs/testing';
import { MessageController } from './message.controller';
import { WhatsappService } from '../whatsapp/whatsapp.service';

jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  Browsers: {
    macOS: jest.fn().mockReturnValue(['MacOS', 'Desktop', '1.0.0']),
  },
  DisconnectReason: {
    loggedOut: 401,
    restartRequired: 515,
  },
  useMultiFileAuthState: jest.fn().mockResolvedValue({
    state: {
      creds: {},
      keys: {},
    },
    saveCreds: jest.fn(),
  }),
  proto: {},
}));

describe('MessageController', () => {
  let controller: MessageController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessageController],
      providers: [
        {
          provide: WhatsappService,
          useValue: {
            connect: jest.fn(),
            sendMessage: jest.fn(),
            disconnect: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<MessageController>(MessageController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
