import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIngestionJobs1787397600000 implements MigrationInterface {
  name = 'AddIngestionJobs1787397600000';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE ingestion_jobs (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type varchar(20) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'QUEUED',
        "inputLabel" varchar(512) NOT NULL,
        progress integer NOT NULL DEFAULT 0,
        attempts integer NOT NULL DEFAULT 0,
        "cancelRequested" boolean NOT NULL DEFAULT false,
        "sourceId" uuid REFERENCES knowledge_sources(id) ON DELETE SET NULL,
        result jsonb,
        "errorMessage" text,
        "startedAt" timestamp,
        "completedAt" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_ingestion_jobs_user" ON ingestion_jobs ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ingestion_jobs_status" ON ingestion_jobs (status)`,
    );
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE ingestion_jobs`);
  }
}
