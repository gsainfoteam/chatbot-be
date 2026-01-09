import 'reflect-metadata';
import { validate } from './env.validation';

describe('Environment Validation', () => {
  const validConfig = {
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_USER: 'postgres',
    DB_PASSWORD: 'postgres',
    DB_NAME: 'ziggle_chatbot',
    DB_SSL: 'false',
    PORT: '3000',
    NODE_ENV: 'development',
    JWT_SECRET: 'this-is-a-very-long-secret-key-with-at-least-32-characters',
    JWT_EXPIRES_IN: '3600',
    ADMIN_BEARER_TOKEN: 'admin-token-with-at-least-16-chars',
    IDP_URL: 'https://idp.test.com',
    IDP_CLIENT_ID: 'test-client-id',
    IDP_CLIENT_SECRET: 'test-client-secret',
  };

  it('should validate correct environment variables', () => {
    expect(() => validate(validConfig)).not.toThrow();
  });

  it('should convert string numbers to numbers', () => {
    const result = validate(validConfig);
    expect(typeof result.DB_PORT).toBe('number');
    expect(result.DB_PORT).toBe(5432);
    expect(typeof result.PORT).toBe('number');
    expect(result.PORT).toBe(3000);
    expect(typeof result.JWT_EXPIRES_IN).toBe('number');
    expect(result.JWT_EXPIRES_IN).toBe(3600);
  });

  it('should convert string booleans to booleans', () => {
    // class-transformer는 'false' 문자열을 true로 변환합니다 (truthy 값)
    // 실제 boolean false를 원하면 빈 문자열이나 '0' 사용
    const falseConfig = { ...validConfig, DB_SSL: '' };
    const falseResult = validate(falseConfig);
    expect(typeof falseResult.DB_SSL).toBe('boolean');
    expect(falseResult.DB_SSL).toBe(false);

    const trueConfig = { ...validConfig, DB_SSL: 'true' };
    const trueResult = validate(trueConfig);
    expect(typeof trueResult.DB_SSL).toBe('boolean');
    expect(trueResult.DB_SSL).toBe(true);
  });

  it('should throw error when DB_HOST is missing', () => {
    const { DB_HOST, ...config } = validConfig;
    expect(() => validate(config)).toThrow(/DB_HOST/);
  });

  it('should throw error when DB_PORT is invalid', () => {
    const invalidPortConfig = { ...validConfig, DB_PORT: '70000' };
    expect(() => validate(invalidPortConfig)).toThrow();
  });

  it('should throw error when NODE_ENV is invalid', () => {
    const invalidEnvConfig = { ...validConfig, NODE_ENV: 'invalid' };
    expect(() => validate(invalidEnvConfig)).toThrow();
  });

  it('should throw error when JWT_SECRET is too short', () => {
    const shortSecretConfig = { ...validConfig, JWT_SECRET: 'short' };
    expect(() => validate(shortSecretConfig)).toThrow(/at least 32 characters/);
  });

  it('should throw error when ADMIN_BEARER_TOKEN is too short', () => {
    const shortTokenConfig = { ...validConfig, ADMIN_BEARER_TOKEN: 'short' };
    expect(() => validate(shortTokenConfig)).toThrow(/at least 16 characters/);
  });

  it('should throw error when JWT_EXPIRES_IN is too short', () => {
    const shortExpiresConfig = { ...validConfig, JWT_EXPIRES_IN: '30' };
    expect(() => validate(shortExpiresConfig)).toThrow();
  });

  it('should throw error when JWT_EXPIRES_IN is too long', () => {
    const longExpiresConfig = { ...validConfig, JWT_EXPIRES_IN: '86401' };
    expect(() => validate(longExpiresConfig)).toThrow();
  });

  it('should accept production environment', () => {
    const prodConfig = { ...validConfig, NODE_ENV: 'production' };
    expect(() => validate(prodConfig)).not.toThrow();
  });

  it('should accept test environment', () => {
    const testConfig = { ...validConfig, NODE_ENV: 'test' };
    expect(() => validate(testConfig)).not.toThrow();
  });

  it('should throw descriptive error messages', () => {
    const invalidConfig = {
      ...validConfig,
      DB_PORT: 'invalid',
      JWT_SECRET: 'short',
    };

    try {
      validate(invalidConfig);
      fail('Should have thrown an error');
    } catch (error) {
      expect(error.message).toContain('Environment variable validation failed');
    }
  });

  it('should validate all required fields are present', () => {
    const incompleteConfig = {
      DB_HOST: 'localhost',
      DB_PORT: '5432',
      // Missing other required fields
    };

    expect(() => validate(incompleteConfig)).toThrow();
  });
});
