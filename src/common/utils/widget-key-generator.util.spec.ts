import {
  generateWidgetKey,
  isValidWidgetKeyFormat,
} from './widget-key-generator.util';

describe('WidgetKeyGeneratorUtil', () => {
  describe('generateWidgetKey', () => {
    it('should generate a key with correct prefix', () => {
      const key = generateWidgetKey();
      expect(key).toMatch(/^wk_live_/);
    });

    it('should generate a key with correct length', () => {
      const key = generateWidgetKey();
      expect(key.length).toBe(32); // wk_live_ (8) + nanoid (24)
    });

    it('should generate unique keys', () => {
      const key1 = generateWidgetKey();
      const key2 = generateWidgetKey();
      expect(key1).not.toBe(key2);
    });

    it('should generate valid format keys', () => {
      const key = generateWidgetKey();
      expect(isValidWidgetKeyFormat(key)).toBe(true);
    });
  });

  describe('isValidWidgetKeyFormat', () => {
    it('should accept valid widget key', () => {
      // 실제로 생성된 키로 테스트
      const generatedKey = generateWidgetKey();
      const valid = isValidWidgetKeyFormat(generatedKey);
      expect(valid).toBe(true);
    });

    it('should reject key without prefix', () => {
      const valid = isValidWidgetKeyFormat('abc123xyz789def456ghi789');
      expect(valid).toBe(false);
    });

    it('should reject key with wrong prefix', () => {
      const valid = isValidWidgetKeyFormat('wk_test_abc123xyz789def456ghi');
      expect(valid).toBe(false);
    });

    it('should reject key with wrong length', () => {
      const valid = isValidWidgetKeyFormat('wk_live_short');
      expect(valid).toBe(false);
    });

    it('should reject key with invalid characters', () => {
      const valid = isValidWidgetKeyFormat('wk_live_abc123@#$%^&*()def456');
      expect(valid).toBe(false);
    });

    it('should reject empty string', () => {
      const valid = isValidWidgetKeyFormat('');
      expect(valid).toBe(false);
    });

    it('should reject null or undefined', () => {
      expect(isValidWidgetKeyFormat(null as any)).toBe(false);
      expect(isValidWidgetKeyFormat(undefined as any)).toBe(false);
    });
  });
});
