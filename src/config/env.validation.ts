// class-transformer reads `design:type` metadata to convert values. Nest loads this
// polyfill at bootstrap, but importing it here keeps the module usable on its own
// (e.g. in unit tests that never start Nest).
import 'reflect-metadata';
import { plainToInstance, Transform } from 'class-transformer';
import type { ValidationError } from 'class-validator';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  validateSync,
} from 'class-validator';

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

  // ADR-011: the service account key lives outside the repository and only its path is
  // configured here, never its contents. Whether the file exists and is a valid key is
  // checked when FirebaseModule starts (src/firebase/service-account.ts), so this schema
  // stays free of file-system access.
  @IsString()
  @IsNotEmpty({
    message: 'FIREBASE_SERVICE_ACCOUNT_PATH must point to the service account JSON file',
  })
  FIREBASE_SERVICE_ACCOUNT_PATH: string;

  // Firebase / Google Cloud project ID rules: 6-30 characters, lowercase letters, digits
  // and hyphens, starting with a letter and not ending with a hyphen.
  @Matches(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, {
    message: 'FIREBASE_PROJECT_ID must be a valid Firebase project ID (e.g. rocky-app-1234)',
  })
  FIREBASE_PROJECT_ID: string;

  // A bare bucket name (e.g. rocky-app.firebasestorage.app). The Admin SDK rejects a
  // gs:// prefix or a URL, so they are rejected here with a clearer message.
  @Matches(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/, {
    message:
      'FIREBASE_STORAGE_BUCKET must be a bare bucket name such as my-project.firebasestorage.app (no gs:// prefix)',
  })
  FIREBASE_STORAGE_BUCKET: string;

  // ADR-002: needed for the Firebase Auth REST API (sign-in and refresh). Treated as a
  // secret: it is never logged, and the error message below never contains the value.
  @Matches(/^\S+$/, { message: 'FIREBASE_WEB_API_KEY must be a non-empty value without spaces' })
  FIREBASE_WEB_API_KEY: string;

  // ADR-003: sets the Secure flag on the auth cookies. Secure by default; only local
  // development over plain http turns it off, and validateEnv rejects false in production.
  // Parsed strictly: implicit conversion would turn the string "false" into true. It also
  // runs before @Transform, so the raw string is read from `obj`, not from `value`.
  @Transform(({ obj }: { obj: Record<string, unknown> }) => parseBooleanString(obj.COOKIE_SECURE))
  @IsBoolean({ message: 'COOKIE_SECURE must be true or false' })
  COOKIE_SECURE: boolean = true;
}

/**
 * Converts the strings "true" and "false" (any case, surrounding spaces ignored) to
 * booleans. Booleans pass through (the property default); anything else is returned
 * unchanged so that @IsBoolean rejects it.
 */
function parseBooleanString(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const normalised = value.trim().toLowerCase();
  if (normalised === 'true') {
    return true;
  }
  if (normalised === 'false') {
    return false;
  }
  return value;
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

  // ADR-003: auth cookies must never travel over plain http in production.
  if (validated.NODE_ENV === NodeEnv.Production && !validated.COOKIE_SECURE) {
    throw new Error(
      'Invalid environment configuration:\n  - COOKIE_SECURE: COOKIE_SECURE must be true in production',
    );
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
