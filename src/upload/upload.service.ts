import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { DocumentsRepository } from '../pdf-processor/documents.repository';
import { GcsStorageService } from '../pdf-processor/gcs-storage.service';
import { toResourceName } from '../pdf-processor/pdf-chunk-parser';
import type { Document } from '../db';

const PDF_MIME = 'application/pdf';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export type DocumentListItem = {
  id: string;
  title: string;
  resourceName: string;
  status: Document['status'];
  summary: string | null;
  gcsPdfPath: string;
  errorMessage: string | null;
  uploadedAt: Date;
  processedAt: Date | null;
};

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(
    private readonly documentsRepo: DocumentsRepository,
    private readonly gcs: GcsStorageService,
  ) {}

  async listMyUploads(
    idpUuid: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<DocumentListItem[]> {
    const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = Math.max(0, options.offset ?? 0);

    const rows = await this.documentsRepo.listByUploader(idpUuid, {
      limit,
      offset,
    });

    return rows.map((row) => this.toListItem(row));
  }

  async getById(id: string, idpUuid: string): Promise<DocumentListItem> {
    const row = await this.documentsRepo.findById(id);
    if (!row || !row.isActive) {
      throw new NotFoundException(`Document not found: ${id}`);
    }
    if (row.uploadedByIdpUuid !== idpUuid) {
      throw new NotFoundException(`Document not found: ${id}`);
    }
    return this.toListItem(row);
  }

  /**
   * Upload PDF to GCS and enqueue processing (status=queued).
   */
  async upload(
    fileBuffer: Buffer,
    filename: string,
    title: string,
    idpUuid: string,
  ): Promise<DocumentListItem> {
    if (!fileBuffer?.length) {
      throw new BadRequestException('file is required');
    }

    const resourceName = toResourceName(filename || 'document.pdf');
    if (!resourceName.trim()) {
      throw new BadRequestException('Invalid filename');
    }

    const gcsPdfPath = this.gcs.toGsPath(`${resourceName}.pdf`);
    let reservation: Document;
    try {
      reservation = await this.documentsRepo.createUploading({
        title,
        resourceName,
        gcsPdfPath,
        uploadedByIdpUuid: idpUuid,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `An active document with resource name "${resourceName}" already exists`,
        );
      }
      throw error;
    }

    this.logger.debug(`Uploading PDF to GCS: ${resourceName}.pdf`);
    try {
      await this.gcs.uploadPdf(resourceName, fileBuffer);
    } catch (error) {
      this.logger.error(
        `GCS upload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.rollbackUpload(reservation.id, resourceName);
      throw new BadRequestException(
        `GCS upload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let record: Document | null;
    try {
      record = await this.documentsRepo.markQueuedAfterUpload(reservation.id);
      if (!record) {
        throw new Error('Upload reservation is no longer active');
      }
    } catch (error) {
      await this.rollbackUpload(reservation.id, resourceName);
      throw new Error(
        `Failed to enqueue the uploaded document: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.logger.log(
      `Upload queued: id=${record.id} resource=${resourceName}`,
    );
    return this.toListItem(record);
  }

  /**
   * Soft-delete DB row and remove GCS artifacts.
   */
  async delete(id: string): Promise<void> {
    const row = await this.documentsRepo.cancelAndSoftDelete(id);
    if (!row) {
      throw new NotFoundException(`Document not found: ${id}`);
    }

    try {
      await this.gcs.deleteResourceArtifacts(row.resourceName);
    } catch (error) {
      this.logger.error(
        `GCS delete failed id=${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadRequestException(
        `GCS delete failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.logger.log(`Document deleted: id=${id} resource=${row.resourceName}`);
  }

  /**
   * Clear chunks and re-enqueue for processing.
   */
  async reprocess(id: string): Promise<DocumentListItem> {
    const row = await this.documentsRepo.findById(id);
    if (!row || !row.isActive) {
      throw new NotFoundException(`Document not found: ${id}`);
    }
    if (row.status === 'uploading') {
      throw new ConflictException('Document upload is still in progress');
    }

    const updated = await this.documentsRepo.enqueueReprocess(id);
    if (!updated) {
      throw new NotFoundException(`Document not found: ${id}`);
    }

    this.logger.log(`Document requeued: id=${id}`);
    return this.toListItem(updated);
  }

  private toListItem(row: Document): DocumentListItem {
    return {
      id: row.id,
      title: row.title,
      resourceName: row.resourceName,
      status: row.status,
      summary: row.summary,
      gcsPdfPath: row.gcsPdfPath,
      errorMessage: row.errorMessage,
      uploadedAt: row.createdAt,
      processedAt: row.processedAt,
    };
  }

  private async rollbackUpload(
    documentId: string,
    resourceName: string,
  ): Promise<void> {
    const results = await Promise.allSettled([
      this.gcs.deleteResourceArtifacts(resourceName),
      this.documentsRepo.hardDelete(documentId),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(
          `Upload rollback failed id=${documentId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      }
    }
  }
}

export { PDF_MIME };

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (
      typeof current === 'object' &&
      current !== null &&
      'code' in current &&
      current.code === '23505'
    ) {
      return true;
    }
    current =
      typeof current === 'object' && current !== null && 'cause' in current
        ? current.cause
        : null;
  }
  return false;
}
