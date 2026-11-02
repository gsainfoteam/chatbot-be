# 채팅 스트리밍(SSE) 계약

> 대상: chatbot-fe(웹 위젯), chatbot-package(Flutter)
> 기준 코드: `chatbot-be` CHA3-17 1~3단계 + Gate 보완 + 웹 검색(실험) (2026-10-27)
> 관련 코드: `src/chat/services/chat-stream.transport.ts`, `src/chat/services/chat-orchestration.service.ts`, `src/chat/agent/**`

이 문서는 답변 스트리밍 API가 보내는 이벤트의 형식, 순서, 의미를 정리합니다. 기존 이벤트(`content`, `resources`, `error`, `[DONE]`)는 바뀌지 않았고, `step`, `sources`, `web_sources` 세 이벤트가 새로 추가됐습니다.

---

## 1. 한눈에 보기

| 이벤트 | 식별 방법 | 언제 오는가 | 새로 추가됨 | 들어간 단계 |
|---|---|---|---|---|
| 답변 조각 | `content` 키가 있음 | 답변 생성 중 여러 번 | 아니오 | - |
| 진행 단계 | `type === "step"` | 에이전트 재탐색을 할 때만, 답변보다 먼저 | **예** | 2단계 (PR #68) |
| 참조 문서 | `type === "resources"` | 답변이 끝난 뒤 0~1번 | 아니오 | - |
| 관련 공지 | `type === "sources"` | 답변이 끝난 뒤 0~1번 | **예** | 3단계 |
| 웹 검색 출처 | `type === "web_sources"` | 답변이 끝난 뒤 0~1번 | **예** | 웹 검색 (실험) |
| 오류 | `error` 키가 있음 | 실패 시 1번, 이후 스트림 종료 | 아니오 | - |
| 종료 | 데이터가 문자열 `[DONE]` | 정상 종료 시 1번 | 아니오 | - |

**하위 호환**: `step`·`sources`·`web_sources` 이벤트에는 `content`·`error` 키가 절대 들어가지 않습니다. 이 두 키와 `type: "resources"`만 처리하는 현재 웹 위젯(`src/api/widgetChat.ts`)과 Flutter 패키지(`chat_api_client.dart`)는 새 이벤트를 그냥 무시하므로, FE를 고치기 전에 BE를 먼저 배포해도 됩니다.

---

## 2. 엔드포인트

| 메서드 | 경로 | 요청 본문 | 비고 |
|---|---|---|---|
| `POST` | `/api/v1/widget/messages/chat/stream` | `{ "question": string }` | 일반 질문 |
| `POST` | `/api/v1/widget/messages/:messageId/regenerate/stream` | 없음 | BAD 피드백 답변을 1회 재생성. 이벤트 형식은 위와 같음 |

- 인증: 위젯 세션 Bearer 토큰 (`Authorization: Bearer <session token>`)
- 응답 헤더: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`

### 스트림을 열기 전의 HTTP 오류

아래 오류는 SSE가 시작되기 전에 일반 HTTP 응답(JSON)으로 옵니다. 이 경우 스트림 이벤트는 오지 않습니다.

| 상태 | 엔드포인트 | 의미 |
|---|---|---|
| 401 | 공통 | 세션 인증 실패 |
| 429 | `chat/stream` | 세션당 질문 횟수 초과. 본문 `{ statusCode: 429, message, limit: 5 }` |
| 400 | `regenerate/stream` | BAD 피드백이 아니거나 이미 재생성한 답변 |
| 404 | `regenerate/stream` | 현재 세션에서 접근할 수 없는 메시지 |

스트림이 일단 시작되면(HTTP 200) 그 뒤의 모든 오류는 `error` 이벤트로 옵니다(4.6 참고).

---

## 3. 프레이밍

```
data: <JSON 또는 [DONE]>\n
\n
```

- 이벤트 하나는 `data: `로 시작하는 한 줄과 빈 줄 하나로 이루어집니다. `event:`, `id:`, `retry:` 필드는 쓰지 않습니다.
- JSON은 한 줄로 직렬화되며 내부에 줄바꿈이 없습니다. 답변 텍스트의 줄바꿈은 `\n` 이스케이프로 들어갑니다.
- 네트워크 청크 경계가 이벤트 경계와 맞지 않을 수 있으니 줄 단위로 버퍼링해서 읽어야 합니다(현재 FE 구현과 같습니다).
- 하트비트(주석 줄 `:`)는 보내지 않습니다. 에이전트가 조사하는 동안에는 `step` 이벤트가 사실상 진행 신호 역할을 합니다(7.3 참고).

---

## 4. 이벤트 상세

FE에서 바로 쓸 수 있는 타입 정의입니다.

```ts
type ChatStreamEvent =
  | ContentEvent
  | StepEvent
  | ResourcesEvent
  | SourcesEvent
  | WebSourcesEvent
  | ErrorEvent
  | '[DONE]';

interface ContentEvent {
  content: string; // 답변 조각. 순서대로 이어 붙인다.
}

interface StepEvent {
  type: 'step';
  id: string; // 같은 id면 같은 단계. 상태가 바뀔 때마다 같은 id로 다시 온다.
  kind:
    | 'research'
    | 'search_documents'
    | 'search_notices'
    | 'get_notice'
    | 'search_web'
    | string;
  label: string; // 서버가 만든 진행 문구 (한국어 해요체)
  status: 'running' | 'done' | 'failed';
  thought?: string; // 모델이 남긴 짧은 설명. 도구 단계에만 있다.
  resultCount?: number; // done일 때만 있다.
}

interface ResourcesEvent {
  type: 'resources';
  resources: Array<{
    path: string; // 예: "2026년+학사편람.pdf"
    formats: string[]; // 현재는 항상 ["pdf"]
    url: string; // encodeURIComponent(path). 리소스 센터 경로 조각이다.
  }>;
}

interface SourcesEvent {
  type: 'sources';
  sources: Array<{
    kind: 'notice'; // Ziggle 공지만 들어간다. 웹 검색 결과는 web_sources로 따로 온다.
    id: string; // Ziggle 공지 id (문자열)
    title: string; // 공지 제목
    url: string; // 그대로 여는 외부 절대 URL. 예: https://ziggle.gistory.me/notice/223132
  }>;
}

interface WebSourcesEvent {
  type: 'web_sources';
  sources: Array<{
    kind: 'web';
    id: string; // 출처 URL과 같다
    title: string; // 도메인. 예: "dorm.gist.ac.kr"
    url: string; // 그대로 여는 외부 절대 URL
    official: boolean; // 학교 공식 도메인(gist.ac.kr과 하위 도메인)인지
  }>;
}

interface ErrorEvent {
  error: string;
}
```

> 앞으로 도구가 늘면 `kind`도 늘어납니다. 모르는 `kind`도 `label`만으로 보여줄 수 있게 만들어 주세요.

### 4.1 `content`: 답변 조각

```json
{"content":"'한국장학재단 2026년 2학기 국가장학금 신청자 가구원 동의 안내' 공지 기준으로,"}
```

- 순서대로 이어 붙이면 전체 답변이 됩니다. 조각 단위는 모델 토큰 단위라 일정하지 않습니다.
- 답변은 제한된 마크다운입니다: `**굵게**`, `*기울임*`, `` `코드` ``, `#`/`##`/`###` 제목, 그리고 **출처 인용 링크**. 표·인용은 쓰지 않도록 프롬프트로 막고 있습니다.
- **출처 인용 링크**: 공지나 웹 검색 결과를 근거로 한 문장은 출처를 마크다운 링크로 밝힙니다.
  - 공지: `[2026년 2학기 국가장학금 신청 안내](https://ziggle.gistory.me/notice/200280) 공지에 따르면`
  - 웹: `[gistnews.co.kr](https://gistnews.co.kr/?p=6913)에 따르면` (공식 출처가 아니면 공식 안내로 다시 확인하라는 문장이 붙습니다)
  - 링크 주소는 같은 답변의 `sources`·`web_sources`에 있는 `url`과 같습니다. 서버가 자료에 실제 주소를 넣고 "그대로 쓰라"고 지시하지만 모델이 쓰는 글이라, 표시 전에 별도 검증은 하지 않습니다.
  - 웹 출처의 실제 주소를 시간 안에 풀지 못하면 링크 없이 도메인만 씁니다(구글 리다이렉트 링크는 시간이 지나면 만료되기 때문).
  - 외부 링크라 새 탭으로 여는 것을 권장합니다. 내부 문서(`resources`)는 본문에 링크로 넣지 않습니다.

### 4.2 `step`: 진행 단계 (신규)

```json
{"type":"step","id":"r1_call_8Hk2","kind":"search_notices","label":"Ziggle 공지 1개를 불러왔어요","status":"done","thought":"국가장학금 가구원 동의 기한을 공지에서 확인해 볼게요","resultCount":1}
```

#### 언제 오는가

질문은 아래 두 경로 중 하나로 처리됩니다. `step`은 **에이전트 경로에서만** 옵니다.

| 경로 | 조건 | step 이벤트 |
|---|---|---|
| 빠른 경로 | 첫 문서 검색이 강하게 맞음 (문서로 답할 수 있는 대부분의 질문) | 없음. 지금처럼 바로 `content`가 온다 |
| 에이전트 경로 | 첫 검색이 비었거나 약함, 또는 공지가 필요해 보이는 질문(공지를 켠 위젯만) | 답변 전에 여러 개 |
| 빠른 경로 → 재시도 | 빠른 경로로 만든 답변이 "현재 확인 가능한 정보가 없어…"로 시작함 | 그 답변은 **클라이언트에 보내지 않고 버린 뒤** 에이전트 경로와 똑같이 `step`이 온다 |

- 서버에서 `AGENT_ENABLED=false`(기본값)이면 항상 빠른 경로라 `step`이 오지 않습니다.
- 첫 검색의 신뢰도를 계산할 때 질문 속 학교 이름(GIST·지스트·광주과학기술원)은 뺍니다. 그래서 "GIST 안강훈 교수"처럼 문서에 없는 사람·시설 질문은 에이전트 경로로 갑니다.
- 재시도의 경우 첫 `step`이 오기 전까지 **2~4초 정도 아무 이벤트도 오지 않을 수** 있습니다(버려진 첫 답변을 만드는 시간).

#### 필드

| 필드 | 설명 |
|---|---|
| `id` | 단계 식별자. 조사 전체 단계는 항상 `"research"`, 도구 단계는 `"r{라운드}_{도구 호출 id}"` 형태입니다. 형식에 의존하지 말고 불투명한 문자열로 다뤄 주세요. |
| `kind` | `research`(조사 전체를 감싸는 단계) 또는 도구 이름 |
| `label` | 서버가 만든 진행 문구. **화면에 그대로 보여주는 주 문구**입니다. 상태가 바뀌면 문구도 바뀝니다. |
| `status` | `running` → `done` 또는 `failed` |
| `thought` | 모델이 도구를 부를 때 남긴 해요체 한 문장(30자 안팎). 도구 단계에만 있고 `running`과 `done`/`failed`에 같은 값이 들어갑니다. 모델이 쓴 문장이라 끝에 마침표가 있거나 없을 수 있고, 서버가 80자에서 자릅니다. 모델이 `reason`을 비우면 키 자체가 없습니다. 보조 문구로만 써 주세요. |
| `resultCount` | `done`일 때만 있습니다. 조사 전체 단계는 모은 자료 수, `search_documents`는 찾은 문서 수, `search_notices`는 찾은 공지 수(최대 6), `get_notice`는 본문을 읽었으면 1, 못 읽었으면 0, `search_web`은 근거 출처가 붙은 문장 수입니다. |

#### 상태 전이와 순서 보장

```
research:running
  ├─ (도구 단계 A) running → done|failed
  ├─ (도구 단계 B) running → done|failed      ← 같은 라운드의 도구는 병렬이라 A/B 이벤트가 섞여 올 수 있다
  └─ (다음 라운드 도구 단계들) …
research:done|failed                           ← 항상 마지막 step
content …                                      ← 답변은 research가 닫힌 뒤 시작
```

- `research` 단계는 **항상 가장 먼저 열리고 가장 마지막에 닫힙니다**. 첫 도구 호출 전 LLM 대기(2~6초)에도 진행 상태를 보여주기 위한 단계입니다.
- 도구 단계 하나는 `running` 1번 후 `done`이나 `failed` 1번, 총 2번 옵니다.
- 같은 라운드에서 여러 도구가 병렬로 실행되면 `running` 여러 개가 먼저 오고 `done`이 나중에 섞여 옵니다. **반드시 `id` 기준으로 갱신**해 주세요.
- 라운드는 최대 3번이고, 한 라운드에 도구는 최대 4개입니다. 실제로는 보통 도구 단계 1~5개가 옵니다.
- 같은 검색 반복, 잘못된 인자, 허용되지 않은 도구, 한 라운드 5번째 이후의 호출은 실행되지 않고 step도 오지 않습니다.
- 에이전트가 예상치 못한 예외로 끝나면 `running`인 단계는 `failed`로 닫혀서 옵니다. 이 경우 `label`은 바뀌지 않습니다. 답변은 첫 검색 결과로 이어서 생성됩니다.

#### `label` 문구 목록

`{query}`와 `{title}`은 30자를 넘으면 잘리고 끝에 `…`가 붙습니다.

| kind | running | done (결과 있음) | done (결과 없음) | failed |
|---|---|---|---|---|
| `research` | `자료를 더 찾아보고 있어요` | `자료 {n}개를 모았어요` | `관련 자료를 찾지 못했어요` | (running 문구 그대로) |
| `search_documents` | `'{query}' 문서를 찾고 있어요` | `'{query}' 관련 문서 {n}개를 찾았어요` | `'{query}'로는 / '{query}'으로는 문서를 찾지 못했어요`¹ | `'{query}' 문서 검색에 실패했어요` |
| `search_notices` | `Ziggle에서 '{k1}', '{k2}' 공지를 찾고 있어요` | `Ziggle 공지 {n}개를 불러왔어요` | `Ziggle에서 관련 공지를 찾지 못했어요` | `Ziggle 공지를 불러오지 못했어요` |
| `get_notice` | `'{title}' 공지를 읽고 있어요` | `'{title}' 공지를 확인했어요` | `'{title}' 공지 본문을 읽지 못해 요약을 참고할게요`² | `'{title}' 공지 본문을 불러오지 못했어요` |
| `search_web` | `웹에서 '{query}'를 / '{query}'을 찾고 있어요`³ | `웹에서 관련 내용 {n}건을 찾았어요` | `웹에서 근거 있는 내용을 찾지 못했어요` | `웹 검색에 실패했어요` |

¹ 받침에 따라 서버가 `로`/`으로`를 고릅니다. 한글로 끝나지 않으면 `(으)로`를 씁니다.
² 본문이 이미지뿐인 공지입니다(학사공지의 약 1/3). 제목과 링크는 답변 자료로 남습니다. 검색 결과에 없던 id를 읽으려 한 경우에도 이 문구가 나옵니다.

³ 받침에 따라 `을`/`를`을 고르고, 한글로 끝나지 않으면 `을(를)`을 씁니다.

`get_notice`에서 제목을 모르면 `'{title}' 공지` 대신 `공지`만 씁니다. 예: `공지 본문을 불러오지 못했어요`

### 4.3 `resources`: 참조 문서 (기존과 같음)

```json
{"type":"resources","resources":[{"path":"2026년+학사편람.pdf","formats":["pdf"],"url":"2026%EB%85%84%2B%ED%95%99%EC%82%AC%ED%8E%B8%EB%9E%8C.pdf"}]}
```

- 리소스 센터에 있는 PDF만 들어갑니다. 관리자가 직접 입력한 텍스트 지식은 원본 PDF가 없어 빠집니다.
- 지금처럼 `url` 앞에 리소스 센터 주소(`${VITE_RESOURCE_CENTER_URL}/resource/`)를 붙여 쓰면 됩니다.
- 답변이 "답변 불가" 문장이면 보내지 않습니다.
- **외부 링크는 이 이벤트에 절대 넣지 않습니다.** FE가 url 앞에 리소스 센터 주소를 붙이기 때문입니다. 외부 링크는 `sources`(공지)와 `web_sources`(웹)로 갑니다.

### 4.4 `sources`: 관련 공지 (신규, 3단계)

```json
{"type":"sources","sources":[{"kind":"notice","id":"223132","title":"[학사] 한국장학재단 2026년 2학기 국가장학금 신청자 가구원 동의 안내","url":"https://ziggle.gistory.me/notice/223132"}]}
```

- Ziggle 공지만 들어갑니다. 웹 검색 결과는 `web_sources`로 따로 옵니다.
- `url`은 **그대로 여는 외부 절대 URL**입니다. 앞에 아무것도 붙이지 마세요. 새 탭으로 여는 것을 권장합니다.
- 최대 3개이고, 본문까지 읽은 공지가 먼저 옵니다.
- 공지 링크는 Ziggle 웹으로 열리며 Ziggle 로그인이 필요할 수 있습니다.
- 답변이 "답변 불가" 문장이면 보내지 않습니다.
- `resources`·`sources`·`web_sources`는 각각 오거나 안 올 수 있습니다. 오면 항상 `resources` → `sources` → `web_sources` 순서입니다.

### 4.5 `web_sources`: 웹 검색 출처 (신규, 실험)

```json
{"type":"web_sources","sources":[{"kind":"web","id":"https://dorm.gist.ac.kr/guide","title":"dorm.gist.ac.kr","url":"https://dorm.gist.ac.kr/guide","official":true}]}
```

- 에이전트가 웹 검색(`search_web`)을 했고 답변에 쓸 근거가 있었을 때만 옵니다. 서버에서 웹 검색을 켜지 않으면(`WEB_SEARCH_ENABLED=false`, 기본값) 절대 오지 않습니다.
- `sources`(공지)와 따로 최대 3개입니다. 공식 도메인 출처가 먼저 옵니다.
- `title`은 페이지 제목이 아니라 **도메인**입니다(구글 그라운딩이 페이지 제목을 주지 않습니다).
- `official`이 `false`인 출처는 뉴스·블로그·SNS 등 학교 공식 안내가 아닐 수 있으니, "공식"/"비공식" 배지처럼 구분해서 보여주는 것을 권장합니다.
- 답변이 "답변 불가" 문장이면 보내지 않습니다.

### 4.6 `error`: 오류

```json
{"error":"Failed to process user question: ..."}
```

- `error` 이벤트를 보낸 직후 서버가 연결을 닫습니다. **`[DONE]`은 오지 않습니다.**
- 메시지는 내부 오류 문자열이라 사용자에게 그대로 보여주지 말고, 공통 오류 문구로 바꿔 주세요.

| 상황 | 그 전에 온 이벤트 | 메시지 저장 |
|---|---|---|
| 질문 처리(검색·조사) 중 실패 | `step`이 일부 왔을 수 있음 | 저장 안 됨 |
| 답변 스트리밍 도중 LLM 스트림 오류 | `content` 일부 | 저장 안 됨 |
| 답변은 끝났는데 저장 실패 | `content` 전체 | 저장 안 됨. `{"error":"Failed to save message"}` |

### 4.7 `[DONE]`: 정상 종료

`data: [DONE]` 뒤에 서버가 연결을 닫습니다. JSON이 아니니 파싱 전에 먼저 비교해 주세요.

---

## 5. 이벤트 순서

```
[에이전트 경로일 때만]  step × N  (research:running 으로 시작, research:done|failed 로 끝)
                        content × M
[답변이 됐을 때만]      resources (0~1)
[답변이 됐을 때만]      sources   (0~1)
[답변이 됐을 때만]      web_sources (0~1)
                        [DONE]
```

### 5.1 예시: 빠른 경로 (가장 흔함)

```
data: {"content":"졸업하려면 "}

data: {"content":"총 130학점 이상을 이수해야 해요."}

data: {"type":"resources","resources":[{"path":"2026년+학사편람.pdf","formats":["pdf"],"url":"2026%EB%85%84%2B%ED%95%99%EC%82%AC%ED%8E%B8%EB%9E%8C.pdf"}]}

data: [DONE]
```

### 5.2 예시: 에이전트 경로 + Ziggle 공지

질문: "국가장학금 가구원 동의 언제까지 해야 돼?" (실제 실행 로그를 바탕으로 재구성)

```
data: {"type":"step","id":"research","kind":"research","label":"자료를 더 찾아보고 있어요","status":"running"}

data: {"type":"step","id":"r1_call_a","kind":"search_notices","label":"Ziggle에서 '국가장학금', '가구원' 공지를 찾고 있어요","status":"running","thought":"국가장학금 가구원 동의 기한을 공지에서 확인해 볼게요"}

data: {"type":"step","id":"r1_call_a","kind":"search_notices","label":"Ziggle 공지 1개를 불러왔어요","status":"done","thought":"국가장학금 가구원 동의 기한을 공지에서 확인해 볼게요","resultCount":1}

data: {"type":"step","id":"research","kind":"research","label":"자료 1개를 모았어요","status":"done","resultCount":1}

data: {"content":"**'한국장학재단 2026년 2학기 국가장학금 신청자 가구원 동의 안내' 공지 기준으로,** "}

data: {"content":"가구원 동의 미완료자는 **10월 30일(목) 18시까지** 한국장학재단 홈페이지에서 동의를 완료하면 됩니다."}

data: {"type":"sources","sources":[{"kind":"notice","id":"223132","title":"[학사] 한국장학재단 2026년 2학기 국가장학금 신청자 가구원 동의 안내","url":"https://ziggle.gistory.me/notice/223132"}]}

data: [DONE]
```

### 5.3 예시: 에이전트 경로에서 병렬 도구 호출

같은 라운드의 두 도구가 동시에 돌기 때문에 `running` 두 개가 먼저 옵니다.

```
data: {"type":"step","id":"research",…,"status":"running"}
data: {"type":"step","id":"r1_call_x","kind":"search_documents","label":"'인재림 장학생' 문서를 찾고 있어요","status":"running",…}
data: {"type":"step","id":"r1_call_y","kind":"search_notices","label":"Ziggle에서 '인재림' 공지를 찾고 있어요","status":"running",…}
data: {"type":"step","id":"r1_call_x",…,"label":"'인재림 장학생'으로는 문서를 찾지 못했어요","status":"done","resultCount":0}
data: {"type":"step","id":"r1_call_y",…,"label":"Ziggle 공지 1개를 불러왔어요","status":"done","resultCount":1}
data: {"type":"step","id":"r2_call_z","kind":"get_notice","label":"'[학사] 인재림 제7기 장학생 선발 모집 안…' 공지를 읽고 있어요","status":"running",…}
data: {"type":"step","id":"r2_call_z",…,"label":"'[학사] 인재림 제7기 장학생 선발 모집 안…' 공지 본문을 읽지 못해 요약을 참고할게요","status":"done","resultCount":0}
data: {"type":"step","id":"research",…,"label":"자료 1개를 모았어요","status":"done","resultCount":1}
data: {"content":"'인재림 제7기 장학생 선발 모집 안내' 공지가 올라와 있지만, 본문이 이미지로만 되어 있어 …"}
data: {"type":"sources","sources":[{"kind":"notice","id":"224205","title":"[학사] 인재림 제7기 장학생 선발 모집 안내","url":"https://ziggle.gistory.me/notice/224205"}]}
data: [DONE]
```

### 5.4 예시: 자료를 끝내 찾지 못함

```
data: {"type":"step","id":"research",…,"status":"running"}
data: …(검색어를 바꿔 가며 도구 단계 2~3개)…
data: {"type":"step","id":"research","kind":"research","label":"관련 자료를 찾지 못했어요","status":"done","resultCount":0}
data: {"content":"질문에 해당하는 문서를 찾지 못해 답변드리기 어렵습니다. …"}
data: [DONE]
```

`resources`·`sources`·`web_sources`는 오지 않습니다.

---

## 6. 히스토리: 저장되는 metadata

`GET /api/v1/widget/messages`(cursor 페이징)가 돌려주는 assistant 메시지의 `metadata`에 같은 정보가 저장됩니다. 대화를 다시 열었을 때 진행 과정과 출처를 다시 그릴 수 있습니다.

```ts
interface AssistantMessageMetadata {
  model?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  resources?: ResourcesEvent['resources']; // SSE와 같은 형식
  sources?: Array<SourcesEvent['sources'][number] & { opened: boolean }>; // SSE 형식 + opened
  webSources?: Array<WebSourcesEvent['sources'][number] & { opened: boolean }>; // SSE 형식 + opened(항상 false)
  steps?: Array<Omit<StepEvent, 'type'>>; // 단계마다 최종 상태 하나 (running 없음)
  regeneratedFromMessageId?: string; // 재생성 답변일 때
  regeneratedFromFeedback?: 'BAD';
}
```

- `steps`는 단계마다 **최종 상태 하나만** 남고, 처음 나타난 순서대로 저장됩니다. `research`가 맨 앞입니다.
- `sources`에는 SSE에 없는 `opened`(본문까지 읽었는지)가 더 있습니다. 쓰지 않으면 무시하면 됩니다.
- 빠른 경로 답변이면 `steps`가 없고, 출처가 없으면 `resources`·`sources`·`webSources`가 없습니다. 키 자체가 없을 수 있으니 optional로 다뤄 주세요.
- assistant 메시지는 답변 텍스트가 비어 있지 않을 때만 저장됩니다.

---

## 7. FE 구현 가이드 (제안)

### 7.1 파서

현재 `widgetChat.ts` 루프에 분기 세 개만 더하면 됩니다.

```ts
if (data === '[DONE]') { onComplete(...); return; }
const parsed = JSON.parse(data);
if (parsed.error) throw new Error(parsed.error);
if (typeof parsed.content === 'string') { fullText += parsed.content; onChunk(fullText); }
if (parsed.type === 'resources') { /* 기존 처리 */ }
if (parsed.type === 'step') { onStep?.(parsed as StepEvent); }          // 신규
if (parsed.type === 'sources') { onSources?.(parsed.sources); }         // 신규
if (parsed.type === 'web_sources') { onWebSources?.(parsed.sources); }  // 신규
```

### 7.2 진행 단계 UI

- 상태는 `Map<id, StepEvent>`로 두고, 이벤트가 올 때마다 `id` 기준으로 덮어씁니다. 표시 순서는 처음 본 순서입니다.
- `research` 단계는 컨테이너나 헤더로, 도구 단계는 그 안의 목록으로 그리면 자연스럽습니다.
- 주 문구는 `label`, 보조 문구는 `thought`(작게, 회색 등)를 권장합니다.
- `running`은 스피너, `done`은 체크, `failed`는 경고 아이콘. `failed`여도 답변은 계속 오니 오류로 다루지 마세요.
- 첫 `content`가 오면 단계 목록을 접어서 요약("자료 3개를 모았어요")만 남기고, 펼쳐 볼 수 있게 하는 것을 권장합니다.
- 히스토리에서는 `metadata.steps`로 접힌 상태를 바로 그리면 됩니다.

### 7.3 타임아웃과 대기 시간

- 에이전트 경로는 첫 `content`까지 보통 **4~20초** 걸립니다. 서버의 조사 시간 상한은 20초(웹 검색을 켜면 35초)이고, 그 뒤 답변 생성이 이어집니다.
- 웹 검색 한 번은 6~15초 걸려서, 웹 검색까지 가는 질문은 첫 `content`까지 **20~30초** 걸릴 수 있습니다.
- 이 동안 `content` 없이 `step`만 옵니다. 도구 단계 사이에 이벤트가 **최대 6초 정도 끊길 수** 있습니다(LLM 응답 대기).
- 클라이언트 전체 타임아웃(현재 5분)은 그대로 둬도 되고, 중간 프록시(nginx 등)의 idle timeout은 30초 이상이어야 합니다.

### 7.4 출처 UI

- `resources`(학교 문서 PDF), `sources`(Ziggle 공지), `web_sources`(웹)는 출처가 다르니, "참고 문서" / "관련 공지" / "웹 검색 결과"처럼 나눠 보여주는 것을 권장합니다.
- `sources[].url`, `web_sources[].url`은 외부 링크입니다. `target="_blank" rel="noopener noreferrer"`로 열어 주세요.

---

## 8. 서버 설정과 배포 상태

| 설정 | 기본값 | 영향 |
|---|---|---|
| `AGENT_ENABLED` | `false` | `false`면 `step`·`sources`가 절대 오지 않음 (기존과 완전히 같음) |
| `ZIGGLE_MCP_URL` / `ZIGGLE_MCP_API_KEY` | 없음 | 비어 있으면 공지 도구가 꺼지고 `search_notices`/`get_notice` 단계와 `sources`가 오지 않음 |
| `ZIGGLE_NOTICE_WIDGET_KEY_IDS` | 없음 | 공지를 쓸 위젯 키 ID 목록(`*` = 전체). 목록에 없는 위젯은 문서 재탐색만 함 |
| `WEB_SEARCH_ENABLED` / `WEB_SEARCH_WIDGET_KEY_IDS` | `false` / 없음 | 켜고 위젯이 목록에 있을 때만 `search_web` 단계와 `web_sources`가 옴 |

| 단계 | 내용 | 상태 |
|---|---|---|
| 1단계 | 에이전트 재탐색 (이벤트 변경 없음) | PR [gsainfoteam/chatbot-be#67](https://github.com/gsainfoteam/chatbot-be/pull/67) (→ development) |
| 2단계 | `step` 이벤트, `metadata.steps` | PR [gsainfoteam/chatbot-be#68](https://github.com/gsainfoteam/chatbot-be/pull/68) (#67 위 stacked) |
| 3단계 | Ziggle 공지 도구, `sources` 이벤트, `metadata.sources` | 브랜치 `ikjun1101/cha3-17-ziggle-mcp` (커밋, PR 전) |
| Gate 보완 | 학교 이름 제외 신뢰도, 빠른 경로 답변 불가 시 재시도 (이벤트 형식 변경 없음) | 브랜치 `ikjun1101/cha3-17-gate-refusal` (커밋, PR 전) |
| 웹 검색 (실험) | `search_web` 단계, `web_sources` 이벤트, `metadata.webSources` | 브랜치 `ikjun1101/cha3-17-web-search` (미커밋, 도입 여부 검토 중) |

---

## 9. FE와 정할 것

1. **단계 UI의 노출 범위**: 도구 단계를 모두 보여줄지, `research` 요약만 보여줄지
2. **`thought` 노출 여부**: 모델이 쓴 문장이라 가끔 어색할 수 있음
3. **출처 표시 위치**: `resources`·`sources`·`web_sources`를 한 목록에 둘지, 섹션을 나눌지. 웹 출처의 공식/비공식 표시 방법
4. **Flutter 패키지 반영 시점**: 웹 위젯과 같은 릴리스에 넣을지
5. **영어 UI**: `label`은 지금 한국어로만 옵니다. 영어 위젯이 있으면 `kind`·`status`·`resultCount`로 FE가 문구를 직접 만드는 방법도 있습니다. 필요하면 알려 주세요.
6. **keepalive**: 조사 중 이벤트 공백(최대 약 6초)이 문제가 되면 서버에서 주석 하트비트를 추가할 수 있습니다.
