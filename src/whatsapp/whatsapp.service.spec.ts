import { throwError } from 'rxjs';

jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  Browsers: {},
  DisconnectReason: {},
  fetchLatestBaileysVersion: jest.fn(),
  useMultiFileAuthState: jest.fn(),
  proto: {},
}));

const { WhatsappService } = require('./whatsapp.service');

describe('WhatsappService retry policy', () => {
  const httpService = {
    patch: jest.fn(),
    post: jest.fn(),
  };

  const pendingRepo = {
    delete: jest.fn(),
  };

  const service = new WhatsappService(
    httpService as any,
    pendingRepo as any,
    {} as any,
    {} as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns terminal_not_available and does not retry on 404 during block status update', async () => {
    httpService.patch.mockReturnValue(
      throwError(() => ({
        message: 'Not found',
        response: { status: 404 },
      })),
    );

    const result = await (service as any).updateAppointmentStatusWithRetry(
      13634,
      'Confirmado',
    );

    expect(result).toBe('terminal_not_available');
    expect(httpService.patch).toHaveBeenCalledTimes(1);
  });

  it('does not retry internal post for non-retryable 4xx errors', async () => {
    httpService.post.mockReturnValue(
      throwError(() => ({
        message: 'Bad request',
        response: { status: 400 },
      })),
    );

    const result = await (service as any).postInternalApiWithRetry(
      'http://localhost:3001/appointment/confirmation-message/events',
      { appointmentId: 1, type: 'INCOMING' },
      'test context',
      { appointmentId: 1 },
      3,
    );

    expect(result).toBe(false);
    expect(httpService.post).toHaveBeenCalledTimes(1);
  });
});
