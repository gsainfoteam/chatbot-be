# 공통 이미지 입력 · 플랫폼 브라우저 저장 계약

기준일: 2026-11-27. 이 저장소에는 백엔드 API와 연동 계약을 구현했다. IndexedDB 저장소, 첨부 UI, 세션 자동 갱신 UI는 프론트엔드에서 이 계약에 맞춰 구현한다.

## 범위와 처리 흐름

- 자체 플랫폼: 로그인 없이 텍스트 또는 이미지로 질문한다. 대화·첨부의 복원 원본은 사용자의 브라우저다. 인증 세션은 30분이고 대화 수명과 무관하다. 대화당 5회 제한을 적용하지 않는다.
- 외부 위젯: 모든 위젯의 기존 `/api/v1/widget/*` API에서 이미지 첨부를 지원한다. 위젯 키에 설정된 사용자별 기간제 질문 한도와 서버 이력 조회를 유지한다. 한도를 설정하지 않은 키에는 누적 질문 제한이 없다. 플랫폼 토큰과 위젯 토큰은 서로 사용할 수 없다.
- 이번 입력 형식은 정적 JPEG, PNG, WebP다. PDF, GIF, APNG, 움직이는 WebP, HEIC, 일반 파일은 받지 않는다. 기존 검색 결과의 PDF 출처를 열람하는 기능과 PDF를 질문에 첨부하는 기능은 별개다.
- 이미지 임베딩을 만들지 않는다. 기존 `heavy` 모델로 이미지 요약·검색 질의를 생성하고 학교 관련 범위를 판정한 뒤, 필요한 경우 기존 문서/공지/웹 검색을 사용한다. 최종 `heavy` 호출에는 정규화한 이미지도 함께 전달한다. 이미지의 주장과 공식 검색 근거를 구분한다.
- 서버는 운영 목적의 질문·답변·요약·출처·피드백·사용량 로그를 남긴다. 이미지 바이트와 data URL은 DB/GCS에 저장하지 않는다. 이미지는 메모리에서 처리하고 모델 제공자에게 전송한다. **브라우저 기반 저장이 서버에 텍스트 기록을 전혀 남기지 않는다는 뜻은 아니다.**

## 배포

이미지 입력은 모든 환경과 모든 유효한 위젯 키에서 기본 지원한다. 이미지 전용 기능 플래그나 위젯 허용 목록은 없다. 기존 위젯 키 상태·도메인·앱 식별자 검증은 유지한다.

1. `bun install`로 sharp를 포함한 의존성을 설치한다. 배포 OS/CPU용 sharp 네이티브 의존성이 필요하다.
2. 기존 배포 절차에 따라 `0021_question_limit.sql` 다음에 `0022_platform_sessions.sql`을 서버 코드 배포보다 먼저 적용한다. 0022 snapshot은 0021의 질문 한도·사용자 식별 필드를 포함한다. 기존 세션의 channel 기본값은 widget이다. 실제 DB에는 적용하지 않았다.
3. 플랫폼 세션 발급 요청에 기존 위젯 키 문자열을 보낸다. DB UUID를 환경 변수로 지정하지 않는다.
4. `heavy`에 이미지 입력 및 OpenAI 호환 Chat Completions 스트리밍을 지원하는 모델을 설정한다. 현재 Letsur 설정의 `gpt-5.4`로 합성 이미지 판독 및 스트리밍을 확인했다. 모델 변경 시 다시 확인한다. 텍스트 임베딩 모델은 그대로 사용한다.

선택적 실연동 확인: `bun src/scripts/platform-vision-smoke.ts`. .env의 Letsur 설정을 사용하고 합성 이미지로 두 번의 모델 호출을 수행한다. API 비용이 발생하며 DB에는 쓰지 않는다. API 키나 이미지 본문을 출력하지 않는다.

### 운영 제한

| 항목                       | 제한                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------- |
| 이미지 수                  | 요청당 3장, 현재 첨부와 과거 이미지 재전송을 합산                                       |
| 파일 크기                  | 장당 10MiB                                                                              |
| 입력 해상도                | 40,000,000픽셀 이하                                                                     |
| 서버 정규화                | 회전 보정·메타데이터 제거·흰 배경·긴 변 최대 2048px·JPEG quality 90·장당 결과 4MiB 이하 |
| 질문                       | 최대 4,000자, 현재 첨부가 없으면 필수                                                   |
| 과거 이력                  | 최대 20개 메시지, content와 imageSummary 합산 32,000자                                  |
| JSON payload               | 최대 256KiB                                                                             |
| 이미지 분석/최종 모델 호출 | 각각 60초 timeout, completion budget 8,000                                              |
| 채팅 처리량                | IP당 분당 20회, 인증 세션당 동시 1개, 프로세스당 동시 4개                               |
| 세션 발급 처리량           | 채팅과 별도로 IP당 분당 20회                                                            |

처리량 제한은 프로세스 메모리 기준이다. 인스턴스가 여러 개면 전역 한도가 아니며 재시작하면 초기화된다. 플랫폼의 텍스트 요청과 플랫폼·위젯의 이미지 요청은 같은 동시 처리 제한을 공유한다. 기존 위젯의 JSON 텍스트 요청은 기존 처리 경로를 유지한다. 세션 발급 분당 제한은 플랫폼 발급 경로 기준이다. 현재 Fastify는 전달된 X-Forwarded-For를 신뢰하지 않으므로 프록시 뒤에서는 `req.ip`가 프록시 주소일 수 있다. 배포 시 신뢰할 프록시 범위를 명시적으로 구성하거나 게이트웨이에서 실제 클라이언트 IP 기준 제한을 적용해야 한다. 임의의 전달 헤더를 그대로 신뢰하면 안 된다.

## 외부 위젯 이미지 요청

기존 웹·앱 위젯 세션 토큰을 그대로 사용한다. 별도 플랫폼 세션을 발급할 필요는 없다.

- `POST /api/v1/widget/messages/chat/stream`: multipart의 `payload` 필드에 `{ "question": "이 공지 설명해 줘", "images": [{ "id": "첨부 UUID" }] }`를 JSON 문자열로 보내고 `image_<UUID>` 파일 필드를 붙인다. 플랫폼과 같은 파일 형식·크기·개수 제한을 적용한다. 이미지가 있으면 question을 생략할 수 있다.
- 기존 `{ "question": "..." }` JSON 요청은 그대로 동작한다. 이미지는 임베딩용 텍스트로 변환해 저장하지 않는다.
- 위젯은 해당 인증 세션의 서버 이력을 사용한다. `history`, `localConversationId`, 과거 메시지용 `images[].messageId`는 보내지 않는다. 이전 이미지를 다시 읽어야 하면 현재 질문에 다시 첨부한다.
- 응답 SSE의 `message_metadata.localConversationId`는 위젯 세션 ID다. 로컬 독립 대화 ID를 뜻하지 않는다. 서버 기록에 이미지 원본은 없으므로 새로고침 후 이미지 복원을 원하면 클라이언트가 별도로 보관해야 한다.
- 이미지 답변의 BAD 재생성은 `POST /api/v1/widget/messages/:answerMessageId/regenerate/stream`에 multipart로 원래 첨부를 같은 ID로 다시 보낸다. payload에는 images만 넣고 question은 생략한다. 서버가 원래 질문과 그 이전 이력을 읽는다. 첨부 없이 재생성을 요청하면 400으로 거부한다.
- 위젯 키의 질문 한도는 최근 설정 기간 동안의 텍스트와 이미지 질문을 합산한다. clientId를 보내 발급받은 세션들은 같은 위젯 키 안에서 사용자 단위로 함께 세고, clientId가 없으면 현재 세션만 센다. 재생성은 질문 횟수를 추가로 소비하지 않는다. 플랫폼의 브라우저 대화 정책과는 구분한다.

아래 절은 `/api/v1/platform/*`를 사용하는 브라우저 이력 방식의 계약이다.

## 인증 세션과 브라우저 대화

`POST /api/v1/platform/auth/session`

```json
{ "widgetKey": "wk_live_발급받은키", "pageUrl": "https://플랫폼-도메인/chat" }
```

201 응답: `{ sessionToken, sessionId, expiresIn: 1800 }`. 브라우저의 Origin이 있으면 pageUrl의 origin과 일치해야 하고, pageUrl은 요청으로 보낸 ACTIVE 위젯 키의 허용 도메인이어야 한다. widgetKey는 DB UUID가 아닌 발급받은 키 문자열이다. Origin 검사는 브라우저 경계 확인이며 사용자 신원 인증이 아니다.

이후 요청은 `Authorization: Bearer <sessionToken>`을 사용한다. 토큰은 메모리에 두고 만료 전에 새로 발급한다. 앱 재시작 시에도 새 토큰을 발급할 수 있다. `localConversationId`는 `crypto.randomUUID()`로 생성하고 토큰을 갱신해도 바꾸지 않는다. 서버의 세션 ID와 로컬 대화 ID는 다른 값이다. 사용자가 새 대화를 만들 때만 새 대화 ID를 만든다.

인증 단계의 HTTP 401이면 새 세션을 발급하고 아직 시작하지 않은 채팅 요청을 한 번 다시 보낼 수 있다. SSE가 시작된 뒤의 오류/연결 중단에는 자동 재전송하지 않는다. 중복 방지 키와 스트림 이어받기는 없다. 세션을 갱신해도 저장한 브라우저 대화는 그대로 읽고 이어갈 수 있다.

## 채팅 요청

`POST /api/v1/platform/messages/chat/stream`

이미지가 없으면 `application/json`, 있으면 `multipart/form-data`를 사용한다. 구조에 정의하지 않은 필드는 거부한다. history는 **현재 질문 이전**의 메시지만 포함한다. 서버의 대화 조회 API를 호출하거나 동일 메시지를 별도로 저장하는 API를 호출하지 않는다.

```typescript
type ChatInput = {
  localConversationId: string; // UUID, 브라우저 대화 ID
  question?: string;
  history?: Array<{
    id: string; // UUID, 브라우저 메시지 ID
    role: 'user' | 'assistant';
    content: string;
    imageSummary?: string; // user 메시지만, 최대 6,000자
  }>;
  images?: Array<{
    id: string; // UUID, 브라우저 첨부 ID
    messageId?: string; // 생략: 현재 질문, 지정: history의 user 메시지
  }>;
};
```

history에는 system/tool 역할을 보낼 수 없다. 이미지 요약과 과거 assistant 답변도 사용자 제공 맥락으로 취급하며 공식 지식 근거로 간주하지 않는다. 이미지를 재전송하지 않았으면 서버는 요약으로만 맥락을 이해하고 세부 판독이 필요할 때 재첨부를 요청할 수 있다.

multipart는 JSON 문자열 `payload` 필드 하나와 각 첨부 ID에 대응하는 `image_<UUID>` 파일 필드로 구성한다. manifest와 실제 파일이 정확히 일치해야 한다. 파일명은 식별에 사용하지 않는다. **Content-Type은 직접 설정하지 않아야 브라우저가 boundary를 붙인다.**

```typescript
const imageId = crypto.randomUUID();
const payload: ChatInput = {
  localConversationId,
  question: '이 학교 공지의 내용을 설명해 줘',
  history: previousMessages,
  images: [{ id: imageId }],
};
const body = new FormData();
body.append('payload', JSON.stringify(payload));
body.append(`image_${imageId}`, imageFile, imageFile.name);
const response = await fetch(
  `${apiOrigin}/api/v1/platform/messages/chat/stream`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}` },
    body,
    signal: abortController.signal,
  },
);
// response.ok 확인 후 response.body를 SSE 파서로 소비한다.
```

이미지만 제출하려면 question을 생략한다. 목적이 명확하지 않으면 원하는 작업을 묻는 안내 답변이 올 수 있다. 과거 이미지 판독이 필요한 후속 질문은 해당 Blob을 다시 보내고 images의 messageId를 과거 user 메시지 ID로 지정한다. 파일 전체를 base64 텍스트로 history에 넣지 않는다. 세 장 제한을 넘으면 사용자가 필요한 이미지를 선택하도록 한다.

## SSE 응답과 완료

기존 [채팅 SSE 계약](./chat-sse-contract.md)의 `content`, `step`, `resources`, `sources`, `web_sources`, `error`, `[DONE]` 형식을 사용한다. 단계 이벤트는 실행된 검색에 따라 생기며 이미지 분석 단계가 별도로 표시되는 것은 아니다. 정상 저장 후 다음 이벤트가 추가된다.

```json
{
  "type": "message_metadata",
  "localConversationId": "로컬 대화 UUID",
  "sessionId": "이번 인증 세션 UUID",
  "userMessageId": "서버 사용자 메시지 UUID 또는 null",
  "answerMessageId": "서버 답변 UUID",
  "imageSummary": "이미지 분석 요약 또는 null",
  "outcome": "image-answer"
}
```

outcome: `answered`(검색 근거 포함), `image-answer`(이미지 설명), `unanswered`, `clarification`, `scope-refused`, `scope-unavailable`. refusal/clarification도 정상 안내 응답이므로 metadata와 DONE을 보낸다. 모델 분석 실패, 잘린 출력, 스트림 실패에는 error를 보내고 DONE을 보내지 않는다.

**HTTP 200만으로 성공 처리하지 않는다. metadata와 `[DONE]`을 모두 받아야 완료다.** metadata의 ID를 브라우저 메시지의 별도 serverMessageId로 저장한다. 로컬 메시지 ID를 덮어쓰지 않는다. imageSummary는 해당 user 턴의 맥락으로 저장한다. 과거 이미지까지 보낸 경우 여러 이미지에 대한 요약일 수 있으므로 개별 이미지 OCR 원문으로 간주하지 않는다.

DONE 없이 연결이 끝나거나 사용자가 중지하면 부분 답변을 `interrupted`로 저장하고 완료 답변과 구분한다. 부분 assistant 답변을 다음 history에 넣지 않는다. 자동 재요청 대신 사용자가 재시도하도록 한다. 서버에 메시지가 일부 기록됐을 수 있으므로 클라이언트 중지와 서버 롤백을 동일시하지 않는다.

### 출처 열람

리소스 출처: `GET /api/v1/platform/messages/resources/<encoded-resource-path>`, Bearer 플랫폼 토큰 필요. `resources[].url`의 인코딩된 상대 경로를 이 prefix 뒤에 붙인다(기존 URL을 중복 인코딩하지 않는다). 직접 구성할 때만 각 경로를 URL 인코딩한다. fetch로 Blob을 받아 object URL을 만들고 열람 후 revoke한다. 일반 `<a>`는 Authorization 헤더를 넣을 수 없으므로 이 API에 바로 연결하지 않는다.

`sources`와 `web_sources`의 외부 URL은 기존 계약을 따른다. 이미지만 읽은 답변에는 공식 출처 목록이 없을 수 있다. 첨부 이미지를 공식 출처처럼 표시하지 않는다.

### 오류

| 응답                         | 프론트 처리                                              |
| ---------------------------- | -------------------------------------------------------- |
| 400                          | 형식/manifest/이미지 검증 오류를 표시하고 입력 수정      |
| 401                          | 만료된 토큰 갱신; 과거 세션 피드백은 재시도하지 않음     |
| 404                          | 현재 세션에 없는 피드백/재생성 대상                      |
| 413                          | 파일 수·크기 또는 본문 제한 안내                         |
| 429                          | 잠시 후 수동 재시도; 새 대화/토큰 발급으로 우회하지 않음 |
| SSE error 또는 DONE 없는 EOF | 부분 답변 표시, 완료로 저장하지 않음                     |

## 피드백과 재생성

- `PUT /api/v1/platform/messages/:answerMessageId/feedback`: `{ "rating": "GOOD" }` 또는 `{ "rating": "BAD" }`.
- `POST /api/v1/platform/messages/:answerMessageId/regenerate/stream`: 위 ChatInput 형식. question을 생략하고 원래 localConversationId, 원래 질문 **이전** history, 원래 질문 이미지를 동일 첨부 ID로 다시 전송한다. 질문 텍스트는 서버의 원본을 사용한다. 원래 답변이나 이후 메시지를 history에 넣지 않는다.
- BAD 원본 답변에 한 번만 허용한다. 재생성 답변을 다시 재생성할 수 없다. 시작된 재생성이 실패해도 1회 권한은 소비된다. 원래 첨부가 없거나 대화 ID가 다른 검증 오류는 권한을 소비하기 전에 거부한다.
- 현재 유효한 인증 세션에서 생성한 답변만 가능하다. 저장한 serverSessionId와 현재 sessionId가 다르면 버튼을 비활성화하고 이유를 표시한다. 토큰 갱신 후에도 과거 대화 열람/새 질문은 가능하다.
- 재생성은 사용자 메시지를 중복 저장하지 않는다. metadata.userMessageId는 null이다. 새 답변은 별도 ID로 저장하고 원본 답변과 연결해 UI에서 교체하거나 버전으로 표시한다.

## 프론트엔드 저장 구조 (구현 계약)

IndexedDB에 아래처럼 버전이 있는 저장소를 둔다. localStorage에는 테마·선택한 대화 ID 같은 가벼운 설정만 둔다. 토큰은 첨부나 대화 데이터와 함께 영구 저장하지 않는다.

```typescript
type Conversation = {
  id: string;
  schemaVersion: 1;
  title: string;
  createdAt: string;
  updatedAt: string;
};
type LocalMessage = {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  status: 'pending' | 'streaming' | 'complete' | 'interrupted' | 'failed';
  attachmentIds: string[];
  imageSummary?: string;
  serverSessionId?: string;
  serverMessageId?: string;
  regeneratedFromLocalMessageId?: string;
  // 기존 출처 목록, outcome, 피드백 상태도 함께 저장한다.
};
type LocalAttachment = {
  id: string;
  conversationId: string;
  messageId: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  name: string;
  size: number;
  blob: Blob;
};
interface ConversationStore {
  list(): Promise<Conversation[]>;
  load(id: string): Promise<{
    conversation: Conversation;
    messages: LocalMessage[];
    attachments: LocalAttachment[];
  }>;
  saveTurn(
    conversation: Conversation,
    messages: LocalMessage[],
    attachments: LocalAttachment[],
  ): Promise<void>;
  remove(id: string): Promise<void>;
}
```

대화/메시지/첨부 갱신은 IndexedDB transaction으로 묶고 UI가 DB 구현에 직접 의존하지 않게 ConversationStore를 둔다. 나중에 서버 저장 어댑터와 로컬 데이터 이전 절차를 추가할 수 있다. 로그인·계정 연결·기기간 동기화·충돌 해결은 이번에 구현하지 않는다.

새로고침/다시 열기 시 이 저장소에서 복원하고 네트워크 연결이 없어도 기존 대화는 읽을 수 있게 한다. history는 최근 완료 메시지에서 최대 20개·32,000자에 맞춰 구성한다. 개별 user/assistant 턴이 분리되지 않도록 오래된 턴 단위로 제외하고, 이미지 summary도 문자 수에 포함한다. 로컬 전체 이력을 삭제할 필요는 없다.

브라우저 저장 공간 부족/저장 거부/시크릿 모드를 처리하고 저장 실패를 사용자에게 알린다. 저장하지 못한 첨부를 저장된 것으로 표시하거나 말없이 과거 대화를 삭제하지 않는다. 새로고침 시 streaming/pending은 interrupted로 복구한다. 삭제는 대화에 딸린 Blob도 함께 지우고 object URL을 해제한다.

UI에는 “이 브라우저에 저장되며 브라우저 데이터 삭제 시 사라집니다. 다른 기기와 동기화되지 않습니다.”를 안내한다. 로컬 삭제가 서버의 운영 기록이나 모델 제공자의 기록까지 삭제하는 것은 아니므로 별도로 구분한다.

## 프론트 출시 확인 항목

1. 텍스트·이미지 1~3장·이미지 단독 질문, 첨부 미리보기/삭제와 잘못된 형식·초과 크기 안내.
2. 새로고침/브라우저 재시작 복원, 이전 이미지 후속 질문 재전송, 여러 로컬 대화 간 맥락 분리.
3. 30분 세션 만료 후 같은 대화 이어가기, 여섯 번째 이상 질문, 과거 세션 피드백 버튼 비활성화.
4. 현재 세션 GOOD/BAD와 1회 재생성, 원본 이미지 미보유 안내, 출처 자료 열람.
5. 처리량 제한·모델 오류·네트워크 단절·사용자 중지 시 부분 답변 상태와 수동 재시도.
6. IndexedDB 저장 실패·공간 부족·로컬 대화 삭제 및 재접속 시 보존 범위 안내.
