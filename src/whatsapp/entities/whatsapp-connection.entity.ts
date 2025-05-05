import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity({ name:'WhatsappConnection'})
export class WhatsappConnection {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  @Index()
  phoneNumber: string;

  @Column({ default: 'disconnected' })
  @Index()
  status: string;

  @Column({ nullable: true })
  qrCodeUrl: string;

  @Column({ type: 'text', nullable: true })
  sessionData: string;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @Column({ type: 'timestamp', nullable: true, onUpdate: 'CURRENT_TIMESTAMP' })
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  deletedAt: Date;
}