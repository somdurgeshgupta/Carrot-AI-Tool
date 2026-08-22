import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddKnowledgeSources1787390400000 implements MigrationInterface {
  name = 'AddKnowledgeSources1787390400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE knowledge_sources (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        type varchar(20) NOT NULL,
        title varchar(255) NOT NULL,
        "sourceKey" varchar(512) NOT NULL,
        "originalLocator" text NOT NULL,
        "canonicalUrl" text,
        checksum varchar(64),
        version integer NOT NULL DEFAULT 1,
        status varchar(20) NOT NULL DEFAULT 'PENDING',
        "refreshFrequency" varchar(20) NOT NULL DEFAULT 'MANUAL',
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        "errorMessage" text,
        "lastIndexedAt" timestamp,
        "lastCheckedAt" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_knowledge_sources_user" FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT "UQ_knowledge_sources_user_key" UNIQUE ("userId", "sourceKey")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_knowledge_sources_user" ON knowledge_sources ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_knowledge_sources_status" ON knowledge_sources (status)`,
    );
    await queryRunner.query(
      `ALTER TABLE document_chunks ADD COLUMN "sourceId" uuid`,
    );
    await queryRunner.query(`
      INSERT INTO knowledge_sources (
        "userId", type, title, "sourceKey", "originalLocator", status,
        metadata, "lastIndexedAt", "lastCheckedAt", "createdAt", "updatedAt"
      )
      SELECT
        "userId",
        CASE WHEN "fileName" LIKE 'web-%' THEN 'WEBSITE' ELSE 'FILE' END,
        "fileName",
        "fileName",
        "fileName",
        'READY',
        jsonb_build_object('migratedFromLegacyChunks', true),
        max("createdAt"),
        max("createdAt"),
        min("createdAt"),
        max("createdAt")
      FROM document_chunks
      GROUP BY "userId", "fileName"
    `);
    await queryRunner.query(`
      UPDATE document_chunks chunk
      SET "sourceId" = source.id
      FROM knowledge_sources source
      WHERE source."userId" = chunk."userId" AND source."sourceKey" = chunk."fileName"
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_document_chunks_source" ON document_chunks ("sourceId")`,
    );
    await queryRunner.query(`
      ALTER TABLE document_chunks
      ADD CONSTRAINT "FK_document_chunks_source"
      FOREIGN KEY ("sourceId") REFERENCES knowledge_sources(id) ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE document_chunks DROP CONSTRAINT IF EXISTS "FK_document_chunks_source"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_document_chunks_source"`,
    );
    await queryRunner.query(
      `ALTER TABLE document_chunks DROP COLUMN IF EXISTS "sourceId"`,
    );
    await queryRunner.query(`DROP TABLE knowledge_sources`);
  }
}
