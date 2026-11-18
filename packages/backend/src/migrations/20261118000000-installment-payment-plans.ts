import { QueryInterface } from 'sequelize';

module.exports = {
  async up(q: QueryInterface) {
    await q.sequelize.transaction(async (transaction) => {
      await q.sequelize.query(
        `
        ALTER TABLE "SubscriptionPeriods" ADD COLUMN "settlementGeneration" INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE "InstallmentPlans" (
          "id" UUID PRIMARY KEY, "subscriptionId" UUID NOT NULL UNIQUE REFERENCES "Subscriptions"("id") ON DELETE RESTRICT,
          "sourceAccountId" UUID NOT NULL REFERENCES "Accounts"("id") ON DELETE RESTRICT,
          "currencyCode" VARCHAR(3) NOT NULL, "totalPrincipal" BIGINT NOT NULL CHECK ("totalPrincipal" > 0),
          "revision" INTEGER NOT NULL CHECK ("revision" > 0), "configuration" JSONB NOT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE "InstallmentScheduleItems" (
          "id" UUID PRIMARY KEY, "planId" UUID NOT NULL REFERENCES "InstallmentPlans"("id") ON DELETE CASCADE,
          "occurrenceNumber" INTEGER NOT NULL CHECK ("occurrenceNumber" > 0), "dueDate" DATE NOT NULL,
          "principal" BIGINT NOT NULL CHECK ("principal" >= 0), "interest" BIGINT NOT NULL CHECK ("interest" >= 0),
          "total" BIGINT NOT NULL CHECK ("total" > 0 AND "total" = "principal" + "interest"),
          "status" VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','paid','cancelled')),
          "periodId" UUID UNIQUE REFERENCES "SubscriptionPeriods"("id") ON DELETE SET NULL,
          "generation" INTEGER NOT NULL DEFAULT 0 CHECK ("generation" >= 0),
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE ("planId", "occurrenceNumber")
        );
        CREATE TABLE "InstallmentSettlements" (
          "id" UUID PRIMARY KEY, "planId" UUID NOT NULL REFERENCES "InstallmentPlans"("id") ON DELETE RESTRICT,
          "itemId" UUID NOT NULL REFERENCES "InstallmentScheduleItems"("id") ON DELETE RESTRICT,
          "periodId" UUID NOT NULL REFERENCES "SubscriptionPeriods"("id") ON DELETE RESTRICT,
          "generation" INTEGER NOT NULL, "state" VARCHAR(20) NOT NULL CHECK ("state" IN ('settled','reverting','reverted')),
          "transactionIds" JSONB NOT NULL, "snapshot" JSONB NOT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE ("periodId", "generation")
        );
        CREATE UNIQUE INDEX installment_active_item ON "InstallmentSettlements" ("itemId") WHERE "state" = 'settled';
        CREATE UNIQUE INDEX installment_active_period ON "InstallmentSettlements" ("periodId") WHERE "state" = 'settled';
        CREATE INDEX installment_transaction_ids ON "InstallmentSettlements" USING gin ("transactionIds");
        CREATE FUNCTION protect_installment_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM "InstallmentSettlements" s JOIN "InstallmentPlans" p ON p."id" = s."planId" JOIN "Subscriptions" sub ON sub."id" = p."subscriptionId" WHERE sub."userId" = OLD."userId" AND s."state" IN ('settled','reverted') AND s."transactionIds" ? OLD."id"::text) THEN
            RAISE EXCEPTION 'Use the installment settlement to change this transaction';
          END IF;
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER installment_transaction_guard BEFORE UPDATE OR DELETE ON "Transactions"
          FOR EACH ROW EXECUTE FUNCTION protect_installment_transaction();
      `,
        { transaction },
      );
    });
  },
  async down(q: QueryInterface) {
    await q.sequelize.transaction(async (transaction) => {
      await q.sequelize.query(
        `
        DO $$ BEGIN IF EXISTS (SELECT 1 FROM "InstallmentSettlements") THEN RAISE EXCEPTION 'Installment settlement history exists; use a reviewed data rollback'; END IF; END $$;
        DROP TRIGGER installment_transaction_guard ON "Transactions";
        DROP FUNCTION protect_installment_transaction();
        DROP TABLE "InstallmentSettlements";
        DROP TABLE "InstallmentScheduleItems";
        DROP TABLE "InstallmentPlans";
        ALTER TABLE "SubscriptionPeriods" DROP COLUMN "settlementGeneration";
      `,
        { transaction },
      );
    });
  },
};
