<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { loadSystemCategories } from '@/api/categories';
import {
  saveInstallmentPlan,
  editInstallmentItem,
  payoffInstallment,
  type SubscriptionDetail,
} from '@/api/subscriptions';
import { api } from '@/api/_api';
import { useAccountsStore } from '@/stores';
import { useInvalidateSubscriptionQueries } from '@/composable/data-queries/subscriptions';
import { VUE_QUERY_GLOBAL_PREFIXES } from '@/common/const';
import { ApiErrorResponseError } from '@/js/errors';
import Button from '@/components/lib/ui/button/Button.vue';
import type { InstallmentAmounts, InstallmentPlanInput, InstallmentScheduleInput } from '@bt/shared/types';
import { ACCOUNT_TYPES, ACCOUNT_CATEGORIES, ACCOUNT_STATUSES } from '@bt/shared/types';
import Big from 'big.js';

const props = defineProps<{ subscription: SubscriptionDetail }>();
const { t } = useI18n();
const accounts = useAccountsStore();
const invalidate = useInvalidateSubscriptionQueries();
const queryClient = useQueryClient();
const { data: categories } = useQuery({ queryKey: ['installment-interest-categories'], queryFn: loadSystemCategories });
const plan = computed(() => props.subscription.installmentPlan);
const hasPaid = computed(() => plan.value?.items.some((item) => item.status === 'paid') ?? false);
const open = ref(false);
const busy = ref(false);
const error = ref('');
const payoffOpen = ref(false);
const fee = ref(0);
const payoffPrincipal = ref(0);
const editId = ref<string | null>(null);
const edit = ref({ principal: 0, interest: 0, total: 0, dueDate: '' });
const draft = ref<InstallmentPlanInput>({
  revision: 0,
  totalPrincipal: 0,
  mode: 'fixed',
  regular: { principal: 0, interest: 0, total: 0 },
  first: { principal: 0, interest: 0, total: 0 },
  last: { interest: 0 },
  linkedSettlementEnabled: false,
  destinationAccountId: null,
  interestCategoryId: null,
});
const customRows = ref<InstallmentScheduleInput[]>([]);
const remaining = computed(() =>
  Number(
    (plan.value?.items ?? [])
      .filter((i) => i.status === 'pending')
      .reduce((sum, i) => sum.plus(i.principal), new Big(0))
      .toString(),
  ),
);
const remainingTotal = computed(() =>
  (plan.value?.items ?? [])
    .filter((i) => i.status === 'pending')
    .reduce((sum, i) => sum.plus(i.total), new Big(0))
    .toFixed(2),
);
const current = computed(() => plan.value?.items.find((i) => i.status === 'pending'));
const sourceAccounts = computed(() =>
  (accounts.accounts ?? []).filter(
    (a) =>
      a.type === ACCOUNT_TYPES.system &&
      a.status === ACCOUNT_STATUSES.active &&
      a.currencyCode === props.subscription.expectedCurrencyCode &&
      a.accountCategory !== ACCOUNT_CATEGORIES.loan &&
      a.accountCategory !== ACCOUNT_CATEGORIES.vehicle,
  ),
);
const destinations = computed(() =>
  (accounts.accounts ?? []).filter(
    (a) =>
      a.id !== (draft.value.sourceAccountId ?? props.subscription.accountId) &&
      a.type === ACCOUNT_TYPES.system &&
      a.status === ACCOUNT_STATUSES.active &&
      a.currencyCode === props.subscription.expectedCurrencyCode &&
      a.accountCategory !== ACCOUNT_CATEGORIES.loan &&
      a.accountCategory !== ACCOUNT_CATEGORIES.vehicle,
  ),
);
const amountFields = ['principal', 'interest', 'total'] as const;
const seed = () => {
  const stored = plan.value;
  if (stored) {
    draft.value = JSON.parse(
      JSON.stringify({ ...stored.configuration, revision: stored.revision, sourceAccountId: stored.sourceAccountId }),
    );
    if (stored.items.some((item) => item.status === 'paid')) draft.value.mode = 'custom';
    customRows.value = stored.items.map((i) => ({
      principal: i.principal,
      interest: i.interest,
      total: i.total,
      dueDate: i.dueDate,
    }));
  } else {
    const total = props.subscription.expectedAmount ?? 0;
    const amounts = { principal: total, interest: 0, total };
    draft.value = {
      revision: 0,
      sourceAccountId: props.subscription.accountId ?? undefined,
      totalPrincipal: Number(new Big(total).times(props.subscription.maxOccurrences ?? 1).toString()),
      mode: 'fixed',
      regular: { ...amounts },
      first: { ...amounts, dueDate: props.subscription.dueDate ?? undefined },
      last: { interest: 0 },
      linkedSettlementEnabled: false,
      destinationAccountId: null,
      interestCategoryId: null,
    };
  }
};
watch(() => props.subscription.installmentPlan, seed, { immediate: true });
async function run(action: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await action();
    invalidate();
    await queryClient.invalidateQueries({ queryKey: [VUE_QUERY_GLOBAL_PREFIXES.transactionChange] });
    editId.value = null;
    payoffOpen.value = false;
  } catch (e) {
    error.value =
      e instanceof ApiErrorResponseError
        ? (e.data.message ?? t('errors.api.unexpectedError'))
        : t('errors.api.unexpectedError');
  } finally {
    busy.value = false;
  }
}
async function preview() {
  await run(async () => {
    const result = await api.post(`/subscriptions/${props.subscription.id}/installment-plan/preview`, {
      ...draft.value,
      mode: 'fixed',
    });
    customRows.value = result as InstallmentScheduleInput[];
    draft.value.mode = 'custom';
  });
}
function save() {
  return run(async () => {
    const input = {
      ...draft.value,
      ...(draft.value.mode === 'custom' ? { schedule: customRows.value } : { schedule: undefined }),
    };
    await saveInstallmentPlan(props.subscription.id, input);
    open.value = false;
  });
}
function startEdit(item: { id: string; principal: number; interest: number; total: number; dueDate: string }) {
  editId.value = item.id;
  edit.value = { principal: item.principal, interest: item.interest, total: item.total, dueDate: item.dueDate };
}
function saveRow() {
  if (plan.value && editId.value)
    void run(() =>
      editInstallmentItem(props.subscription.id, editId.value!, { ...edit.value, revision: plan.value!.revision }),
    );
}
function confirmPayoff() {
  if (plan.value && current.value)
    void run(() =>
      payoffInstallment(props.subscription.id, {
        revision: plan.value!.revision,
        generation: current.value!.generation,
        principal: payoffPrincipal.value,
        interest: fee.value,
      }),
    );
}
</script>

<template>
  <section class="bg-card mb-6 min-w-0 rounded-lg border p-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 class="font-semibold">{{ t('planned.subscriptions.installment.title') }}</h2>
      <Button variant="outline" size="sm" :disabled="busy" @click="open = !open">{{
        t('planned.subscriptions.installment.configure')
      }}</Button>
    </div>
    <p class="text-muted-foreground mt-2 text-sm">{{ t('planned.subscriptions.installment.direction') }}</p>
    <p v-if="error" class="text-destructive mt-3" role="alert">{{ error }}</p>
    <form v-if="open" class="mt-4 grid gap-4" @submit.prevent="save">
      <p class="text-muted-foreground text-sm">{{ t('planned.subscriptions.installment.requirements') }}</p>
      <label class="grid gap-1 text-sm"
        >{{ t('planned.subscriptions.installment.source')
        }}<select v-model="draft.sourceAccountId" :disabled="hasPaid" required class="bg-background rounded border p-2">
          <option v-for="account in sourceAccounts" :key="account.id" :value="account.id">{{ account.name }}</option>
        </select></label
      >
      <label class="grid gap-1 text-sm"
        >{{ t('planned.subscriptions.installment.totalPrincipal')
        }}<input
          v-model.number="draft.totalPrincipal"
          :disabled="hasPaid"
          type="number"
          min="0.01"
          step="0.01"
          required
          class="bg-background rounded border p-2"
      /></label>
      <label class="grid gap-1 text-sm"
        >{{ t('planned.subscriptions.installment.mode')
        }}<select v-model="draft.mode" :disabled="hasPaid" class="bg-background rounded border p-2">
          <option value="fixed">{{ t('planned.subscriptions.installment.fixed') }}</option>
          <option value="custom">{{ t('planned.subscriptions.installment.custom') }}</option>
        </select></label
      >
      <template v-if="draft.mode === 'fixed'">
        <fieldset v-for="kind in ['first', 'regular'] as const" :key="kind" class="rounded border p-3">
          <legend>{{ t(`planned.subscriptions.installment.${kind}`) }}</legend>
          <div v-if="draft[kind]" class="grid gap-3 sm:grid-cols-3">
            <label v-for="field in amountFields" :key="field" class="grid gap-1 text-sm"
              >{{ t(`planned.subscriptions.installment.${field}`)
              }}<input
                v-model.number="(draft[kind] as InstallmentAmounts)[field]"
                type="number"
                min="0"
                step="0.01"
                required
                class="bg-background rounded border p-2"
            /></label>
          </div>
        </fieldset>
        <label v-if="draft.first" class="grid gap-1 text-sm"
          >{{ t('planned.subscriptions.installment.firstDate')
          }}<input v-model="draft.first.dueDate" type="date" required class="bg-background rounded border p-2"
        /></label>
        <label v-if="draft.last" class="grid gap-1 text-sm"
          >{{ t('planned.subscriptions.installment.lastInterest')
          }}<input
            v-model.number="draft.last.interest"
            type="number"
            min="0"
            step="0.01"
            required
            class="bg-background rounded border p-2"
        /></label>
        <p class="text-muted-foreground text-sm">{{ t('planned.subscriptions.installment.lastResidual') }}</p>
        <Button type="button" variant="outline" :disabled="busy" @click="preview">{{
          t('planned.subscriptions.installment.previewCustom')
        }}</Button>
      </template>
      <template v-else>
        <Button v-if="!customRows.length" type="button" variant="outline" :disabled="busy" @click="preview">{{
          t('planned.subscriptions.installment.previewCustom')
        }}</Button>
        <div v-for="(row, index) in customRows" :key="index" class="grid gap-2 rounded border p-3 sm:grid-cols-4">
          <label class="grid text-sm"
            >{{ t('planned.subscriptions.installment.occurrence', { number: index + 1 })
            }}<input
              v-model="row.dueDate"
              type="date"
              required
              class="bg-background rounded border p-2"
              :disabled="plan?.items[index]?.status === 'paid'"
          /></label>
          <label v-for="field in amountFields" :key="field" class="grid text-sm"
            >{{ t(`planned.subscriptions.installment.${field}`)
            }}<input
              v-model.number="row[field]"
              type="number"
              min="0"
              step="0.01"
              required
              class="bg-background rounded border p-2"
              :disabled="plan?.items[index]?.status === 'paid'"
          /></label>
        </div>
      </template>
      <label class="flex items-center gap-2"
        ><input v-model="draft.linkedSettlementEnabled" :disabled="hasPaid" type="checkbox" />{{
          t('planned.subscriptions.installment.linked')
        }}</label
      >
      <template v-if="draft.linkedSettlementEnabled">
        <label class="grid gap-1 text-sm"
          >{{ t('planned.subscriptions.installment.destination')
          }}<select
            v-model="draft.destinationAccountId"
            :disabled="hasPaid"
            required
            class="bg-background rounded border p-2"
          >
            <option v-for="account in destinations" :key="account.id" :value="account.id">{{ account.name }}</option>
          </select></label
        >
        <label class="grid gap-1 text-sm"
          >{{ t('planned.subscriptions.installment.interestCategory')
          }}<select
            v-model="draft.interestCategoryId"
            :disabled="hasPaid"
            required
            class="bg-background rounded border p-2"
          >
            <option v-for="category in categories" :key="category.id" :value="category.id">{{ category.name }}</option>
          </select></label
        >
      </template>
      <div class="flex gap-2">
        <Button type="submit" :disabled="busy || (draft.mode === 'custom' && !customRows.length)">{{
          t('planned.subscriptions.installment.save')
        }}</Button
        ><Button type="button" variant="ghost" :disabled="busy" @click="open = false">{{
          t('planned.subscriptions.cancel')
        }}</Button>
      </div>
    </form>
    <template v-if="plan">
      <p class="mt-4 text-sm">
        {{
          t('planned.subscriptions.installment.remaining', {
            principal: remaining.toFixed(2),
            total: remainingTotal,
            currency: plan.currencyCode,
          })
        }}
      </p>
      <div class="relative mt-3 overflow-x-auto">
        <table
          class="w-full min-w-[38rem] text-left text-sm [&_td]:px-3 [&_td]:py-2 [&_td]:whitespace-nowrap [&_th]:px-3 [&_th]:py-2"
        >
          <thead>
            <tr>
              <th class="p-2">{{ t('planned.subscriptions.installment.period') }}</th>
              <th>{{ t('planned.subscriptions.installment.dueDate') }}</th>
              <th>{{ t('planned.subscriptions.installment.principal') }}</th>
              <th>{{ t('planned.subscriptions.installment.interest') }}</th>
              <th>{{ t('planned.subscriptions.installment.total') }}</th>
              <th>{{ t('planned.subscriptions.installment.status') }}</th>
              <th>
                <span class="sr-only">{{ t('planned.subscriptions.installment.edit') }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in plan.items" :key="item.id" class="border-t">
              <td class="p-2">{{ item.occurrenceNumber }}</td>
              <td>{{ item.dueDate }}</td>
              <td>{{ item.principal.toFixed(2) }}</td>
              <td>{{ item.interest.toFixed(2) }}</td>
              <td>{{ item.total.toFixed(2) }}</td>
              <td>{{ t(`planned.subscriptions.installment.${item.status}`) }}</td>
              <td>
                <Button
                  v-if="item.status === 'pending'"
                  variant="ghost"
                  size="sm"
                  :disabled="busy"
                  @click="startEdit(item)"
                  >{{ t('planned.subscriptions.installment.edit') }}</Button
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <form v-if="editId" class="mt-3 grid gap-3 rounded border p-3 sm:grid-cols-4" @submit.prevent="saveRow">
        <label class="grid text-sm"
          >{{ t('planned.subscriptions.installment.dueDate')
          }}<input v-model="edit.dueDate" type="date" required class="bg-background rounded border p-2"
        /></label>
        <label v-for="field in amountFields" :key="field" class="grid text-sm"
          >{{ t(`planned.subscriptions.installment.${field}`)
          }}<input
            v-model.number="edit[field]"
            type="number"
            min="0"
            step="0.01"
            required
            class="bg-background rounded border p-2"
        /></label>
        <p class="text-muted-foreground text-sm sm:col-span-4">{{ t('planned.subscriptions.installment.editHint') }}</p>
        <Button type="submit" :disabled="busy">{{ t('planned.subscriptions.installment.save') }}</Button
        ><Button type="button" variant="ghost" @click="editId = null">{{ t('planned.subscriptions.cancel') }}</Button>
      </form>
      <Button
        v-if="plan.configuration.linkedSettlementEnabled && current"
        class="mt-4"
        variant="outline"
        :disabled="busy"
        @click="
          payoffOpen = !payoffOpen;
          payoffPrincipal = remaining;
        "
        >{{ t('planned.subscriptions.installment.payoff') }}</Button
      >
      <form v-if="payoffOpen" class="mt-3 grid gap-3 rounded border p-3" @submit.prevent="confirmPayoff">
        <p>
          {{
            t('planned.subscriptions.installment.payoffConfirm', {
              principal: remaining.toFixed(2),
              currency: plan.currencyCode,
            })
          }}
        </p>
        <label class="grid text-sm"
          >{{ t('planned.subscriptions.installment.payoffPrincipal')
          }}<input
            v-model.number="payoffPrincipal"
            type="number"
            min="0.01"
            step="0.01"
            required
            class="bg-background rounded border p-2"
        /></label>
        <label class="grid text-sm"
          >{{ t('planned.subscriptions.installment.payoffFee')
          }}<input
            v-model.number="fee"
            type="number"
            min="0"
            step="0.01"
            required
            class="bg-background rounded border p-2"
        /></label>
        <Button type="submit" :disabled="busy">{{ t('planned.subscriptions.installment.confirmPayoff') }}</Button>
      </form>
    </template>
  </section>
</template>
