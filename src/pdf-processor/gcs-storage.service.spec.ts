import { describe, expect, it } from '@jest/globals';
import { decodeServiceAccountCredentials } from './gcs-storage.service';

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64');
}

describe('decodeServiceAccountCredentials', () => {
  it('decodes the service account fields required by Google Storage', () => {
    expect(
      decodeServiceAccountCredentials(
        encode({
          type: 'service_account',
          project_id: 'test-project',
          client_email: 'storage@test-project.iam.gserviceaccount.com',
          private_key:
            '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n',
        }),
      ),
    ).toEqual({
      client_email: 'storage@test-project.iam.gserviceaccount.com',
      private_key:
        '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n',
    });
  });

  it('rejects malformed JSON', () => {
    const encoded = Buffer.from('not-json', 'utf-8').toString('base64');
    expect(() => decodeServiceAccountCredentials(encoded)).toThrow(
      /base64-encoded service account JSON/,
    );
  });

  it('rejects credentials missing required fields', () => {
    expect(() =>
      decodeServiceAccountCredentials(encode({ type: 'service_account' })),
    ).toThrow(/client_email and private_key/);
  });
});
