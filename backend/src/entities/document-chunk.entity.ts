import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('document_chunks')
export class DocumentChunkEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  userId: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  fileName: string;

  @Column({ type: 'varchar', length: 50, default: 'txt' })
  fileType: string;

  @Column({ type: 'int', default: 0 })
  chunkIndex: number;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'json', nullable: true })
  embedding: number[];

  @CreateDateColumn()
  createdAt: Date;
}
