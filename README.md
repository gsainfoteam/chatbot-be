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
# ⚠️ 보안 요구사항: 최소 32자 이상의 강력한 시크릿 키 필요
# 프로덕션에서는 반드시 안전한 랜덤 문자열로 변경하세요
# 생성 방법: openssl rand -base64 32
JWT_SECRET=your-secret-key-here-change-in-production-min-32-chars
JWT_EXPIRES_IN=3600

# Admin Authentication
# ⚠️ 보안 요구사항: 최소 16자 이상의 강력한 토큰 필요
# 프로덕션에서는 반드시 안전한 랜덤 문자열로 변경하세요
# 생성 방법: openssl rand -base64 24
ADMIN_BEARER_TOKEN=your-admin-token-here-change-in-production-min-16-chars
```

### 🔒 보안 주의사항

**프로덕션 배포 전 필수 체크리스트:**

1. **JWT_SECRET**: 최소 32자 이상의 강력한 랜덤 문자열 사용
2. **ADMIN_BEARER_TOKEN**: 최소 16자 이상의 강력한 랜덤 토큰 사용
3. 취약한 기본값(`default-secret-key`, `secret`, `test` 등) 사용 금지
4. 환경 변수가 올바르게 설정되지 않으면 애플리케이션이 시작되지 않습니다

**안전한 시크릿 생성 방법:**
```bash
# JWT Secret 생성 (최소 32자)
openssl rand -base64 32

# Admin Token 생성 (최소 16자)
openssl rand -base64 24
```

## Database Setup

### 로컬 개발 환경

```bash
# PostgreSQL이 설치되어 있어야 합니다
# 데이터베이스 생성
$ psql -U postgres -c "CREATE DATABASE ziggle_chatbot;"

# 마이그레이션 파일 생성 (스키마 변경 시)
$ bun run db:generate

# 스키마를 데이터베이스에 적용
$ bun run db:push

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
# 애플리케이션 컨테이너에서 마이그레이션 실행
$ docker-compose exec app bun run db:push

# 마이그레이션 파일 생성
$ docker-compose exec app bun run db:generate

# Drizzle Studio 실행 (로컬에서 Docker DB 접속)
$ bun run db:studio
```

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

### 3. Admin Management (Private, 관리자 토큰 필요)
- `GET /api/v1/admin/widget-keys` - 위젯 키 목록 조회
- `POST /api/v1/admin/widget-keys` - 위젯 키 생성
- `PATCH /api/v1/admin/widget-keys/:widgetKeyId/revoke` - 위젯 키 폐기

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
