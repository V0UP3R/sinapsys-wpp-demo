import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity({ name: 'PendingConfirmation' })
export class PendingConfirmation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  appointmentId: number;

  @Column()
  phone: string;
}