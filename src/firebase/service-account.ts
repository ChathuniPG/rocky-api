import { readFileSync } from 'node:fs';
import type { ServiceAccount } from 'firebase-admin/app';

/** The fields `cert()` needs, all guaranteed to be present after validation. */
export type ValidatedServiceAccount = Required<ServiceAccount>;

/** Fields that must be non-empty strings in a Google service account key file. */
const REQUIRED_FIELDS = ['project_id', 'client_email', 'private_key'] as const;

/**
 * Thrown at startup when the service account key file is missing or invalid. It is a
 * configuration error, not a request error, so it is not a `FirebaseDomainError`.
 *
 * The message names the file path and the failed check only. It never contains the
 * file's contents, because the file holds a private key (NFR-SEC-04).
 */
export class ServiceAccountConfigError extends Error {
  constructor(path: string, reason: string) {
    super(`Invalid Firebase service account (FIREBASE_SERVICE_ACCOUNT_PATH=${path}): ${reason}`);
    this.name = 'ServiceAccountConfigError';
  }
}

/**
 * Reads and validates the service account key file so the app fails fast at startup
 * instead of on the first Firebase call (ADR-011: the key lives outside the repository).
 *
 * @param path - Path to the JSON key file, from FIREBASE_SERVICE_ACCOUNT_PATH.
 * @param expectedProjectId - FIREBASE_PROJECT_ID; the key must belong to this project.
 * @returns The credential fields in the shape `cert()` accepts.
 * @throws {ServiceAccountConfigError} If the file cannot be read, is not valid JSON, is
 *   not a service account key, lacks a required field, or belongs to another project.
 */
export function loadServiceAccount(
  path: string,
  expectedProjectId: string,
): ValidatedServiceAccount {
  const parsed = parseJson(path, readKeyFile(path));

  if (!isRecord(parsed) || parsed.type !== 'service_account') {
    throw new ServiceAccountConfigError(
      path,
      'the file is not a service account key ("type" must be "service_account")',
    );
  }

  const { project_id: projectId, client_email: clientEmail, private_key: privateKey } = parsed;
  if (
    !isNonEmptyString(projectId) ||
    !isNonEmptyString(clientEmail) ||
    !isNonEmptyString(privateKey)
  ) {
    const missing = REQUIRED_FIELDS.filter((field) => !isNonEmptyString(parsed[field]));
    throw new ServiceAccountConfigError(path, `missing or empty field(s): ${missing.join(', ')}`);
  }

  // A key from another project would initialise fine but fail every token verification
  // with a confusing audience error, so the mismatch is caught here instead.
  if (projectId !== expectedProjectId) {
    throw new ServiceAccountConfigError(path, 'project_id does not match FIREBASE_PROJECT_ID');
  }

  return { projectId, clientEmail, privateKey };
}

/** Reads the file, reporting only the error code (e.g. ENOENT) on failure. */
function readKeyFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'unknown error';
    throw new ServiceAccountConfigError(path, `the file cannot be read (${code})`);
  }
}

/**
 * Parses the file as JSON. The SyntaxError message is deliberately discarded: Node quotes
 * part of the input in it, which could expose part of the private key.
 */
function parseJson(path: string, contents: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new ServiceAccountConfigError(path, 'the file is not valid JSON');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
