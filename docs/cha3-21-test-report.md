# CHA3-21 검증 결과

> **이 문서는 2026-11-18 기준이며 설계가 바뀌어 상당 부분이 유효하지 않습니다.**
>
> 당시에는 키워드로 공지를 수집하고 `MAX(notice_id)` 커서와 선점(claim) 방식을 썼는데,
> 지금은 범용 질의로 최신 목록을 받고 생성이 끝난 뒤에 장부를 기록합니다.
> 아래의 커서·선점·씨딩 검증 내역은 더 이상 존재하지 않는 코드에 대한 것입니다.
>
> 최신 설계와 측정 결과는 `docs/cha3-21-handoff.md`와
> `docs/cha3-21-sample-questions.md`를 보세요.

PR [#76](https://github.com/gsainfoteam/chatbot-be/pull/76) · 브랜치 `simjimin/cha3-21`

mock만으로 확인하지 않고 **실제 지글 staging·실제 LLM·실제 DB·실제 HTTP 요청**으로 확인했습니다. 아래 로그는 전부 실제 실행 출력을 그대로 옮긴 것입니다.

| 종류 | 규모 | 어디 |
| --- | --- | --- |
| 자동 단위 테스트 | 84개 (6개 파일) | 1절 |
| 지글 staging 탐사 | 2회 | 2절 |
| 실제 DB에 대고 돌린 스크립트 | 5회 · 확인 24개 | 3절 |
| 앱 기동 후 HTTP 호출 | 기동 6회 · 확인 35개 | 4절 |
| 지글 staging 수집 호출 | 8회분 (키워드 10개 × 8) | 3절, 4절 |
| 실제 LLM 호출 | 1회 (7.1초, 질문 2건) | 3절 |

확인 24개 = 스키마 제약 6 + 수집 10 + LLM 8
확인 35개 = 위젯 API 11 + 관리자 API 20 + 전체 흐름 4

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

## 2. 지글 MCP 탐사 — 설계를 바꾼 데이터

구현 **전에** staging에 직접 찔러봤고, 여기서 나온 값이 설계를 결정했습니다.

### 2-1. 제공 도구와 파라미터 제약

```
TOOLS: [ "search_notices", "get_notice" ]

empty   | isError: true | MCP error -32602: Too small: expected string to have >=1 characters at query
space   | isError: true | MCP error -32602: Too small: expected string to have >=1 characters at query
word    | isError: false | ids: [ 199291, 199290, 199276, 199275, 199256 ]
nolimit | isError: true | MCP error -32602: Too small: ... at query

limit=100 → MCP error -32602: Too big: expect...
get_notice(199293) → 본문 2076자 | 앞부분: <div class="bd_detail_cont"> <p></p><p ...
```

목록 전용 도구가 없고, `query`가 필수이며 빈 문자열·공백 모두 거부됩니다. `limit` 상한은 20입니다.

### 2-2. 키워드 8개 조사

```
장학    받은개수: 20 | 요약있음: 8
모집    받은개수: 20 | 요약있음: 12
신청    받은개수: 20 | 요약있음: 0
수강    받은개수: 20 | 요약있음: 9
기숙사   받은개수: 20 | 요약있음: 19
졸업    받은개수: 20 | 요약있음: 5
행사    받은개수: 20 | 요약있음: 7
채용    받은개수: 20 | 요약있음: 19
---
총 응답: 160 | 요약 있는 것: 79 | 중복제거 후 공지수: 115
id 범위: 88 ~ 199293
```

**요약 보유율 49%**와 **id 범위가 88까지 내려가는 것**(= 검색 결과가 최신순이 아님)이 `get_notice` 보조 경로와 커서 설계의 근거입니다.

---

## 3. 실제 DB에 대고 돌린 스크립트 — 5회

### 3-1. 스키마 제약 (트랜잭션 → 롤백) · 확인 6개

```
선점 1회차: 1 행 -> 내가 집음 OK
선점 2회차: 0 행 -> 이미 처리됨, 건너뜀 OK
커서 MAX(notice_id): 199293 -> 최신 id OK
101자 질문: 거부됨 OK (suggested_questions_question_length)
같은 질문 재등록: 0 행 -> 유니크로 차단 OK
AI 행 기본값: {"source":"AI","status":"PENDING","notice_id":199293}
생략시 기본값: {"source":"ADMIN","status":"PENDING"} ->  OK

롤백 후 — suggested_questions: 0 | notice_question_ingestions: 0 | widget_keys: 0
```

### 3-2. 지글 staging 수집 (LLM 없이) · 확인 10개

```
  OK  isEnabled

-- 1회차 (첫 실행 = 씨딩)
Ziggle에서 공지 132건 수집 (최신 id=199293)
[6f655f65-...] 첫 실행: 공지 132건을 기준점으로 기록했습니다.
               다음 주기부터 id > 199293 인 공지만 처리합니다.
  OK  씨딩 132건, 선점 0건
  OK  장부 132행, 최대 공지 id=199293

-- 2회차 (새 공지 없음)
[6f655f65-...] 커서 199293 기준 새 공지 0건, 선점 0건
  OK  씨딩 0, 새 공지 0, 선점 0
  OK  장부 안 늘어남 = 중복 호출 안 함

-- 상위 3건을 장부에서 지워 새 공지인 것처럼 만들기
   지운 id: 199293, 199292, 199291 | 새 커서: 199290

-- 3회차 (새 공지 3건 처리해야 함)
[6f655f65-...] 커서 199290 기준 새 공지 3건, 선점 3건
  OK  새 공지 3건 인식
  OK  선점 3건
  OK  선점한 것이 아까 지운 그 공지들
   요약 보유: 0/3
   - id=199293 「필전 2026 – 조선 백일장」 참가 안내
   - id=199292 [인문사회과학부 런치톡] 성큼 들어온 AI, 이제 '어떻게'를 물을 시간(1
   - id=199291 [학사] 2026학년도 2학기 교내장학금(성적우수/생활지원) 신청 안내

-- 4회차 (다시 새 공지 없음)
  OK  선점 0건 = 같은 공지 재처리 안 함

-- 두 인스턴스가 동시에 같은 공지를 집으면
  OK  동시 선점 결과 [true, false] = 한쪽만 성공

정리 후 — notice_question_ingestions: 0 | widget_keys: 0
```

마지막 줄이 `notice_question_ingestions` 테이블의 존재 이유입니다. `Promise.all`로 같은 공지를 동시에 집게 했더니 한쪽만 1행을 받았습니다.

**가장 최근 공지 3건의 요약 보유가 0/3**이었습니다. 전체 평균 49%보다 나쁜데, 최신 공지일수록 지글 자동 요약이 아직 안 붙기 때문으로 보입니다. `get_notice` 경로가 예외가 아니라 주 경로입니다.

### 3-3. 실제 LLM 호출 · 확인 8개

```
모델(normal): openai/gpt-4o-mini

대상 공지 id=199293 (요약 없음)
제목: 「필전 2026 – 조선 백일장」 참가 안내

[NoticeIngestionService]   Ziggle에서 공지 132건 수집 (최신 id=199293)
[QuestionGenerationService] id=199293 질문 2/2건 저장 (PENDING)
[NoticeIngestionService]   커서 199292 기준 새 공지 1건 → 선점 1건, 질문 2건 저장

소요 7098ms
  OK  선점 1건
  OK  실패 0건

저장된 질문 2건:
  Q: 백일장 참가 신청은 어떻게 해요?   (18자)
  P: 백일장 참가 신청은 원문 링크에서 확인하실 수 있습니다. 참가 대상은 전국 대학
     학부 재학생 및 휴학생이며, 접수 마감은 2026년 11월 17일입니다.
     자세한 사항은 공지 원문을 참고하세요: https://ziggle.gistory.me/notice/199293
     source=AI status=PENDING notice_id=199293

  Q: 예선은 언제, 어디서 열리나요?   (17자)
  P: 예선은 2026년 11월 21일(토) 14:00~17:00에 전북대학교 진수당 77주년기념홀에서
     열립니다. 자세한 사항은 공지 원문을 참고하세요: https://ziggle.gistory.me/notice/199293
     source=AI status=PENDING notice_id=199293

  OK  전부 PENDING = 검수 전에는 위젯에 안 나감
  OK  source=AI
  OK  질문 길이 100자 이하
  OK  출처 공지 id 기록됨
  OK  출처 공지 제목 기록됨
  OK  재실행 시 선점 0건 = LLM 재호출 없음

정리 후 — suggested_questions: 0 | notice_question_ingestions: 0
```

요약이 없는 공지가 걸려서 `get_notice` → HTML → `htmlToPlainText` → `maskPersonalInfo` 경로가 함께 검증됐습니다.

질문 두 개가 **공지 제목 복붙이 아니라 학생 말투**이고 20자 이내입니다. 프롬프트에는 공지에서 뽑은 실제 마감일·일시·장소·대상과 원문 링크가 들어갔습니다.

### 3-4. 버그 재현 · 3-5. 수정 후 재검증

5절에 따로 적었습니다.

---

## 4. 앱 기동 후 실제 HTTP 호출 — 기동 6회, 확인 35개

| 기동 | 포트 | 목적 | 결과 |
| --- | --- | --- | --- |
| 1 | 3000 | 위젯 API 확인 | **실패** — 다른 프로젝트가 점유 중이어서 기동 자체가 안 됨 |
| 2 | 3100 | 위젯 API 확인 | 확인 11개 |
| 3 | 3100 | 관리자 API · 전체 흐름 | 확인 20 + 4개 |
| 4 | 3101 | 워커 꺼짐 | 로그 확인 |
| 5 | 3102 | 워커 켜짐 | 로그 확인 |
| 6 | 3103 | Swagger 문서 확인 | 401 (Basic Auth 필요) |

1번은 포트 3000을 다른 프로젝트의 `bun --watch src/main.ts`가 쓰고 있어 우리 앱이 뜨지 못했습니다. 에러 응답 형식이 같아서(둘 다 `@gsainfoteam/nest-observability`) 처음에는 우리 앱인 줄 알았고, 프로세스를 확인해 알아냈습니다. 이후 3100번대로 옮겼습니다.

### 4-1. 위젯 API · 확인 11개

준비: 내 위젯 APPROVED 2건 / PENDING 1건 / REJECTED 1건, 남의 위젯 APPROVED 1건

```
① 토큰 없이            -> 401 401 차단 OK
② 세션 발급            -> 201 OK
③ 조회                 -> 200 [{"id":"38d3c687-...","question":"국가장학금 언제까지 신청해요?"},
                                {"id":"7d155c53-...","question":"기숙사 언제 들어가요?"}]
   APPROVED 2건만        -> OK      (PENDING·REJECTED 제외됨)
   최신순                -> OK
   prompt 미노출          -> OK      (키가 id, question 둘뿐)
   남의 위젯 질문 제외     -> OK
④ limit=1              -> 1건 OK
⑤ limit=99             -> 400 거부 OK
⑥ limit=abc            -> 400 거부 OK
⑦ 모르는 파라미터        -> 400 거부 OK
⑧ 잘못된 토큰           -> 401 차단 OK

정리 후 — suggested_questions: 0 | widget_keys: 0 | sessions: 0
```

③ 한 줄에 확인이 4개 들어 있어 ①~⑧이지만 확인은 11개입니다.

### 4-2. 관리자 API · 확인 20개

준비: 내 위젯 키, 남의 위젯 키, AI가 만든 PENDING 질문 1건. 관리자 JWT 2개를 `JWT_SECRET`으로 직접 서명해 만들었습니다(`AdminJwtStrategy`가 서명만 검증하고 DB를 보지 않음).

```
① 인증 없이 목록
  OK  401 차단
② POST 등록
  OK  201 생성 (받음: 201)
  OK  source=ADMIN, status=APPROVED
  OK  직접 등록은 noticeUrl null
③ 중복 등록
  OK  409 충돌
④ 남의 위젯 키에 등록
  OK  404 (403 아님 — 존재 숨김)
⑤ 101자 질문
  OK  400 거부
⑥ GET ?status=PENDING&source=AI
  OK  AI 후보 1건
  OK  prompt 노출됨(관리자용)
  OK  공지 링크 생성
  OK  페이지 정보
⑦ 다른 관리자가 같은 목록 조회
  OK  내 질문 안 보임
⑧ PATCH 승인
  OK  200 승인됨
  OK  검수자·시각 기록
  OK  프롬프트 수정 반영
⑨ PATCH 빈 바디
  OK  400 거부
⑩ 남의 질문 PATCH
  OK  404 차단
⑪ GET 상세 / 없는 id
  OK  상세 200
  OK  uuid 아님 400
  OK  없는 id 404

정리 후 — suggested_questions: 0 | widget_keys: 0
```

④와 ⑩이 **403이 아니라 404**인 것이 의도한 동작입니다. 403을 주면 그 id가 존재한다는 사실이 드러납니다. `unanswered-questions`와 같은 규칙입니다.

### 4-3. 전체 흐름 · 확인 4개

```
  OK  검수 전: 위젯에 안 보임 (PENDING)
  OK  승인 후: 위젯에 노출됨
  OK  위젯 응답에 프롬프트 없음
  OK  거절 후: 위젯에서 사라짐

정리 후 — suggested_questions: 0 | widget_keys: 0 | sessions: 0
```

관리자 API와 위젯 API가 같은 `status` 컬럼으로 실제로 연결되는지 확인한 것입니다.

### 4-4. 주기 작업 기동

**꺼짐** (`SUGGESTED_QUESTIONS_ENABLED=false`, 기본값):

```
[SuggestedQuestionsWorker] 추천 질문 생성 주기 작업이 꺼져 있습니다
                           (SUGGESTED_QUESTIONS_ENABLED / SUGGESTED_QUESTIONS_WIDGET_KEY_IDS 확인)
```

**켜짐**:

```
[SuggestedQuestionsWorker]  추천 질문 생성 주기 작업을 시작합니다
[NoticeIngestionService]    Ziggle에서 공지 132건 수집 (최신 id=199293)
[NoticeIngestionService]    [2257e600-...] 첫 실행: 공지 132건을 기준점으로 기록했습니다.
                            다음 주기부터 id > 199293 인 공지만 처리합니다.
[SuggestedQuestionsWorker]  주기 작업 완료 — 위젯 키 1개, 기준점 132건, 공지 0건, 질문 0건 저장, 실패 0건

장부: 132 행 | 최대 id: 199293 | 생성된 질문: 0
정리 후 — 장부: 0 | 위젯키: 0
```

기동 직후 자동으로 돌았고, 첫 실행이라 **LLM은 0회 호출**했습니다. 씨딩이 없었다면 배포 직후 132건에 LLM을 호출했을 것입니다.

---

## 5. 리뷰에서 지적받은 버그 — 재현 → 수정 → 재검증

> 새 공지가 한 주기 상한을 넘으면 일부가 영영 처리되지 않는다

### 5-1. 재현

공지 20건(id 101~120), 상한 10건, 시작 커서 100. 실제 `fetchRecent()`와 같이 내림차순으로 주는 가짜 피드를 썼습니다.

```
시작 커서: 100 | 새 공지: 101 ~ 120 (20건), 한 주기 상한 10건

1회차  선점 10건  처리 10건 [120~111]  → 커서 120
2회차  선점 0건   처리 0건  [없음]     → 커서 120
3회차  선점 0건   처리 0건  [없음]     → 커서 120

처리된 공지: 111, 112, 113, 114, 115, 116, 117, 118, 119, 120
누락된 공지: 110, 109, 108, 107, 106, 105, 104, 103, 102, 101

>>> 10건이 영영 처리되지 않습니다. 버그 확인됨.
```

실패 복구도 동작하지 않았습니다.

```
-- 실패 복구: 중간 공지 하나가 LLM 오류 (id=115)
1회차  선점 10  실패 1  커서 120
  115 장부에 있나: 없음(선점 취소됨)
2회차  선점 0  처리 [없음]
  >>> 115가 재시도되지 않습니다. 주석과 다릅니다.
```

원인은 세 가지가 겹친 것입니다.

| | |
| --- | --- |
| `fetchRecent()` | `sort((a,b) => b.id - a.id)` — 내림차순(최신 먼저) |
| `fresh.slice(0, maxPerRun)` | 가장 새 것 N건만 처리 |
| 커서 | `MAX(notice_id)` |

최신부터 처리하면 커서가 미처리 공지를 추월합니다. 코드에 "다음 주기에 다시 집게 한다"는 주석을 달아두었으나 실제로는 재시도되지 않았습니다. 4단계 검증(3-2절)에서 공지가 3건뿐인 시나리오만 돌려서 상한에 걸리는 경우를 보지 못했습니다.

### 5-2. 수정

```ts
// 오래된 것부터 처리한다. 커서가 MAX(notice_id)라서, 최신부터 처리하면
// 한 주기 상한에 걸려 남은 과거 공지가 커서에 추월당해 영영 집히지 않는다.
const fresh = notices
  .filter((notice) => notice.id > cursor)
  .sort((a, b) => a.id - b.id);
```

```ts
} catch (error) {
  ...
  await this.repo.releaseNotice(widgetKeyId, notice.id);
  this.logger.warn(...);
  // 뒤 공지를 계속 처리하면 커서가 이 공지를 넘어가 다시 집지 못한다.
  // 이번 주기는 여기서 멈추고 다음 주기에 이 공지부터 다시 시작한다.
  break;
}
```

### 5-3. 재검증 — 같은 스크립트

```
1회차  선점 10건  처리 10건 [101~110]  → 커서 110
2회차  선점 10건  처리 10건 [111~120]  → 커서 120
3회차  선점 0건   처리 0건  [없음]     → 커서 120

처리된 공지: 101 ~ 120 전부
누락된 공지: 없음
>>> 누락 없음
```

```
-- 실패 복구 (105가 실패)
1회차  선점 5  실패 1  커서 104          ← 105를 안 넘어감
  105 장부에 있나: 없음(선점 취소됨)
2회차  선점 10  처리 [105, 106, 107, 108, 109, 110, 111, 112, 113, 114]
  >>> 105 재시도됨
```

### 5-4. 회귀 테스트 3개

| 테스트 | 검사 내용 |
| --- | --- |
| `caps how many notices one run takes, taking the oldest first` | 집는 순서까지 검사 (`[2, 3]`) |
| `leaves the rest of a backlog for the next pass` | 1회차 `[2,3]` → 2회차 `[4,5]`, 합치면 전부 |
| `stops the pass at a failure so the cursor cannot pass it` | 실패 뒤 공지를 집지 않는지 |

`keeps going after one notice fails` 테스트는 제거했습니다. 실패 후에도 계속 진행하는 것을 검사하고 있었는데, 그게 버그 동작이었습니다.

---

## 6. 알려진 한계

### 6-1. 영구적으로 실패하는 공지는 뒤 공지를 막습니다

실패 시 중단하므로, 같은 공지가 매 주기 실패하면 커서가 멈춥니다.

가능성은 낮다고 봅니다. `generateForNotice`에서 예외가 날 수 있는 곳은 세 군데뿐입니다.

| 지점 | 영구적일 수 있나 |
| --- | --- |
| `ziggle.getNoticeBody()` | 아니오. MCP 도구 오류는 `return null`이라 예외가 안 납니다. 네트워크 장애만 예외이고 일시적입니다 |
| `repo.create()` | 아니오. 중복은 `onConflictDoNothing`, 길이는 사전 검증으로 걸립니다 |
| `llm.callLLM()` | 여기만 가능성이 있습니다 |

`llm.callLLM()`도 본문을 6,000자로 자르므로 컨텍스트 초과는 불가능하고, 키·쿼터 문제는 모든 공지가 실패하므로 전체가 멈추는 것이 맞습니다. 특정 공지에서만 영구히 실패하는 경우는 콘텐츠 필터 정도입니다.

막히더라도 이미 승인된 질문은 그대로 노출되므로 사용자 영향은 없고, 6시간마다 WARN 로그가 남습니다.

프로세스 메모리로 재시도 횟수를 세어 넘기는 방식을 만들어 보았으나 되돌렸습니다. 재시작하면 초기화되고 replica마다 따로 세는 휘발 상태라, 영속 상태(장부)와 섞이면 동작을 예측하기 어려워집니다. 실제로 발생하면 장부에 `attempts` 컬럼을 추가해 N회 후 포기시키는 것이 맞습니다.

### 6-2. 질문에 매칭된 `prompt`가 답변에 쓰이지 않습니다

저장과 검수까지는 구현했고 답변 경로 연결은 별도 작업입니다. `src/chat`에서 `suggested_questions`를 참조하는 코드가 없는 것을 확인했습니다.

연결하려면 `ChatRequestDto`에 `suggestedQuestionId`를 받고, 승인 상태와 위젯 키를 검증해 프롬프트를 조회한 뒤, `chat-orchestration.service.ts`의 답변 스트림 시작 지점 **5곳**에 전달해야 합니다. 하나라도 빠뜨리면 특정 경로에서만 프롬프트가 안 먹습니다.

### 6-3. 협업자(`VIEWER`)도 승인·거절이 가능합니다

`collaborator_role` enum에 `VIEWER`밖에 없고, 스코핑이 `status = 'ACCEPTED'`만 보고 역할을 보지 않습니다. `unanswered-questions`와 같은 규칙이라 일관성은 있으나 의도된 것인지 확인이 필요합니다.

---

## 7. 머지 전 확인

1. **마이그레이션 번호** — 이 브랜치는 `0020`을 씁니다. CHA3-20도 `0020`을 쓰고 있어, 그쪽이 먼저 머지되면 파일과 `_journal.json`의 `idx`·`tag`를 `0021`로 바꿔야 합니다.
2. **CI 실패 3건은 이 변경과 무관합니다.** `development`에서도 동일하고, `src/upload`와 `src/organizations`는 한 줄도 건드리지 않았습니다.
   - `organizations.repository.spec.ts` 1건: 소스 파일 텍스트를 LF 기준으로 비교하는 테스트입니다. 해당 파일이 CRLF 1,507개·단독 LF 0개로 체크아웃되어 있고, 기대 문자열이 원본에는 없지만 CRLF를 LF로 바꾸면 찾아지는 것을 확인했습니다. Linux CI에서는 통과합니다.
   - `upload.service.spec.ts` 2건: `ForbiddenException` 기대인데 `BadRequestException`이 납니다. CHA3-16에 적힌 두 테스트와 이름까지 같습니다.
3. **diff 5,503줄 중 2,634줄은 drizzle 생성물입니다.** `drizzle/meta/0020_snapshot.json`(2,595줄)은 읽지 않아도 됩니다. 실제 리뷰 대상은 `src/suggested-questions/` 1,886줄입니다.
4. `SUGGESTED_QUESTIONS_ENABLED` 기본값이 `false`라 머지해도 운영 동작은 바뀌지 않습니다.

---

재현 방법은 `docs/cha3-21-local-testing.md`에 있습니다.
