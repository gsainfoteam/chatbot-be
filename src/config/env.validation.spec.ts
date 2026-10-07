import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { validate } from './env.validation';

function baseEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB_HOST: 'localhost',
    DB_PORT: 5432,
    DB_USER: 'test-user',
    DB_PASSWORD: 'test-only-placeholder',
    DB_NAME: 'test',
    DB_SSL: false,
    PORT: 3000,
    NODE_ENV: 'test',
    JWT_SECRET: 'x'.repeat(32),
    JWT_EXPIRES_IN: 3600,
    ADMIN_BEARER_TOKEN: 'a'.repeat(16),
    IDP_URL: 'https://idp.example.com',
    IDP_CLIENT_ID: 'test-client-id',
    IDP_CLIENT_SECRET: 'test-client-secret',
    DOMAIN_NAME: 'example.com',
    MCP_BASE_URL: 'https://mcp.example.com',
    MCP_RESOURCE_API_URL: 'https://mcp-resource.example.com',
    GCS_BUCKET: 'test-bucket',
    GCP_PROJECT_ID: 'test-project',
    ...overrides,
  };
}

describe('env validation for LLM_PROVIDER', () => {
  it('requires Letsur credentials by default', () => {
    expect(() =>
      validate(
        baseEnv({
          LETSUR_AI_GATEWAY_BASE_URL: 'https://gw.letsur.ai/v1',
          LETSUR_AI_GATEWAY_API_KEY: 'letsur-key',
        }),
      ),
    ).not.toThrow();

    expect(() => validate(baseEnv({}))).toThrow(/LETSUR_AI_GATEWAY/);
  });

  it('requires OpenRouter credentials when LLM_PROVIDER=openrouter', () => {
    expect(() =>
      validate(
        baseEnv({
          LLM_PROVIDER: 'openrouter',
          OPEN_ROUTER_API_KEY: 'or-key',
        }),
      ),
    ).not.toThrow();

    expect(() =>
      validate(
        baseEnv({
          LLM_PROVIDER: 'openrouter',
        }),
      ),
    ).toThrow(/OPEN_ROUTER_API_KEY/);
  });
});

describe('env validation for GCS credentials', () => {
  const letsurEnv = {
    LETSUR_AI_GATEWAY_BASE_URL: 'https://gw.letsur.ai/v1',
    LETSUR_AI_GATEWAY_API_KEY: 'letsur-key',
  };

  it('accepts a base64-encoded service account JSON', () => {
    const encoded = Buffer.from(
      JSON.stringify({
        client_email: 'storage@example.iam.gserviceaccount.com',
        private_key: 'private-key',
      }),
    ).toString('base64');

    expect(() =>
      validate(
        baseEnv({
          ...letsurEnv,
          GCS_SERVICE_ACCOUNT_KEY_BASE64: encoded,
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a non-base64 credential value', () => {
    expect(() =>
      validate(
        baseEnv({
          ...letsurEnv,
          GCS_SERVICE_ACCOUNT_KEY_BASE64: 'not base64!',
        }),
      ),
    ).toThrow(/base64/);
  });
});

describe('embedding backfill configuration', () => {
  const credentials = {
    LETSUR_AI_GATEWAY_BASE_URL: 'https://gw.example.com/v1',
    LETSUR_AI_GATEWAY_API_KEY: 'test-key',
  };

  it.each([false, 'false', 'FALSE'])(
    'honors the kill-switch value %s',
    (value) => {
      expect(
        validate(baseEnv({ ...credentials, EMBEDDING_BACKFILL_ENABLED: value }))
          .EMBEDDING_BACKFILL_ENABLED,
      ).toBe(false);
    },
  );

  it.each(['fasle', '0', 'off'])('rejects an ambiguous boolean %s', (value) => {
    expect(() =>
      validate(baseEnv({ ...credentials, EMBEDDING_BACKFILL_ENABLED: value })),
    ).toThrow();
  });

  it.each([
    { EMBEDDING_BACKFILL_BATCH_SIZE: 0 },
    { EMBEDDING_BACKFILL_BATCH_SIZE: 65 },
    { EMBEDDING_BACKFILL_BATCH_SIZE: 1.5 },
    { EMBEDDING_BACKFILL_INTERVAL_MS: 999 },
    { EMBEDDING_BACKFILL_INTERVAL_MS: 86400001 },
    { EMBEDDING_BACKFILL_INTERVAL_MS: 'NaN' },
  ])('rejects invalid limits %j', (settings) => {
    expect(() => validate(baseEnv({ ...credentials, ...settings }))).toThrow();
  });

  it('accepts numeric strings and keeps the search and backfill switches independent', () => {
    const result = validate(
      baseEnv({
        ...credentials,
        EMBEDDING_BACKFILL_ENABLED: 'true',
        EMBEDDING_BACKFILL_BATCH_SIZE: '32',
        EMBEDDING_BACKFILL_INTERVAL_MS: '300000',
        EMBEDDING_RETRIEVAL_ENABLED: false,
      }),
    );
    expect(result.EMBEDDING_BACKFILL_ENABLED).toBe(true);
    expect(result.EMBEDDING_BACKFILL_BATCH_SIZE).toBe(32);
    expect(result.EMBEDDING_BACKFILL_INTERVAL_MS).toBe(300000);
    expect(result.EMBEDDING_RETRIEVAL_ENABLED).toBe(false);
  });
});
