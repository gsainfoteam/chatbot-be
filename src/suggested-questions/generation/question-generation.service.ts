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

export interface GeneratedQuestion {
  question: string;
  prompt: string;
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
    widgetKeyId: string,
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
            noticeUrl: this.ziggle.noticeUrl(notice.id),
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

    let saved = 0;
    for (const candidate of candidates) {
      const row = await this.repo.create({
        widgetKeyId,
        question: candidate.question,
        prompt: candidate.prompt,
        source: 'AI',
        status: 'PENDING',
        createdByIdpUuid: null,
        reviewedByIdpUuid: null,
        reviewedAt: null,
        noticeId: notice.id,
        noticeTitle: maskPersonalInfo(notice.title).slice(0, 500),
      });
      // null이면 같은 질문이 이미 있다는 뜻. 공지가 겹치면 흔한 일이라 넘어간다.
      if (row) saved += 1;
    }

    this.logger.log(
      `id=${notice.id} 질문 ${saved}/${candidates.length}건 저장 (PENDING)`,
    );
    return { noticeId: notice.id, saved, skipped: false };
  }

  /** 요약이 있으면 그걸 쓰고, 없으면 본문을 받아 평문으로 바꾼다. */
  private async readBody(
    notice: ZiggleNoticeSummary,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (notice.summary?.trim()) {
      return maskPersonalInfo(notice.summary).slice(0, MAX_BODY_CHARS);
    }

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
    const { question, prompt } = item as Record<string, unknown>;
    if (typeof question !== 'string' || typeof prompt !== 'string') continue;

    const trimmedQuestion = question.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedQuestion || !trimmedPrompt) continue;
    // DB의 길이 제약에 걸리면 삽입이 통째로 실패하므로 여기서 버린다.
    if (trimmedQuestion.length > SUGGESTED_QUESTION_MAX_LENGTH) continue;

    const key = normalizeQuestion(trimmedQuestion);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    questions.push({ question: trimmedQuestion, prompt: trimmedPrompt });
  }
  return questions;
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
