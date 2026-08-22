import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSharedPublicKnowledge1787394000000 implements MigrationInterface {
  name = 'AddSharedPublicKnowledge1787394000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE knowledge_sources ALTER COLUMN "userId" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE knowledge_sources ADD COLUMN visibility varchar(10) NOT NULL DEFAULT 'PRIVATE'`,
    );
    await queryRunner.query(
      `ALTER TABLE knowledge_sources ADD COLUMN "publicKey" varchar(64)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_knowledge_sources_visibility" ON knowledge_sources (visibility)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_knowledge_sources_public_key" ON knowledge_sources ("publicKey") WHERE "publicKey" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE document_chunks ALTER COLUMN "userId" DROP NOT NULL`,
    );
    await queryRunner.query(`
      CREATE TABLE user_knowledge_sources (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "sourceId" uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        enabled boolean NOT NULL DEFAULT true,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_user_knowledge_source" UNIQUE ("userId", "sourceId")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_user_knowledge_sources_user" ON user_knowledge_sources ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_user_knowledge_sources_source" ON user_knowledge_sources ("sourceId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE user_knowledge_sources`);
    await queryRunner.query(
      `ALTER TABLE document_chunks ALTER COLUMN "userId" SET NOT NULL`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_knowledge_sources_public_key"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_knowledge_sources_visibility"`,
    );
    await queryRunner.query(
      `ALTER TABLE knowledge_sources DROP COLUMN "publicKey"`,
    );
    await queryRunner.query(
      `ALTER TABLE knowledge_sources DROP COLUMN visibility`,
    );
    await queryRunner.query(
      `ALTER TABLE knowledge_sources ALTER COLUMN "userId" SET NOT NULL`,
    );
  }
}
