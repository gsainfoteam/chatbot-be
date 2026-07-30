import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage, Bucket, File } from '@google-cloud/storage';

type GcsServiceAccountCredentials = {
  client_email: string;
  private_key: string;
};

export type ResourceIndexEntry = {
  description: string;
  chunks: { path: string; description: string }[];
};

export type ResourceIndex = Record<string, ResourceIndexEntry>;

const RESOURCES_INDEX_PATH = '_resources.json';

export function decodeServiceAccountCredentials(
  encodedKey: string,
): GcsServiceAccountCredentials {
  let parsed: unknown;
  try {
    const json = Buffer.from(encodedKey, 'base64').toString('utf-8');
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new Error(
      'GCS_SERVICE_ACCOUNT_KEY_BASE64 must be a base64-encoded service account JSON',
    );
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('client_email' in parsed) ||
    typeof parsed.client_email !== 'string' ||
    !parsed.client_email ||
    !('private_key' in parsed) ||
    typeof parsed.private_key !== 'string' ||
    !parsed.private_key
  ) {
    throw new Error(
      'Decoded GCS service account JSON must contain client_email and private_key',
    );
  }

  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
  };
}

@Injectable()
export class GcsStorageService {
  private readonly logger = new Logger(GcsStorageService.name);
  private readonly bucket: Bucket;
  private readonly bucketName: string;

  constructor(private readonly configService: ConfigService) {
    this.bucketName = this.configService.getOrThrow<string>('GCS_BUCKET');
    const projectId = this.configService.getOrThrow<string>('GCP_PROJECT_ID');
    const encodedKey = this.configService.get<string>(
      'GCS_SERVICE_ACCOUNT_KEY_BASE64',
    );
    const credentials = encodedKey
      ? decodeServiceAccountCredentials(encodedKey)
      : undefined;
    const storage = new Storage({ projectId, credentials });
    this.bucket = storage.bucket(this.bucketName);
    this.logger.log(
      `GCS bucket ready: ${this.bucketName} (auth=${credentials ? 'service-account-env' : 'ADC'})`,
    );
  }

  toGsPath(objectPath: string): string {
    return `gs://${this.bucketName}/${objectPath}`;
  }

  async uploadPdf(resourceName: string, pdfBytes: Buffer): Promise<string> {
    const objectPath = `${resourceName}.pdf`;
    await this.bucket.file(objectPath).save(pdfBytes, {
      contentType: 'application/pdf',
      resumable: false,
    });
    return this.toGsPath(objectPath);
  }

  async downloadPdf(resourceName: string): Promise<Buffer> {
    const objectPath = `${resourceName}.pdf`;
    const [buf] = await this.bucket.file(objectPath).download();
    return buf;
  }

  async uploadMarkdown(objectPath: string, content: string): Promise<void> {
    await this.bucket.file(objectPath).save(Buffer.from(content, 'utf-8'), {
      contentType: 'text/markdown; charset=utf-8',
      resumable: false,
    });
  }

  /**
   * Upload processed documents map (path → markdown string).
   * Binary (image) entries are skipped in phase 1.
   */
  async uploadDocuments(
    documents: Record<string, string>,
  ): Promise<void> {
    for (const [path, content] of Object.entries(documents)) {
      await this.uploadMarkdown(path, content);
      this.logger.debug(`Uploaded: ${path}`);
    }
  }

  async updateResourceIndex(
    resourceName: string,
    metadata: ResourceIndexEntry,
  ): Promise<void> {
    const index = await this.readResourceIndex();
    index[resourceName] = metadata;
    await this.writeResourceIndex(index);
    this.logger.log(`Updated ${RESOURCES_INDEX_PATH} for: ${resourceName}`);
  }

  async removeResourceIndexEntry(resourceName: string): Promise<void> {
    const index = await this.readResourceIndex();
    if (!(resourceName in index)) return;
    delete index[resourceName];
    await this.writeResourceIndex(index);
    this.logger.log(`Removed ${RESOURCES_INDEX_PATH} entry: ${resourceName}`);
  }

  /**
   * Delete PDF, root md, and prefix folder for a resource.
   */
  async deleteResourceArtifacts(resourceName: string): Promise<void> {
    const toDelete: File[] = [
      this.bucket.file(`${resourceName}.pdf`),
      ...(await this.getProcessedArtifactFiles(resourceName)),
    ];

    await this.deleteFiles(toDelete);
    await this.removeResourceIndexEntry(resourceName);
  }

  /**
   * Delete generated Markdown while preserving the source PDF for retry.
   */
  async deleteProcessedArtifacts(resourceName: string): Promise<void> {
    const toDelete = await this.getProcessedArtifactFiles(resourceName);
    await this.deleteFiles(toDelete);
    await this.removeResourceIndexEntry(resourceName);
  }

  private async getProcessedArtifactFiles(
    resourceName: string,
  ): Promise<File[]> {
    const files: File[] = [
      this.bucket.file(`${resourceName}.md`),
    ];

    const [prefixFiles] = await this.bucket.getFiles({
      prefix: `${resourceName}/`,
    });
    files.push(...prefixFiles);
    return files;
  }

  private async deleteFiles(files: File[]): Promise<void> {
    await Promise.all(
      files.map(async (file) => {
        try {
          await file.delete({ ignoreNotFound: true });
        } catch (error) {
          this.logger.warn(
            `Failed to delete ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  }

  private async readResourceIndex(): Promise<ResourceIndex> {
    const file = this.bucket.file(RESOURCES_INDEX_PATH);
    try {
      const [exists] = await file.exists();
      if (!exists) return {};
      const [buf] = await file.download();
      return JSON.parse(buf.toString('utf-8')) as ResourceIndex;
    } catch (error) {
      this.logger.warn(
        `Failed to read ${RESOURCES_INDEX_PATH}, starting empty: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {};
    }
  }

  private async writeResourceIndex(index: ResourceIndex): Promise<void> {
    await this.bucket.file(RESOURCES_INDEX_PATH).save(
      Buffer.from(JSON.stringify(index, null, 2), 'utf-8'),
      {
        contentType: 'application/json; charset=utf-8',
        resumable: false,
      },
    );
  }
}
