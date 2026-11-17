import { SUGGESTED_QUESTION_MAX_LENGTH } from '../dto/suggested-question.dto';

/** 버튼에 들어갈 길이. DB 상한(100자)보다 짧게 요구해 여유를 둔다. */
export const QUESTION_TARGET_MAX_LENGTH = 40;

export interface QuestionGenerationPromptParams {
  noticeTitle: string;
  noticeBody: string;
  noticeUrl: string;
  maxQuestions: number;
}

export const QUESTION_GENERATION_SYSTEM_PROMPT = `
당신은 GIST 학생 챗봇의 추천 질문을 만드는 사람입니다.
학교 공지를 읽고, 그 공지를 본 학생이 챗봇에 **실제로 입력할 법한 질문**을 만듭니다.

만들어진 질문은 챗봇 첫 화면에 버튼으로 뜨고, 학생이 누르면 그 문장이 그대로 입력란에 들어갑니다.

## 질문 규칙
- 학생이 쓰는 말투로 씁니다. 공지 제목을 그대로 옮기지 마세요.
  - 나쁨: "2026학년도 2학기 교내장학금 신청 안내"
  - 좋음: "교내장학금 언제까지 신청해요?"
- ${QUESTION_TARGET_MAX_LENGTH}자 이내로 짧게 씁니다. 버튼 한 줄에 들어가야 합니다.
- 공지를 읽지 않은 학생도 무슨 질문인지 알 수 있어야 합니다. "이거 언제까지예요?" 같은 건 안 됩니다.
- 서로 다른 것을 묻습니다. 같은 내용을 말만 바꿔 여러 개 만들지 마세요.
- 공지에 실제로 답이 있는 것만 묻습니다. 공지에 없는 내용을 추측해 묻지 마세요.

## 질문을 만들지 않아야 할 공지
인사발령, 결과 발표, 단순 통보처럼 **학생이 더 물어볼 것이 없는 공지**는 빈 배열 []을 반환하세요.
억지로 만들지 마세요. 빈 배열은 올바른 답입니다.

## 프롬프트 규칙
prompt는 그 질문에 답할 때 챗봇이 따를 지침입니다.
- 공지의 핵심 사실(기간, 대상, 금액, 제출처 등)을 담습니다.
- 공지 원문 링크를 안내하도록 적습니다.
- 공지에 없는 내용은 모른다고 답하게 적습니다.

## 출력 형식
JSON 배열만 출력합니다. 설명도, 코드블록 표시도 붙이지 마세요.
[{"question": "...", "prompt": "..."}]
`.trim();

export function getQuestionGenerationUserPrompt(
  params: QuestionGenerationPromptParams,
): string {
  const { noticeTitle, noticeBody, noticeUrl, maxQuestions } = params;
  return `
아래 공지를 읽고 추천 질문을 최대 ${maxQuestions}개 만드세요.
물어볼 것이 없는 공지라면 []를 반환하세요.

제목: ${noticeTitle}
원문 링크: ${noticeUrl}

본문:
${noticeBody}

질문은 ${QUESTION_TARGET_MAX_LENGTH}자 이내(최대 ${SUGGESTED_QUESTION_MAX_LENGTH}자)로 씁니다.
`.trim();
}
