import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { isAxiosError } from 'axios';
import type { EmbeddingClient } from './embedding-client.interface';
import { DEFAULT_EMBEDDING_BATCH_SIZE } from './embedding.constants';
import { truncateEmbeddingInput } from './embedding-text';

type EmbeddingResponse = {
  data?: Array<{ index?: number; embedding?: unknown }>;
};

function readPositiveInteger(
  value: string | number | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

@Injectable()
export class OpenAiCompatibleEmbeddingClient implements EmbeddingClient {
  readonly model: string;
  readonly dimensions: number;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly batchSize: number;

  constructor(private readonly configService: ConfigService) {
    const baseUrl = this.configService
      .getOrThrow<string>('EMBEDDING_BASE_URL')
      .replace(/\/+$/, '');
    this.endpoint = `${baseUrl}/embeddings`;
    this.apiKey = this.configService.getOrThrow<string>('EMBEDDING_API_KEY');
    this.model = this.configService.getOrThrow<string>('EMBEDDING_MODEL');
    this.dimensions = readPositiveInteger(
      this.configService.get<string | number>('EMBEDDING_DIMENSIONS'),
      1536,
      'EMBEDDING_DIMENSIONS',
    );
    this.batchSize = readPositiveInteger(
      this.configService.get<string | number>('EMBEDDING_BATCH_SIZE'),
      DEFAULT_EMBEDDING_BATCH_SIZE,
      'EMBEDDING_BATCH_SIZE',
    );
  }

  async embedTexts(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];

    const prepared = inputs.map((input, index) => {
      const text = truncateEmbeddingInput(input);
      if (!text) {
        throw new Error(`Embedding input at index ${index} is empty`);
      }
      return text;
    });

    const allEmbeddings: number[][] = [];
    for (let offset = 0; offset < prepared.length; offset += this.batchSize) {
      const batch = prepared.slice(offset, offset + this.batchSize);
      const embeddings = await this.requestBatch(batch);
      allEmbeddings.push(...embeddings);
    }
    return allEmbeddings;
  }

  private async requestBatch(inputs: string[]): Promise<number[][]> {
    let response: { data: EmbeddingResponse };
    try {
      response = await axios.post<EmbeddingResponse>(
        this.endpoint,
        {
          model: this.model,
          input: inputs,
          dimensions: this.dimensions,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30_000,
        },
      );
    } catch (error) {
      const detail = isAxiosError(error)
        ? `HTTP ${error.response?.status ?? 'request failure'}`
        : error instanceof Error
          ? error.message
          : String(error);
      throw new Error(`Embedding API request failed: ${detail}`, {
        cause: error,
      });
    }

    const rows = response.data.data;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('Embedding API returned an empty response');
    }
    if (rows.length !== inputs.length) {
      throw new Error(
        `Embedding API returned ${rows.length} rows for ${inputs.length} inputs`,
      );
    }

    const ordered = new Array<number[]>(inputs.length);
    for (const row of rows) {
      if (
        !Number.isInteger(row.index) ||
        row.index! < 0 ||
        row.index! >= inputs.length ||
        ordered[row.index!] != null
      ) {
        throw new Error('Embedding API returned invalid or duplicate indexes');
      }
      if (
        !Array.isArray(row.embedding) ||
        row.embedding.length !== this.dimensions ||
        !row.embedding.every(
          (value): value is number =>
            typeof value === 'number' && Number.isFinite(value),
        )
      ) {
        const actual = Array.isArray(row.embedding)
          ? row.embedding.length
          : 'invalid';
        throw new Error(
          `Embedding dimension mismatch: expected ${this.dimensions}, received ${actual}`,
        );
      }
      ordered[row.index!] = row.embedding;
    }

    if (ordered.some((embedding) => embedding == null)) {
      throw new Error('Embedding API response is missing an input index');
    }
    return ordered;
  }
}
