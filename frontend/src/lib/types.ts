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

export type InvoiceStatus = 'DRAFT' | 'SENT' | 'PAID' | 'OVERDUE'

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
  currency: string

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

  formatted: {
    netTotal: string
    vatTotal: string
    grossTotal: string
  }

  issueDate: string
  dueDate: string
  sentAt: string | null
  paidAt: string | null
  createdAt: string

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
