export interface InstallmentAmounts {
  principal: number;
  interest: number;
  total: number;
}

export interface InstallmentScheduleInput extends InstallmentAmounts {
  dueDate?: string;
}

export interface InstallmentPlanInput {
  revision: number;
  totalPrincipal: number;
  mode: 'fixed' | 'custom';
  regular: InstallmentAmounts;
  first?: InstallmentScheduleInput;
  last?: { interest: number; principal?: number; total?: number; dueDate?: string };
  schedule?: InstallmentScheduleInput[];
  sourceAccountId?: string;
  linkedSettlementEnabled: boolean;
  destinationAccountId?: string | null;
  interestCategoryId?: string | null;
}

export interface InstallmentScheduleItem extends InstallmentAmounts {
  id: string;
  occurrenceNumber: number;
  dueDate: string;
  status: 'pending' | 'paid' | 'cancelled';
  periodId: string | null;
  generation: number;
}

export interface InstallmentPlanDetail {
  revision: number;
  currencyCode: string;
  sourceAccountId: string;
  totalPrincipal: number;
  configuration: InstallmentPlanInput;
  items: InstallmentScheduleItem[];
}
