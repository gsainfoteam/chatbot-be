import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

export class MonthlyReportQueryDto {
  @ApiPropertyOptional({
    description: '보고서 달(KST, YYYY-MM). 생략하면 지난달',
    example: '2026-10',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month?: string;
}

export const REPORT_OUTCOMES = [
  'answered',
  'partial',
  'source-only',
  'unanswered',
  'scope-refused',
  'unknown',
] as const;
export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];

export class ReportPeriodDto {
  @ApiProperty({ example: '2026-10' })
  month: string;

  @ApiProperty({ description: '시작일(포함, KST)', example: '2026-10-01' })
  start: string;

  @ApiProperty({ description: '종료일(미포함, KST)', example: '2026-11-01' })
  end: string;

  @ApiProperty({ example: 'Asia/Seoul' })
  timeZone: string;
}

export class ReportSummaryDto {
  @ApiProperty({ description: '사용자 질문 수' })
  questions: number;

  @ApiProperty({ description: '답변 수(재생성 포함)' })
  answers: number;

  @ApiProperty({ description: '질문한 사용자 수(clientId 기준, 없으면 세션)' })
  users: number;

  @ApiProperty({ description: '답변 토큰 합계' })
  tokens: number;

  @ApiProperty({
    description: '평균 응답 시간(ms). 기록이 없으면 null',
    type: Number,
    nullable: true,
  })
  avgResponseMs: number | null;
}

export class ReportFeedbackDto {
  @ApiProperty()
  good: number;

  @ApiProperty()
  bad: number;

  @ApiProperty({ description: 'BAD 피드백 후 재생성한 답변 수' })
  regenerated: number;

  @ApiProperty({
    description: 'BAD 비율(%, BAD/답변). 답변이 없으면 null',
    type: Number,
    nullable: true,
  })
  badRate: number | null;

  @ApiProperty({
    description: '피드백 참여율(%, 피드백/답변). 답변이 없으면 null',
    type: Number,
    nullable: true,
  })
  feedbackRate: number | null;
}

export class ReportTotalsDto {
  @ApiProperty({ type: ReportSummaryDto })
  summary: ReportSummaryDto;

  @ApiProperty({ type: ReportFeedbackDto })
  feedback: ReportFeedbackDto;
}

export class ReportOutcomeCountDto {
  @ApiProperty({
    enum: REPORT_OUTCOMES,
    description: '답변 결과. unknown은 결과 기록이 없는 예전 답변',
  })
  outcome: ReportOutcome;

  @ApiProperty()
  count: number;
}

export class ReportQuestionCountDto {
  @ApiProperty({ description: '대표 질문(가장 최근 표현)' })
  question: string;

  @ApiProperty()
  count: number;
}

export class ReportUnansweredDto {
  @ApiProperty({ description: '이 달에 새로 생긴 미답변 질문 수' })
  created: number;

  @ApiProperty({ description: '이 달에 해결한 미답변 질문 수' })
  resolved: number;
}

export class MonthlyReportDto {
  @ApiProperty()
  widgetKeyId: string;

  @ApiProperty({ type: ReportPeriodDto })
  period: ReportPeriodDto;

  @ApiProperty({ type: ReportTotalsDto, description: '이 달 집계' })
  current: ReportTotalsDto;

  @ApiProperty({
    type: ReportTotalsDto,
    description: '지난달 집계(전월 대비용)',
  })
  previous: ReportTotalsDto;

  @ApiProperty({ type: [ReportOutcomeCountDto] })
  outcomes: ReportOutcomeCountDto[];

  @ApiProperty({
    type: [ReportQuestionCountDto],
    description: 'BAD 피드백을 받은 질문 상위 10개',
  })
  topBadQuestions: ReportQuestionCountDto[];

  @ApiProperty({
    type: [ReportQuestionCountDto],
    description: '참고 자료 없이 답한 질문 상위 10개',
  })
  topUnansweredQuestions: ReportQuestionCountDto[];

  @ApiProperty({ type: ReportUnansweredDto })
  unansweredQuestions: ReportUnansweredDto;
}
