import { describe, expect, it } from '@jest/globals';
import { hasImage, htmlToPlainText, maskPersonalInfo } from './notice-text';

describe('htmlToPlainText', () => {
  it('keeps paragraphs and line breaks', () => {
    expect(
      htmlToPlainText(
        '<div class="bd_detail_content"><p>신청 기간: 10.1.~10.6.</p><p>대상<br>학사과정 재학생</p></div>',
      ),
    ).toBe('신청 기간: 10.1.~10.6.\n대상\n학사과정 재학생');
  });

  it('turns table rows into one line each', () => {
    expect(
      htmlToPlainText(
        '<table><tr><th>구분</th><th>금액</th></tr><tr><td>입학금</td><td>&nbsp;0원</td></tr></table>',
      ),
    ).toBe('구분 | 금액\n입학금 | 0원');
  });

  it('turns list items into bullets', () => {
    expect(
      htmlToPlainText('<ul><li>성적증명서</li><li>재학증명서</li></ul>'),
    ).toBe('- 성적증명서\n- 재학증명서');
  });

  it('decodes entities and drops scripts and comments', () => {
    expect(
      htmlToPlainText(
        '<p>&#039;지정 MOOC&#039; &amp; 환급 &lt;안내&gt;</p><script>x()</script><!-- memo -->',
      ),
    ).toBe("'지정 MOOC' & 환급 <안내>");
  });

  it('returns an empty string for an image-only body', () => {
    const html =
      '<p><p><img src="https://www.gist.ac.kr/_prog/download/?editor_image=/a.jpg" alt="external_image"></p></p>';
    expect(htmlToPlainText(html)).toBe('');
    expect(hasImage(html)).toBe(true);
  });
});

describe('maskPersonalInfo', () => {
  it('masks resident registration and mobile numbers', () => {
    expect(
      maskPersonalInfo('주민번호 010101-3123456, 연락처 010-1234-5678'),
    ).toBe('주민번호 [주민등록번호 가림], 연락처 [휴대전화 번호 가림]');
  });

  it('keeps office phone numbers and emails', () => {
    const text = '문의: 학사지원팀 062-715-2061, scholarship@gist.ac.kr';
    expect(maskPersonalInfo(text)).toBe(text);
  });

  it('masks student IDs only when they form a list', () => {
    expect(maskPersonalInfo('공고번호 20261027')).toBe('공고번호 20261027');
    expect(maskPersonalInfo('합격자: 20241234, 20245678, 20231111')).toBe(
      '합격자: [학번 가림], [학번 가림], [학번 가림]',
    );
  });
});
