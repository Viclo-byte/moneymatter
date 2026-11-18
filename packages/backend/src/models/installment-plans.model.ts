import type { InstallmentPlanInput } from '@bt/shared/types';
import { IdColumn } from '@common/types/id-column';
import { Money } from '@common/types/money';
import { MoneyField } from '@common/types/money-column';
import { Table, Column, Model, DataType } from 'sequelize-typescript';

@Table({ tableName: 'InstallmentPlans', timestamps: true, freezeTableName: true })
export default class InstallmentPlans extends Model {
  @Column(IdColumn()) declare id: string;
  @Column({ type: DataType.UUID, allowNull: false, unique: true, references: { model: 'Subscriptions', key: 'id' } })
  declare subscriptionId: string;
  @Column({ type: DataType.UUID, allowNull: false, references: { model: 'Accounts', key: 'id' } })
  declare sourceAccountId: string;
  @Column({ type: DataType.STRING(3), allowNull: false }) declare currencyCode: string;
  @MoneyField({ storage: 'cents', allowNull: false }) declare totalPrincipal: Money;
  @Column({ type: DataType.INTEGER, allowNull: false }) declare revision: number;
  @Column({ type: DataType.JSONB, allowNull: false }) declare configuration: InstallmentPlanInput;
}
