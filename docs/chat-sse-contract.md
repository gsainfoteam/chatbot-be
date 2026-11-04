# 프론트엔드 전달용 채팅 API·SSE 계약

기준일: 2026-11-03. 대상: CHA3-17 통합 브랜치 `ikjun1101/cha3-17-web-search`의 현재 구현. 이 문서는 현재 지원하는 동작을 설명하며, 마지막 절의 후속 개선 후보는 아직 제공되는 계약이 아니다.

## 1. 먼저 알아야 할 규칙

1. **HTTP 200은 스트리밍 시작, `[DONE]`은 정상 완료**다. 본문 도착이나 `research` 단계의 `done`만으로 요청을 완료 처리하지 않는다.
2. 요청은 **POST + Bearer 인증**이다. 브라우저에서는 `fetch`의 응답 스트림을 소비한다. 기본 `EventSource`를 그대로 사용하는 방식은 이 요청 형태에 맞지 않는다.
3. 답변 조각은 덧붙이고, 진행 단계는 같은 `id`를 갱신한다. 참조 목록은 답변 뒤에 오며 없으면 이벤트가 생략된다.
4. **HTTP 오류, SSE 오류, 안내 답변, 연결 중단**은 서로 다르다. 아래 오류 처리 표를 따른다.
5. 자동 재접속·자동 재전송은 하지 않는다. 이어받기와 중복 방지 키가 없으며 재전송은 새 질문으로 처리될 수 있다.
6. 서버가 사용자/assistant 메시지를 저장한다. 스트리밍 API와 별도로 같은 메시지를 `POST /messages`에 저장하지 않는다.

## 2. 요청 API

모든 URL은 백엔드 API origin 기준이다. 아래 두 스트리밍 API는 같은 응답 형식을 사용한다.

| 용도             | Method / Path                                               | Body                                |
| ---------------- | ----------------------------------------------------------- | ----------------------------------- |
| 새 질문          | `POST /api/v1/widget/messages/chat/stream`                  | `{ "question": "..." }`             |
| BAD 답변 재생성  | `POST /api/v1/widget/messages/:messageId/regenerate/stream` | 없음                                |
| 히스토리         | `GET /api/v1/widget/messages?limit=20&cursor=<messageId>`   | 없음                                |
| 피드백 저장/변경 | `PUT /api/v1/widget/messages/:messageId/feedback`           | `{ "rating": "GOOD" }` 또는 `"BAD"` |

공통 인증:

```http
Authorization: Bearer <sessionToken>
```

새 질문 요청 예시:

```http
POST /api/v1/widget/messages/chat/stream
Authorization: Bearer <sessionToken>
Content-Type: application/json
Accept: text/event-stream
```

```json
{ "question": "GIST 창업 지원 제도를 알려줘." }
```

- `question`: 필수 문자열, 빈 문자열 불가, 최대 4,000자. FE는 공백만 있는 입력도 막는다. 추가 필드는 전역 DTO 검증에서 거절될 수 있다.
- 세션당 사용자 질문 최대 5개. FE에서 보내기 버튼 중복 클릭을 막고 같은 세션의 요청은 한 번에 하나만 진행한다.
- 거절·정보 부족 안내도 사용자 질문이 저장되므로 횟수를 사용한다. 오류/취소 역시 이미 저장된 사용자 질문의 횟수를 되돌리지 않는다.
- 토큰은 기존 `POST /api/v1/widget/auth/session`으로 발급한다. 응답의 `sessionToken`, `expiresIn`을 사용하고 만료 시 401을 처리한다. 새 세션은 기존 대화를 이어받는 토큰 갱신이 아니다.
- 현재 스트리밍 CORS 허용 origin은 `http://localhost:5173` 및 서버 `DOMAIN_NAME`으로 설정한 HTTPS origin이다. 위젯 키의 허용 도메인과 API CORS는 별도 확인 대상이다.

## 3. 전송 형식과 TypeScript 타입

정상 시작 응답:

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

각 프레임은 다음처럼 빈 줄로 끝난다. 예시의 줄바꿈은 실제 LF이며, JSON 문자열 안의 줄바꿈은 `\n`으로 이스케이프된다.

```text
data: {"content":"안녕하세요.\n"}

data: [DONE]

```

- `event:`, SSE 프레임의 `id:`, `retry:` 필드는 현재 보내지 않는다. 진행 JSON의 `id`는 SSE 재개용 ID가 아니다.
- `[DONE]`은 JSON이 아니다. JSON 파싱보다 먼저 비교한다.
- `reader.read()` 한 번의 결과가 프레임 하나라는 보장은 없다. 한 프레임이 여러 조각으로 나뉘거나 여러 프레임이 함께 도착할 수 있다.
- UTF-8 streaming decoder를 사용해 한글 경계를 보존하고, 빈 줄까지 모은 뒤 `data:`를 해석한다. LF/CRLF를 모두 처리하도록 구현하는 것을 권장한다.
- 알 수 없는 `type`과 추가 필드는 무시한다. 완성된 프레임의 JSON이 깨졌다면 프로토콜 오류로 취급하고 정상 완료로 표시하지 않는다.

```ts
type ResourceInfo = {
  path: string;
  formats: string[]; // 현재 채팅 참조 목록은 ["pdf"]
  url: string; // 절대 URL이 아닌 encodeURIComponent(path) 값
};

type NoticeSource = {
  kind: 'notice';
  id: string;
  title: string;
  url: string; // 절대 http(s) URL
};

type WebSource = {
  kind: 'web';
  id: string;
  title: string; // 현재는 출처 도메인
  url: string; // 절대 http(s) URL
  official: boolean;
};

type ResearchStep = {
  id: string;
  kind: string;
  label: string;
  status: 'running' | 'done' | 'failed';
  thought?: string;
  resultCount?: number;
};

type ChatSsePayload =
  | { content: string }
  | ({ type: 'step' } & ResearchStep)
  | { type: 'resources'; resources: ResourceInfo[] }
  | { type: 'sources'; sources: NoticeSource[] }
  | { type: 'web_sources'; sources: WebSource[] }
  | { error: string };

// [DONE]은 ChatSsePayload와 별도로 처리한다.
// 런타임 입력에는 추가 필드나 아직 모르는 type이 올 수 있다.
```

## 4. 이벤트별 계약

### 4.1 답변 조각 — content

```text
data: {"content":"GIST에는 **창업 지원 프로그램**이 있습니다.\n\n"}

```

`content`에는 `type`이 없다. 수신 문자열을 순서대로 누적하며 임의의 공백·줄바꿈을 추가하지 않는다. Markdown과 출처 링크가 여러 조각으로 갈라질 수 있으므로 누적 본문을 기준으로 렌더링한다.

공지/웹 인용 표지 `[cite:N]`는 BE가 등록된 제목·URL의 Markdown 링크로 변환한다. FE가 표지를 다시 해석하거나 링크를 추정하지 않는다. Markdown의 raw HTML은 비활성화하거나 정제하고, 외부 링크는 안전하게 처리한다.

개인정보·인용 처리를 위해 BE가 끝부분 약 128자 또는 미완성 번호/링크를 보류할 수 있다. 짧은 답변은 마지막에 한 번에 도착할 수 있다. 모델 토큰과 content 이벤트는 일대일이 아니다.

### 4.2 조사 진행 — step

```text
data: {"type":"step","id":"research","kind":"research","label":"자료를 더 찾아보고 있어요","status":"running"}

data: {"type":"step","id":"r1_call_1","kind":"search_notices","label":"Ziggle 공지를 찾고 있어요","status":"running","thought":"신청 기간을 확인할게요"}

data: {"type":"step","id":"r1_call_1","kind":"search_notices","label":"Ziggle 공지 3개를 불러왔어요","status":"done","thought":"신청 기간을 확인할게요","resultCount":3}

```

| 필드          | 의미와 표시 규칙                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | 요청 내 단계 키. 같은 id를 새 항목으로 추가하지 않고 갱신한다. 여러 질문에서 `research` 등 같은 값이 재사용되므로 요청별로 관리한다.    |
| `kind`        | 현재 `research`, `search_documents`, `search_notices`, `get_notice`, `search_web`. 알 수 없는 kind도 일반 진행 항목으로 표시할 수 있다. |
| `label`       | 표시할 진행 문구. FE가 도구명으로 문장을 다시 만들 필요가 없다.                                                                         |
| `status`      | 해당 단계의 상태. `done`은 검색/자료 수집이 끝났다는 뜻이며 전체 답변 완료가 아니다.                                                    |
| `thought`     | 선택적 행동 설명. 보조 문구로 표시하고 답변 본문에 합치지 않는다. 모델의 숨은 추론이 아니다.                                            |
| `resultCount` | 선택적 결과 수. 0도 유효하다. 답변 정확도나 전체 진행률로 환산하지 않는다.                                                              |

빠른 답변이나 범위 안내에서는 step이 아예 없을 수 있다. 공지 탐색 등으로 조사에 들어가면 답변 전에 발생한다. 독립적인 도구의 단계가 교차할 수 있어 고정된 순서를 가정하지 않는다. `failed` 단계 뒤에 다른 경로로 정상 답변할 수 있다.

### 4.3 내부 참고 문서 — resources

```text
data: {"type":"resources","resources":[{"path":"guide.pdf","formats":["pdf"],"url":"guide.pdf"}]}

```

- `path`는 표시할 문서명, `url`은 이미 URL 인코딩된 리소스 경로다. 예를 들어 `학사 안내.pdf`는 `%ED%95%99%EC%82%AC%20%EC%95%88%EB%82%B4.pdf`가 된다.
- 현재 채팅 참조는 상위 PDF 단위로 제공한다. 원본 PDF가 없는 텍스트 지식 문서는 목록에서 제외될 수 있다.
- 기존 리소스 센터 연동을 쓴다면 배포 환경의 리소스 endpoint prefix에 `url`을 붙인다. 이미 인코딩된 값을 다시 `encodeURIComponent`하지 않는다.
- BE 프록시를 쓸 수도 있다: `GET /api/v1/widget/messages/resources/<resource.url>`. 이 경로는 Bearer 인증이 필요하므로 일반 `<a href>`만으로 인증되지 않는다. 인증된 fetch로 받아 Blob URL을 표시하는 등의 기존 방식을 사용한다.
- 공지·웹 URL과 내부 리소스 URL의 조립 규칙을 혼용하지 않는다.
- 이 목록은 답변에 전달된 내부 PDF 후보다. 문장별 실제 인용을 추적한 목록은 아니다.

### 4.4 관련 공지 — sources

```text
data: {"type":"sources","sources":[{"kind":"notice","id":"42","title":"장학금 신청 안내","url":"https://ziggle.gistory.me/notice/42"}]}

```

`title`을 링크 문구로 쓰고 `url`을 그대로 연다. 리소스 센터 prefix를 붙이지 않는다. `id`는 문자열로 취급한다. 별도 카드의 중복 제거 키로는 URL을 사용할 수 있다.

### 4.5 웹 검색 출처 — web_sources

```text
data: {"type":"web_sources","sources":[{"kind":"web","id":"https://www.gist.ac.kr/example","title":"www.gist.ac.kr","url":"https://www.gist.ac.kr/example","official":true}]}

```

`official`은 설정된 학교 공식 도메인 여부이며 내용의 정확성이나 학교의 승인을 보증하지 않는다. false이면 외부 출처라는 점을 표시할 수 있다. 웹 기능을 껐거나 실제 인용이 없으면 이벤트가 오지 않는다.

공지·웹 목록은 최종 본문에서 실제로 인용한 등록 출처만 담는다. 상위 N개를 임의로 자르지 않는다. 본문 인용 링크와 별도의 출처 목록이 함께 존재할 수 있다. 출처 이벤트마다 해당 유형 목록을 설정하고, 이벤트가 없는 유형은 빈 목록으로 둔다.

### 4.6 정상 완료 — [DONE]

```text
data: [DONE]

```

본문 및 가능한 참조 목록 처리 후 전송한다. 요청 로딩을 종료하고 히스토리를 조회하여 저장된 메시지 ID와 metadata를 동기화한다. `step`의 id와 DB 메시지 ID는 다르다. 현재 SSE에는 최종 `messageId`가 없다.

### 4.7 스트리밍 오류 — error

```text
data: {"error":"답변 생성 중 오류가 발생했습니다."}

```

`error`에는 `type`이 없다. 오류를 받으면 실패 상태로 종료하고 DONE을 기다리지 않는다. 이 경로는 정상적으로 DONE을 보내지 않는다. 이미 받은 본문은 부분 답변으로 유지할 수 있지만 저장된 완성 답변으로 취급하지 않는다.

현재 페이로드는 문자열 하나뿐이며 `code`, `retryable`, `requestId`, `messageId`가 없다. 오류 문자열의 완전 일치나 영어 문구로 재시도 정책을 분기하지 않는다. 사용자에게는 FE의 일반 오류 안내를 표시하고, 서버 문자열은 진단용으로 취급하는 것을 권장한다.

## 5. 오류와 안내 응답 처리

### 5.1 HTTP 오류 — SSE 시작 전

먼저 `response.ok`를 확인한다. 실패 응답을 SSE 파서에 넣지 않는다. 일반적으로 JSON이지만 프록시/네트워크 오류 응답은 다른 형식일 수 있으므로 파싱 실패에 대비한다.

```ts
type HttpErrorBody = {
  statusCode?: number;
  message?: string | string[];
  error?: string;
  limit?: number;
};
```

| 상태              | 현재 발생 조건                                                    | FE 처리                                                                          |
| ----------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 400               | 빈 질문, 4,000자 초과, 잘못된 DTO/UUID. 재생성 조건 불충족도 포함 | 입력 또는 재생성 상태 확인. 같은 요청 자동 반복 금지                             |
| 401               | 세션 토큰 누락·오류·만료                                          | 세션 만료 안내 후 기존 세션 발급 흐름으로 이동. 질문 자동 재전송 금지            |
| 404               | 재생성 대상 메시지 또는 원래 질문이 현재 세션에 없음              | 히스토리 재조회, 해당 재생성 동작 종료                                           |
| 429 + `limit: 5`  | 질문 횟수 사전 검사에서 5회 소진                                  | 현재 세션 질문 한도 안내. 일시적 과부하와 구분                                   |
| 429, `limit` 없음 | 같은 세션의 동시 스트림, 요청 빈도 또는 동시 처리 한도            | 진행 중 요청을 기다리거나 나중에 수동 재시도. 정확한 재시도 시각은 제공되지 않음 |
| 5xx               | SSE 시작 전 서버/인프라 장애                                      | 일반 서비스 오류 표시, 자동 재전송 금지                                          |

질문 한도 오류 예시:

```json
{
  "statusCode": 429,
  "message": "이 세션에서는 최대 5개의 질문만 가능합니다.",
  "limit": 5
}
```

동시 요청 오류 예시:

```json
{
  "statusCode": 429,
  "message": "요청이 많습니다. 진행 중인 답변을 기다린 후 다시 시도해 주세요."
}
```

현재 BE는 이 제한에 대한 `Retry-After`를 별도로 설정하지 않는다. 제한은 프로세스 단위로 세션 동시 1개, IP 동시 3개/분당 20회, 전체 동시 32개다. FE는 숫자를 하드코딩해 서버의 허용 여부를 예측하지 않는다.

SSE 시작 후 DB에서 질문 한도 경합 등을 감지하면 HTTP 429로 바꿀 수 없어 SSE error 문자열로 전달될 수 있다. 상태 코드와 구조화된 `limit`을 모든 실패 경로에서 받을 수 있는 것은 아니다.

### 5.2 HTTP 200 이후의 오류·중단

| 관찰한 상태                              | 의미                                            | FE 처리                                                                |
| ---------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `error` 수신                             | 스트리밍/처리 실패                              | 로딩 종료, 일반 오류 안내, 부분 본문은 미완료로 표시                   |
| `error: "Failed to save message"`        | 저장 또는 응답 마무리 구간 실패                 | 같은 일반 오류 처리. 저장 여부를 단정하지 말고 히스토리 조회           |
| `error`에 다른 문자열 수신               | 답변 스트림 시작 전 검색·모델 호출 등 실패 가능 | 같은 일반 오류 처리. 원문 문자열을 코드처럼 해석하지 않음              |
| DONE 없이 EOF/네트워크 오류              | 비정상 중단, 서버 저장 여부 불명                | 로딩 종료, 미완료 표시, 히스토리 조회 후 수동 재시도                   |
| FE가 직접 abort                          | 사용자 중단                                     | 실패 경고 대신 중단 상태 표시. 후속 이벤트를 현재 요청에 적용하지 않음 |
| HTTP 200이지만 Content-Type이 SSE가 아님 | 프록시/서버 응답 불일치 가능                    | 프로토콜 오류로 처리                                                   |

오류 시 남은 `running` 단계도 UI에서 종료/중단 표시로 정리한다. 이는 FE의 표시 상태이며 BE `status` enum에 `cancelled`를 추가한 것은 아니다.

### 5.3 일반 content로 오는 안내 — error가 아님

다음 경우는 현재 **일반 content → [DONE]**으로 끝난다. 메시지로 저장되며 질문 횟수도 사용한다.

| 상황                         | 현재 응답 예시/행동                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 범위 밖·민감정보·우회 요청   | `GIST의 학사·공지·시설·학교생활에 관한 질문을 도와드릴 수 있어요. 개인의 민감정보 요청이나 학교와 무관한 작업은 도와드리기 어려워요.` |
| 범위 판정 최종 실패/타임아웃 | `일시적으로 요청을 처리하지 못했어요. 잠시 후 같은 질문으로 다시 시도해 주세요.`                                                      |
| 근거 부족                    | 확인 가능한 정보가 부족하다는 일반 답변. 문구는 모델 응답에 따라 달라짐                                                               |
| 부분 답변/원문 확인 필요     | 확인된 부분만 답하거나 이미지 공지 등 원문 확인을 안내                                                                                |

범위 판정은 호출당 30초, 타임아웃일 때만 한 번 재시도한다. 실패한 첫 호출의 서버 로그가 있어도 두 번째 판정이 성공하면 정상 답변이 이어질 수 있다.

안내 종류를 구분하는 전용 SSE 이벤트가 없으므로 FE는 문구 일치로 거절/장애 상태를 추정하지 않고 본문으로 표시한다. 별도 배너나 재시도 버튼을 상태별로 제어하려면 BE의 구조화된 결과 계약을 추가해야 한다.

## 6. 요청 생명주기와 재시도

FE 권장 상태: `idle → waiting → researching / streaming → completed | failed | cancelled`.

- 요청 직후부터 기본 로딩을 표시한다. 범위 판정/첫 검색에는 step이 없고 **heartbeat도 없다**. 헤더 또는 첫 이벤트가 늦을 수 있으므로 무응답 10초만으로 실패 판정하지 않는다. 현재 전체 요청에 대한 고정 완료 시간 보장은 없다.
- step 수신 시 진행 목록을 표시한다. research done 이후에도 답변 생성·저장이 남아 있다.
- content 수신 시 본문을 누적한다. content가 끝난 것처럼 보여도 출처와 DONE을 기다린다.
- error 또는 DONE 수신으로 해당 요청을 종료 처리한다. 종료 처리 이후 추가 콜백은 무시한다.
- 요청마다 로컬 요청 키와 `AbortController`를 둔다. 중단한 이전 요청의 콜백이 새 답변에 섞이지 않도록 한다.
- 사용자 중단 시 fetch를 abort한다. BE도 연결 종료를 감지해 취소를 시도하지만 이미 진행된 호출의 비용·DB 저장이 되돌려지는 것은 아니다.
- `Last-Event-ID` 기반 재개, 이전 토큰부터 이어받기, idempotency key는 지원하지 않는다.
- 수동 재시도 전에 히스토리를 확인한다. 실패/연결 끊김 후에도 사용자 질문이나 완성 답변이 저장됐을 수 있다. 현재는 SSE에 messageId가 없어 동일 문장·동시 탭 상황의 정확한 매칭에 한계가 있다.
- 질문 재전송은 새 사용자 메시지와 추가 횟수를 만들 수 있다. 횟수 우회를 위해 새 세션을 자동 발급하지 않는다.

## 7. 히스토리·피드백·재생성

히스토리 응답은 최신순이며, 과거 페이지는 `nextCursor`로 조회한다. 아래는 구조 예시다.

```json
{
  "messages": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "role": "assistant",
      "content": "저장된 답변 본문",
      "metadata": {
        "steps": [
          {
            "id": "research",
            "kind": "research",
            "label": "자료 2개를 모았어요",
            "status": "done",
            "resultCount": 2
          }
        ],
        "resources": [
          { "path": "guide.pdf", "formats": ["pdf"], "url": "guide.pdf" }
        ],
        "sources": [
          {
            "kind": "notice",
            "id": "42",
            "title": "장학금 신청 안내",
            "url": "https://ziggle.gistory.me/notice/42",
            "opened": true
          }
        ]
      },
      "feedback": null,
      "createdAt": "2026-11-03T00:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

| 실시간 이벤트  | 히스토리 필드                            |
| -------------- | ---------------------------------------- |
| 누적 `content` | `message.content`                        |
| `step`         | `metadata.steps` (최종 상태,`type` 없음) |
| `resources`    | `metadata.resources`                     |
| `sources`      | `metadata.sources`                       |
| `web_sources`  | **`metadata.webSources`** (camelCase)    |

- metadata와 각 배열은 없을 수 있다. 오래된 메시지에서도 기본 본문을 표시할 수 있어야 한다.
- 저장된 출처에는 `opened` 등 실시간 이벤트에 없는 추가 필드가 있을 수 있다. 표시의 필수 조건으로 삼지 않는다.
- `model`, `usage`, `evaluation`은 추가 metadata다. `evaluation`에는 범위/종료 이유/시간/사용량 진단이 있으며 화면의 정답 점수로 쓰지 않는다. 범위 판정 실패도 현재 `outcome`상 `scope-refused`로 묶일 수 있으므로 운영 진단은 `scope`, `scopeFailure`도 함께 확인한다.
- 스트리밍에서는 model/usage/evaluation 전용 이벤트를 제공하지 않는다.
- DONE 후 저장된 assistant의 `id`를 얻어 GOOD/BAD 피드백을 보낸다. ID 확인 전에는 피드백 동작을 비활성화한다.
- 재생성은 BAD 피드백을 받은 원본 assistant 답변에 1회만 허용한다. 원본을 덮어쓰지 않고 새 assistant 메시지를 저장하며 `metadata.regeneratedFromMessageId`, `regeneratedFromFeedback: "BAD"`로 연결한다.
- 재생성은 사용자 질문을 추가 저장하지 않아 5회 제한을 추가 소모하지 않는다. 동일 세션 동시 요청 제한은 적용된다.
- 현재 재생성 기회는 스트리밍 시작 전에 선점한다. 이후 오류/취소, 심지어 admission 429가 발생해도 선점이 남을 수 있다. 실패 시 자동 재생성을 반복하지 말고 히스토리를 다시 조회한다.

## 8. 전체 스트림 예시

다음은 형식 설명용 예시이며 실제 행사/공지 내용이 아니다.

```text
data: {"type":"step","id":"research","kind":"research","label":"자료를 더 찾아보고 있어요","status":"running"}

data: {"type":"step","id":"r1_call_1","kind":"search_notices","label":"Ziggle 공지를 찾고 있어요","status":"running"}

data: {"type":"step","id":"r1_call_1","kind":"search_notices","label":"Ziggle 공지 1개를 불러왔어요","status":"done","resultCount":1}

data: {"type":"step","id":"research","kind":"research","label":"자료 1개를 모았어요","status":"done","resultCount":1}

data: {"content":"장학금 신청 안내를 확인했어요. "}

data: {"content":"[공지 원문](https://ziggle.gistory.me/notice/42)을 참고해 주세요."}

data: {"type":"sources","sources":[{"kind":"notice","id":"42","title":"공지 원문","url":"https://ziggle.gistory.me/notice/42"}]}

data: [DONE]

```

빠른 경로에서는 step 없이 content부터 시작할 수 있다. 현재 성공 경로의 목록 전송 순서는 resources → sources → web_sources → DONE이며 빈 목록은 생략한다. FE는 각 목록이 반드시 존재하거나 셋 모두 함께 온다고 가정하지 않는다.

## 9. FE 인수 확인 항목

- [ ] 일반 답변이 step 없이 시작해도 표시된다.
- [ ] 같은 step id가 갱신되고, 새 질문의 같은 id와 섞이지 않는다.
- [ ] research done과 개별 도구 failed를 전체 요청 완료/실패로 오인하지 않는다.
- [ ] UTF-8 한글·JSON·Markdown 링크가 임의의 네트워크 경계에서 나뉘어도 복원된다.
- [ ] 내부 문서의 인코딩 경로와 공지/웹 절대 URL을 각각 올바르게 연다.
- [ ] 웹의 official 표시와 히스토리 webSources 복원이 동작한다.
- [ ] HTTP 400/401/429, SSE error, DONE 없는 EOF, 사용자 abort를 구분한다.
- [ ] 범위 거절·일시적 판정 실패의 일반 content도 메시지로 표시한다.
- [ ] 실패/취소 후 무한 로딩과 이전 요청의 늦은 콜백이 남지 않는다.
- [ ] 질문/assistant 메시지를 별도로 중복 저장하거나 자동 재전송하지 않는다.
- [ ] DONE 후 히스토리에서 메시지 ID를 얻은 다음 피드백·재생성을 제공한다.

## 10. 현재 계약에 없는 기능과 후속 개선 후보

다음은 FE가 존재한다고 가정하면 안 되는 항목이다. 필요하면 별도 BE 작업으로 계약을 확장한다.

| 미지원 항목                                | 필요해지는 이유                                         |
| ------------------------------------------ | ------------------------------------------------------- |
| 안정적인 오류 `code`, `retryable`, 요청 ID | 오류별 화면·재시도 정책, 운영 추적                      |
| 최종 messageId 및 구조화된 결과 이벤트     | 히스토리 재조회 없이 피드백 연결, 거절/서비스 장애 구분 |
| 범위 판정 진행 이벤트·heartbeat            | 첫 이벤트까지의 대기 표시와 연결 상태 확인              |
| 재연결/이어받기·중복 방지 키               | 중단 후 안전한 재요청                                   |
| 실패한 재생성의 선점 해제/명확한 잔여 횟수 | 장애 이후 재생성 UX                                     |
| 별도 되묻기 이벤트                         | 질문 대상을 확인하는 전용 UI                            |

## 구현 근거

- [SSE 출력과 종료](../src/chat/services/chat-stream.transport.ts)
- [메시지 저장·출처·오류 처리](../src/chat/services/chat-orchestration.service.ts)
- [요청·피드백·재생성 API](../src/chat/chat.controller.ts)
- [세션 인증](../src/auth/guards/widget-session.guard.ts)
- [요청 제한](../src/chat/safety/chat-admission.ts)
- [범위 판정과 안내 문구](../src/chat/safety/gist-scope.policy.ts)
- [내부 문서 URL](../src/chat/services/resource-content.service.ts)
- [재생성 선점·히스토리](../src/chat/services/chat.service.ts)
- [로컬 실행·테스트 방법](cha3-17-local-testing.md)
