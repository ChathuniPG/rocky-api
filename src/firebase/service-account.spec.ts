import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadServiceAccount, ServiceAccountConfigError } from './service-account';

// Every credential here is fake. Each test writes its own file to a temp directory, so
// no test ever reads a real key.
const PROJECT_ID = 'rocky-test-1234';
const FAKE_PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\nFAKE-KEY-MATERIAL-for-tests\n-----END PRIVATE KEY-----\n';
const FAKE_KEY_ID = 'fake-private-key-id-0123456789';

const validKey = {
  type: 'service_account',
  project_id: PROJECT_ID,
  private_key_id: FAKE_KEY_ID,
  private_key: FAKE_PRIVATE_KEY,
  client_email: `firebase-adminsdk-test@${PROJECT_ID}.iam.gserviceaccount.com`,
  client_id: '000000000000000000000',
};

/** Runs the loader and returns its error, failing the test if it throws anything else. */
function loadError(path: string, projectId = PROJECT_ID): ServiceAccountConfigError {
  try {
    loadServiceAccount(path, projectId);
  } catch (error: unknown) {
    if (error instanceof ServiceAccountConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected loadServiceAccount to throw');
}

/** Asserts that no secret from the fake key file leaked into the error message. */
function expectNoSecrets(error: Error): void {
  expect(error.message).not.toContain('FAKE-KEY-MATERIAL');
  expect(error.message).not.toContain('BEGIN PRIVATE KEY');
  expect(error.message).not.toContain(FAKE_KEY_ID);
}

describe('loadServiceAccount', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rocky-sa-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeKeyFile(contents: string): string {
    const path = join(dir, 'service-account.json');
    writeFileSync(path, contents, 'utf8');
    return path;
  }

  it('returns the credential fields of a valid key file', () => {
    const path = writeKeyFile(JSON.stringify(validKey));

    expect(loadServiceAccount(path, PROJECT_ID)).toEqual({
      projectId: PROJECT_ID,
      clientEmail: validKey.client_email,
      privateKey: FAKE_PRIVATE_KEY,
    });
  });

  it('fails when the file does not exist, naming the path and error code', () => {
    const path = join(dir, 'missing.json');

    const error = loadError(path);

    expect(error.message).toContain(path);
    expect(error.message).toMatch(/cannot be read \(ENOENT\)/);
  });

  it('fails when the path is a directory', () => {
    const path = join(dir, 'a-directory');
    mkdirSync(path);

    expect(loadError(path).message).toMatch(/cannot be read \(EISDIR\)/);
  });

  it('fails on invalid JSON without quoting the file contents', () => {
    // Truncated JSON: Node's SyntaxError would quote this text, private key included.
    const path = writeKeyFile(JSON.stringify(validKey).slice(0, 120));

    const error = loadError(path);

    expect(error.message).toMatch(/not valid JSON$/);
    expectNoSecrets(error);
  });

  it.each([
    ['a JSON array', '[]'],
    ['a JSON string', '"service_account"'],
    ['the wrong type', JSON.stringify({ ...validKey, type: 'authorized_user' })],
    ['no type', JSON.stringify({ ...validKey, type: undefined })],
  ])('fails when the file is %s', (_label, contents) => {
    const error = loadError(writeKeyFile(contents));

    expect(error.message).toMatch(/not a service account key/);
    expectNoSecrets(error);
  });

  it('names every missing or empty field, but not the values present', () => {
    const path = writeKeyFile(
      JSON.stringify({ ...validKey, project_id: '', client_email: undefined }),
    );

    const error = loadError(path);

    expect(error.message).toMatch(/missing or empty field\(s\): project_id, client_email$/);
    expectNoSecrets(error);
  });

  it('fails when private_key is missing', () => {
    const path = writeKeyFile(JSON.stringify({ ...validKey, private_key: undefined }));

    expect(loadError(path).message).toMatch(/field\(s\): private_key$/);
  });

  it('fails when a field is not a string', () => {
    const path = writeKeyFile(JSON.stringify({ ...validKey, client_email: 42 }));

    expect(loadError(path).message).toMatch(/field\(s\): client_email$/);
  });

  it('fails when project_id does not match FIREBASE_PROJECT_ID', () => {
    const path = writeKeyFile(JSON.stringify(validKey));

    const error = loadError(path, 'another-project-99');

    expect(error.message).toMatch(/project_id does not match FIREBASE_PROJECT_ID$/);
    expect(error.message).not.toContain(PROJECT_ID);
    expectNoSecrets(error);
  });
});
