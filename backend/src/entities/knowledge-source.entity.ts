import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DocumentChunkEntity } from './document-chunk.entity';

export enum KnowledgeSourceType {
  FILE = 'FILE',
  WEBSITE = 'WEBSITE',
  SITEMAP = 'SITEMAP',
  TEXT = 'TEXT',
}
export enum KnowledgeSourceStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  READY = 'READY',
  FAILED = 'FAILED',
  REFRESHING = 'REFRESHING',
  DISABLED = 'DISABLED',
}
export enum KnowledgeRefreshFrequency {
  MANUAL = 'MANUAL',
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
}
export enum KnowledgeSourceVisibility {
  PRIVATE = 'PRIVATE',
  PUBLIC = 'PUBLIC',
}

@Entity('knowledge_sources')
@Index(['userId', 'sourceKey'], { unique: true })
export class KnowledgeSourceEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid', nullable: true }) @Index() userId: string | null;
  @Column({
    type: 'varchar',
    length: 10,
    default: KnowledgeSourceVisibility.PRIVATE,
  })
  @Index()
  visibility: KnowledgeSourceVisibility;
  @Column({ type: 'varchar', length: 64, nullable: true }) publicKey:
    string | null;
  @Column({ type: 'varchar', length: 20 }) type: KnowledgeSourceType;
  @Column({ type: 'varchar', length: 255 }) title: string;
  @Column({ type: 'varchar', length: 512 }) sourceKey: string;
  @Column({ type: 'text' }) originalLocator: string;
  @Column({ type: 'text', nullable: true }) canonicalUrl: string | null;
  @Column({ type: 'varchar', length: 64, nullable: true }) checksum:
    string | null;
  @Column({ type: 'integer', default: 1 }) version: number;
  @Column({
    type: 'varchar',
    length: 20,
    default: KnowledgeSourceStatus.PENDING,
  })
  @Index()
  status: KnowledgeSourceStatus;
  @Column({
    type: 'varchar',
    length: 20,
    default: KnowledgeRefreshFrequency.MANUAL,
  })
  refreshFrequency: KnowledgeRefreshFrequency;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) metadata: Record<
    string,
    unknown
  >;
  @Column({ type: 'text', nullable: true }) errorMessage: string | null;
  @Column({ type: 'timestamp', nullable: true }) lastIndexedAt: Date | null;
  @Column({ type: 'timestamp', nullable: true }) lastCheckedAt: Date | null;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
  @OneToMany(() => DocumentChunkEntity, (chunk) => chunk.source)
  chunks: DocumentChunkEntity[];
}
