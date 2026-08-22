import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum IngestionJobType {
  FILE = 'FILE',
  WEBSITE = 'WEBSITE',
  SITEMAP = 'SITEMAP',
}
export enum IngestionJobStatus {
  QUEUED = 'QUEUED',
  PROCESSING = 'PROCESSING',
  RETRYING = 'RETRYING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

@Entity('ingestion_jobs')
export class IngestionJobEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) @Index() userId: string;
  @Column({ type: 'varchar', length: 20 }) type: IngestionJobType;
  @Column({ type: 'varchar', length: 20, default: IngestionJobStatus.QUEUED })
  @Index()
  status: IngestionJobStatus;
  @Column({ type: 'varchar', length: 512 }) inputLabel: string;
  @Column({ type: 'integer', default: 0 }) progress: number;
  @Column({ type: 'integer', default: 0 }) attempts: number;
  @Column({ type: 'boolean', default: false }) cancelRequested: boolean;
  @Column({ type: 'uuid', nullable: true }) sourceId: string | null;
  @Column({ type: 'jsonb', nullable: true }) result: Record<
    string,
    unknown
  > | null;
  @Column({ type: 'text', nullable: true }) errorMessage: string | null;
  @Column({ type: 'timestamp', nullable: true }) startedAt: Date | null;
  @Column({ type: 'timestamp', nullable: true }) completedAt: Date | null;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
