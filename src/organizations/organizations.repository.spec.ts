import { readFileSync } from 'fs';
import { join } from 'path';

describe('OrganizationsRepository concurrency invariants', () => {
  const source = readFileSync(
    join(process.cwd(), 'src', 'organizations', 'organizations.repository.ts'),
    'utf8',
  );

  it('serializes final-manager changes on the organization row', () => {
    expect(source).toContain(
      'await this.lockOrganizations(tx, [organizationId])',
    );
    expect(source).toContain('this.countAcceptedManagers(tx, organizationId)');
    expect(source).toContain("return { kind: 'last_manager' }");
    expect(source).toContain(
      'this.isCurrentManager(tx, organizationId, actor)',
    );
  });

  it('locks and conditionally updates the current owner during transfer', () => {
    expect(source).toContain(
      'SELECT id FROM documents WHERE id = ${documentId} FOR UPDATE',
    );
    expect(source).toContain(
      'await this.lockOrganizations(tx, [\n        input.expectedOwnerOrganizationId,\n        input.targetOrganizationId,',
    );
    expect(source).toContain('documents.ownerOrganizationId,');
    expect(source).toContain('input.expectedOwnerOrganizationId,');
    expect(source).toContain('tx.insert(documentOwnershipTransfers)');
    expect(source).toContain('.delete(documentOrganizationShares)');
  });

  it('reauthorizes document management after locking the organization', () => {
    expect(source).toContain('lockAndAuthorizeDocumentManage');
    expect(source).toContain('evaluateDocumentAccess({');
    expect(source).toContain(
      "decision.canManage ? state : { kind: 'forbidden' }",
    );
  });

  it('does not touch chunks or processing state in share/transfer code', () => {
    const transferSection = source.slice(source.indexOf('async setShare'));
    expect(transferSection).not.toContain('documentChunks');
    expect(transferSection).not.toContain("status: 'queued'");
    expect(transferSection).not.toContain('processingToken');
  });
});
