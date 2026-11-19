# CHA3-21: 추천 질문 로컬 확인

브랜치: `simjimin/cha3-21`. 지글 공지에서 LLM이 예상 질문을 만들고, 관리자가 검수한 질문만 위젯 첫 화면에 노출한다.

새 테이블이 2개 있으므로 마이그레이션이 필요하다 (`drizzle/0020_suggested_questions.sql`).

## 1. 환경 준비

기존 `.env`는 자동 변경하지 않았다. `.env.example`의 `SUGGESTED_QUESTIONS_*` 항목을 참고해 추가한다.

```dotenv
# 지글 MCP (기존 항목). staging 키를 쓴다.
ZIGGLE_MCP_URL=https://api.stg.ziggle.gistory.me/mcp
ZIGGLE_MCP_API_KEY=<staging 키>

# 주기 작업. 기본은 꺼짐이고, 로컬에서 수집을 확인할 때만 켠다.
SUGGESTED_QUESTIONS_ENABLED=false
SUGGESTED_QUESTIONS_WIDGET_KEY_IDS=
```

`SUGGESTED_QUESTIONS_WIDGET_KEY_IDS`에는 **위젯 키의 UUID**를 넣는다. 공개 `widgetKey` 문자열이 아니다. `*`는 받지 않는다. 비어 있으면 주기 작업이 돌지 않는다.

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

`SUGGESTED_QUESTIONS_ENABLED=true`와 위젯 키를 넣고 앱을 다시 띄운다. 워커는 `app.listen()` 직후에 한 번 돌고, 이후 `SUGGESTED_QUESTIONS_INTERVAL_MS`(기본 6시간)마다 돈다.

**첫 실행은 질문을 만들지 않는다.** 지금 보이는 공지를 기준점으로 장부에만 기록한다.

```
[NoticeIngestionService] Ziggle에서 공지 132건 수집 (최신 id=199293)
[NoticeIngestionService] [<위젯 키>] 첫 실행: 공지 132건을 기준점으로 기록했습니다.
                         다음 주기부터 id > 199293 인 공지만 처리합니다.
[SuggestedQuestionsWorker] 주기 작업 완료 — 위젯 키 1개, 기준점 132건, 공지 0건, 질문 0건 저장, 실패 0건
```

이 단계가 없으면 첫 실행에서 과거 공지 100건 넘게 LLM을 호출한다.

실제 생성을 보려면 장부에서 최신 몇 건을 지워 "새 공지"로 만든다.

```sql
DELETE FROM notice_question_ingestions
WHERE widget_key_id = '<위젯 키 UUID>'
  AND notice_id IN (
    SELECT notice_id FROM notice_question_ingestions
    WHERE widget_key_id = '<위젯 키 UUID>'
    ORDER BY notice_id DESC LIMIT 3
  );
```

다음 주기에 그 3건이 LLM으로 넘어가고, 만들어진 질문은 `PENDING`으로 저장된다. 주기를 기다리기 싫으면 `SUGGESTED_QUESTIONS_INTERVAL_MS=60000`(최솟값)으로 낮춘다.

확인할 것:

- 생성된 질문은 전부 `source=AI`, `status=PENDING`이다. 승인 전에는 위젯에 나오지 않는다.
- `notice_id`와 `notice_title`이 채워져 있다. 관리자가 어떤 공지에서 나왔는지 보기 위한 것이다.
- 같은 공지를 두 번 처리하지 않는다. 두 번째 주기에 `공지 0건`이 나와야 한다.

## 4. 알아둘 것

**지글에는 최신 공지 목록 도구가 없다.** `search_notices`의 `query`가 필수이고 빈 문자열은 거부된다(실측). 그래서 씨드 키워드 10개로 각각 검색해 id로 합친다. 어떤 키워드에도 걸리지 않는 공지는 놓친다. 안 잡히는 공지가 보이면 `SUGGESTED_QUESTIONS_SEED_KEYWORDS`에 단어를 추가한다. 재배포는 필요 없다.

**검색 결과는 최신순이 아니다.** 키워드 10개로 132건을 받았을 때 id 범위가 88 ~ 199293이었다. 그래서 장부의 `MAX(notice_id)`를 커서로 써서 그보다 큰 공지만 처리한다.

**요약이 없는 공지가 절반이다.** 160건 중 79건만 `summary`가 있었고, 최신 공지일수록 비어 있다. 요약이 없으면 `get_notice`로 본문(HTML)을 받아 `htmlToPlainText`로 평문으로 바꾼 뒤 `maskPersonalInfo`를 적용한다. 이미지만 있는 공지는 건너뛴다.

**실패 처리가 두 갈래다.** LLM 호출이 터지면 선점을 되돌려 다음 주기에 다시 시도한다. 응답은 왔는데 질문이 0개면 되돌리지 않는다. "물어볼 것이 없는 공지"는 정상 결과이고, 장부에 남겨야 매 주기 다시 호출하지 않는다.

**주기 작업은 인스턴스마다 돈다.** cron 라이브러리나 쿠버네티스 CronJob이 아니라 앱 프로세스 안의 타이머다(`EmbeddingBackfillWorker`와 같은 방식). 같은 공지를 중복 처리하는 것은 `notice_question_ingestions`의 복합 기본키로 막는다. `INSERT ... ON CONFLICT DO NOTHING RETURNING`으로 행을 받은 인스턴스만 LLM을 호출한다.

## 5. 자동 검증

```sh
bunx jest src/suggested-questions src/config
bunx tsc --noEmit
bun run build
```

자동 테스트는 지글과 모델을 mock해 분기와 계약을 확인한다. 실제 질문 품질은 staging에서 확인한다.

`bun run test:unit`을 돌리면 이 변경과 무관한 실패가 3건 있다. `development`에서도 동일하다.

- `organizations.repository.spec.ts` 1건: 소스 파일 텍스트를 LF 기준으로 비교하는 테스트라 Windows의 CRLF 체크아웃에서 깨진다. Linux CI에서는 통과한다.
- `upload.service.spec.ts` 2건: 접근 불가 조직 필터에서 `ForbiddenException` 대신 `BadRequestException`이 난다. CHA3-16에 적힌 것과 같은 증상이다.

## 6. 이번 범위에 없는 것

- 추천 질문을 눌렀을 때 매칭된 `prompt`로 답변하는 연결. 기존 채팅 경로 변경이 필요해 별도 이슈로 둔다. 지금은 질문 문구가 채팅 입력란에 들어가고 일반 답변 경로를 탄다.
- 노출 순서 지정(`display_order`)과 질문 만료. 컬럼·정렬만 추가하면 되므로 나중에 넣어도 비용이 거의 없다.
- 첫 화면 카드 UI는 FE.
