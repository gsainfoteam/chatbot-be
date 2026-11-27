import { describe, expect, it, jest } from '@jest/globals';
import type { SuggestedQuestionSource } from '../db';
import type {
  ActiveQuestionRecord,
  SuggestedQuestionsRepository,
} from './suggested-questions.repository';
import { SuggestedQuestionsService } from './suggested-questions.service';
import { SUGGESTED_QUESTIONS_PER_SOURCE } from './dto/suggested-question.dto';

function row(
  id: string,
  source: SuggestedQuestionSource,
  question = `${source} 질문 ${id}`,
): ActiveQuestionRecord {
  return { id, question, prompt: `${question}에 대한 요청문`, source };
}

function service(
  bySource: Record<SuggestedQuestionSource, ActiveQuestionRecord[]>,
) {
  const pickActive = jest.fn<SuggestedQuestionsRepository['pickActive']>(
    async (source) => bySource[source],
  );
  const repository = { pickActive } as unknown as SuggestedQuestionsRepository;
  return { service: new SuggestedQuestionsService(repository), pickActive };
}

describe('SuggestedQuestionsService', () => {
  it('picks two from each source', async () => {
    const { service: subject, pickActive } = service({ ADMIN: [], AI: [] });

    await subject.listForWidget();

    expect(SUGGESTED_QUESTIONS_PER_SOURCE).toBe(2);
    expect(pickActive).toHaveBeenCalledTimes(2);
    expect(pickActive).toHaveBeenCalledWith('ADMIN', 2, expect.any(Date));
    expect(pickActive).toHaveBeenCalledWith('AI', 2, expect.any(Date));
  });

  it('puts admin questions first so the top row is admin-written', async () => {
    const { service: subject } = service({
      AI: [row('a1', 'AI'), row('a2', 'AI')],
      ADMIN: [row('m1', 'ADMIN'), row('m2', 'ADMIN')],
    });

    const result = await subject.listForWidget();

    expect(result.map((q) => q.source)).toEqual(['ADMIN', 'ADMIN', 'AI', 'AI']);
  });

  it('does not backfill a short source from the other one', async () => {
    const { service: subject } = service({
      ADMIN: [row('m1', 'ADMIN'), row('m2', 'ADMIN')],
      AI: [],
    });

    const result = await subject.listForWidget();

    expect(result).toHaveLength(2);
    expect(result.every((q) => q.source === 'ADMIN')).toBe(true);
  });

  it('hands the question and prompt to the widget as a pair', async () => {
    // FE는 question을 버튼에 띄우고, 누르면 prompt를 채팅 요청에 보낸다.
    // 저장소가 다른 열을 실어 보내도 위젯 응답에는 이 네 개만 나가야 한다.
    const extra = {
      ...row('m1', 'ADMIN', '학교 Wi-Fi는 어떻게 설정하나요?'),
      reviewedByIdpUuid: 'admin-1',
    } as ActiveQuestionRecord;
    const { service: subject } = service({ ADMIN: [extra], AI: [] });

    const result = await subject.listForWidget();

    expect(result).toEqual([
      {
        id: 'm1',
        question: '학교 Wi-Fi는 어떻게 설정하나요?',
        prompt: '학교 Wi-Fi는 어떻게 설정하나요?에 대한 요청문',
        source: 'ADMIN',
      },
    ]);
    expect(Object.keys(result[0])).toEqual([
      'id',
      'question',
      'prompt',
      'source',
    ]);
  });

  it('returns an empty list when nothing is active', async () => {
    const { service: subject } = service({ ADMIN: [], AI: [] });

    await expect(subject.listForWidget()).resolves.toEqual([]);
  });
});
