import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AxiosError } from 'axios';
import FormData from 'form-data';
import { DB_CONNECTION, uploadedResources } from '../db';
import type { Database } from '../db';
import type { UploadedResource } from '../db';
import { eq, and, desc } from 'drizzle-orm';

const PDF_MIME = 'application/pdf';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * gcs_path(gs://bucket/object-path)에서 resource-center DELETE용 객체 경로만 추출
 * resource-center는 버킷 접두어 없이 객체 경로만 받음
 */
function toResourcePath(gcsPath: string): string {
  const match = gcsPath.match(/^gs:\/\/[^/]+\/(.+)$/);
  return match ? match[1] : gcsPath;
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private readonly resourceApiBaseUrl: string;

  constructor(
    @Inject(DB_CONNECTION) private readonly db: Database,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.resourceApiBaseUrl = this.configService.getOrThrow<string>(
      'MCP_RESOURCE_API_URL',
    );
  }

  /**
   * 현재 admin이 업로드한 문서 목록 조회 (is_active = true만, 최신순)
   */
  async listMyUploads(
    idpUuid: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<
    {
      id: string;
      title: string;
      metadata: Record<string, unknown>;
      uploadedAt: Date;
    }[]
  > {
    const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = Math.max(0, options.offset ?? 0);

    const rows = await this.db
      .select({
        id: uploadedResources.id,
        title: uploadedResources.title,
        metadata: uploadedResources.metadata,
        uploadedAt: uploadedResources.createdAt,
      })
      .from(uploadedResources)
      .where(
        and(
          eq(uploadedResources.uploadedByIdpUuid, idpUuid),
          eq(uploadedResources.isActive, true),
        ),
      )
      .orderBy(desc(uploadedResources.createdAt))
      .limit(limit)
      .offset(offset);

    return rows;
  }

  /**
   * PDF 파일을 resource-center에 업로드하고 우리 DB에 기록 저장
   */
  async upload(
    fileBuffer: Buffer,
    filename: string,
    title: string,
    idpUuid: string,
  ): Promise<UploadedResource> {
    const form = new FormData();
    form.append('file', fileBuffer, {
      filename: filename || 'document.pdf',
      contentType: PDF_MIME,
    });

    const uploadUrl = `${this.resourceApiBaseUrl}/upload`;
    this.logger.debug(`Uploading file to resource-center: ${uploadUrl}`);

    let metadata: Record<string, unknown>;
    try {
      const response = await firstValueFrom(
        this.httpService
          .post(uploadUrl, form, {
            headers: form.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            responseType: 'text',
            validateStatus: (status) => status >= 200 && status < 300,
          })
          .pipe(
            catchError((error: AxiosError) => {
              const status = error.response?.status;
              const message =
                error.response?.data != null
                  ? JSON.stringify(error.response.data)
                  : error.message;
              this.logger.error(
                `Resource-center upload failed: ${status} ${message}`,
              );
              throw new BadRequestException(
                status === 400
                  ? `Upload failed: ${message}`
                  : `Resource-center upload failed: ${message}`,
              );
            }),
          ),
      );
      const raw =
        typeof response.data === 'string'
          ? response.data
          : String(response.data);
      metadata = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      if (error instanceof SyntaxError) {
        this.logger.error('Resource-center response is not valid JSON', error);
        throw new BadRequestException(
          'Resource-center upload response is not valid JSON',
        );
      }
      this.logger.error('Upload failed', error);
      throw new BadRequestException(
        `Upload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const [record] = await this.db
      .insert(uploadedResources)
      .values({
        title,
        metadata,
        uploadedByIdpUuid: idpUuid,
        isActive: true,
      })
      .returning();

    if (!record) {
      throw new Error('Failed to insert upload record');
    }
    this.logger.log(`Upload recorded: id=${record.id}`);
    return record;
  }

  /**
   * resource-center에서 삭제 성공 후 DB에서 is_active = false 및 metadata 갱신
   * (DB는 DELETE 성공 후에만 갱신하여, 외부 삭제 실패 시 재시도 가능)
   */
  async delete(id: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(uploadedResources)
      .where(eq(uploadedResources.id, id))
      .limit(1);

    if (!row) {
      throw new NotFoundException(`Upload not found: ${id}`);
    }
    if (!row.isActive) {
      throw new NotFoundException(`Upload already deleted: ${id}`);
    }

    const rawPath =
      typeof row.metadata?.gcs_path === 'string'
        ? row.metadata.gcs_path
        : typeof row.metadata?.path === 'string'
          ? row.metadata.path
          : null;
    if (!rawPath) {
      this.logger.warn(
        `No gcs_path/path in metadata for id=${id}, skipping resource-center DELETE`,
      );
      return;
    }
    const pathForDelete = toResourcePath(rawPath);
    const deleteUrl = `${this.resourceApiBaseUrl}/resource/${encodeURIComponent(pathForDelete)}`;
    this.logger.debug(`Deleting resource at: ${deleteUrl}`);

    try {
      const response = await firstValueFrom(
        this.httpService
          .delete<{
            status?: string;
            path?: string;
            deleted_files?: string[];
            count?: number;
          }>(deleteUrl)
          .pipe(
            catchError((error: AxiosError) => {
              const status = error.response?.status;
              const message =
                error.response?.data != null
                  ? JSON.stringify(error.response.data)
                  : error.message;
              this.logger.error(
                `Resource-center delete failed id=${id} deleteUrl=${deleteUrl} status=${status} ${message}`,
              );
              if (status === 404) {
                throw new NotFoundException(
                  `Resource not found at resource-center: ${rawPath}`,
                );
              }
              throw new BadRequestException(
                `Resource-center delete failed: ${message}`,
              );
            }),
          ),
      );

      const deleteResponse =
        typeof response.data === 'object' && response.data !== null
          ? response.data
          : typeof response.data === 'string'
            ? (() => {
                try {
                  return JSON.parse(response.data) as Record<string, unknown>;
                } catch {
                  return {};
                }
              })()
            : {};

      const mergedMetadata: Record<string, unknown> = {
        ...(row.metadata as Record<string, unknown>),
        ...deleteResponse,
      };

      const now = new Date();
      await this.db
        .update(uploadedResources)
        .set({
          isActive: false,
          metadata: mergedMetadata,
          updatedAt: now,
        })
        .where(eq(uploadedResources.id, id));

      this.logger.debug(
        `Resource-center delete response applied to metadata: ${JSON.stringify(deleteResponse)}`,
      );
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      this.logger.error(
        `Delete failed id=${id} deleteUrl=${deleteUrl}`,
        error instanceof Error ? error.stack : error,
      );
      throw new BadRequestException(
        `Delete failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
