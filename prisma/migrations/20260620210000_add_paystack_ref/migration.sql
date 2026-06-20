-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "paystackRef" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_paystackRef_key" ON "subscriptions"("paystackRef");
