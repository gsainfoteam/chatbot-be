import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { WidgetMessagesService } from './widget-messages.service';
import { WidgetSessionGuard } from '../auth/guards/widget-session.guard';
import { CurrentSession } from '../auth/decorators/current-session.decorator';
import type { SessionPayload } from '../auth/decorators/current-session.decorator';
import { ChatMessageInputDto } from '../common/dto/chat-message-input.dto';
import { ChatMessageDto } from '../common/dto/chat-message.dto';
import { PaginatedMessagesDto } from '../common/dto/paginated-messages.dto';

@ApiTags('Widget Messages')
@Controller('api/v1/widget/messages')
@UseGuards(WidgetSessionGuard)
@ApiBearerAuth('widgetSessionAuth')
export class WidgetMessagesController {
  constructor(
    private readonly widgetMessagesService: WidgetMessagesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: '대화 내역 조회 (페이징)',
    description: 'cursor 기반 페이징으로 대화 내역을 조회합니다.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
    description: '이전 페이지의 마지막 메시지 ID (없으면 최신순 조회)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: '한 번에 가져올 메시지 개수',
    example: 20,
  })
  @ApiResponse({
    status: 200,
    description: '조회 성공',
    type: PaginatedMessagesDto,
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  async getMessages(
    @CurrentSession() session: SessionPayload,
    @Query('cursor') cursor?: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ): Promise<PaginatedMessagesDto> {
    return this.widgetMessagesService.getMessages(
      session.sessionId,
      cursor,
      limit,
    );
  }

  @Post()
  @ApiOperation({
    summary: '대화 메시지 저장',
    description: 'user 또는 assistant의 메시지를 저장합니다.',
  })
  @ApiResponse({
    status: 201,
    description: '저장 성공',
    type: ChatMessageDto,
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  async createMessage(
    @CurrentSession() session: SessionPayload,
    @Body() dto: ChatMessageInputDto,
  ): Promise<ChatMessageDto> {
    return this.widgetMessagesService.createMessage(session.sessionId, dto);
  }
}
