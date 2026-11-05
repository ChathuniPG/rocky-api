import { NodeEnv, validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('applies defaults when variables are missing', () => {
    const env = validateEnv({});

    expect(env.NODE_ENV).toBe(NodeEnv.Development);
    expect(env.PORT).toBe(4000);
  });

  it('accepts a valid configuration and converts PORT to a number', () => {
    const env = validateEnv({ NODE_ENV: 'production', PORT: '8080' });

    expect(env.NODE_ENV).toBe(NodeEnv.Production);
    expect(env.PORT).toBe(8080);
  });

  it('ignores unrelated environment variables', () => {
    expect(() => validateEnv({ PATH: '/usr/bin', HOME: '/home/rocky' })).not.toThrow();
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => validateEnv({ PORT: 'abc' })).toThrow(/PORT/);
  });

  it('rejects a PORT outside the valid range', () => {
    // Exact match: proves "70000" was converted to a number and failed only on @Max.
    expect(() => validateEnv({ PORT: '70000' })).toThrow(
      /^Invalid environment configuration:\n {2}- PORT: PORT must not be greater than 65535$/,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('reports every invalid variable in a single error', () => {
    expect(() => validateEnv({ NODE_ENV: 'staging', PORT: 'abc' })).toThrow(
      /Invalid environment configuration:[\s\S]*NODE_ENV[\s\S]*PORT/,
    );
  });

  it('never includes the rejected value in the error message', () => {
    expect(() => validateEnv({ NODE_ENV: 'super-secret-value' })).toThrow(/NODE_ENV/);
    expect(() => validateEnv({ NODE_ENV: 'super-secret-value' })).not.toThrow(/super-secret-value/);
  });
});
