# Chat SSE 계약 — CHA3-17 BE 통합

## 요청

`POST /api/v1/widget/messages/chat/stream`

```http
Authorization: Bearer <sessionToken>
Content-Type: application/json
```

```json
{ "question": "GIST 장학금 신청 기간은 언제인가요?" }
```

질문은 최대 4,000자, 세션당 사용자 질문 최대 5회다. HTTP 단계에서 인증/유효성/횟수/동시 요청 제한에 걸리면 일반 오류 응답(400/401/429 등)을 받는다. SSE 헤더가 시작된 뒤의 오류는 아래 `error` 이벤트로 전달된다. 거절 답변도 질문 횟수에 포함된다.

기존 `POST /api/v1/widget/messages/:messageId/regenerate/stream`도 같은 SSE 형식을 사용한다. BAD 답변의 재생성 조건은 기존대로 유지하며 사용자 질문을 중복 저장하지 않는다. 동시 요청 제한은 재생성에도 적용된다.

## 프레임과 종료

응답은 `text/event-stream`. 각 프레임은 `data: <JSON>\n\n`이다. 네트워크 조각과 SSE 프레임 경계는 일치하지 않으므로 FE가 줄/프레임 버퍼를 유지해야 한다.

정상 종료는 `data: [DONE]\n\n`. `error` 또는 DONE 없이 연결이 끊기면 정상 완료로 표시하지 않는다. 알려지지 않은 이벤트는 무시한다. 새 되묻기 이벤트는 도입하지 않았다.

| 이벤트    | 형태                                            | FE 동작                      |
| --------- | ----------------------------------------------- | ---------------------------- |
| 답변      | `{"content":"신청 기간은…"}`                    | 기존 본문 뒤에 덧붙임        |
| 진행      | `{"type":"step",...}`                           | 같은 id를 갱신               |
| 내부 문서 | `{"type":"resources","resources":[...]}`        | 기존 PDF 표시 방식 유지      |
| 공지 출처 | `{"type":"sources","sources":[...]}`            | 절대 URL로 표시              |
| 웹 출처   | `{"type":"web_sources","sources":[...]}`        | 절대 URL, official 여부 표시 |
| 오류      | `{"error":"답변 생성 중 오류가 발생했습니다."}` | 오류 표시, 진행 상태 종료    |
| 완료      | `[DONE]`                                        | 로딩 종료                    |

진행 이벤트는 답변보다 먼저 오거나 없을 수 있다. 출처 이벤트는 본문 뒤, DONE 전에 전송된다. 빈 출처 배열의 이벤트는 생략한다.

## 진행 이벤트

```json
{
  "type": "step",
  "id": "r2_call_1",
  "kind": "search_notices",
  "label": "Ziggle 공지를 불러왔어요",
  "status": "done",
  "thought": "신청 기간을 확인할게요",
  "resultCount": 3
}
```

- `status`: `running | done | failed`.
- `kind`: `research | search_documents | search_notices | get_notice | search_web`. 향후 추가 값을 허용한다.
- `thought`: 선택적 짧은 행동 설명. 숨은 추론이 아니며 답변 본문에 합치지 않는다.
- `resultCount`: 선택적 숫자. 0도 유효하다.
- 같은 `id`의 상태를 갱신하며 배열에 중복으로 쌓지 않는다.
- 개별 도구 실패 뒤 다른 경로로 답변할 수 있다. `failed` 하나만으로 전체 요청을 실패 처리하지 않는다.
- `step`에는 `content`/`error` 키를 넣지 않는다.

## 출처와 출력 처리

```json
{
  "type": "sources",
  "sources": [
    {
      "kind": "notice",
      "id": "42",
      "title": "장학금 안내",
      "url": "https://ziggle.gistory.me/notice/42"
    }
  ]
}
```

```json
{
  "type": "web_sources",
  "sources": [
    {
      "kind": "web",
      "id": "https://www.gist.ac.kr/example",
      "title": "www.gist.ac.kr",
      "url": "https://www.gist.ac.kr/example",
      "official": true
    }
  ]
}
```

공지/웹 출처는 **최종 답변에서 실제로 인용한 검증된 출처만** 전송한다. 상위 3개를 임의로 고르지 않는다. `official`은 설정된 공식 도메인과의 일치 여부이며 내용의 정확성을 보증하는 점수가 아니다.

모델의 `[cite:N]` 표지를 BE가 등록된 제목/URL의 Markdown 링크로 바꾼다. FE에 표지를 노출하지 않는다. 등록되지 않은 모델 생성 URL은 링크로 전달하지 않는다. 공지/웹 URL에는 MCP 리소스 서버 주소를 덧붙이지 않는다. 기존 `resources`는 최종 답변에 전달된 내부 PDF 후보이며, 공지/웹과 달리 문장별 인용 추적 목록은 아니다.

답변은 휴대전화·주민번호 필터를 거친 뒤 SSE와 DB에 같은 내용으로 전달한다. 이메일과 부서 전화는 유지한다. 번호와 인용이 토큰 경계에서 갈라져도 처리하기 위해 끝부분 약 128자를 버퍼링하며 미완성 번호/링크는 더 길게 보류할 수 있다. 따라서 모델 토큰과 FE content 이벤트는 일대일로 대응하지 않는다. FE도 Markdown을 안전하게 렌더링해야 한다.

## 검색/종료 동작

- `AGENT_ENABLED=true`일 때 GIST 질문 범위를 먼저 판정한다. 무관한 작업, 민감정보 추출, 우회 요구는 고정 안내로 응답하며 검색하지 않는다. 판정 호출은 최대 30초 기다리고, 타임아웃일 때만 한 번 재시도한다. 최종 실패 시 검색하지 않고 일시적인 처리 오류로 안내한다. 질문 범위 거절과는 다른 문구를 사용한다.
- 강한 내부 근거가 있으면 빠른 경로로 답한다. 근거가 약하거나 없거나, 빠른 답변의 시작이 답변 불가 문구이면 조사 경로로 이동한다.
- 0건/중복 결과만으로 조사 루프를 종료하지 않는다. 다음 라운드에서 다른 검색어·도구·본문 조회·구조화된 종료를 판단한다.
- `finish_research`의 complete/partial/insufficient와 실제 근거 경로를 검증한다. 요약 없는 후보는 본문을 읽거나 질문과 무관해 제외한 이유를 남긴다.
- 한도나 오류로 끝난 조사에서 모인 자료를 사용할 수 있으나, 충분한 근거가 확보됐다는 의미는 아니다. 부족한 내용을 추정하지 않도록 답변에 제한을 전달한다.
- 웹은 내부 문서와 활성화된 공지 검색이 끝난 뒤에만 실행한다. 최대 2회/질문, 1회/라운드. 근거 없는 결과 이후 반복하지 않는다.
- 전역 시간 제한은 `AGENT_ENFORCE_TIME_BUDGET=true`일 때만 적용한다. 기본은 라운드/도구 횟수와 개별 API timeout으로 제한한다.
- 연결 해제 시 진행 중인 HTTP 모델/MCP 요청을 취소하고 후속 도구 호출을 중단한다. 이미 실행 중인 DB/임베딩 작업은 반환 후 후속 작업을 중단한다.

## 히스토리와 평가

`GET /api/v1/widget/messages`의 assistant `metadata`:

- `steps`: 최종 상태의 진행 목록.
- `resources`, `sources`, `webSources`: 전송한 참조 목록. 저장된 공지/웹 항목에는 내부 추적용 `opened`가 포함될 수 있다.
- `model`, `usage`: 확인된 모델/토큰 사용량.
- `evaluation`: 범위, 경로, 조사 종료 사유, 근거 평가, 도구 사용, 지연, 사용량 누락 여부. UI의 정답 점수로 사용하지 않는다.

별도 evaluation SSE 이벤트는 없다. 정상 답변은 저장한 뒤 출처와 DONE을 전송한다. 취소/실패 요청은 서버 `[CHAT_EVALUATION]` 로그에만 남을 수 있다. 세부 로컬 설정과 지표 해석은 [로컬 테스트 가이드](cha3-17-local-testing.md)를 참고한다.
