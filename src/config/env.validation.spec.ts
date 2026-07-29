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
