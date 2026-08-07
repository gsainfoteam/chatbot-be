/**
 * PDF Pass 2: metadata-only chunk labeling.
 *
 * The server already split the markdown into sections. The LLM only assigns
 * relative path + search description (and optionally a document summary).
 *
 * Placeholders: {filename}
 */

export const PDF_CHUNKING_PROMPT = `
당신은 문서 검색용 메타데이터 전문가입니다.
서버가 이미 Markdown을 섹션으로 분할했습니다. 당신은 **본문을 다시 쓰지 말고**,
각 섹션의 path와 description만 JSON으로 반환하세요.

**문서 정보:**
- 파일명: {filename}

**입력 형식:**
각 항목은 index, title, snippet(본문 앞부분)을 가집니다.

**출력 규칙 (매우 중요):**
1. JSON 객체만 출력하세요. 마크다운 코드블록(\`\`\`)으로 감싸지 마세요.
2. 본문 내용을 절대 재출력하지 마세요.
3. 스키마:
{
  "summary": "문서 전체 고수준 요약 1~2문장",
  "chunks": [
    { "index": 0, "path": "상대-경로", "description": "검색용 설명" }
  ]
}
4. 입력으로 주어진 모든 index를 빠짐없이 한 번씩 포함하세요.
5. path 요구사항:
   - 파일명(stem)을 path에 넣지 마세요. 서버가 prefix를 붙입니다.
   - 상대 path만 사용 (예: "수강신청/신청방법", "학사-일정")
   - 영문 소문자, 한글, 하이픈(-), 슬래시(/) 사용
   - 공백은 하이픈으로 치환
6. description 요구사항:
   - 사용자가 이 내용을 찾기 위해 할 수 있는 질문 키워드/동의어 포함
   - 15-40 단어로 상세하게 작성
7. summary는 문서 전체를 한눈에 파악할 수 있는 고수준 요약입니다.
   (batch 요청이면 현재 batch 범위 기준으로 최선을 다해 작성)

**예시 출력:**
{"summary":"GIST 학사 안내 - 수강신청과 학사일정","chunks":[{"index":0,"path":"수강신청/신청방법","description":"수강신청 기간, ZEUS 신청 절차, 개설교과목 조회, 학점 제한"},{"index":1,"path":"학사-일정","description":"개강일, 중간고사·기말고사 기간, 수강 정정, 방학 일정"}]}

이제 아래 섹션 목록에 대해 JSON만 출력하세요:

`;
