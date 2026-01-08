import {
  extractDomain,
  isDomainAllowed,
  validateOriginAndPageUrl,
} from './domain-validator.util';

describe('DomainValidatorUtil', () => {
  describe('extractDomain', () => {
    it('should extract domain from https URL', () => {
      const domain = extractDomain('https://www.example.com/path');
      expect(domain).toBe('www.example.com');
    });

    it('should extract domain from http URL', () => {
      const domain = extractDomain('http://example.com');
      expect(domain).toBe('example.com');
    });

    it('should extract domain with port', () => {
      const domain = extractDomain('https://localhost:3000/api');
      expect(domain).toBe('localhost');
    });

    it('should handle URL without protocol', () => {
      const domain = extractDomain('example.com/path');
      expect(domain).toBe('example.com');
    });
  });

  describe('isDomainAllowed', () => {
    it('should allow exact domain match', () => {
      const allowed = isDomainAllowed('example.com', ['example.com']);
      expect(allowed).toBe(true);
    });

    it('should allow subdomain when root domain is allowed', () => {
      const allowed = isDomainAllowed('www.example.com', ['example.com']);
      expect(allowed).toBe(true);
    });

    it('should allow wildcard subdomain', () => {
      const allowed = isDomainAllowed('api.example.com', ['*.example.com']);
      expect(allowed).toBe(true);
    });

    it('should allow nested subdomain with wildcard', () => {
      const allowed = isDomainAllowed('api.v1.example.com', ['*.example.com']);
      expect(allowed).toBe(true);
    });

    it('should reject non-matching domain', () => {
      const allowed = isDomainAllowed('other.com', ['example.com']);
      expect(allowed).toBe(false);
    });

    it('should be case-insensitive', () => {
      const allowed = isDomainAllowed('Example.COM', ['example.com']);
      expect(allowed).toBe(true);
    });

    it('should reject empty domain', () => {
      const allowed = isDomainAllowed('', ['example.com']);
      expect(allowed).toBe(false);
    });

    it('should reject when allowedDomains is empty', () => {
      const allowed = isDomainAllowed('example.com', []);
      expect(allowed).toBe(false);
    });
  });

  describe('validateOriginAndPageUrl', () => {
    it('should accept when only pageUrl is provided', () => {
      const result = validateOriginAndPageUrl(
        undefined,
        'https://example.com/page',
      );
      expect(result.valid).toBe(true);
      expect(result.domain).toBe('example.com');
    });

    it('should accept when origin and pageUrl match', () => {
      const result = validateOriginAndPageUrl(
        'https://example.com',
        'https://example.com/page',
      );
      expect(result.valid).toBe(true);
      expect(result.domain).toBe('example.com');
    });

    it('should reject when origin and pageUrl domains differ', () => {
      const result = validateOriginAndPageUrl(
        'https://example.com',
        'https://other.com/page',
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('mismatch');
    });

    it('should handle URL-like string without protocol', () => {
      const result = validateOriginAndPageUrl(undefined, 'invalid-url');
      // extractDomain은 URL-like string도 처리 가능
      expect(result.valid).toBe(true);
      expect(result.domain).toBe('invalid-url');
    });

    it('should be case-insensitive for domain matching', () => {
      const result = validateOriginAndPageUrl(
        'https://Example.COM',
        'https://example.com/page',
      );
      expect(result.valid).toBe(true);
    });
  });
});
