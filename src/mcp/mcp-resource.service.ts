import {
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AxiosError } from 'axios';

/**
 * MCP 리소스 서비스
 * MCP 서버의 리소스 API를 프록시하여 제공합니다.
 */
@Injectable()
export class McpResourceService {
  private readonly logger = new Logger(McpResourceService.name);
  private readonly resourceApiBaseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    // 환경 변수에서 리소스 API URL 가져오기 (기본값 제공)
    this.resourceApiBaseUrl =
      this.configService.get<string>('MCP_RESOURCE_API_URL') ||
      'https://resource-center-573707418062.us-central1.run.app';
  }

  /**
   * 리소스 읽기 (MCP 리소스 서버의 HTTP API 사용)
   * @param resourcePath 리소스 경로 (예: "2025 캠프 발표자료_ 1일차 오전(학생지원,장학복지)")
   * @returns 리소스 데이터 (Buffer 또는 텍스트)
   */
  async getResource(resourcePath: string): Promise<{
    content: Buffer | string;
    mimeType?: string;
  }> {
    try {
      // 리소스 경로를 URL 인코딩하여 API 엔드포인트 구성
      const encodedPath = encodeURIComponent(resourcePath);
      const resourceUrl = `${this.resourceApiBaseUrl}/resource/${encodedPath}`;

      this.logger.debug(`Fetching resource from: ${resourceUrl}`);

      const response = await firstValueFrom(
        this.httpService
          .get(resourceUrl, {
            responseType: 'arraybuffer', // 바이너리 데이터 지원
          })
          .pipe(
            catchError((error: AxiosError) => {
              if (error.response?.status === 404) {
                throw new NotFoundException(
                  `Resource not found: ${resourcePath}`,
                );
              }
              this.logger.error(
                `Error fetching resource: ${error.message}`,
                error.response?.data,
              );
              throw new InternalServerErrorException(
                `Failed to fetch resource: ${error.message}`,
              );
            }),
          ),
      );

      // Content-Type 확인
      const contentType =
        response.headers['content-type'] ||
        response.headers['Content-Type'] ||
        'application/octet-stream';

      // 이미지나 PDF는 Buffer로, 텍스트는 string으로 반환
      const isText =
        contentType.startsWith('text/') ||
        contentType.includes('json') ||
        contentType.includes('xml') ||
        contentType.includes('markdown');

      return {
        content: isText
          ? Buffer.from(response.data).toString('utf-8')
          : Buffer.from(response.data),
        mimeType: contentType,
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`Error getting resource: ${error}`);
      throw error;
    }
  }
}
