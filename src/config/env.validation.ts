// class-transformer reads `design:type` metadata to convert values. Nest loads this
// polyfill at bootstrap, but importing it here keeps the module usable on its own
// (e.g. in unit tests that never start Nest).
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import type { ValidationError } from 'class-validator';
import { IsEnum, IsInt, IsUrl, Max, Min, validateSync } from 'class-validator';

/** Runtime environments the API supports. */
export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/**
 * Schema for the environment variables the API reads at startup.
 *
 * Each property is one variable. A property initialiser is that variable's default.
 * Every variable must also be documented in `.env.example`.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  // The explicit `: number` matters: without it TypeScript emits `design:type` as Object,
  // and class-transformer cannot convert the string "4000" into a number.
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 4000;

  // Required, no default: a missing database must stop the app at startup rather than
  // fail on the first query. `require_tld: false` allows hosts like localhost or
  // 127.0.0.1. The value contains the password, so it is never logged (NFR-SEC-04).
  @IsUrl(
    { protocols: ['postgres', 'postgresql'], require_protocol: true, require_tld: false },
    { message: 'DATABASE_URL must be a postgres:// or postgresql:// connection URL' },
  )
  DATABASE_URL: string;
}

/**
 * Validates and type-converts raw environment variables. Used as the `validate` hook
 * of `ConfigModule.forRoot`, so the app fails fast at startup if the configuration is
 * missing or invalid.
 *
 * @param config - Raw key/value pairs from `process.env` and any `.env` file.
 * @returns The validated configuration, with defaults applied and values converted
 *   to their declared types (e.g. `PORT` as a number).
 * @throws {Error} If any variable is invalid. The message names every failing
 *   variable and its constraint, but never its value.
 */
export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  // Environment values are always strings; implicit conversion turns "4000" into 4000
  // based on the declared property types.
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n${formatErrors(errors)}`);
  }

  return validated;
}

/**
 * Builds one line per failing variable. Uses only the constraint messages (e.g.
 * "PORT must be an integer number") and never the rejected value, because later
 * variables will hold secrets that must never be logged.
 */
function formatErrors(errors: ValidationError[]): string {
  return errors
    .map((error) => {
      const messages = Object.values(error.constraints ?? {}).join('; ');
      return `  - ${error.property}: ${messages}`;
    })
    .join('\n');
}
