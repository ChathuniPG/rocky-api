import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import type { EnvironmentVariables } from '../config/env.validation';
import { DATABASE_CONNECTION_TIMEOUT_MS, PrismaService } from './prisma.service';

// Mock functions installed on the stubbed client below. The `mock` prefix lets the hoisted
// jest.mock factory reference them; the tests assert on them directly.
const mockClientConstructor = jest.fn();
const mockConnect = jest.fn();
const mockDisconnect = jest.fn();
const mockQueryRaw = jest.fn();

// Replace the generated client with a stub: unit tests never open a database connection.
jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class {
    $connect = mockConnect;
    $disconnect = mockDisconnect;
    $queryRaw = mockQueryRaw;

    constructor(options: unknown) {
      mockClientConstructor(options);
    }
  },
}));

jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn().mockImplementation(() => ({ adapterName: 'stub-pg' })),
}));

const DATABASE_URL = 'postgresql://rocky:s3cret-pw@127.0.0.1:5432/rocky';

function createService(): PrismaService {
  // A real ConfigService over a fixed object: no casts, same `get()` behaviour as the app.
  return new PrismaService(new ConfigService<EnvironmentVariables, true>({ DATABASE_URL }));
}

describe('PrismaService', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockDisconnect.mockResolvedValue(undefined);
    mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('creates the pg driver adapter from DATABASE_URL and passes it to PrismaClient', () => {
    createService();

    expect(PrismaPg).toHaveBeenCalledWith(
      expect.objectContaining({ connectionString: DATABASE_URL }),
    );
    expect(mockClientConstructor).toHaveBeenCalledWith({ adapter: { adapterName: 'stub-pg' } });
  });

  it('sets a 5 second connection timeout on the pg pool, so startup cannot hang', () => {
    createService();

    expect(DATABASE_CONNECTION_TIMEOUT_MS).toBe(5000);
    expect(PrismaPg).toHaveBeenCalledWith({
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });
  });

  it('connects and verifies the connection with a query on module init', async () => {
    await createService().onModuleInit();

    expect(mockConnect).toHaveBeenCalledTimes(1);
    // Tagged template: the first argument holds the literal SQL parts.
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(mockQueryRaw).toHaveBeenCalledWith(['SELECT 1']);
    // The ping runs after $connect.
    expect(mockConnect.mock.invocationCallOrder[0]).toBeLessThan(
      mockQueryRaw.mock.invocationCallOrder[0],
    );
  });

  it('fails module init when the database is unreachable', async () => {
    mockQueryRaw.mockRejectedValueOnce(new Error("Can't reach database server"));

    await expect(createService().onModuleInit()).rejects.toThrow("Can't reach database server");
    expect(logSpy).not.toHaveBeenCalledWith('Connected to the database');
  });

  it('propagates a $connect failure', async () => {
    mockConnect.mockRejectedValueOnce(new Error('connect failed'));

    await expect(createService().onModuleInit()).rejects.toThrow('connect failed');
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('disconnects on module destroy', async () => {
    await createService().onModuleDestroy();

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it('never logs the connection string', async () => {
    const service = createService();

    await service.onModuleInit();
    await service.onModuleDestroy();

    const logged = JSON.stringify(logSpy.mock.calls);
    expect(logged).not.toContain('s3cret-pw');
    expect(logged).not.toContain(DATABASE_URL);
  });
});
