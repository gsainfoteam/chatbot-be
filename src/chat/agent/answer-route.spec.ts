import { describe, expect, it } from '@jest/globals';
import { decideAnswerRoute } from './answer-route';

describe('decideAnswerRoute', () => {
  it('always answers directly while the agent is disabled', () => {
    expect(
      decideAnswerRoute({ agentEnabled: false, documentCount: 0 }),
    ).toEqual({ route: 'direct', reason: 'agent-disabled' });
  });

  it('answers directly on a confident first search', () => {
    expect(
      decideAnswerRoute({
        agentEnabled: true,
        documentCount: 3,
        confident: true,
      }),
    ).toEqual({ route: 'direct', reason: 'confident-match' });
  });

  it('keeps the LLM-selection result as before when there is no score', () => {
    expect(decideAnswerRoute({ agentEnabled: true, documentCount: 2 })).toEqual(
      { route: 'direct', reason: 'unscored-match' },
    );
  });

  it('researches again when the first search found nothing', () => {
    expect(
      decideAnswerRoute({
        agentEnabled: true,
        documentCount: 0,
        confident: true,
      }),
    ).toEqual({ route: 'agent', reason: 'no-documents' });
  });

  it('researches again when the first search is weak', () => {
    expect(
      decideAnswerRoute({
        agentEnabled: true,
        documentCount: 2,
        confident: false,
      }),
    ).toEqual({ route: 'agent', reason: 'weak-match' });
  });

  it('researches notices even after a confident document match', () => {
    expect(
      decideAnswerRoute({
        agentEnabled: true,
        documentCount: 3,
        confident: true,
        noticeIntent: true,
      }),
    ).toEqual({ route: 'agent', reason: 'notice-intent' });
  });

  it('ignores notice intent while the agent is disabled', () => {
    expect(
      decideAnswerRoute({
        agentEnabled: false,
        documentCount: 3,
        noticeIntent: true,
      }),
    ).toEqual({ route: 'direct', reason: 'agent-disabled' });
  });
});
