import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ApiOkResponse, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { DocumentListItemDto } from './document-list-item.dto';

@Controller('document-list-item-schema-probe')
class DocumentListItemSchemaProbeController {
  @Get()
  @ApiOkResponse({ type: DocumentListItemDto })
  get(): void {}
}

describe('DocumentListItemDto OpenAPI schema', () => {
  it('describes nested organization and uploader response fields', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DocumentListItemSchemaProbeController],
    }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    try {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
      );
      const schemas = document.components?.schemas ?? {};
      const item = schemas.DocumentListItemDto as {
        properties?: Record<string, unknown>;
      };

      expect(JSON.stringify(item.properties?.ownerOrganization)).toContain(
        '#/components/schemas/DocumentOrganizationSummaryDto',
      );
      expect(JSON.stringify(item.properties?.uploader)).toContain(
        '#/components/schemas/DocumentUploaderSummaryDto',
      );
      expect(JSON.stringify(item.properties?.sharedOrganizations)).toContain(
        '#/components/schemas/DocumentOrganizationSummaryDto',
      );
      expect(schemas.DocumentOrganizationSummaryDto).toMatchObject({
        properties: { id: {}, name: {}, slug: {} },
      });
      expect(schemas.DocumentUploaderSummaryDto).toMatchObject({
        properties: { idpUuid: {}, email: {}, name: {} },
      });
    } finally {
      await app.close();
    }
  });
});
