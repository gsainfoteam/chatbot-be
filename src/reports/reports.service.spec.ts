import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { OrganizationsRepository } from '../organizations/organizations.repository';
import type { UnansweredQuestionsRepository } from '../unanswered-questions/unanswered-questions.repository';
import { MonthlyReportQueryDto } from './dto/monthly-report.dto';
import type { ProblemKind, ReportsRepository } from './reports.repository';
import { ReportsService, addMonths, monthPeriod } from './reports.service';

const admin = { uuid: 'admin-1', email: 'admin@example.com', role: 'ADMIN' };
const totals = (overrides: Record<string, number> = {}) => ({
  questions: 0,
  answers: 0,
  users: 0,
  tokens: 0,
  avgResponseMs: null,
  good: 0,
  bad: 0,
  regenerated: 0,
  ...overrides,
});

const createService = ({
  exists = true,
  superAdmin = false,
  accessible = ['key-1'],
} = {}) => {
  const repo = {
    widgetKeyExists: jest.fn().mockResolvedValue(exists),
    summarize: jest.fn().mockResolvedValue(totals()),
    countOutcomes: jest.fn().mockResolvedValue([]),
    listProblemQuestions: jest.fn().mockResolvedValue([]),
    countUnansweredChanges: jest
      .fn()
      .mockResolvedValue({ created: 0, resolved: 0 }),
  };
  const organizationsRepo = {
    isCurrentSuperAdmin: jest.fn().mockResolvedValue(superAdmin),
  };
  const unansweredRepo = {
    listAccessibleWidgetKeyIds: jest.fn().mockResolvedValue(accessible),
  };
  const service = new ReportsService(
    repo as unknown as ReportsRepository,
    organizationsRepo as unknown as OrganizationsRepository,
    unansweredRepo as unknown as UnansweredQuestionsRepository,
  );
  return { service, repo, unansweredRepo };
};

describe('report periods', () => {
  it('moves months across year boundaries', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(monthPeriod('2026-12')).toEqual({
      start: '2026-12-01',
      end: '2027-01-01',
    });
  });

  it('accepts only YYYY-MM months of 2000-2099', async () => {
    const errors = (month: string) =>
      validate(plainToInstance(MonthlyReportQueryDto, { month }));

    expect(await errors('2026-10')).toHaveLength(0);
    for (const invalid of [
      '2026-13',
      '2026-00',
      '2026-1',
      '26-10',
      'october',
      '0000-01', // PostgreSQL에 없는 연도
      '0099-05', // Date.UTC가 1999년으로 바꾸는 연도
      '1999-12',
    ]) {
      expect(await errors(invalid)).not.toHaveLength(0);
    }
  });
});

describe('ReportsService.getMonthlyReport', () => {
  afterEach(() => jest.useRealTimers());

  it('defaults to the previous month in KST', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-30T15:30:00Z') }); // 12/1 00:30 KST
    const { service, repo } = createService();

    const report = await service.getMonthlyReport('key-1', admin);

    expect(report.period).toEqual({
      month: '2026-11',
      start: '2026-11-01',
      end: '2026-12-01',
      timeZone: 'Asia/Seoul',
    });
    expect(repo.summarize).toHaveBeenCalledWith('key-1', {
      start: '2026-10-01',
      end: '2026-11-01',
    });
  });

  it('allows the current month and rejects a future one', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-21T03:00:00Z') });
    const { service } = createService();

    await expect(
      service.getMonthlyReport('key-1', admin, '2026-11'),
    ).resolves.toBeDefined();
    await expect(
      service.getMonthlyReport('key-1', admin, '2026-12'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets owners, collaborators and super admins view, and hides the key from others', async () => {
    const view = (options: Parameters<typeof createService>[0]) =>
      createService(options).service.getMonthlyReport(
        'key-1',
        admin,
        '2026-10',
      );

    await expect(view({ accessible: ['other-key'] })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(view({ accessible: ['key-1'] })).resolves.toBeDefined();
    await expect(
      view({ superAdmin: true, exists: false, accessible: [] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    const superAdmin = createService({ superAdmin: true, accessible: [] });
    await expect(
      superAdmin.service.getMonthlyReport('key-1', admin, '2026-10'),
    ).resolves.toBeDefined();
    expect(
      superAdmin.unansweredRepo.listAccessibleWidgetKeyIds,
    ).not.toHaveBeenCalled();
  });

  it('computes rates, zero-fills outcomes and groups the same questions', async () => {
    const { service, repo } = createService();
    repo.summarize
      .mockResolvedValueOnce(
        totals({ answers: 8, good: 3, bad: 2, regenerated: 1 }),
      )
      .mockResolvedValueOnce(totals());
    repo.countOutcomes.mockResolvedValue([
      { outcome: 'answered', count: 5 },
      { outcome: null, count: 2 },
      { outcome: 'surprise', count: 1 },
    ]);
    repo.listProblemQuestions.mockImplementation(
      async (_key: string, _period: unknown, kind: ProblemKind) =>
        kind === 'bad'
          ? ['학식 메뉴?', '셔틀', '학식 메뉴 ']
          : Array.from({ length: 12 }, (_, i) => `질문 ${i}`),
    );

    const report = await service.getMonthlyReport('key-1', admin, '2026-10');

    expect(repo.summarize).toHaveBeenNthCalledWith(2, 'key-1', {
      start: '2026-09-01',
      end: '2026-10-01',
    });
    expect(report.current.feedback).toEqual({
      good: 3,
      bad: 2,
      regenerated: 1,
      badRate: 25,
      feedbackRate: 62.5,
    });
    expect(report.previous.feedback.badRate).toBeNull();
    expect(report.outcomes).toEqual([
      { outcome: 'answered', count: 5 },
      { outcome: 'partial', count: 0 },
      { outcome: 'source-only', count: 0 },
      { outcome: 'unanswered', count: 0 },
      { outcome: 'scope-refused', count: 0 },
      { outcome: 'unknown', count: 3 },
    ]);
    expect(report.topBadQuestions).toEqual([
      { question: '학식 메뉴?', count: 2 },
      { question: '셔틀', count: 1 },
    ]);
    expect(report.topUnansweredQuestions).toHaveLength(10);
    expect(report.topUnansweredQuestions[0]).toEqual({
      question: '질문 0',
      count: 1,
    });
  });
});
