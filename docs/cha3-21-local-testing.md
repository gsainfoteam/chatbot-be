# CHA3-21: 추천 질문 로컬 확인

브랜치: `simjimin/cha3-21`. 지글 공지에서 LLM이 예상 질문을 만들고, 관리자가 검수한 질문만 위젯 첫 화면에 노출한다.

새 테이블이 2개 있으므로 마이그레이션이 필요하다 (`drizzle/0020_suggested_questions.sql`).

## 1. 환경 준비

기존 `.env`는 자동 변경하지 않았다. `.env.example`의 `SUGGESTED_QUESTIONS_*` 항목을 참고해 추가한다.

```dotenv
# 지글 MCP. 로컬 개발은 prod 키를 쓴다 (아래 참조).
ZIGGLE_MCP_URL=https://api.ziggle.gistory.me/mcp
ZIGGLE_MCP_API_KEY=<prod 키>

# 공지 링크를 만들 주소. MCP와 같은 환경을 가리켜야 한다.
ZIGGLE_NOTICE_URL_BASE=https://ziggle.gistory.me/notice/

# 주기 작업. 기본은 꺼짐이고, 로컬에서 수집을 확인할 때만 켠다.
SUGGESTED_QUESTIONS_ENABLED=false
SUGGESTED_QUESTIONS_WIDGET_KEY_IDS=
```

**로컬은 prod 지글을 본다.** staging에는 학생 단체가 직접 쓴 공지(하우스연합회·문화행사위원회
등)가 들어오지 않아 이 기능을 제대로 확인할 수 없다. 지글 담당 선배에게 확인한 결과
"staging에 실시간 복제를 하는 게 아니니 prod 바탕으로 개발하면 된다"는 답을 받았다
(2026-11-24). 지글 MCP 도구는 `search_notices`·`get_notice` **둘 다 읽기 전용**이라
지글 데이터를 변경할 수단이 없다.

**`ZIGGLE_NOTICE_URL_BASE`는 MCP와 짝을 맞춰야 한다.** 공지 id가 환경마다 따로 매겨지기
때문이다(같은 공지가 staging `199306` / prod `200977`). 어긋나면 전혀 다른 공지가 열리고,
그 링크가 질문의 `prompt`에 들어가 학생에게 나간다.

```
staging : api.stg.ziggle.gistory.me/mcp  <->  https://stg.ziggle.gistory.me/notice/
prod    : api.ziggle.gistory.me/mcp      <->  https://ziggle.gistory.me/notice/
```

**배포 환경에서는 각자 자기 환경을 쓴다.** staging 배포본은 staging 지글을 보므로
자치 공지가 없는 상태 그대로다. 그쪽에서 이 기능을 검증할 수는 없다.

`SUGGESTED_QUESTIONS_WIDGET_KEY_IDS`에는 **위젯 키의 UUID**를 넣는다. 공개 `widgetKey` 문자열이 아니다. `*`는 받지 않는다. 비어 있으면 주기 작업이 돌지 않는다.

설정 항목은 이 둘뿐이다. 실행 주기, 검색어, 모델 티어, 공지당 질문 수는 전부 코드 상수이고 왜 그 값인지는 해당 파일 주석에 적혀 있다.

```sh
bun run db:migrate
bun run start:dev
```

## 2. 관리자 API 확인 (LLM 없이)

주기 작업을 켜지 않아도 관리자 등록과 위젯 노출까지는 전부 확인할 수 있다.

```sh
# 질문 등록 (source=ADMIN, 바로 APPROVED)
curl -X POST http://localhost:3000/api/v1/admin/suggested-questions \
  -H "Authorization: Bearer <admin JWT>" -H "Content-Type: application/json" \
  -d '{"widgetKeyId":"<위젯 키 UUID>","question":"기숙사 언제 들어가요?","prompt":"입사 일정을 안내한다"}'

# 검수 대기 목록 (AI가 만든 것만)
curl "http://localhost:3000/api/v1/admin/suggested-questions?status=PENDING&source=AI" \
  -H "Authorization: Bearer <admin JWT>"

# 승인 / 거절
curl -X PATCH http://localhost:3000/api/v1/admin/suggested-questions/<id> \
  -H "Authorization: Bearer <admin JWT>" -H "Content-Type: application/json" \
  -d '{"status":"APPROVED"}'
```

관리자 API는 **SUPER_ADMIN만** 쓸 수 있다 (`AdminJwtGuard` + `SuperAdminGuard`).

위젯 쪽은 세션 토큰이 필요하다.

```sh
# 세션 발급
curl -X POST http://localhost:3000/api/v1/widget/auth/session \
  -H "Content-Type: application/json" \
  -d '{"widgetKey":"<공개 widgetKey>","pageUrl":"https://<허용 도메인>/"}'

# 추천 질문 조회
curl "http://localhost:3000/api/v1/widget/suggested-questions?limit=5" \
  -H "Authorization: Bearer <세션 토큰>"
```

확인할 것:

- `PENDING`·`REJECTED` 질문은 위젯 응답에 나오지 않는다.
- 위젯 응답에 `prompt`가 없다. `id`와 `question`뿐이다.
- 다른 위젯 키의 질문이 섞이지 않는다. `widgetKeyId`는 쿼리가 아니라 세션에서 읽는다.
- 접근 권한이 없는 질문·위젯 키는 403이 아니라 404로 응답한다. 존재 여부를 드러내지 않기 위함이다.

## 3. 주기 작업 확인

`SUGGESTED_QUESTIONS_ENABLED=true`와 위젯 키를 넣고 앱을 다시 띄운다.

주기 작업은 **한국 시간 00·06·12·18시**에 돈다(`@Cron('0 0,6,12,18 * * *', { timeZone: 'Asia/Seoul' })`).
기동 직후에 한 번 돌지 않으므로, 로컬에서 바로 보고 싶으면 아래 백필 스크립트를 쓴다.

```
[NoticeFeedService]        최신 공지 10건 (id 199298~199307), 제목 확보 10건
[QuestionGenerationService] id=199307 질문 1/1건 저장 (PENDING)
[NoticeIngestionService]   [<위젯 키>] 장부에 없는 공지 10건 → 처리 9건, 질문 6건 저장, 본문 없음 1건
[SuggestedQuestionsWorker] 주기 작업 완료 — 위젯 키 1개, 공지 9건 처리, 질문 6건 저장, 실패 0건
```

확인할 것:

- 생성된 질문은 전부 `source=AI`, `status=PENDING`이다. 승인 전에는 위젯에 나오지 않는다.
- `notice_id`와 `notice_title`이 채워져 있다. 관리자가 어떤 공지에서 나왔는지 보기 위한 것이다.
- 같은 공지를 두 번 처리하지 않는다. 두 번째 실행에서 `처리 0건`이 나와야 한다.

다시 생성시켜 보려면 장부에서 최신 몇 건을 지운다.

```sql
DELETE FROM notice_question_ingestions
WHERE widget_key_id = '<위젯 키 UUID>'
  AND notice_id IN (
    SELECT notice_id FROM notice_question_ingestions
    WHERE widget_key_id = '<위젯 키 UUID>'
    ORDER BY notice_id DESC LIMIT 3
  );
```

## 4. 기존 공지 백필

주기 작업은 **최신 10건만** 본다. 기능을 처음 켤 때는 이미 올라와 있는 공지에 질문이
하나도 없으므로 백필을 한 번 돌려야 한다.

```sh
bun run build
node dist/backfill-suggested-questions.js --count 200
```

주기 작업과 같은 수집·생성 경로를 쓰고 가져올 건수만 다르다. 장부가 공지당 1회를
보장하므로 여러 번 돌려도, 직후에 주기 작업이 돌아도 같은 공지에 다시 질문을 만들지 않는다.

공지 200건이면 LLM 호출 200회, 10분 안팎이다. 만들어진 질문은 전부 `PENDING`이다.

## 5. 알아둘 것

**지글에는 최신 공지 목록 도구가 없다.** `search_notices`의 `query`가 필수이고 빈 문자열은
거부된다. 그런데 `ziggle-be/apps/api/src/mcp/mcp.service.ts`를 보면 각 질의가
`orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }]`로 **최신순**이고
`plainBody: { contains: query }`로 거른다. 그래서 거의 모든 본문에 들어가는 짧은 문자열
(`다`, `의`, `a`, `e`, `1`)로 검색하면 그게 곧 최신 목록이 된다.

주제어(장학·기숙사 같은)로 수집하면 그 주제의 공지만 걸려 수집이 편향된다. 키워드는
수집 수단이 아니라 제목·요약을 얻는 수단이다.

**검색이 놓치는 것은 `plainBody`가 빈 공지뿐이다.** 곧 본문이 이미지뿐인 공지이고,
어차피 질문을 만들 수 없어 생성 단계에서 건너뛴다. staging 실측에서 최신 60개 id 구간의
본문 있는 44건을 전부 포착했다(놓친 것 0건).

**공지 id는 환경마다 따로 매겨진다.** staging과 prod가 각자 크롤러를 돌리는 별도
인스턴스다. 1번의 `ZIGGLE_NOTICE_URL_BASE` 주의사항이 여기서 나온다.

**요약이 없으면 본문을 받는다.** `summary`가 비어 있으면 `get_notice`로 본문(HTML)을 받아
`htmlToPlainText`로 평문으로 바꾼 뒤 `maskPersonalInfo`를 적용한다. prod는 요약 보유율이
68%인데 staging은 최신 구간이 0%라 거의 항상 본문을 받는다.

**장부 기록은 생성이 끝난 뒤에 한다.** 본문이 이미지뿐이거나 모델이 "물어볼 게 없다"고
판단한 경우에도 기록한다. 다시 돌려도 결과가 같은 확정된 결론이기 때문이다. 반대로
네트워크 오류처럼 예외로 끊긴 공지는 기록하지 않아 다음 주기에 다시 집힌다.

**프롬프트에 오늘 날짜를 넘긴다.** 마감이 지난 공지는 모델이 빈 배열을 돌려준다.
prod 30건 측정에서 질문이 0건인 13건 중 7건 이상이 이미 끝난 행사였다. 생성률이 낮은 것이
품질이 나쁜 것은 아니다.

## 6. 자동 검증

```sh
bunx jest src/suggested-questions src/config
bunx tsc --noEmit
bun run build
```

자동 테스트는 지글과 모델을 mock해 분기와 계약을 확인한다. 실행 시각은 `cron` 패키지로
실제 발화 시각을 계산해 서울 기준 00·06·12·18시인지 검증한다(UTC 컨테이너에서 9시간
밀리는 사고를 막기 위함).

실제 질문 품질은 `scratchpad/quality-run.ts`로 prod 지글을 **읽기만** 해서 잰다.
결과는 `docs/cha3-21-sample-questions.md`에 있다.

`bun run test:unit`을 돌리면 이 변경과 무관한 실패가 3건 있다. `development`에서도 동일하다.

- `organizations.repository.spec.ts` 1건: 소스 파일 텍스트를 LF 기준으로 비교하는 테스트라 Windows의 CRLF 체크아웃에서 깨진다. Linux CI에서는 통과한다.
- `upload.service.spec.ts` 2건: 접근 불가 조직 필터에서 `ForbiddenException` 대신 `BadRequestException`이 난다. CHA3-16에 적힌 것과 같은 증상이다.

## 7. 이번 범위에 없는 것

- **관리자 검수 화면과 위젯 첫 화면 버튼.** 둘 다 `chatbot-fe` 작업이다. 백엔드 API는
  이 브랜치에 다 들어 있다(`suggested-questions-admin.controller.ts`, 위젯 `listApproved`).
- 추천 질문을 눌렀을 때 매칭된 `prompt`로 답변하는 연결. 기존 채팅 경로 변경이 필요해 별도 이슈로 둔다. 지금은 질문 문구가 채팅 입력란에 들어가고 일반 답변 경로를 탄다.
- 노출 순서 지정(`display_order`)과 질문 만료. 컬럼·정렬만 추가하면 되므로 나중에 넣어도 비용이 거의 없다.
- 본문이 이미지뿐인 공지에서 질문 만들기. OCR이나 비전 모델이 필요해 범위 밖으로 뒀다.
