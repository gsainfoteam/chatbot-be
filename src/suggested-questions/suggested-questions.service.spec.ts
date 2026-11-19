import { describe, expect, it, jest } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { SuggestedQuestionsRepository } from './suggested-questions.repository';
import { SuggestedQuestionsService } from './suggested-questions.service';
import {
  ListSuggestedQuestionsQueryDto,
  SUGGESTED_QUESTION_DEFAULT_LIMIT,
  SUGGESTED_QUESTION_MAX_LIMIT,
} from './dto/suggested-question.dto';

const WIDGET_KEY_ID = '00000000-0000-0000-0000-0000000000b1';
const QUESTION_ID = '00000000-0000-0000-0000-0000000000a1';

function service(rows: { id: string; question: string }[]) {
  const listApproved = jest
    .fn<SuggestedQuestionsRepository['listApproved']>()
    .mockResolvedValue(rows);
  const repository = {
    listApproved,
  } as unknown as SuggestedQuestionsRepository;
  return { service: new SuggestedQuestionsService(repository), listApproved };
}

describe('SuggestedQuestionsService', () => {
  it('scopes the lookup to the session widget key', async () => {
    const { service: subject, listApproved } = service([]);

    await subject.listForWidget(WIDGET_KEY_ID, 3);

    expect(listApproved).toHaveBeenCalledWith(WIDGET_KEY_ID, 3);
  });

  it('returns only the id and question', async () => {
    // 저장소가 실수로 prompt를 실어 보내도 위젯 응답에는 나가지 않아야 한다.
    const { service: subject } = service([
      {
        id: QUESTION_ID,
        question: '국가장학금 언제까지 신청해요?',
        prompt: '답변할 때 쓰는 내부 지침',
      } as { id: string; question: string },
    ]);

    const result = await subject.listForWidget(WIDGET_KEY_ID, 5);

    expect(result).toEqual([
      { id: QUESTION_ID, question: '국가장학금 언제까지 신청해요?' },
    ]);
    expect(Object.keys(result[0])).toEqual(['id', 'question']);
  });

  it('returns an empty list when nothing is approved', async () => {
    const { service: subject } = service([]);

    await expect(subject.listForWidget(WIDGET_KEY_ID, 5)).resolves.toEqual([]);
  });
});

describe('ListSuggestedQuestionsQueryDto', () => {
  function parse(query: Record<string, unknown>) {
    const dto = plainToInstance(ListSuggestedQuestionsQueryDto, query, {
      enableImplicitConversion: false,
    });
    return { dto, errors: validateSync(dto) };
  }

  it('defaults the limit when it is omitted', () => {
    const { dto, errors } = parse({});

    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(SUGGESTED_QUESTION_DEFAULT_LIMIT);
  });

  it('accepts a numeric string from the query string', () => {
    const { dto, errors } = parse({ limit: '10' });

    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(10);
  });

  it('rejects a limit above the cap', () => {
    const { errors } = parse({
      limit: String(SUGGESTED_QUESTION_MAX_LIMIT + 1),
    });

    expect(errors).toHaveLength(1);
  });

  it('rejects a limit below one', () => {
    const { errors } = parse({ limit: '0' });

    expect(errors).toHaveLength(1);
  });
});
