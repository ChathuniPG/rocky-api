import { NodeEnv, validateEnv } from './env.validation';

// The minimum configuration the API accepts: every required variable, nothing else.
const DATABASE_URL = 'postgresql://rocky:s3cret-pw@127.0.0.1:5432/rocky';
const required = { DATABASE_URL };

describe('validateEnv', () => {
  it('applies defaults when only the required variables are set', () => {
    const env = validateEnv(required);

    expect(env.NODE_ENV).toBe(NodeEnv.Development);
    expect(env.PORT).toBe(4000);
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
      expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
    });

    it.each([
      'postgres://rocky:pw@localhost:5432/rocky',
      'postgresql://rocky:pw@127.0.0.1:5432/rocky?schema=public',
      'postgresql://rocky:pw@db.example.com:5432/rocky',
    ])('accepts %s', (url) => {
      expect(validateEnv({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
    });

    it.each(['mysql://rocky:pw@localhost:3306/rocky', 'not-a-url', 'localhost:5432/rocky', ''])(
      'rejects %p',
      (url) => {
        expect(() => validateEnv({ DATABASE_URL: url })).toThrow(
          /DATABASE_URL must be a postgres:\/\/ or postgresql:\/\/ connection URL/,
        );
      },
    );

    it('never includes the password in the error message', () => {
      const env = { DATABASE_URL: 'mysql://rocky:s3cret-pw@localhost:3306/rocky' };

      expect(() => validateEnv(env)).toThrow(/DATABASE_URL/);
      expect(() => validateEnv(env)).not.toThrow(/s3cret-pw/);
    });
  });
});
