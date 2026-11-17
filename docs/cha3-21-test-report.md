# CHA3-21 검증 결과

PR [#76](https://github.com/gsainfoteam/chatbot-be/pull/76) · 브랜치 `simjimin/cha3-21`

mock만으로 확인하지 않고, **실제 지글 staging·실제 LLM·실제 DB·실제 HTTP 요청**으로 확인한 내용을 정리했습니다.

| 종류 | 규모 |
| --- | --- |
| 자동 단위 테스트 | 84개 (6개 파일) |
| 실제 DB 검증 | 5회 (총 38개 항목) |
| 앱 기동 후 HTTP 호출 | 6회 기동, 39개 항목 |
| 지글 staging 실제 호출 | 탐사 2회 + 수집 11회분 |
| 실제 LLM 호출 | 1회 (7.1초, 질문 2건 생성) |

---

## 1. 자동 단위 테스트 — 84개 통과

```
PASS  src/config/env.validation.spec.ts
PASS  src/suggested-questions/suggested-questions.service.spec.ts
PASS  src/suggested-questions/suggested-questions-admin.service.spec.ts
PASS  src/suggested-questions/generation/notice-ingestion.service.spec.ts
PASS  src/suggested-questions/generation/question-generation.spec.ts
PASS  src/suggested-questions/generation/suggested-questions.worker.spec.ts

Test Suites: 6 passed, 6 total
Tests:       84 passed, 84 total
```

`bunx tsc --noEmit`, `bunx eslint`, `bun run build` 모두 통과합니다.

---

## 2. 지글 MCP 실측 — 설계를 바꾼 데이터

구현 전에 staging에 직접 찔러봤고, 여기서 나온 값이 설계를 결정했습니다.

```
TOOLS: [ "search_notices", "get_notice" ]          ← 목록 전용 도구 없음

query=""     → isError: Too small: expected string to have >=1 characters
query=" "    → isError: 같음 (공백도 거부)
query="장학"  → ids: [199291, 199290, 199276, 199275, 199256]
limit=100    → isError: Too big (상한 20)
get_notice   → 본문 2,076자, HTML
```

키워드 8개로 조사한 결과:

```
장학    20건 중 요약 8건        기숙사  20건 중 요약 19건
모집    20건 중 요약 12건       졸업    20건 중 요약 5건
신청    20건 중 요약 0건        행사    20건 중 요약 7건
수강    20건 중 요약 9건        채용    20건 중 요약 19건

총 160건 중 요약 보유 79건(49%) · 중복 제거 후 115건
id 범위: 88 ~ 199293          ← 검색 결과가 최신순이 아님
```

이 두 가지(요약 49%, id 범위)가 `get_notice` 보조 경로와 커서 설계의 근거입니다.

---

## 3. 실제 DB 검증

### 3-1. 스키마 제약 (트랜잭션 → 롤백)

```
선점 1회차 returning: 1 행  → 내가 집음
선점 2회차 returning: 0 행  → 이미 처리됨, 건너뜀
커서 MAX(notice_id): 199293 → 최신 id 선택
101자 질문: 거부됨 (suggested_questions_question_length)
같은 질문 재등록: 0 행 → 유니크로 차단
기본값: source=ADMIN, status=PENDING

롤백 후 — suggested_questions: 0 | notice_question_ingestions: 0 | widget_keys: 0
```

### 3-2. 지글 staging 수집 (LLM 없이)

```
1회차  Ziggle에서 공지 132건 수집 (최신 id=199293)
       첫 실행: 공지 132건을 기준점으로 기록          선점 0건, LLM 0회
2회차  커서 199293 기준 새 공지 0건                   장부 안 늘어남

장부에서 상위 3건(199293, 199292, 199291) 삭제 → 커서 199290

3회차  새 공지 3건 인식, 선점 3건
       - id=199293 「필전 2026 – 조선 백일장」 참가 안내
       - id=199292 [인문사회과학부 런치톡] ...
       - id=199291 [학사] 2026학년도 2학기 교내장학금 신청 안내
4회차  선점 0건 → 같은 공지 재처리 안 함

동시 선점 테스트: Promise.all로 같은 공지 → [true, false]
```

마지막 줄이 `notice_question_ingestions` 테이블의 존재 이유입니다. 인스턴스가 둘이어도 한쪽만 1행을 받습니다.

### 3-3. 실제 LLM 호출 1회

```
모델: openai/gpt-4o-mini
대상: id=199293 「필전 2026 – 조선 백일장」 참가 안내 (요약 없음 → get_notice 경로)
소요: 7,098ms

Q: 백일장 참가 신청은 어떻게 해요?   (18자)
P: 참가 대상은 전국 대학 학부 재학생 및 휴학생이며, 접수 마감은 2026년 11월 17일입니다.
   자세한 사항은 공지 원문을 참고하세요: https://ziggle.gistory.me/notice/199293

Q: 예선은 언제, 어디서 열리나요?   (17자)
P: 예선은 2026년 11월 21일(토) 14:00~17:00에 전북대학교 진수당 77주년기념홀에서 열립니다.

확인: 전부 PENDING · source=AI · 100자 이하 · 출처 공지 id·제목 기록
      재실행 시 선점 0건 (LLM 재호출 없음)
```

요약이 없는 공지가 걸려서 `get_notice` → HTML → `htmlToPlainText` → `maskPersonalInfo` 경로가 함께 검증됐습니다. 전체의 절반 이상인 주 경로입니다.

---

## 4. 앱 기동 후 실제 HTTP 호출

### 4-1. 위젯 API

```
① 토큰 없이              401 차단
② 세션 발급              201
③ 조회                   200  APPROVED 2건만 · 최신순 · prompt 미노출 · 남의 위젯 질문 제외
④ limit=1                1건
⑤ limit=99 (상한 초과)    400
⑥ limit=abc              400
⑦ 모르는 쿼리 파라미터     400
⑧ 위조 토큰              401
```

### 4-2. 관리자 API

```
① 인증 없이              401
② POST 등록              201 · source=ADMIN · status=APPROVED · noticeUrl null
③ 중복 등록              409
④ 남의 위젯 키에 등록      404  (403이 아님 — 존재 여부를 드러내지 않음)
⑤ 101자 질문             400
⑥ ?status=PENDING&source=AI   AI 후보 1건 · prompt 노출(관리자용) · 공지 링크 · 페이지 정보
⑦ 다른 관리자가 조회       내 질문 안 보임
⑧ PATCH 승인             200 · 검수자·시각 기록 · 프롬프트 수정 반영
⑨ PATCH 빈 바디          400
⑩ 남의 질문 PATCH        404
⑪ 상세 200 · uuid 아님 400 · 없는 id 404
```

### 4-3. 전체 흐름

```
PENDING      → 위젯에 안 보임
관리자 승인   → 위젯에 노출됨, 응답에 prompt 없음
관리자 거절   → 위젯에서 사라짐
```

### 4-4. 주기 작업

꺼짐(기본값):

```
[SuggestedQuestionsWorker] 추천 질문 생성 주기 작업이 꺼져 있습니다
                           (SUGGESTED_QUESTIONS_ENABLED / SUGGESTED_QUESTIONS_WIDGET_KEY_IDS 확인)
```

켜짐:

```
[SuggestedQuestionsWorker]  추천 질문 생성 주기 작업을 시작합니다
[NoticeIngestionService]    Ziggle에서 공지 132건 수집 (최신 id=199293)
[NoticeIngestionService]    첫 실행: 공지 132건을 기준점으로 기록했습니다.
[SuggestedQuestionsWorker]  주기 작업 완료 — 위젯 키 1개, 기준점 132건, 공지 0건, 질문 0건 저장, 실패 0건
```

기동 직후 자동으로 돌았고, 첫 실행이라 LLM은 호출하지 않았습니다.

---

## 5. 리뷰에서 지적받은 버그 — 재현 후 수정

> 새 공지가 한 주기 상한을 넘으면 일부가 영영 처리되지 않는다

**재현했습니다.** 공지 20건(id 101~120), 상한 10건:

```
1회차  선점 10건  처리 [120~111]  → 커서 120
2회차  선점 0건   처리 [없음]     → 커서 120
3회차  선점 0건   처리 [없음]     → 커서 120

처리된 공지: 111 ~ 120
누락된 공지: 101 ~ 110      ← 10건이 영영 처리되지 않음
```

원인은 세 가지가 겹친 것이었습니다.

| | |
| --- | --- |
| `fetchRecent()` | 내림차순(최신 먼저)으로 반환 |
| `fresh.slice(0, maxPerRun)` | 가장 새 것 N건만 처리 |
| 커서 | `MAX(notice_id)` |

최신부터 처리하면 커서가 미처리 공지를 추월합니다. 같은 이유로 실패 복구도 동작하지 않았습니다. 재시도된다는 주석을 달아놨지만 실제로는 재시도되지 않았습니다.

```
1회차  id=115 실패 → 선점 취소   커서 120
2회차  선점 0  처리 [없음]        → 115 재시도 안 됨
```

**수정**: 오래된 것부터 처리하고, 실패하면 그 주기를 거기서 멈춥니다. 그러면 커서가 실패한 공지를 넘어가지 않습니다.

```ts
const fresh = notices
  .filter((notice) => notice.id > cursor)
  .sort((a, b) => a.id - b.id);
...
} catch (error) {
  ...
  await this.repo.releaseNotice(widgetKeyId, notice.id);
  break;   // 커서가 이 공지를 넘어가지 않도록 이번 주기는 중단
}
```

**수정 후 같은 시나리오**:

```
처리된 공지: 101 ~ 120 전부
누락된 공지: 없음

--- 실패 복구 (105가 실패) ---
1회차  101~104 처리, 105 실패 → 중단   커서 104   ← 105를 안 넘어감
2회차  처리 [105, 106, ... 114]         → 105 재시도됨
```

회귀 테스트 3개를 추가했습니다.

| 테스트 | 검사 내용 |
| --- | --- |
| `caps how many notices one run takes, taking the oldest first` | 집는 순서까지 검사 (`[2, 3]`) |
| `leaves the rest of a backlog for the next pass` | 1회차 `[2,3]` → 2회차 `[4,5]`, 합치면 전부 |
| `stops the pass at a failure so the cursor cannot pass it` | 실패 뒤 공지를 집지 않는지 |

`keeps going after one notice fails` 테스트는 제거했습니다. 실패 후에도 계속 진행하는 것을 검사하고 있었는데, 그게 버그 동작이었습니다.

---

## 6. 알려진 한계

**영구적으로 실패하는 공지는 뒤 공지를 막습니다.** 실패 시 중단하므로, 같은 공지가 매 주기 실패하면 커서가 멈춥니다.

가능성은 낮다고 봅니다.

- `getNoticeBody()`는 MCP 도구 오류를 `null`로 돌려주고 예외를 던지지 않습니다. 네트워크 장애만 예외이고 이는 일시적입니다.
- `repo.create()`는 중복을 `onConflictDoNothing`으로, 길이를 사전 검증으로 걸러 예외가 나지 않습니다.
- 남는 건 `llm.callLLM()`인데, 본문을 6,000자로 자르므로 컨텍스트 초과는 불가능하고, 키·쿼터 문제는 모든 공지가 실패하므로 전체가 멈추는 것이 맞습니다. 특정 공지에서만 영구히 실패하는 경우는 콘텐츠 필터 정도입니다.

막히더라도 이미 승인된 질문은 그대로 노출되므로 사용자 영향은 없고, 6시간마다 WARN 로그가 남습니다.

프로세스 메모리로 재시도 횟수를 세어 넘기는 방식도 검토했으나, 재시작하면 초기화되고 replica마다 따로 세는 휘발 상태라 동작을 예측하기 어려워져 넣지 않았습니다. 실제로 발생하면 장부에 `attempts` 컬럼을 추가해 N회 후 포기시키는 것이 맞습니다.

**질문에 매칭된 `prompt`가 답변에 쓰이지 않습니다.** 저장과 검수까지는 구현했고, 답변 경로 연결은 별도 작업으로 둡니다. `chat-orchestration.service.ts`의 답변 스트림 시작 지점 5곳에 전달해야 해서 범위가 커집니다.

**협업자(`VIEWER`)도 승인·거절이 가능합니다.** `collaborator_role` enum에 `VIEWER`밖에 없고 스코핑이 `status = 'ACCEPTED'`만 보기 때문입니다. `unanswered-questions`와 같은 규칙이라 일관성은 있으나 의도된 것인지 확인이 필요합니다.

---

## 7. 머지 전 확인

1. **마이그레이션 번호** — 이 브랜치는 `0020`을 씁니다. CHA3-20도 `0020`을 쓰고 있어, 그쪽이 먼저 머지되면 파일과 `_journal.json`의 `idx`·`tag`를 `0021`로 바꿔야 합니다.
2. **CI 실패 3건은 이 변경과 무관합니다.** `development`에서도 동일합니다.
   - `organizations.repository.spec.ts` 1건: 소스 파일 텍스트를 LF 기준으로 비교해 Windows CRLF 체크아웃에서 깨집니다. 원본에는 없고 CRLF를 LF로 바꾸면 찾아지는 것을 확인했습니다.
   - `upload.service.spec.ts` 2건: `ForbiddenException` 기대인데 `BadRequestException`이 납니다. CHA3-16에 적힌 두 테스트와 같습니다.
3. **diff 5,503줄 중 2,634줄은 drizzle 생성물입니다.** `drizzle/meta/0020_snapshot.json`(2,595줄)은 읽지 않아도 됩니다. 실제 리뷰 대상은 `src/suggested-questions/` 1,886줄입니다.
4. `SUGGESTED_QUESTIONS_ENABLED` 기본값이 `false`라 머지해도 운영 동작은 바뀌지 않습니다.
