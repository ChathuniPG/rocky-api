import { NodeEnv, SeedEnv, validateEnv } from './env.validation';

// The minimum configuration the API accepts: every required variable, nothing else.
// All values are fake; no test touches a real Firebase project.
const DATABASE_URL = 'postgresql://rocky:s3cret-pw@127.0.0.1:5432/rocky';
const FIREBASE_WEB_API_KEY = 'AIzaFakeKeyForUnitTests0000000000000000';
const required = {
  DATABASE_URL,
  FIREBASE_SERVICE_ACCOUNT_PATH: 'D:/secrets/fake-service-account.json',
  FIREBASE_PROJECT_ID: 'rocky-test-1234',
  FIREBASE_STORAGE_BUCKET: 'rocky-test-1234.firebasestorage.app',
  FIREBASE_WEB_API_KEY,
};

/** Returns the required configuration without one variable, to test that it is required. */
function without(key: keyof typeof required): Record<string, string> {
  const { [key]: _omitted, ...rest } = required;
  return rest;
}

describe('validateEnv', () => {
  it('applies defaults when only the required variables are set', () => {
    const env = validateEnv(required);

    expect(env.NODE_ENV).toBe(NodeEnv.Development);
    expect(env.PORT).toBe(4000);
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.DATABASE_URL).toBe(DATABASE_URL);
  });

  it('accepts a valid configuration and converts PORT to a number', () => {
    const env = validateEnv({ ...required, NODE_ENV: 'production', PORT: '8080' });

    expect(env.NODE_ENV).toBe(NodeEnv.Production);
    expect(env.PORT).toBe(8080);
  });

  it('ignores unrelated environment variables', () => {
    expect(() => validateEnv({ ...required, PATH: '/usr/bin', HOME: '/home/rocky' })).not.toThrow();
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => validateEnv({ ...required, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('rejects a PORT outside the valid range', () => {
    // Exact match: proves "70000" was converted to a number and failed only on @Max.
    expect(() => validateEnv({ ...required, PORT: '70000' })).toThrow(
      /^Invalid environment configuration:\n {2}- PORT: PORT must not be greater than 65535$/,
    );
  });

  describe('HOST', () => {
    it('defaults to 127.0.0.1', () => {
      expect(validateEnv(required).HOST).toBe('127.0.0.1');
    });

    it.each(['127.0.0.1', '0.0.0.0', '::1', '::'])('accepts %s', (host) => {
      expect(validateEnv({ ...required, HOST: host }).HOST).toBe(host);
    });

    it.each(['localhost', 'example.com', '127.0.0.256', '127.0.0.1:4000', ''])(
      'rejects %p',
      (host) => {
        expect(() => validateEnv({ ...required, HOST: host })).toThrow(
          /HOST must be an IPv4 or IPv6 address/,
        );
      },
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ ...required, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('reports every invalid variable in a single error', () => {
    expect(() => validateEnv({ ...required, NODE_ENV: 'staging', PORT: 'abc' })).toThrow(
      /Invalid environment configuration:[\s\S]*NODE_ENV[\s\S]*PORT/,
    );
  });

  it('never includes the rejected value in the error message', () => {
    const env = { ...required, NODE_ENV: 'super-secret-value' };

    expect(() => validateEnv(env)).toThrow(/NODE_ENV/);
    expect(() => validateEnv(env)).not.toThrow(/super-secret-value/);
  });

  describe('DATABASE_URL', () => {
    it('is required', () => {
      expect(() => validateEnv(without('DATABASE_URL'))).toThrow(/DATABASE_URL/);
    });

    it.each([
      'postgres://rocky:pw@localhost:5432/rocky',
      'postgresql://rocky:pw@127.0.0.1:5432/rocky?schema=public',
      'postgresql://rocky:pw@db.example.com:5432/rocky',
    ])('accepts %s', (url) => {
      expect(validateEnv({ ...required, DATABASE_URL: url }).DATABASE_URL).toBe(url);
    });

    it.each(['mysql://rocky:pw@localhost:3306/rocky', 'not-a-url', 'localhost:5432/rocky', ''])(
      'rejects %p',
      (url) => {
        expect(() => validateEnv({ ...required, DATABASE_URL: url })).toThrow(
          /DATABASE_URL must be a postgres:\/\/ or postgresql:\/\/ connection URL/,
        );
      },
    );

    it('never includes the password in the error message', () => {
      const env = { ...required, DATABASE_URL: 'mysql://rocky:s3cret-pw@localhost:3306/rocky' };

      expect(() => validateEnv(env)).toThrow(/DATABASE_URL/);
      expect(() => validateEnv(env)).not.toThrow(/s3cret-pw/);
    });
  });

  describe('FIREBASE_SERVICE_ACCOUNT_PATH', () => {
    it('is required', () => {
      expect(() => validateEnv(without('FIREBASE_SERVICE_ACCOUNT_PATH'))).toThrow(
        /FIREBASE_SERVICE_ACCOUNT_PATH/,
      );
    });

    it('rejects an empty value', () => {
      expect(() => validateEnv({ ...required, FIREBASE_SERVICE_ACCOUNT_PATH: '' })).toThrow(
        /FIREBASE_SERVICE_ACCOUNT_PATH must point to the service account JSON file/,
      );
    });

    it.each(['D:/AssessmentProjects/ROCKY/secrets/rocky-sa.json', '/etc/rocky/secrets/sa.json'])(
      'accepts %s',
      (path) => {
        const env = validateEnv({ ...required, FIREBASE_SERVICE_ACCOUNT_PATH: path });

        expect(env.FIREBASE_SERVICE_ACCOUNT_PATH).toBe(path);
      },
    );
  });

  describe('FIREBASE_PROJECT_ID', () => {
    it('is required', () => {
      expect(() => validateEnv(without('FIREBASE_PROJECT_ID'))).toThrow(/FIREBASE_PROJECT_ID/);
    });

    it.each(['rocky-app', 'rocky-test-1234', 'abcdef'])('accepts %s', (projectId) => {
      expect(validateEnv({ ...required, FIREBASE_PROJECT_ID: projectId }).FIREBASE_PROJECT_ID).toBe(
        projectId,
      );
    });

    it.each(['Rocky-App', '1rocky-app', 'rocky-app-', 'short', 'rocky_app', ''])(
      'rejects %p',
      (projectId) => {
        expect(() => validateEnv({ ...required, FIREBASE_PROJECT_ID: projectId })).toThrow(
          /FIREBASE_PROJECT_ID must be a valid Firebase project ID/,
        );
      },
    );
  });

  describe('FIREBASE_STORAGE_BUCKET', () => {
    it('is required', () => {
      expect(() => validateEnv(without('FIREBASE_STORAGE_BUCKET'))).toThrow(
        /FIREBASE_STORAGE_BUCKET/,
      );
    });

    it.each(['rocky-test-1234.firebasestorage.app', 'rocky-test-1234.appspot.com'])(
      'accepts %s',
      (bucket) => {
        const env = validateEnv({ ...required, FIREBASE_STORAGE_BUCKET: bucket });

        expect(env.FIREBASE_STORAGE_BUCKET).toBe(bucket);
      },
    );

    it.each([
      'gs://rocky-test-1234.firebasestorage.app',
      'https://storage.googleapis.com/rocky-test-1234',
      'Rocky-Bucket',
      '',
    ])('rejects %p', (bucket) => {
      expect(() => validateEnv({ ...required, FIREBASE_STORAGE_BUCKET: bucket })).toThrow(
        /FIREBASE_STORAGE_BUCKET must be a bare bucket name/,
      );
    });
  });

  describe('COOKIE_SECURE', () => {
    it('defaults to true', () => {
      expect(validateEnv(required).COOKIE_SECURE).toBe(true);
    });

    it.each([
      ['true', true],
      ['TRUE', true],
      [' true ', true],
      ['false', false],
      ['False', false],
    ])('parses %p as %p', (raw, expected) => {
      expect(validateEnv({ ...required, COOKIE_SECURE: raw }).COOKIE_SECURE).toBe(expected);
    });

    it.each(['yes', '1', '0', ''])('rejects %p', (raw) => {
      expect(() => validateEnv({ ...required, COOKIE_SECURE: raw })).toThrow(
        /COOKIE_SECURE must be true or false/,
      );
    });

    it('rejects false in production', () => {
      expect(() =>
        validateEnv({ ...required, NODE_ENV: 'production', COOKIE_SECURE: 'false' }),
      ).toThrow(/COOKIE_SECURE must be true in production/);
    });

    it('accepts true in production', () => {
      const env = validateEnv({ ...required, NODE_ENV: 'production', COOKIE_SECURE: 'true' });

      expect(env.COOKIE_SECURE).toBe(true);
    });
  });

  describe('FIREBASE_WEB_API_KEY', () => {
    it('is required', () => {
      expect(() => validateEnv(without('FIREBASE_WEB_API_KEY'))).toThrow(/FIREBASE_WEB_API_KEY/);
    });

    it.each(['', 'has a space', ' AIzaLeadingSpace'])('rejects %p', (key) => {
      expect(() => validateEnv({ ...required, FIREBASE_WEB_API_KEY: key })).toThrow(
        /FIREBASE_WEB_API_KEY must be a non-empty value without spaces/,
      );
    });

    it('never includes the key in the error message', () => {
      const env = { ...required, FIREBASE_WEB_API_KEY: 'AIza secret key' };

      expect(() => validateEnv(env)).toThrow(/FIREBASE_WEB_API_KEY/);
      expect(() => validateEnv(env)).not.toThrow(/AIza secret key/);
    });
  });

  describe('SEED_DEMO_PASSWORD', () => {
    it('is optional: the API does not need it', () => {
      expect(validateEnv(required).SEED_DEMO_PASSWORD).toBeUndefined();
    });

    it('is passed through when set', () => {
      expect(
        validateEnv({ ...required, SEED_DEMO_PASSWORD: 'demo-pass-1' }).SEED_DEMO_PASSWORD,
      ).toBe('demo-pass-1');
    });

    it('rejects an empty value without echoing it', () => {
      expect(() => validateEnv({ ...required, SEED_DEMO_PASSWORD: '' })).toThrow(
        /SEED_DEMO_PASSWORD must not be empty/,
      );
    });
  });

  describe('SEED_ENV', () => {
    it('is optional: the API does not need it', () => {
      expect(validateEnv(required).SEED_ENV).toBeUndefined();
    });

    it.each([SeedEnv.Local, SeedEnv.Production])('accepts %p', (seedEnv) => {
      expect(validateEnv({ ...required, SEED_ENV: seedEnv }).SEED_ENV).toBe(seedEnv);
    });

    it.each(['', 'staging', 'LOCAL', 'production '])('rejects %p', (seedEnv) => {
      expect(() => validateEnv({ ...required, SEED_ENV: seedEnv })).toThrow(
        /SEED_ENV must be one of: local, production/,
      );
    });
  });
});
