import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { KnowledgeSourceEntity } from './knowledge-source.entity';

@Entity('user_knowledge_sources')
@Index(['userId', 'sourceId'], { unique: true })
export class UserKnowledgeSourceEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) @Index() userId: string;
  @Column({ type: 'uuid' }) @Index() sourceId: string;
  @Column({ type: 'boolean', default: true }) enabled: boolean;
  @CreateDateColumn() createdAt: Date;
  @ManyToOne(() => KnowledgeSourceEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sourceId' })
  source: KnowledgeSourceEntity;
}
