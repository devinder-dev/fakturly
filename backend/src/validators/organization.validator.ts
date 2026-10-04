// organization.validator.ts — Zod schemas for an organization's details.
//
// The Swedish identifiers are NORMALISED here, not just checked. The database
// enforces `orgNumber` unique by comparing strings, so "5591234561" and
// "559123-4561" would be two different companies to it — the same business
// registered twice. Every number is therefore stored in one canonical
// spelling, whatever the operator typed.
//
// Every message is Swedish: an admin will see these in the company settings.
// Zod's own defaults ("Invalid input: expected string, received undefined")
// are English, so no check here is left on a default.

import { z } from 'zod'
import { emailSchema } from './auth.validator.ts'

const stripSpacesAndDashes = (value: string) => value.replace(/[\s-]/g, '')

const ORG_NUMBER_STORED = /^\d{6}-\d{4}$/
const VAT_NUMBER_STORED = /^SE\d{10}01$/

/**
 * One message for "missing", another for "wrong type".
 *
 * Zod reports both as the same issue (invalid_type); only `input` tells them
 * apart. A single message would answer "Ange organisationsnummer" to someone
 * who DID send one, as a number instead of text.
 */
const requiredText = (missing: string, wrongType: string) => ({
  error: (issue: { input?: unknown }) => (issue.input === undefined ? missing : wrongType)
})

/**
 * Organisationsnummer: ten digits, stored as NNNNNN-NNNN.
 *
 * Format only for now. The tenth digit is a Luhn check digit; verifying it
 * belongs with the other Swedish identifier checks in lib/, and is adopted
 * here once that lands. Until then a typo in the last digit gets through.
 */
export const orgNumberSchema = z
  .string(requiredText('Ange organisationsnummer', 'Ogiltigt organisationsnummer'))
  // Cap BEFORE transforming — no reason to regex a megabyte.
  .max(20, { message: 'Ogiltigt organisationsnummer' })
  .transform(stripSpacesAndDashes)
  .pipe(z.string().regex(/^\d{10}$/, { message: 'Ogiltigt organisationsnummer' }))
  .transform((digits) => `${digits.slice(0, 6)}-${digits.slice(6)}`)

/**
 * Momsregistreringsnummer: "SE" + the ten digits of the organisationsnummer +
 * "01". Stored uppercase without spaces. That it actually matches the
 * organisationsnummer is checked on the whole object below.
 */
export const vatNumberSchema = z
  .string({ message: 'Ogiltigt momsregistreringsnummer' })
  .max(20, { message: 'Ogiltigt momsregistreringsnummer' })
  .transform((value) => value.replace(/\s/g, '').toUpperCase())
  .pipe(z.string().regex(VAT_NUMBER_STORED, { message: 'Ogiltigt momsregistreringsnummer' }))

/** Bankgironummer: seven or eight digits, stored as NNN-NNNN or NNNN-NNNN. */
export const bankgiroSchema = z
  .string({ message: 'Ogiltigt bankgironummer' })
  .max(20, { message: 'Ogiltigt bankgironummer' })
  .transform(stripSpacesAndDashes)
  .pipe(z.string().regex(/^\d{7,8}$/, { message: 'Ogiltigt bankgironummer' }))
  .transform((digits) => `${digits.slice(0, -4)}-${digits.slice(-4)}`)

export const createOrganizationSchema = z
  .object(
    {
      name: z
        .string(requiredText('Ange företagets namn', 'Ogiltigt namn'))
        .trim()
        .min(1, { message: 'Ange företagets namn' })
        .max(200, { message: 'Namnet får vara högst 200 tecken' }),
      orgNumber: orgNumberSchema,
      // Optional: a business below the VAT threshold has none.
      vatNumber: vatNumberSchema.optional(),
      // Required: a Swedish invoice must state the seller's address.
      address: z
        .string(requiredText('Ange företagets adress', 'Ogiltig adress'))
        .trim()
        .min(1, { message: 'Ange företagets adress' })
        .max(300, { message: 'Adressen får vara högst 300 tecken' }),
      // Where customers' replies to invoice emails go. Type and length are
      // checked here, in Swedish, before the shared emailSchema (whose own
      // type and length messages are Zod's English defaults) ever sees it.
      email: z
        .string(requiredText('Ange e-postadress', 'Ogiltig e-postadress'))
        .max(254, { message: 'E-postadressen får vara högst 254 tecken' })
        .pipe(emailSchema),
      // Optional: a business may take card payments only.
      bankgiro: bankgiroSchema.optional(),
      fSkatt: z.boolean({ message: 'Ange F-skatt som ja eller nej' }).default(true),
      // A sanity bound, not a legal rule — long terms are a business decision.
      paymentTermsDays: z
        .number({ message: 'Betalningsvillkoret anges i hela dagar' })
        .int({ message: 'Betalningsvillkoret anges i hela dagar' })
        .min(0, { message: 'Betalningsvillkoret måste vara 0–365 dagar' })
        .max(365, { message: 'Betalningsvillkoret måste vara 0–365 dagar' })
        .default(30)
    },
    { message: 'Ogiltiga företagsuppgifter' }
  )
  .superRefine((org, ctx) => {
    // Zod 4 runs this even when a field above already failed. Comparing a
    // malformed number would add a second, misleading "does not match" on
    // top of the real "invalid format" — so only compare two valid ones.
    if (!org.vatNumber || !VAT_NUMBER_STORED.test(org.vatNumber)) return
    if (!ORG_NUMBER_STORED.test(org.orgNumber)) return

    // The VAT number embeds the organisationsnummer. A mismatch means one of
    // the two was mistyped, and both end up on every invoice.
    if (org.vatNumber !== `SE${org.orgNumber.replace('-', '')}01`) {
      ctx.addIssue({
        code: 'custom',
        path: ['vatNumber'],
        message: 'Momsregistreringsnumret matchar inte organisationsnumret'
      })
    }
  })

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>
