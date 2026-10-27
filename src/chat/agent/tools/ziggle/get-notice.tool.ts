import { Injectable } from '@nestjs/common';
import type {
  AgentStepOutcome,
  AgentTool,
  AgentToolContext,
  AgentToolResult,
} from '../../agent.types';
import { hasImage, htmlToPlainText, maskPersonalInfo } from './notice-text';
import {
  NOTICE_MARKER,
  noticeDocumentPath,
  noticeRegistry,
  shortTitle,
} from './notice-registry';
import { ZiggleNoticeClient } from './ziggle-notice.client';

export const GET_NOTICE_TOOL_NAME = 'get_notice';

/** 최종 답변 자료로 넘기는 공지 본문 상한 */
const MAX_BODY_CHARS = 6_000;
/** 에이전트에게 보여주는 공지 본문 상한 */
const MAX_BODY_CHARS_FOR_AGENT = 3_000;

/** 검색에서 본 공지의 본문을 평문으로 읽는다. */
@Injectable()
export class GetNoticeTool implements AgentTool {
  readonly definition = {
    type: 'function' as const,
    function: {
      name: GET_NOTICE_TOOL_NAME,
      description:
        'search_notices 결과에 나온 공지 하나의 본문을 읽는다. 요약만으로 기간·대상·제출 서류 등을 알 수 없을 때만 쓴다.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'integer',
            description: 'search_notices 결과의 공지 id',
          },
          reason: {
            type: 'string',
            description:
              '이 공지를 왜 읽는지 사용자에게 말하듯 쓴 해요체 한 문장(30자 이내).',
          },
        },
        required: ['id', 'reason'],
      },
    },
  };

  constructor(private readonly ziggle: ZiggleNoticeClient) {}

  async execute(
    args: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<AgentToolResult> {
    const id = Number(args.id);
    const known = Number.isInteger(id)
      ? noticeRegistry(context).get(id)
      : undefined;
    if (!known) {
      return {
        content: 'search_notices 결과에 나온 공지 id만 읽을 수 있습니다.',
        resultCount: 0,
      };
    }

    const html = await this.ziggle.getNoticeBody(id);
    if (html == null) {
      return { content: '해당 공지를 찾을 수 없습니다.', resultCount: 0 };
    }

    const source = {
      kind: 'notice' as const,
      id: String(id),
      title: known.title,
      url: this.ziggle.noticeUrl(id),
      opened: true,
    };

    const text = maskPersonalInfo(htmlToPlainText(html));
    if (!text) {
      // 학사공지의 상당수는 본문이 이미지 한 장이다. 내용은 못 읽어도 "이런 공지가 있다"는 것과
      // 원문 링크는 답이 되므로, 요약이 없을 때만 제목 자료와 출처를 남긴다.
      const reason = hasImage(html)
        ? '본문이 이미지로만 되어 있어'
        : '본문이 비어 있어';
      if (known.summary) {
        return {
          content: `${reason} 읽을 수 없습니다. 검색 결과의 요약을 참고하세요.`,
          resultCount: 0,
        };
      }
      return {
        content: `${reason} 읽을 수 없고 요약도 없습니다. 제목과 원문 링크만 답변 자료로 남깁니다.`,
        resultCount: 0,
        documents: [
          {
            path: noticeDocumentPath(id, 'body'),
            content: `${NOTICE_MARKER} ${known.title}\n\n(${reason} 내용을 확인할 수 없는 공지입니다. 세부 내용은 공지 원문에서 확인해야 합니다.)`,
          },
        ],
        sources: [source],
      };
    }

    const body =
      text.length > MAX_BODY_CHARS
        ? `${text.slice(0, MAX_BODY_CHARS)}\n[이하 생략]`
        : text;
    return {
      content: `### [id=${id}] ${known.title}\n${body.slice(0, MAX_BODY_CHARS_FOR_AGENT)}`,
      resultCount: 1,
      documents: [
        {
          path: noticeDocumentPath(id, 'body'),
          content: `${NOTICE_MARKER} ${known.title}\n\n${body}`,
        },
      ],
      sources: [source],
    };
  }

  describeStep(
    args: Record<string, unknown>,
    outcome: AgentStepOutcome,
    context: AgentToolContext,
  ): string {
    const known = noticeRegistry(context).get(Number(args.id));
    const title = known ? `'${shortTitle(known.title)}' 공지` : '공지';
    switch (outcome.status) {
      case 'running':
        return `${title}를 읽고 있어요`;
      case 'done':
        return outcome.resultCount > 0
          ? `${title}를 확인했어요`
          : `${title} 본문을 읽지 못해 요약을 참고할게요`;
      case 'failed':
        return `${title} 본문을 불러오지 못했어요`;
    }
  }
}
