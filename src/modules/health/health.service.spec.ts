import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { HEALTH_CHECK_TIMEOUT_MS, HealthService } from './health.service';

describe('HealthService', () => {
  let service: HealthService;
  let queryRaw: jest.Mock;
  let warn: jest.SpyInstance;

  beforeEach(async () => {
    queryRaw = jest.fn();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [HealthService, { provide: PrismaService, useValue: { $queryRaw: queryRaw } }],
    }).compile();

    service = moduleRef.get(HealthService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('returns true when SELECT 1 succeeds', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    await expect(service.isDatabaseUp()).resolves.toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns false and logs only the error name when the query fails', async () => {
    const error = new Error("Can't reach database server at db.internal:5432");
    error.name = 'PrismaClientKnownRequestError';
    queryRaw.mockRejectedValue(error);

    await expect(service.isDatabaseUp()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'Database health check failed: PrismaClientKnownRequestError',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('db.internal');
  });

  it('returns false when the query does not answer in time', async () => {
    jest.useFakeTimers();
    queryRaw.mockReturnValue(new Promise(() => undefined));

    const result = service.isDatabaseUp();
    await jest.advanceTimersByTimeAsync(HEALTH_CHECK_TIMEOUT_MS);

    await expect(result).resolves.toBe(false);
  });

  it('clears the timeout after a successful check', async () => {
    jest.useFakeTimers();
    queryRaw.mockResolvedValue([]);

    await service.isDatabaseUp();

    expect(jest.getTimerCount()).toBe(0);
  });
});
