import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Trace } from '@gsainfoteam/nest-observability';
import { OrganizationsRepository } from '../organizations/organizations.repository';
import type { AdminPrincipal } from '../organizations/organization.types';
import { normalizeQuestion } from '../unanswered-questions/question-normalizer';
import { UnansweredQuestionsRepository } from '../unanswered-questions/unanswered-questions.repository';
import {
  MonthlyReportDto,
  REPORT_OUTCOMES,
  type ReportOutcome,
  type ReportQuestionCountDto,
  type ReportTotalsDto,
} from './dto/monthly-report.dto';
import { ReportsRepository, type ReportPeriod } from './reports.repository';

const TOP_QUESTIONS = 10;
const KST_MONTH = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
});

/** 'YYYY-MM'을 offset달만큼 옮긴다. */
export function addMonths(month: string, offset: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber - 1 + offset, 1))
    .toISOString()
    .slice(0, 7);
}

/** 'YYYY-MM'을 KST 기간으로 바꾼다. 주간 보고서는 같은 모양의 기간 함수만 더하면 된다. */
export function monthPeriod(month: string): ReportPeriod {
  return { start: `${month}-01`, end: `${addMonths(month, 1)}-01` };
}

@Trace()
@Injectable()
export class ReportsService {
  constructor(
    private readonly repo: ReportsRepository,
    private readonly organizationsRepo: OrganizationsRepository,
    private readonly unansweredRepo: UnansweredQuestionsRepository,
  ) {}

  /** 요청한 달(기본은 지난달)을 요청 시점에 집계한다. 진행 중인 달은 지금까지의 값이다. */
  async getMonthlyReport(
    widgetKeyId: string,
    principal: AdminPrincipal,
    month?: string,
  ): Promise<MonthlyReportDto> {
    await this.assertCanView(widgetKeyId, principal);
    const thisMonth = KST_MONTH.format(new Date());
    const target = month ?? addMonths(thisMonth, -1);
    if (target > thisMonth) {
      throw new BadRequestException('month cannot be in the future');
    }

    const period = monthPeriod(target);
    const [current, previous, outcomes, bad, unanswered, unansweredChanges] =
      await Promise.all([
        this.repo.summarize(widgetKeyId, period),
        this.repo.summarize(widgetKeyId, monthPeriod(addMonths(target, -1))),
        this.repo.countOutcomes(widgetKeyId, period),
        this.repo.listProblemQuestions(widgetKeyId, period, 'bad'),
        this.repo.listProblemQuestions(widgetKeyId, period, 'unanswered'),
        this.repo.countUnansweredChanges(widgetKeyId, period),
      ]);

    const outcomeCounts = new Map<ReportOutcome, number>();
    for (const { outcome, count } of outcomes) {
      const key = REPORT_OUTCOMES.includes(outcome as ReportOutcome)
        ? (outcome as ReportOutcome)
        : 'unknown';
      outcomeCounts.set(key, (outcomeCounts.get(key) ?? 0) + count);
    }

    return {
      widgetKeyId,
      period: { month: target, ...period, timeZone: 'Asia/Seoul' },
      current: toTotals(current),
      previous: toTotals(previous),
      outcomes: REPORT_OUTCOMES.map((outcome) => ({
        outcome,
        count: outcomeCounts.get(outcome) ?? 0,
      })),
      topBadQuestions: topQuestions(bad),
      topUnansweredQuestions: topQuestions(unanswered),
      unansweredQuestionCounts: unansweredChanges,
    };
  }

  /**
   * 키 소유자·수락한 협업자·SUPER_ADMIN만 본다(미답변 질문 API와 같은 규칙).
   * 볼 수 없는 키도 미답변 질문 API처럼 존재를 드러내지 않고 404로 답한다.
   */
  private async assertCanView(widgetKeyId: string, principal: AdminPrincipal) {
    const visible = (await this.organizationsRepo.isCurrentSuperAdmin(
      principal,
    ))
      ? await this.repo.widgetKeyExists(widgetKeyId)
      : (
          await this.unansweredRepo.listAccessibleWidgetKeyIds(principal.uuid)
        ).includes(widgetKeyId);
    if (!visible) throw new NotFoundException('Widget key not found');
  }
}

function toTotals(
  row: Awaited<ReturnType<ReportsRepository['summarize']>>,
): ReportTotalsDto {
  const { questions, answers, users, tokens, avgResponseMs } = row;
  const { good, bad, regenerated } = row;
  return {
    summary: { questions, answers, users, tokens, avgResponseMs },
    feedback: {
      good,
      bad,
      regenerated,
      badRate: percent(bad, answers),
      feedbackRate: percent(good + bad, answers),
    },
  };
}

function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

/** 같은 질문(normalizeQuestion 기준)을 묶어 많은 순으로 고른다. 입력이 최신순이라 동률이면 최근 질문이 먼저다. */
function topQuestions(questions: string[]): ReportQuestionCountDto[] {
  const groups = new Map<string, ReportQuestionCountDto>();
  for (const question of questions) {
    const key = normalizeQuestion(question);
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { question, count: 1 });
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_QUESTIONS);
}
