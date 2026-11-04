import { AnswerOutputFilter, safeSources } from './answer-output';

const source = {
  kind: 'notice' as const,
  id: '42',
  title: '장학금 공지',
  url: 'https://ziggle.gistory.me/notice/42',
  opened: true,
};
describe('streamed answer privacy and citations', () => {
  it('masks phone numbers split at every possible boundary', () => {
    for (const phone of [
      '010-1234-5678',
      '+82 10 1234 5678',
      '010 1234 5678',
      '０１０－１２３４－５６７８',
      '010\u200b-1234\u200b-5678',
    ]) {
      const text = '담당자 ' + phone + ' 입니다. ' + '후속 설명 '.repeat(60);
      for (let split = 0; split < text.length; split++) {
        const f = new AnswerOutputFilter();
        const result =
          f.push(text.slice(0, split)) +
          f.push(text.slice(split)) +
          f.push('', true);
        expect(result).not.toContain(phone);
        expect(result).toContain('[휴대전화 번호 가림]');
      }
    }
  });
  it('renders only registered citations and records exactly the used sources', () => {
    const f = new AnswerOutputFilter([
      source,
      { ...source, id: '43', url: source.url + '3' },
    ]);
    const result =
      f.push('신청 기간은 내일까지예요. [ci') +
      f.push('te:1] [cite:999]') +
      f.push('', true);
    expect(result).toContain(`[장학금 공지](${source.url})`);
    expect(result).not.toContain('cite:');
    expect(f.usedSources()).toEqual([source]);
  });
  it('removes invented links while retaining emails and office numbers', () => {
    const f = new AnswerOutputFilter([source]);
    const result = f.push(
      '[학교](https://evil.example) help@gist.ac.kr 062-715-1234',
      true,
    );
    expect(result).not.toContain('evil.example');
    expect(result).toContain('help@gist.ac.kr 062-715-1234');
  });
  it('rejects unsafe source URLs and sanitizes source titles', () => {
    expect(safeSources([{ ...source, url: 'javascript:alert(1)' }])).toEqual(
      [],
    );
    expect(
      safeSources([{ ...source, title: '연락 010-1234-5678' }])[0].title,
    ).not.toContain('010-1234');
  });
});
