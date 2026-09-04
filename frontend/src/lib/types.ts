// types.ts — the shapes the API returns.
//
// Written by hand rather than generated. That is a deliberate trade: a
// generator would keep these in sync automatically, but hand-writing them
// means the frontend states what it EXPECTS, and a mismatch shows up as a
// type error rather than as `undefined` on screen.
//
// If these drift from the backend, the fix is here — the backend is the
// authority on its own responses.

export type Role = 'ADMIN' | 'CLIENT'

export type User = {
  id: string
  email: string
  role: Role
}

export type LoginResponse = {
  accessToken: string
  user: User
}

export type Client = {
  id: string
  name: string
  email: string
  phone: string | null
  address: string | null
  createdAt: string
}

export type InvoiceStatus = 'DRAFT' | 'SENT' | 'PAID' | 'OVERDUE' | 'CREDITED'
export type InvoiceType = 'INVOICE' | 'CREDIT_NOTE'

export type LedgerType =
  | 'INVOICE_CREATED'
  | 'PAYMENT_RECEIVED'
  | 'LATE_FEE_ADDED'
  | 'REMINDER_FEE_ADDED'
  | 'CREDIT_NOTE_ISSUED'
  | 'LATE_FEE_WAIVED'
  | 'REMINDER_FEE_WAIVED'
  | 'REFUND'
  | 'ADJUSTMENT'

/** One row of the immutable ledger. Never edited, never deleted. */
export type LedgerRow = {
  id: string
  type: LedgerType
  amountOre: number
  description: string
  createdAt: string
}

export type InvoiceReference = { id: string; invoiceNumber: string }

export type InvoiceItem = {
  id: string
  description: string
  quantity: number
  /** Öre, excluding VAT. Integer. */
  unitPriceOre: number
  /** Basis points: 2500 = 25%. */
  vatRate: number
  netOre: number
  vatOre: number
  grossOre: number
}

export type Invoice = {
  id: string
  invoiceNumber: string
  clientId: string
  status: InvoiceStatus
  type: InvoiceType
  currency: string

  /** Set on a credit note: the invoice it cancels. */
  creditsInvoice: InvoiceReference | null
  /** Set on a credited invoice: the credit note(s) that cancelled it. */
  creditNotes: InvoiceReference[]

  /**
   * Amounts arrive as integer öre — the exact value — with formatted strings
   * alongside for display.
   *
   * The formatted strings are for showing. The öre are for comparing,
   * summing and sorting. Parsing "12 345,67 SEK" back into a number is
   * exactly where a float would creep in and money would start to drift.
   */
  netTotalOre: number
  vatTotalOre: number
  grossTotalOre: number
  lateFeeOre: number
  reminderFeeOre: number
  /** gross + interest + reminder fee. Computed by the API, once. */
  totalDueOre: number

  formatted: {
    netTotal: string
    vatTotal: string
    grossTotal: string
    totalDue: string
  }

  issueDate: string
  dueDate: string
  sentAt: string | null
  paidAt: string | null
  reminderSentAt: string | null
  createdAt: string

  ledger: LedgerRow[]
  items: InvoiceItem[]
}

export type Paginated<T, K extends string> = {
  pagination: { total: number; limit: number; offset: number }
} & Record<K, T[]>

export type ClientListResponse = {
  clients: Client[]
  pagination: { total: number; limit: number; offset: number }
}

export type InvoiceListResponse = {
  invoices: Invoice[]
  pagination: { total: number; limit: number; offset: number }
}

// ─────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────

export type MonthlyRow = {
  /** "YYYY-MM" */
  month: string
  invoicedOre: number
  receivedOre: number
}

export type Dashboard = {
  outstanding: { amountOre: number; count: number }
  overdue: { amountOre: number; count: number }
  thisMonth: { invoicedOre: number; receivedOre: number }
  /** Twelve entries, oldest first. Zero-filled by the API. */
  months: MonthlyRow[]
  topClients: Array<{
    clientId: string
    name: string
    outstandingOre: number
    invoiceCount: number
  }>
  formatted: {
    outstanding: string
    overdue: string
    invoicedThisMonth: string
    receivedThisMonth: string
  }
}

// ─────────────────────────────────────────────────────────────
// Demo mode — only answered by an API running with DEMO_MODE on
// ─────────────────────────────────────────────────────────────

export type DemoAccount = {
  role: Role
  email: string
  password: string
  label: string
}

export type DemoResponse = {
  accounts: DemoAccount[]
  resetsNightly: boolean
}

// ─────────────────────────────────────────────────────────────
// Audit log
// ─────────────────────────────────────────────────────────────

export type AuditEntry = {
  id: string
  action: string
  resource: string
  resourceId: string | null
  actorEmail: string | null
  email: string | null
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
}

export type AuditLogResponse = {
  entries: AuditEntry[]
  pagination: { total: number; limit: number; offset: number }
  actions: string[]
}

// ─────────────────────────────────────────────────────────────
// Reports
// ─────────────────────────────────────────────────────────────

export type AgingBucketKey = 'current' | 'days1to30' | 'days31to60' | 'days61to90' | 'over90'

export type AgingRow = Record<AgingBucketKey, number> & {
  totalOre: number
  clientId: string
  clientName: string
  invoiceCount: number
  oldestDueDate: string
}

export type AgingReport = {
  asOf: string
  rows: AgingRow[]
  totals: Record<AgingBucketKey, number> & { totalOre: number }
  buckets: Array<{ key: AgingBucketKey; label: string }>
  formatted: { total: string }
}

export type VatReport = {
  from: string
  to: string
  documentCount: number
  rows: Array<{ vatRate: number; netOre: number; vatOre: number; lineCount: number }>
  totals: { netOre: number; vatOre: number }
  formatted: { net: string; vat: string }
}
