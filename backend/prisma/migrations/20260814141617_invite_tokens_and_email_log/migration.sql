/*
  Warnings:

  - Added the required column `recipient` to the `EmailLog` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "PasswordTokenType" AS ENUM ('INVITE', 'RESET');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EmailType" ADD VALUE 'INVITE';
ALTER TYPE "EmailType" ADD VALUE 'PASSWORD_RESET';

-- DropForeignKey
ALTER TABLE "EmailLog" DROP CONSTRAINT "EmailLog_invoiceId_fkey";

-- AlterTable
ALTER TABLE "EmailLog" ADD COLUMN     "providerMessageId" TEXT,
ADD COLUMN     "recipient" TEXT NOT NULL,
ADD COLUMN     "userId" TEXT,
ALTER COLUMN "invoiceId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "PasswordToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "PasswordTokenType" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordToken_tokenHash_key" ON "PasswordToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordToken_userId_idx" ON "PasswordToken"("userId");

-- CreateIndex
CREATE INDEX "PasswordToken_expiresAt_idx" ON "PasswordToken"("expiresAt");

-- CreateIndex
CREATE INDEX "EmailLog_invoiceId_idx" ON "EmailLog"("invoiceId");

-- CreateIndex
CREATE INDEX "EmailLog_userId_idx" ON "EmailLog"("userId");

-- CreateIndex
CREATE INDEX "EmailLog_type_sentAt_idx" ON "EmailLog"("type", "sentAt");

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordToken" ADD CONSTRAINT "PasswordToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
