import { describe, expect, it, jest } from '@jest/globals';
import {
  decodeServiceAccountCredentials,
  GcsStorageService,
} from './gcs-storage.service';

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

describe('GcsStorageService deletion', () => {
  it('attempts every deletion and propagates aggregated failures', async () => {
    const warn = jest.fn();
    const service = Object.create(
      GcsStorageService.prototype,
    ) as GcsStorageService;
    Object.defineProperty(service, 'logger', { value: { warn } });

    type DeleteOptions = { ignoreNotFound: boolean };
    const firstDelete = jest.fn(async (_options: DeleteOptions) => undefined);
    const failedDelete = jest.fn(async (_options: DeleteOptions) => {
      throw new Error('permission denied');
    });
    const lastDelete = jest.fn(async (_options: DeleteOptions) => undefined);
    const files = [
      { name: 'doc.pdf', delete: firstDelete },
      { name: 'doc.md', delete: failedDelete },
      { name: 'doc/chunk.md', delete: lastDelete },
    ];
    const deleteFiles = (
      service as unknown as {
        deleteFiles(items: typeof files): Promise<void>;
      }
    ).deleteFiles.bind(service);

    await expect(deleteFiles(files)).rejects.toThrow(
      'Failed to delete 1 GCS object(s)',
    );
    expect(firstDelete).toHaveBeenCalledWith({ ignoreNotFound: true });
    expect(failedDelete).toHaveBeenCalledWith({ ignoreNotFound: true });
    expect(lastDelete).toHaveBeenCalledWith({ ignoreNotFound: true });
    expect(warn).toHaveBeenCalledWith(
      'Failed to delete doc.md: permission denied',
    );
  });
});
