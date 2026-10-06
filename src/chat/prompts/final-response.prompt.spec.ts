import { describe, expect, it } from '@jest/globals';
import {
  FINAL_RESPONSE_SYSTEM_PROMPT,
  NO_ANSWER_MESSAGE,
  isNoAnswerResponse,
} from './final-response.prompt';

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

describe('isNoAnswerResponse', () => {
  it.each([
    NO_ANSWER_MESSAGE,
    '현재 GIFT 프로그램 지원 시 장학금에 대한 정보는 확인할 수 없습니다.',
    '입사할 때 필요한 서류에 대한 정보는 현재 확인 가능한 내용이 없습니다.',
    '해당하는 문서를 찾지 못해 답변할 수 없습니다. 죄송합니다. 다른 질문이 있으면 물어봐 주세요.',
    '기숙사비에 대한 정보는 없습니다.\n\n추가로 궁금한 사항이 있으시면 말씀해 주세요.',
    '해당 질문에는 답변할 수 없습니다.',
    '죄송하지만 해당 정보는 확인할 수 없습니다.',
    // 스트림이 내용 없이 끝난 경우
    '',
  ])('treats a refusal-only answer as unanswered: %s', (answer) => {
    expect(isNoAnswerResponse(answer)).toBe(true);
  });

  it.each([
    '예체능 이수요건은 총 4과목입니다.',
    // 부분 답변: 내용 문장이 하나라도 있으면 답변이다
    '## 이수 요건\n- 체육 과목 2개와 예술 과목 2개를 이수해야 합니다.\n\n수강신청 기간에 대한 정보는 현재 확인 가능한 내용이 없습니다.',
    `GIFT 지원 자격은 3학년 이상입니다. 그 외 내용은 현재 확인 가능한 정보에 없습니다.`,
    // 연락처처럼 숫자가 있는 안내는 정보로 본다
    '장학금 정보는 확인할 수 없습니다. 학생지원팀(062-000-0000)에 문의하시기 바랍니다.',
    // 부재를 말하지만 그 자체가 답인 문장은 거절이 아니다
    '별도로 제출할 자료는 없습니다.',
    '분실물을 찾지 못한 경우 학생지원팀에 신고하세요.',
    '본인 확인이 어려운 경우 학생증을 지참하세요.',
    '개인정보 없이도 신청할 수 있습니다.',
    // 한 문장 안에 답과 거절이 섞인 부분 답변
    '졸업 요건은 130학점이지만 기숙사비는 확인할 수 없습니다.',
    '기숙사비는 확인할 수 없으나, 입사일은 2월 26일입니다.',
  ])('treats an answer with content as answered: %s', (answer) => {
    expect(isNoAnswerResponse(answer)).toBe(false);
  });
});
