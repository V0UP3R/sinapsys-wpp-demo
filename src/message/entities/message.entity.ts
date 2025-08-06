import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity({ name: 'PendingConfirmation' })
export class PendingConfirmation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  appointmentId: number;

  @Column()
  phone: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamp' })
  expiresAt: Date;
}