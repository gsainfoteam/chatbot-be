import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  LLM_CLIENT,
  type LlmClient,
} from '../../chat/llm/llm-client.interface';
import type { LlmModelType } from '../../chat/types/llm.types';
import {
  ZiggleNoticeClient,
  type ZiggleNoticeSummary,
} from '../../chat/agent/tools/ziggle/ziggle-notice.client';
import {
  hasImage,
  htmlToPlainText,
  maskPersonalInfo,
} from '../../chat/agent/tools/ziggle/notice-text';
import { SuggestedQuestionsRepository } from '../suggested-questions.repository';
import { SUGGESTED_QUESTION_MAX_LENGTH } from '../dto/suggested-question.dto';
import { normalizeQuestion } from '../../unanswered-questions/question-normalizer';
import {
  QUESTION_GENERATION_SYSTEM_PROMPT,
  buildAnswerPrompt,
  getQuestionGenerationUserPrompt,
} from './question-generation.prompt';

/**
 * 공지 하나에서 만들 질문 수 상한.
 *
 * 많이 만드는 것이 목적이 아니다. 한 공지에서 학생이 실제로 물어볼 만한 것은
 * 보통 마감일과 신청 방법 둘이고, 셋째부터는 같은 내용을 말만 바꾼 것이 나온다.
 */
export const QUESTIONS_PER_NOTICE = 2;

/** LLM에 넘기는 본문 길이 상한. 공지는 보통 2천 자 안팎이다. */
export const MAX_BODY_CHARS = 6000;

/**
 * 공지 한 건을 읽고 질문 두 개를 만드는 일에는 normal이면 충분하다.
 * light는 자기완결적인 질문을 못 만들고, heavy는 하루 몇 건에 쓸 이유가 없다.
 */
export const MODEL_TIER: LlmModelType = 'normal';

/**
 * 검색어 개수와 길이 상한. 에이전트의 search_notices가 키워드 하나를 20자까지만 받는다.
 */
export const MAX_KEYWORDS = 3;
export const MAX_KEYWORD_CHARS = 20;

/** LLM이 돌려준 한 건. 답변용 prompt는 이걸로 코드가 조립한다. */
export interface GeneratedQuestion {
  question: string;
  /** 모델이 고른 검색어. 본문에 실제로 있는지는 아직 확인 전이다. */
  keywords: string[];
}

export interface NoticeGenerationResult {
  noticeId: number;
  /** 저장된 질문 수. 질문거리가 없는 공지면 0 */
  saved: number;
  /** 본문을 읽지 못해 건너뛴 경우 */
  skipped: boolean;
}

/**
 * 공지 하나를 읽어 추천 질문 후보를 만든다. 저장은 항상 PENDING이라
 * 관리자가 승인하기 전에는 위젯에 나가지 않는다.
 */
@Injectable()
export class QuestionGenerationService {
  private readonly logger = new Logger(QuestionGenerationService.name);

  constructor(
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
    private readonly ziggle: ZiggleNoticeClient,
    private readonly repo: SuggestedQuestionsRepository,
  ) {}

  /**
   * 공지 하나 처리.
   *
   * 본문을 못 읽으면 건너뛴다(이미지만 있는 공지 등). LLM 호출이 실패하면 예외를
   * 그대로 올려 호출 쪽이 선점을 되돌리게 한다. 응답은 왔는데 질문이 0개인 것은
   * 정상이므로 예외가 아니다.
   */
  async generateForNotice(
    notice: ZiggleNoticeSummary,
    signal?: AbortSignal,
  ): Promise<NoticeGenerationResult> {
    const body = await this.readBody(notice, signal);
    if (!body) {
      this.logger.debug(`id=${notice.id} 본문을 읽지 못해 건너뜁니다`);
      return { noticeId: notice.id, saved: 0, skipped: true };
    }

    const response = await this.llm.callLLM(
      [
        { role: 'system', content: QUESTION_GENERATION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: getQuestionGenerationUserPrompt({
            today: todayInSeoul(),
            noticeTitle: maskPersonalInfo(notice.title),
            noticeBody: body,
            maxQuestions: QUESTIONS_PER_NOTICE,
          }),
        },
      ],
      this.llm.getModel(MODEL_TIER),
      { temperature: 0.4, max_tokens: 2000, signal },
    );

    const raw = response.choices[0]?.message?.content ?? '';
    const candidates = parseGeneratedQuestions(raw).slice(
      0,
      QUESTIONS_PER_NOTICE,
    );
    if (candidates.length === 0) {
      this.logger.debug(`id=${notice.id} 만들 질문이 없습니다`);
      return { noticeId: notice.id, saved: 0, skipped: false };
    }

    const noticeTitle = maskPersonalInfo(notice.title).slice(0, 500);
    let saved = 0;
    for (const candidate of candidates) {
      // 본문에 없는 검색어로는 이 공지가 검색되지 않는다. 하나도 남지 않으면 챗봇이
      // 공지를 찾지 못하는 질문이라 버린다.
      const keywords = keywordsFoundInBody(candidate.keywords, body);
      if (keywords.length === 0) {
        this.logger.debug(
          `id=${notice.id} 본문에 있는 검색어가 없어 버립니다: ${candidate.question}`,
        );
        continue;
      }

      const row = await this.repo.create({
        question: candidate.question,
        prompt: buildAnswerPrompt({
          noticeId: notice.id,
          noticeTitle,
          keywords,
          question: candidate.question,
        }),
        source: 'AI',
        status: 'PENDING',
        createdByIdpUuid: null,
        reviewedByIdpUuid: null,
        reviewedAt: null,
        noticeId: notice.id,
        noticeTitle,
      });
      // null이면 같은 질문이 이미 있다는 뜻. 공지가 겹치면 흔한 일이라 넘어간다.
      if (row) saved += 1;
    }

    this.logger.log(
      `id=${notice.id} 질문 ${saved}/${candidates.length}건 저장 (PENDING)`,
    );
    return { noticeId: notice.id, saved, skipped: false };
  }

  /**
   * 공지 본문을 평문으로 읽는다.
   *
   * 요약이 있어도 본문을 읽는다. 검색어는 지글 검색이 보는 본문(plainBody)에 있어야
   * 해서, 요약에서 고른 단어는 검색에 안 걸릴 수 있다. 새 공지는 하루 몇 건이라
   * 공지당 MCP 호출 하나는 부담이 아니다.
   *
   * 평문 본문이 없으면(이미지만 있는 공지) 건너뛴다. 요약이 있어도 그렇다. 지글 검색은
   * 본문만 보므로 이런 공지는 챗봇이 검색으로 찾을 수 없고, 질문을 만들어도 답하지 못한다.
   */
  private async readBody(
    notice: ZiggleNoticeSummary,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const html = await this.ziggle.getNoticeBody(notice.id, signal);
    if (html == null) return null;

    const text = maskPersonalInfo(htmlToPlainText(html)).trim();
    if (!text) {
      // 이미지만 있는 공지. 제목만으로 질문을 만들면 틀린 답을 부른다.
      this.logger.debug(
        `id=${notice.id} 평문 본문 없음 (이미지 ${hasImage(html) ? '있음' : '없음'})`,
      );
      return null;
    }
    return text.slice(0, MAX_BODY_CHARS);
  }
}

/**
 * LLM 응답에서 질문 후보를 뽑는다.
 *
 * 모델이 JSON을 마크다운 코드블록으로 감싸는 일이 잦아 먼저 벗겨 낸다.
 * 형식이 어긋난 항목은 버리고, 남은 것만 돌려준다. 파싱 실패는 빈 배열이다.
 */
export function parseGeneratedQuestions(raw: string): GeneratedQuestion[] {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const questions: GeneratedQuestion[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const { question, keywords } = item as Record<string, unknown>;
    if (typeof question !== 'string') continue;

    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) continue;
    // DB의 길이 제약에 걸리면 삽입이 통째로 실패하므로 여기서 버린다.
    if (trimmedQuestion.length > SUGGESTED_QUESTION_MAX_LENGTH) continue;

    const key = normalizeQuestion(trimmedQuestion);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    questions.push({
      question: trimmedQuestion,
      keywords: Array.isArray(keywords)
        ? keywords
            .filter((k): k is string => typeof k === 'string')
            .map((k) => k.trim())
            .filter(Boolean)
        : [],
    });
  }
  return questions;
}

/**
 * 모델이 고른 검색어 중 본문에 그대로 들어 있는 것만 남긴다.
 *
 * 지글 검색은 본문 부분일치(대소문자 무시)라 한 글자만 달라도 걸리지 않는다.
 * 모델은 "겨울행사"를 "겨울 행사"로 옮기는 식으로 자주 바꿔 쓰므로 믿지 않고 확인한다.
 */
export function keywordsFoundInBody(
  keywords: string[],
  body: string,
): string[] {
  const haystack = body.toLowerCase();
  const found: string[] = [];
  for (const keyword of keywords) {
    if (keyword.length > MAX_KEYWORD_CHARS) continue;
    const needle = keyword.toLowerCase();
    if (!haystack.includes(needle)) continue;
    if (found.some((k) => k.toLowerCase() === needle)) continue;
    found.push(keyword);
    if (found.length === MAX_KEYWORDS) break;
  }
  return found;
}

/** 한국 시간 기준 오늘. 컨테이너가 UTC라 타임존을 명시한다. */
export function todayInSeoul(now: Date = new Date()): string {
  return now.toLocaleDateString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
