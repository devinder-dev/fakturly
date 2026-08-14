/*
  Warnings:

  - You are about to drop the column `amount` on the `Invoice` table. All the data in the column will be lost.
  - You are about to drop the column `totalOre` on the `InvoiceItem` table. All the data in the column will be lost.
  - Added the required column `grossOre` to the `InvoiceItem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `netOre` to the `InvoiceItem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `vatOre` to the `InvoiceItem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `vatRate` to the `InvoiceItem` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "InvoiceItem" DROP CONSTRAINT "InvoiceItem_invoiceId_fkey";

-- AlterTable
ALTER TABLE "Invoice" DROP COLUMN "amount",
ADD COLUMN     "grossTotalOre" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "netTotalOre" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "vatTotalOre" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "InvoiceItem" DROP COLUMN "totalOre",
ADD COLUMN     "grossOre" INTEGER NOT NULL,
ADD COLUMN     "netOre" INTEGER NOT NULL,
ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "vatOre" INTEGER NOT NULL,
ADD COLUMN     "vatRate" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "InvoiceNumberSeries" (
    "year" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InvoiceNumberSeries_pkey" PRIMARY KEY ("year")
);

-- CreateIndex
CREATE INDEX "Invoice_clientId_status_idx" ON "Invoice"("clientId", "status");

-- CreateIndex
CREATE INDEX "Invoice_status_dueDate_idx" ON "Invoice"("status", "dueDate");

-- CreateIndex
CREATE INDEX "InvoiceItem_invoiceId_idx" ON "InvoiceItem"("invoiceId");

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
