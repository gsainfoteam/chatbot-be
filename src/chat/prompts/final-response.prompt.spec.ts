import { describe, expect, it } from '@jest/globals';
import { FINAL_RESPONSE_SYSTEM_PROMPT } from './final-response.prompt';

describe('FINAL_RESPONSE_SYSTEM_PROMPT', () => {
  it('requires direct answers without exposing document retrieval', () => {
    expect(FINAL_RESPONSE_SYSTEM_PROMPT).toContain(
      '출처를 드러내지 않는 자연스러운 서술',
    );
    expect(FINAL_RESPONSE_SYSTEM_PROMPT).toContain('"문서에 따르면"');
    expect(FINAL_RESPONSE_SYSTEM_PROMPT).toContain(
      '사용자가 출처나 근거를 명시적으로 묻지 않았다면',
    );
  });
});
