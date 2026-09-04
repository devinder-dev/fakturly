-- CreateEnum
CREATE TYPE "InvoiceType" AS ENUM ('INVOICE', 'CREDIT_NOTE');

-- AlterEnum
ALTER TYPE "InvoiceStatus" ADD VALUE 'CREDITED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionType" ADD VALUE 'REMINDER_FEE_ADDED';
ALTER TYPE "TransactionType" ADD VALUE 'CREDIT_NOTE_ISSUED';
ALTER TYPE "TransactionType" ADD VALUE 'LATE_FEE_WAIVED';
ALTER TYPE "TransactionType" ADD VALUE 'REMINDER_FEE_WAIVED';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "creditsInvoiceId" TEXT,
ADD COLUMN     "reminderFeeOre" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reminderSentAt" TIMESTAMP(3),
ADD COLUMN     "type" "InvoiceType" NOT NULL DEFAULT 'INVOICE';

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_creditsInvoiceId_fkey" FOREIGN KEY ("creditsInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
