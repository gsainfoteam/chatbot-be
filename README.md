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
JWT_SECRET=your-secret-key-here-change-in-production
JWT_EXPIRES_IN=3600

# Admin Authentication
ADMIN_BEARER_TOKEN=your-admin-token-here-change-in-production
```

## Database Setup

```bash
# 마이그레이션 파일 생성
$ bun run db:generate

# 마이그레이션 실행 (스키마 적용)
$ bun run db:push

# Drizzle Studio 실행 (데이터베이스 GUI)
$ bun run db:studio
```

## Compile and run the project

```bash
# development
$ bun run start

# watch mode
$ bun run start:dev

# production mode
$ bun run start:prod
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

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
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
