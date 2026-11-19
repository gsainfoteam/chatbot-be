import { readResearchAssessment } from './research-decision';

describe('research completion contract', () => {
  const known = new Set(['rules/1']);
  const complete = {
    outcome: 'complete',
    evidencePaths: ['rules/1'],
    unresolvedQuestions: [],
    reason: '질문에 대한 근거를 확인함',
  };
  it('requires known evidence for a complete answer', () => {
    expect(
      readResearchAssessment(JSON.stringify(complete), known)?.outcome,
    ).toBe('complete');
    expect(
      readResearchAssessment(
        JSON.stringify({ ...complete, evidencePaths: ['invented'] }),
        known,
      ),
    ).toBeNull();
    expect(
      readResearchAssessment(
        JSON.stringify({ ...complete, evidencePaths: [] }),
        known,
      ),
    ).toBeNull();
  });
  it('retains unresolved questions for partial or insufficient evidence', () => {
    expect(
      readResearchAssessment(
        JSON.stringify({ ...complete, outcome: 'partial' }),
        known,
      ),
    ).toBeNull();
    expect(
      readResearchAssessment(
        JSON.stringify({
          ...complete,
          outcome: 'partial',
          unresolvedQuestions: ['신청 마감'],
        }),
        known,
      )?.outcome,
    ).toBe('partial');
  });
  it('rejects malformed and contradictory decisions', () => {
    for (const value of [
      'null',
      '{}',
      '{',
      JSON.stringify({ ...complete, unresolvedQuestions: ['미확인'] }),
    ]) {
      expect(readResearchAssessment(value, known)).toBeNull();
    }
  });
});
