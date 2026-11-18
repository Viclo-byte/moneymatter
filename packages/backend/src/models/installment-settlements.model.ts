import { IdColumn } from '@common/types/id-column';
import { Table, Column, Model, DataType } from 'sequelize-typescript';

export interface SettlementSnapshot {
  principal: number;
  interest: number;
  total: number;
  sourceAccountId: string;
  destinationAccountId: string | null;
  currencyCode: string;
  transferId: string | null;
  principalTransactionId: string | null;
  interestTransactionId: string | null;
  cancelledItemIds: string[];
  itemBeforePayoff?: { principal: number; interest: number; total: number };
}

@Table({ tableName: 'InstallmentSettlements', timestamps: true, freezeTableName: true })
export default class InstallmentSettlements extends Model {
  @Column(IdColumn()) declare id: string;
  @Column({ type: DataType.UUID, allowNull: false, references: { model: 'InstallmentPlans', key: 'id' } })
  declare planId: string;
  @Column({ type: DataType.UUID, allowNull: false, references: { model: 'InstallmentScheduleItems', key: 'id' } })
  declare itemId: string;
  @Column({ type: DataType.UUID, allowNull: false, references: { model: 'SubscriptionPeriods', key: 'id' } })
  declare periodId: string;
  @Column({ type: DataType.INTEGER, allowNull: false }) declare generation: number;
  @Column({ type: DataType.STRING(20), allowNull: false }) declare state: 'settled' | 'reverting' | 'reverted';
  @Column({ type: DataType.JSONB, allowNull: false }) declare transactionIds: string[];
  @Column({ type: DataType.JSONB, allowNull: false }) declare snapshot: SettlementSnapshot;
}
