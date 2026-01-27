import {
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
  GatewayTimeoutException,
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
    this.resourceApiBaseUrl = this.configService.getOrThrow<string>(
      'MCP_RESOURCE_API_URL',
    );
  }

  /**
   * 리소스 읽기 (MCP 리소스 서버의 HTTP API 사용)
   * @param resourcePath 리소스 경로
   * @returns 리소스 데이터 (Buffer 또는 텍스트)
   */
  async getResource(resourcePath: string): Promise<{
    content: Buffer | string;
    mimeType?: string;
  }> {
    try {
      const encodedPath = encodeURIComponent(resourcePath);
      const resourceUrl = `${this.resourceApiBaseUrl}/resource/${encodedPath}`;

      this.logger.debug(`Fetching resource from: ${resourceUrl}`);

      const response = await firstValueFrom(
        this.httpService
          .get(resourceUrl, {
            responseType: 'arraybuffer',
            timeout: 5000,
          })
          .pipe(
            catchError((error: AxiosError) => {
              // 타임아웃 에러 처리
              if (
                error.code === 'ECONNABORTED' ||
                error.code === 'ETIMEDOUT' ||
                error.message?.includes('timeout')
              ) {
                this.logger.error(
                  `Timeout while fetching resource ${resourcePath}: ${error.message}`,
                  error instanceof Error ? error.stack : undefined,
                );
                throw new GatewayTimeoutException(
                  `Request timeout while fetching resource: ${resourcePath}`,
                );
              }

              if (error.response?.status === 404) {
                this.logger.warn(`Resource not found: ${resourcePath}`);
                throw new NotFoundException(
                  `Resource not found: ${resourcePath}`,
                );
              }
              this.logger.error(
                `Failed to fetch resource ${resourcePath}: ${error.message}`,
                error instanceof Error ? error.stack : undefined,
              );
              throw new InternalServerErrorException(
                `Failed to fetch resource: ${error.message}`,
              );
            }),
          ),
      );

      const contentType =
        response.headers['content-type'] ||
        response.headers['Content-Type'] ||
        'application/octet-stream';

      const isText =
        contentType.startsWith('text/') ||
        contentType.includes('json') ||
        contentType.includes('xml') ||
        contentType.includes('markdown');

      const contentLength = response.data?.length || 0;
      this.logger.debug(
        `Resource fetched: ${resourcePath} (${contentLength} bytes, ${contentType})`,
      );

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
