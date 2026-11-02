# CHA3-17: BE 보완 후 로컬 확인

현재 통합 브랜치: `ikjun1101/cha3-17-web-search`. 웹 검색을 꺼도 이 브랜치에서 내부 문서·Ziggle·안전 처리 전체를 확인할 수 있다. 새 DB 스키마 변경은 없다.

## PR별 반영 범위

| PR  | 브랜치 끝부분  | 보완 내용                                                                  |
| --- | -------------- | -------------------------------------------------------------------------- |
| #67 | `cha3-17`      | 근거 경로와 미해결 질문을 포함하는 종료 판단, 도구 실행 한도               |
| #68 | `step-events`  | 결과 0건/중복 결과만으로 조기 종료하지 않고 다음 판단 라운드 진행          |
| #70 | `ziggle-mcp`   | 요약 없는 후보의 본문 조회, 개인정보 필터, 검증된 출처 인용                |
| #71 | `gate-refusal` | GIST 범위 판정, 5회 제한 원자성, 동시 요청 제한, 연결 해제 취소, 평가 기록 |
| #72 | `web-search`   | 앞선 변경 통합, 웹 검색 선행 조건/실행 한도, 출처 검증, 로컬 확인 도구     |

브랜치는 위 순서로 연결되어 있다. 상위 변경을 다음 브랜치에 merge했으며 기존 PR을 대체하지 않았다.

## 1. 환경 준비

기존 `.env`는 자동 변경하지 않았다. `.env.example`을 참고하여 **로컬/테스트 DB**, 모델 키, 위젯 키를 준비한다. 기존 스키마가 없는 테스트 DB는 저장소의 기존 마이그레이션 절차로 준비한다.

처음에는 웹 검색 없이 확인한다. 아래 값을 기존 설정에 반영한다.

```dotenv
AGENT_ENABLED=true
AGENT_MAX_ROUNDS=6
AGENT_ENFORCE_TIME_BUDGET=false
ZIGGLE_MCP_URL=https://api.stg.ziggle.gistory.me/mcp
ZIGGLE_MCP_API_KEY=<테스트용 키>
ZIGGLE_NOTICE_WIDGET_KEY_IDS=*
WEB_SEARCH_ENABLED=false
# 로컬 채팅 테스트 중 자동 임베딩 복구 작업을 돌리지 않으려면:
EMBEDDING_BACKFILL_ENABLED=false
```

`*`는 모든 위젯에 공지를 허용한다. 한 위젯만 확인하려면 실제 widget key **ID**를 넣는다(공개 widgetKey 문자열과 다름). Ziggle URL/키가 준비되지 않았다면 내부 문서만 먼저 확인할 수 있다. 문서와 청크가 들어 있는 테스트 DB여야 검색 자체를 확인할 수 있다.

```sh
bun install --frozen-lockfile
bun run start:dev
```

기본 포트는 3000이며 모델 제공자는 기존 `LLM_PROVIDER` 설정을 따른다. scope 판정은 light, 조사 모델은 `AGENT_MODEL_TIER`, 답변은 heavy를 사용한다. 모델 키가 유효해야 실제 요청을 실행할 수 있다.

## 2. 질문 하나 실행

다른 터미널에 다음 환경 변수를 설정한다. 세션 토큰은 명령 출력에 표시하지 않는다.

```sh
export CHAT_TEST_BASE_URL=http://localhost:3000
export CHAT_TEST_WIDGET_KEY='<테스트 위젯의 공개 키>'
export CHAT_TEST_PAGE_URL='http://localhost:5173'
bun run test:chat:smoke 'GIST 장학금 신청 기간은 언제야?'
```

위젯의 allowedDomains에 pageUrl 도메인이 등록되어 있어야 한다. 스크립트는 새 세션을 발급하고 **실제 모델을 호출하며 대화/사용량을 테스트 DB에 저장한다**. 여러 질문을 같은 대화에서 확인하려면 기존 UI에서 발급받은 토큰을 `CHAT_TEST_SESSION_TOKEN`으로 설정한다. 이 값이 있으면 세션을 새로 발급하지 않는다.

출력에는 단계, 최종 답변, 실제 인용된 공지/웹 출처, 응답 시간, 저장된 `metadata.evaluation`이 나온다. `Ctrl+C`로 요청을 취소할 수 있다. 로컬 주소만 허용하며 대표 질문 평가를 자동 수행하는 도구는 아니다.

## 3. 먼저 확인할 동작

- 첫 검색이 비거나 약한 경우: 다른 검색어, 공지 검색, 필요한 본문 조회가 이어지는지 확인한다.
- 공지에 요약이 없는 경우: 관련 후보를 읽거나 제외 이유를 남겨야 정상 종료할 수 있다. 이미지 공지는 내용을 추정하지 않고 원문 확인을 안내해야 한다.
- 개인정보: 답변/출처 제목/진행 문구에서 휴대전화와 주민번호가 가려지고, 이메일·부서 전화는 유지되는지 확인한다.
- 범위: 무관한 작업과 개인 휴대전화 요청을 거절하고, 직전 GIST 질문에 대한 짧은 후속 질문은 허용하는지 확인한다.
- 동일 세션: 5개 질문까지 저장되고 6번째 질문은 거절되는지 확인한다. 진행 중인 동일 세션의 추가 스트림도 거절된다.
- 취소: UI 연결 해제나 스크립트 중단 후 새로운 모델/도구 호출이 이어지지 않는지 로그로 확인한다.
- `AGENT_ENABLED=false`: agent/scope/공지/웹 검색을 사용하지 않는 기존 검색 경로로 돌아가는지 확인한다. 학교명 정규화와 공통 출력 필터는 유지한다.

이는 동작 점검 목록이다. 답변 내용의 정답 여부와 출시 기준은 다음 단계의 대표 질문/Human Feedback으로 판단한다.

## 4. 웹 검색 비교 실험

위 동작을 확인한 뒤 서버를 다음 설정으로 재시작한다.

```dotenv
WEB_SEARCH_ENABLED=true
WEB_SEARCH_WIDGET_KEY_IDS=*
WEB_SEARCH_ALLOWED_DOMAINS=gist.ac.kr
WEB_SEARCH_OFFICIAL_DOMAINS=gist.ac.kr
```

현재 Google grounding 호출은 Letsur 게이트웨이 설정이 필요하다. `WEB_SEARCH_MODEL`은 기본 `gemini-2.5-flash`다. 외부 출처도 비교하려면 `WEB_SEARCH_ALLOWED_DOMAINS`를 비우면 된다. 먼저 내부 문서와 활성화된 공지 검색이 끝나야 웹 검색이 실행된다. 질문당 최대 2회, 라운드당 1회이며 근거 있는 결과가 없으면 웹을 반복하지 않는다. 해결되지 않은 redirect URL과 허용 도메인 밖의 출처는 답변 근거에서 제외한다.

웹 검색을 켜도 모든 질문에서 웹을 호출하지는 않는다. 기존 근거가 충분하면 바로 답한다. 검색 추천 UI 등 제공자의 표시 요구사항 검토는 공개 출시 전 별도로 마무리해야 한다. 이 브랜치는 웹 실험을 가능하게 하는 상태이며 공개 활성화 결정을 포함하지 않는다.

## 평가 기록 읽기

- `route`, `routeReason`, `scope`: 최초 경로와 범위 판단.
- `stopReason`: `ready`는 유효한 complete 종료, `exhausted`는 partial/insufficient 종료. `max-rounds`, `llm-error`, `unassessed`는 근거가 충분하다는 뜻이 아니다.
- `assessment`: 실제 근거 경로, 남은 질문, 종료 이유, 제외한 후보.
- `rounds`, `toolCalls`, `toolFailures`, `researchMs`, `firstContentMs`, `totalMs`: 탐색 과정과 지연.
- `observedUsage`, `usageIncomplete`, `discardedAnswers`: 확인된 사용량과 누락 여부. 취소된 생성이나 폐기된 첫 답변은 정확한 사용량을 받지 못할 수 있다.
- `outcome`, `outcomeBasis`: 운영 분석용 분류. 실제 정답 판정이나 Human Feedback 점수가 아니다.

정상 응답은 메시지 metadata에 저장한다. 오류/취소 요청은 답변이 저장되지 않을 수 있으며 서버의 `[CHAT_EVALUATION]` 로그에서 확인한다. 이 로그를 외부 공유할 때는 질문·근거 메타데이터의 취급 범위를 따로 고려한다.

## 자동 검증과 범위

```sh
bun run test:unit --runInBand
bunx tsc --noEmit
bun run build
```

자동 테스트는 모델·도구를 mock해 분기/계약을 확인한다. 실제 모델의 범위 판별, 실제 DB 동시 요청, 실제 Ziggle·웹 응답 품질은 위 로컬 확인 후 staging에서 확인한다.

추가 요청 제한은 현재 **프로세스 단위**다: 세션당 동시 1개, IP당 동시 3개/분당 20개, 전체 동시 32개. 프록시 뒤에서 모든 요청이 같은 IP로 보이거나 여러 replica를 사용하면 운영 설정을 재검토해야 한다. 임의의 X-Forwarded-For를 신뢰하도록 바꾸지 않았다.

전역 조사 시간 제한은 기본 꺼져 있다. 최대 라운드, 도구별 실행 횟수, 개별 API timeout은 유지한다. 응답 속도 목표와 웹 검색 공개 여부는 실제 답변 평가 후 결정한다.
