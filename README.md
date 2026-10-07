<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

채팅 위젯의 **인증(Auth)** 및 **대화 내역 저장(History Storage)**을 담당하는 백엔드 API입니다.

## Tech Stack

- **Runtime**: Bun
- **Framework**: NestJS + Fastify
- **Database**: PostgreSQL
- **ORM**: Drizzle ORM

## Project setup

```bash
# 패키지 설치
$ bun install

# 환경 변수 설정
$ cp .env.example .env
# .env 파일을 열어서 데이터베이스 정보를 입력하세요
```

## Patched dependencies

- **@modelcontextprotocol/sdk**: MCP Client와 Server 간 **단일 연결**을 유지하기 위해, SDK의 `ping` 메서드가 서버로 요청을 보내지 않도록 patch-package로 비활성화되어 있습니다. (`patches/@modelcontextprotocol+sdk+1.25.2.patch`)
- `bun install` 시 `postinstall` 스크립트가 자동으로 패치를 적용합니다.
- **@modelcontextprotocol/sdk 버전을 올릴 때**: `patches/` 의 패치가 새 버전에 그대로 적용되지 않을 수 있습니다. 버전 업 후 `bun run build` 또는 MCP 연동 테스트로 동작을 확인하고, 필요하면 패치를 수정한 뒤 `bun install --yarn` 후 `npx patch-package @modelcontextprotocol/sdk` 로 패치 파일을 재생성하세요.

## Environment Variables

`.env` 파일에 다음 환경 변수를 설정하세요:

```env
# Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=ziggle_chatbot
DB_SSL=false

# Application
PORT=3000
NODE_ENV=development

# JWT (세션 토큰용)
# 보안 요구사항: 최소 32자 이상의 강력한 시크릿 키 필요
# 프로덕션에서는 반드시 안전한 랜덤 문자열로 변경하세요
# 생성 방법: openssl rand -base64 32
JWT_SECRET=your-secret-key-here-change-in-production-min-32-chars
JWT_EXPIRES_IN=3600

# Infoteam IDP Configuration (Admin 인증용)
IDP_URL=https://api.account.gistory.me
IDP_CLIENT_ID=your_client_id
IDP_CLIENT_SECRET=your_client_secret

# Admin Authentication (Legacy - Optional, 더 이상 사용되지 않음)
# ADMIN_BEARER_TOKEN=your-admin-token-here-change-in-production-min-16-chars
```

**안전한 시크릿 생성 방법:**

```bash
# JWT Secret 생성 (최소 32자)
openssl rand -base64 32
```

**Admin 인증 변경사항:**

- 기존의 `ADMIN_BEARER_TOKEN` 방식에서 **Infoteam IDP OAuth 2.0** 인증으로 변경되었습니다.
- Admin API 접근 시 `@gistory.me` 이메일로 IDP 인증이 필요합니다.
- 자세한 마이그레이션 가이드는 [ADMIN_IDP_MIGRATION.md](./ADMIN_IDP_MIGRATION.md)를 참고하세요.

## Database Setup

### 로컬 개발 환경

```bash
# PostgreSQL이 설치되어 있어야 합니다
# 데이터베이스 생성
$ psql -U postgres -c "CREATE DATABASE ziggle_chatbot;"

# 마이그레이션 파일 생성 (스키마 변경 시)
$ bun run db:generate

# 스키마를 데이터베이스에 적용 (개발 환경용 - 빠른 동기화)
$ bun run db:push

# 또는 마이그레이션 실행 (프로덕션과 동일한 방식)
$ bun run db:migrate

# Drizzle Studio 실행 (데이터베이스 GUI)
$ bun run db:studio
```

### Docker 환경

**Docker는 로컬의 `.env` 파일을 자동으로 읽습니다.**

- `DB_HOST`는 자동으로 `postgres`로 오버라이드 (Docker 네트워크용)
- `NODE_ENV`는 자동으로 `production`으로 오버라이드
- 나머지 값들은 `.env` 파일에서 그대로 사용됩니다

```bash
# .env 파일이 있는지 확인
$ ls -la .env

# Docker Compose로 PostgreSQL + 애플리케이션 실행
$ docker-compose up -d

# 로그 확인
$ docker-compose logs -f app

# 서비스 중지
$ docker-compose down

# 데이터베이스 포함 전체 삭제
$ docker-compose down -v
```

### Docker 마이그레이션 수동 실행

```bash
# 애플리케이션 컨테이너에서 마이그레이션 실행 (권장)
$ docker-compose exec app bun run db:migrate

# 또는 안전한 마이그레이션 스크립트 사용
$ docker-compose exec app bun run db:migrate:safe

# 마이그레이션 파일 생성 (스키마 변경 시)
$ docker-compose exec app bun run db:generate

# Drizzle Studio 실행 (로컬에서 Docker DB 접속)
$ bun run db:studio
```

### 프로덕션 서버 마이그레이션

서버에 배포할 때는 다음 명령어로 마이그레이션을 실행하세요:

```bash
# 안전한 마이그레이션 실행 (권장)
$ bun run db:migrate:safe

# 또는 직접 실행
$ bun run db:migrate
```

**중요 사항:**

- 모든 마이그레이션 파일은 **idempotent**하게 작성되어 있어 여러 번 실행해도 안전합니다.
- ENUM 타입, 테이블, 인덱스, 제약조건은 이미 존재하면 자동으로 건너뜁니다.
- 서버의 데이터베이스가 로컬 개발 환경과 동일한 구조로 동기화됩니다.

## Compile and run the project

### 로컬 환경

```bash
# development
$ bun run start

# watch mode
$ bun run start:dev

# production mode
$ bun run start:prod
```

### Docker 환경

```bash
# 개발 모드 (docker-compose.yml 수정 필요)
$ docker-compose up

# 백그라운드 실행
$ docker-compose up -d

# 프로덕션 빌드
$ docker build -t ziggle-chatbot-be .
$ docker run -p 3000:3000 --env-file .env ziggle-chatbot-be
```

서버 실행 후 다음 URL에서 확인할 수 있습니다:

- **API**: http://localhost:3000
- **Swagger 문서**: http://localhost:3000/api/docs

## API 엔드포인트

### 1. Widget Auth (Public)

- `POST /api/v1/widget/auth/session` - 위젯 세션 토큰 발급

### 2. Widget Messages (Public, 인증 필요)

- `GET /api/v1/widget/messages` - 대화 내역 조회 (커서 기반 페이징)
- `POST /api/v1/widget/messages` - 대화 메시지 저장

### 3. Admin Management (Private, IDP 인증 필요)

- `GET /api/v1/admin/widget-keys` - 위젯 키 목록 조회
- `POST /api/v1/admin/widget-keys` - 위젯 키 생성
- `PATCH /api/v1/admin/widget-keys/:widgetKeyId/revoke` - 위젯 키 폐기

### 4. Unanswered Questions (Private, IDP 인증 필요)

참고 문서 0개로 답변된 질문은 위젯 키·질문 단위로 누적됩니다. SUPER_ADMIN은 전체,
그 외 관리자는 자신이 만들었거나 협업자로 초대받은 위젯 키의 질문만 다룹니다.
지식을 주입하면 질문은 바로 해결 처리되고, 그 문서 처리가 실패하면 다시 미해결로
돌아갑니다(문서 연결은 유지되어 재처리에 성공하면 다시 해결 처리).

- `GET /api/v1/admin/unanswered-questions` - 미답변 질문 목록 (기본: 미해결, 검색·상태·정렬)
- `GET /api/v1/admin/unanswered-questions/:id` - 상세 (최근 답변 포함)
- `PATCH /api/v1/admin/unanswered-questions/:id` - 상태 변경 (`open`/`resolved`)
- `POST /api/v1/admin/unanswered-questions/:id/knowledge/text` - 텍스트 지식 주입
- `POST /api/v1/admin/unanswered-questions/:id/knowledge/pdf` - PDF 지식 주입

**인증 방식:** Infoteam IDP OAuth 2.0 (`@gistory.me` 이메일 필수)

자세한 API 스펙은 Swagger 문서를 참고하세요.

## 테스트

### 유닛 테스트

```bash
# 모든 유닛 테스트 실행
$ bun test

# watch 모드
$ bun run test:watch

# 커버리지 확인
$ bun run test:cov

# 특정 파일만 테스트
$ bun test src/admin/admin.service.spec.ts
```

### E2E 테스트

```bash
# E2E 테스트 실행
$ bun run test:e2e

# 모든 테스트 실행 (unit + e2e)
$ bun run test:all
```

### 테스트 커버리지

```bash
# 커버리지 리포트 생성
$ bun run test:cov

# coverage/ 폴더에 HTML 리포트 생성됨
$ open coverage/lcov-report/index.html
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).

## 저장된 chunk 임베딩 자동 복구

앱은 DB 마이그레이션과 HTTP 서버 시작이 끝난 뒤, 임베딩이 없는
`document_chunks`를 백그라운드에서 복구합니다. 기존 문서의 초기 백필과
업로드 중 API 장애로 누락된 임베딩을 같은 워커가 처리합니다.
임베딩 작업이나 API 장애는 HTTP 서버 시작을 막지 않습니다.

| 환경 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `EMBEDDING_BACKFILL_ENABLED` | `true` | 자동 복구 활성화. 검색 설정과 독립적입니다. |
| `EMBEDDING_BACKFILL_INTERVAL_MS` | `300000` | 한 번의 작업이 끝난 뒤 다음 확인까지 대기 시간. 1초~24시간. |
| `EMBEDDING_BACKFILL_BATCH_SIZE` | `64` | DB 조회 및 API 요청 배치 크기. 정수 1~64. |

앱과 같은 DB 설정 및 Letsur 또는 OpenRouter의 URL/API 키 쌍을 사용합니다.
임베딩 설정이 없거나 사용할 수 없는 URL이면 자동 워커는 비활성화됩니다.
기본 모델은 `text-embedding-3-large`이고, 현재 DB는 3072차원입니다.
검색을 끄는 `EMBEDDING_RETRIEVAL_ENABLED=false`는 백필을 끄지 않습니다.

각 실행은 전용 DB 연결의 advisory lock을 얻은 경우에만 진행합니다.
여러 Pod와 수동 CLI 사이에서도 한 실행자만 백필하며, 다른 실행자는
대기하지 않고 건너뜁니다. 연결이 끊기면 작업도 중단합니다.
API 요청 동안 DB 트랜잭션이나 행 잠금을 유지하지 않습니다.

대상은 ID 순서로 제한된 크기만 읽고, 배치별로 저장합니다.
조회 후 chunk 내용이나 문서 제목이 변경되거나 chunk가 삭제되면 해당 결과는
저장하지 않습니다. 기본 실행은 이미 생성된 임베딩을 덮어쓰지 않습니다.
작업 도중 추가된 chunk는 다음 실행에서 처리될 수 있습니다.

입력 오류(413/422 및 입력 관련 코드가 있는 400)는 배치를 나눠 실패한 chunk를
분리합니다. 다른 입력은 계속 처리하고, 실패한 chunk는 다음 실행에서 재시도합니다.
인증·모델 설정 오류, 429, 서버 장애 등은 현재 실행을 중단하고 대기 시간을
두 배씩 늘립니다(최대 1시간, 설정 간격이 더 길면 그 간격).
복구 후에는 기본 간격으로 돌아갑니다.
성공한 배치는 유지되지만 API 응답 후 DB 저장 전에 중단된 배치는 재호출될 수 있습니다.

로그의 `Embedding backfill progress`와 `Embedding backfill complete`에서
조회(`selected`), 저장(`saved`), 입력 실패(`failed`) 건수와 실행 시간을 확인할 수 있습니다.
SIGTERM/SIGINT 또는 앱 종료 시 새 배치를 중단하고 진행 중 API 요청을 취소합니다.

수동 복구도 동일한 처리 로직과 잠금을 사용합니다. 앱의 마이그레이션이 완료된 뒤 실행하세요.

```bash
# 소스 체크아웃에서 실행
bun run db:backfill:embeddings

# 배포 이미지에서 실행 (development의 Webpack 빌드 결과)
kubectl exec -n <namespace> <app-pod> -- bun /app/dist/backfill-chunk-embeddings.js

# Docker Compose
docker compose exec app bun run db:backfill:embeddings:prod

# 기존 임베딩까지 전체 재생성: 명시적인 운영 작업으로만 실행
bun run db:backfill:embeddings --all
```

다른 백필이 실행 중이거나 복구하지 못한 입력이 남으면 수동 CLI는 실패 코드로 종료합니다.
모델 변경 시 동일 차원이더라도 기존 벡터와 새 모델 벡터가 섞이지 않도록 자동 워커를 끄고
전체 재임베딩을 별도로 진행하세요. 차원이 달라지면 먼저 스키마 변경이 필요합니다.

실제 DB 검증은 **빈 테스트 전용 DB**에서 실행합니다. DB 이름은 `_test`로 끝나야 합니다.
외부 임베딩 API를 호출하지 않으며, 고정 벡터로 마이그레이션·잠금·동시 수정 보호를 확인합니다.

```bash
bun run build
EMBEDDING_BACKFILL_TEST_DB=true DB_NAME=embedding_backfill_test \
  bun run test:e2e --runInBand test/embedding-backfill-database.e2e-spec.ts
```

자동 임베딩 복구는 앱이 연결한 DB만 처리합니다. 브랜치별 배포 설정은 유지합니다.
`development` push는 `staging.yml`에서 `dev` 이미지를 만들고 `values.stg.yaml`을 갱신하며,
`v*` 태그는 `production.yml`에서 `prod` 이미지를 만들고 `values.prod.yaml`을 갱신합니다.
최신 기능 코드 동기화 시에도 배포 목적지·인증·관측 설정을 일괄 덮어쓰지 않습니다.
