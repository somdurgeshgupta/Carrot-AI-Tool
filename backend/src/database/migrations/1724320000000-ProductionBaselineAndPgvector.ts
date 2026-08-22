import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProductionBaselineAndPgvector1724320000000 implements MigrationInterface {
  name = 'ProductionBaselineAndPgvector1724320000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        email varchar NOT NULL UNIQUE,
        "passwordHash" varchar NOT NULL,
        name varchar,
        "createdAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        title varchar NOT NULL,
        "modelId" varchar NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        "userId" uuid REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        role varchar(20) NOT NULL,
        content text NOT NULL,
        "modelId" varchar,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "sessionId" uuid REFERENCES chat_sessions(id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS document_chunks (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "fileName" varchar(255) NOT NULL,
        "fileType" varchar(50) NOT NULL DEFAULT 'txt',
        "chunkIndex" integer NOT NULL DEFAULT 0,
        content text NOT NULL,
        embedding vector(768),
        "createdAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_5f83d5f7cb243fc77f4865a0b2" ON document_chunks ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_f30a0804a98edafb61d22bf4bc" ON document_chunks ("fileName")`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS document_chunks_embedding_hnsw`,
    );
    await queryRunner.query(`
      DO $$
      DECLARE embedding_type text;
      BEGIN
        SELECT data_type INTO embedding_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'document_chunks' AND column_name = 'embedding';

        IF embedding_type IN ('json', 'jsonb') THEN
          IF EXISTS (
            SELECT 1 FROM document_chunks
            WHERE embedding IS NOT NULL AND json_array_length(embedding::json) <> 768
          ) THEN
            RAISE EXCEPTION 'Cannot migrate embeddings: non-768-dimensional rows must be re-embedded first';
          END IF;
          ALTER TABLE document_chunks
            ALTER COLUMN embedding TYPE vector(768)
            USING CASE WHEN embedding IS NULL THEN NULL ELSE embedding::text::vector(768) END;
        END IF;
      END $$
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS document_chunks_embedding_hnsw
      ON document_chunks USING hnsw (embedding vector_cosine_ops)
      WHERE embedding IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS document_chunks_embedding_hnsw`,
    );
    await queryRunner.query(`
      ALTER TABLE document_chunks
      ALTER COLUMN embedding TYPE json
      USING CASE WHEN embedding IS NULL THEN NULL ELSE embedding::text::json END
    `);
  }
}
