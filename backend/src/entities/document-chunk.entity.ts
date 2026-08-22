import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { KnowledgeSourceEntity } from './knowledge-source.entity';

@Entity('document_chunks')
export class DocumentChunkEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  userId: string | null;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  fileName: string;

  @Column({ type: 'varchar', length: 50, default: 'txt' })
  fileType: string;

  @Column({ type: 'int', default: 0 })
  chunkIndex: number;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'vector', length: 768, nullable: true })
  embedding: number[];

  @Column({ type: 'uuid', nullable: true })
  @Index()
  sourceId: string | null;

  @ManyToOne(() => KnowledgeSourceEntity, (source) => source.chunks, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'sourceId' })
  source: KnowledgeSourceEntity | null;

  @CreateDateColumn()
  createdAt: Date;
}
