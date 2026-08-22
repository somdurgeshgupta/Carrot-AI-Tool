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

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

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
# Redis-accelerated knowledge retrieval

Redis is an optional cache; PostgreSQL remains the source of truth. Set
`REDIS_URL` in the environment (see `.env.example`) and run a Redis-compatible
server to cache repeated retrieval results, query embeddings, and bounded user
memory. If Redis is unavailable, the backend starts and retrieves normally.
The client reconnects automatically with capped exponential backoff; the health
endpoint reports cache connection state, reconnect attempts, hits, misses,
errors, and cache-operation latency without exposing the Redis URL.

Start the bundled local Redis service from the repository root:

```powershell
docker compose up -d redis
docker compose ps
```

The Compose stack also provides PostgreSQL 18 with pgvector. Existing native
PostgreSQL data should be exported with the migration profile before starting
the container on port 5432. The migration dump is retained in a named Docker
volume until it is deliberately removed after validation.

Authenticated knowledge ingestion endpoints:

- `POST /api/rag/upload` indexes an uploaded document.
- `POST /api/rag/website` with `{ "url": "https://example.com/page" }` indexes
  readable content from a public HTTP(S) page. Local/private network targets and
  unvalidated redirects are rejected.
- `GET /api/rag/sources` lists only the authenticated user's knowledge sources,
  including type, version, lifecycle status, refresh policy, timestamps, and
  non-sensitive ingestion metadata.

Every newly indexed file or website has a durable Knowledge Source record.
Chunks reference that source, and synchronous ingestion records the
`PENDING -> PROCESSING -> READY` lifecycle (or `FAILED` with a bounded error).
Checksum-based unchanged-content detection is intentionally handled by the next
phase rather than being mixed into this schema migration.

Public website knowledge is shared safely: a canonical public URL has one
global source and chunk set, while `user_knowledge_sources` records which users
have enabled it. Adding an already-ready URL reuses its chunks without fetching
or embedding again. Removing it only unsubscribes that user. Uploaded files and
text remain private, and retrieval still requires either ownership or an
enabled public-source subscription.

Before embedding, content is normalized deterministically and hashed with
SHA-256. Re-uploading an unchanged private file reuses its existing chunks and
does not increment the source version. Changed content advances the version and
is embedded again. Public pages retain one checksum per canonical source;
scheduled changed-page checks are added by the refresh phase.

## Background ingestion

File and website ingestion returns HTTP `202` with a durable PostgreSQL job
record. BullMQ workers perform parsing, crawling, chunking, embedding, and
database writes outside the request path. Clients can poll
`GET /api/rag/ingestion/:jobId` or request cancellation with
`DELETE /api/rag/ingestion/:jobId`. Jobs record queued, processing, retrying,
completed, failed, and cancelled states plus progress and bounded errors.

Redis remains disposable: if it is unavailable, new ingestion requests return
a controlled `503` while chat, existing retrieval, authentication, and the rest
of the backend continue. File payloads are staged under the uploads directory,
validated against path escape, and deleted after completion, terminal failure,
or cancellation. Retry count, backoff, and concurrency are configurable through
the corresponding `INGESTION_*` environment values.

`POST /api/rag/sitemap` queues bounded sitemap ingestion. It accepts only
public HTTP(S) targets, reads at most 1 MB of sitemap XML, keeps same-origin
pages, normalizes and deduplicates URLs, respects robots.txt directives, and
indexes at most `SITEMAP_MAX_PAGES` (hard capped at 25). Individual pages retain
the existing 10-second timeout and 2 MB content limit. JavaScript-rendered pages
are intentionally deferred to avoid introducing an unrestricted browser crawler.

## Database migrations and PostgreSQL vector search

Production schema changes are version-controlled and `synchronize` is disabled.
Run pending migrations before starting a newly deployed backend:

```powershell
npm.cmd run migration:show
npm.cmd run migration:run
npm.cmd run migration:revert
npm.cmd run migration:generate -- src/database/migrations/DescriptiveName
```

Carrot AI uses a native PostgreSQL `vector(768)` column and an HNSW cosine
index. The first production migration safely converts compatible legacy JSON
embeddings and refuses to discard embeddings with another dimension. The SQL
helper in `sql/enable-pgvector.sql` is intended only for inspecting or preparing
a fresh database; normal deployments must use TypeORM migrations.

After enabling pgvector, re-upload older documents that contain legacy
384-dimensional fallback embeddings so they can use the vector index.
