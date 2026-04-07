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

  it('usa o nome do responsavel no follow-up de paciente menor', () => {
    const message = (service as any).buildFollowUpSinglePendingMessage({
      date: '2026-04-10T16:00:00.000Z',
      blockStartTime: '2026-04-10T16:00:00.000Z',
      blockEndTime: '2026-04-10T20:00:00.000Z',
      clinic: { timezone: 'America/Sao_Paulo' },
      professional: { user: { name: 'AT VITORIA XAIANE' } },
      patient: {
        personalInfo: { name: 'THEO TABAY SANTOS' },
        patientResponsible: [
          {
            responsible: {
              name: 'SARA CAROLINA TABAY SANTOS',
            },
          },
        ],
      },
    });

    expect(message).toContain('Obrigado, SARA CAROLINA TABAY SANTOS!');
    expect(message).toContain('o agendamento de THEO TABAY SANTOS');
  });

  it('resolve selecao pendente pelo nome do profissional', () => {
    const option = (service as any).extractPendingSelectionOption(
      'o da vitoria',
      [
        {
          appointmentId: 1,
          label: '10/04/2026 13:00 as 17:00 com AT VITORIA XAIANE',
          normalizedProfessionalName: 'at vitoria xaiane',
          normalizedDate: '10042026',
          normalizedTime: '1300',
        },
        {
          appointmentId: 2,
          label: '06/04/2026 08:00 as 12:00 com AT OUTRO',
          normalizedProfessionalName: 'at outro',
          normalizedDate: '06042026',
          normalizedTime: '0800',
        },
      ],
    );

    expect(option?.appointmentId).toBe(1);
  });

  it('ordena opcoes pendentes pelo horario do atendimento', () => {
    const sorted = (service as any).sortPendingTargetsBySchedule([
      {
        appointmentId: 16477,
        pendingIds: ['b'],
        details: {
          date: '2026-05-01T11:00:00.000Z',
          blockStartTime: '2026-05-01T11:00:00.000Z',
        },
      },
      {
        appointmentId: 16475,
        pendingIds: ['a'],
        details: {
          date: '2026-04-24T11:00:00.000Z',
          blockStartTime: '2026-04-24T11:00:00.000Z',
        },
      },
    ]);

    expect(sorted.map((target) => target.appointmentId)).toEqual([
      16475,
      16477,
    ]);
  });

  it('deixa explicito que nenhuma acao foi executada na mensagem de ambiguidade', () => {
    const reply = (service as any).buildPendingSelectionReply(
      'ANE LIMA BARBOSA',
      [
        {
          appointmentId: 1,
          label: '01/05/2026 08:00 as 10:00 com TO - ISABELA COSTA',
          normalizedProfessionalName: 'to isabela costa',
          normalizedDate: '01052026',
          normalizedTime: '0800',
        },
      ],
      'CONFIRM',
    );

    expect(reply).toContain(
      'Encontrei mais de um atendimento pendente para confirmar, entao ainda nao foi feita nenhuma alteracao',
    );
  });

});
