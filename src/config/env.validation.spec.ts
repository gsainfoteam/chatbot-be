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
    EMBEDDING_BASE_URL: 'https://embeddings.example.com/v1',
    EMBEDDING_API_KEY: 'embedding-test-key',
    EMBEDDING_MODEL: 'test-embedding-model',
    EMBEDDING_DIMENSIONS: 1536,
    EMBEDDING_BATCH_SIZE: 32,
    RAG_VECTOR_SEARCH_ENABLED: false,
    RAG_VECTOR_CANDIDATE_LIMIT: 20,
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

describe('env validation for RAG embeddings', () => {
  const letsurEnv = {
    LETSUR_AI_GATEWAY_BASE_URL: 'https://gw.letsur.ai/v1',
    LETSUR_AI_GATEWAY_API_KEY: 'letsur-key',
  };

  it('accepts the pgvector schema dimension and vector defaults', () => {
    const values: Record<string, unknown> = baseEnv(letsurEnv);
    delete values.EMBEDDING_DIMENSIONS;
    delete values.EMBEDDING_BATCH_SIZE;
    delete values.RAG_VECTOR_SEARCH_ENABLED;
    delete values.RAG_VECTOR_CANDIDATE_LIMIT;
    const validated = validate(values);
    expect(validated.EMBEDDING_DIMENSIONS).toBe(1536);
    expect(validated.EMBEDDING_BATCH_SIZE).toBe(32);
    expect(validated.RAG_VECTOR_SEARCH_ENABLED).toBe(false);
    expect(validated.RAG_VECTOR_CANDIDATE_LIMIT).toBe(20);
  });

  it('rejects a dimension that does not match vector(1536)', () => {
    expect(() =>
      validate(baseEnv({ ...letsurEnv, EMBEDDING_DIMENSIONS: 1024 })),
    ).toThrow(/EMBEDDING_DIMENSIONS must be 1536/);
  });
});
