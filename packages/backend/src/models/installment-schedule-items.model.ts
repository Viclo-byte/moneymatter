import { IdColumn } from '@common/types/id-column';
import { Money } from '@common/types/money';
import { MoneyField } from '@common/types/money-column';
import { Table, Column, Model, DataType } from 'sequelize-typescript';

@Table({ tableName: 'InstallmentScheduleItems', timestamps: true, freezeTableName: true })
export default class InstallmentScheduleItems extends Model {
  @Column(IdColumn()) declare id: string;
  @Column({ type: DataType.UUID, allowNull: false, references: { model: 'InstallmentPlans', key: 'id' } })
  declare planId: string;
  @Column({ type: DataType.INTEGER, allowNull: false }) declare occurrenceNumber: number;
  @Column({ type: DataType.DATEONLY, allowNull: false }) declare dueDate: string;
  @MoneyField({ storage: 'cents', allowNull: false }) declare principal: Money;
  @MoneyField({ storage: 'cents', allowNull: false }) declare interest: Money;
  @MoneyField({ storage: 'cents', allowNull: false }) declare total: Money;
  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'pending' }) declare status:
    | 'pending'
    | 'paid'
    | 'cancelled';
  @Column({ type: DataType.UUID, allowNull: true, references: { model: 'SubscriptionPeriods', key: 'id' } })
  declare periodId: string | null;
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 }) declare generation: number;
}
