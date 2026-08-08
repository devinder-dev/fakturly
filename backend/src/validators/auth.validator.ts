// auth.validator.ts — Zod-scheman för allt som rör inloggning och lösenord.
//
// Validering svarar på EN fråga: "har datan rätt form?"
// Den frågar aldrig databasen och ringer aldrig ut på nätverket.
// Affärsregler (finns e-posten? är lösenordet läckt?) hör hemma i service-lagret.

import { z } from 'zod'

// ─────────────────────────────────────────────────────────────
// E-post
// ─────────────────────────────────────────────────────────────

// Ordningen i kedjan spelar roll. Vi trimmar och sänker till gemener
// FÖRST, sedan validerar vi. Gör vi tvärtom skulle "  Anna@Example.se  "
// underkännas trots att det är en helt giltig adress.
//
// 254 tecken är den maxlängd RFC 5321 tillåter för en e-postadress.
// Utan tak kan någon skicka in 10 MB text och tvinga oss att validera den.
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Ogiltig e-postadress' }).max(254))

// ─────────────────────────────────────────────────────────────
// Lösenord — TVÅ olika scheman, med flit
// ─────────────────────────────────────────────────────────────

// 1) VID INLOGGNING: kontrollera bara formen, aldrig policyn.
//
// Varför inte min(12) här också? Två skäl:
//   a) Det läcker policyn. Svarar vi "minst 12 tecken" vet en angripare
//      att allt kortare är bortkastad tid i en brute force-attack.
//   b) Policyn ändras över tid. Höjer vi minimum till 14 i framtiden
//      skulle varje befintlig användare med 12 tecken bli utelåst vid
//      INLOGGNING — inte ombedd att byta, bara utelåst.
//
// Taket på 1024 är ett DoS-skydd: Argon2id är avsiktligt långsamt, och
// vi vill inte hasha en megabyte text per request.
export const loginPasswordSchema = z
  .string()
  .min(1, 'Lösenord krävs')
  .max(1024)

// 2) NÄR ETT LÖSENORD SÄTTS: här gäller policyn (NIST SP 800-63B).
//
// NIST säger tvärtemot vad de flesta tror:
//   - Längd slår komplexitet
//   - INGA sammansättningsregler ("måste ha versal + siffra + symbol").
//     De sänker verklig entropi, eftersom alla svarar med "Sommar2026!"
//   - INGEN tvingad rotation. Den ger Sommar2026 -> Sommar2027.
//   - Kontrollera mot läckta lösenord istället — det fångar långt mer.
//
// normalize('NFKC') är inte kosmetika. Samma lösenordsfras kan skrivas
// som olika byte-sekvenser på olika enheter (t.ex. "é" som ett tecken
// eller som "e" + accent). Utan normalisering hashar de OLIKA, och
// användaren blir utelåst från sitt eget konto på sin andra dator.
export const newPasswordSchema = z
  .string()
  .max(1024) // tak innan vi gör något arbete alls
  .transform((value) => value.normalize('NFKC'))
  .pipe(
    z
      .string()
      .min(12, 'Lösenordet måste vara minst 12 tecken')
      // Maxgränsen ligger på 128 — NIST kräver att den INTE är lägre än 64,
      // så att lösenordsfraser fungerar. Argon2id har ingen 72-bytes-fälla
      // som bcrypt, så vi behöver inte kapa kort.
      .max(128, 'Lösenordet får vara högst 128 tecken')
  )

// ─────────────────────────────────────────────────────────────
// Scheman per endpoint
// ─────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  email: emailSchema,
  password: loginPasswordSchema
})

// Används när en inbjuden klient sätter sitt första lösenord,
// och när någon byter lösenord via en återställningslänk.
export const setPasswordSchema = z.object({
  token: z.string().min(1, 'Token krävs'),
  password: newPasswordSchema
})

// Admin lägger upp en ny klient. Lägg märke till vad som INTE finns här:
// inget `role`-fält. Rollen sätts alltid på servern.
// Läste vi role från request-body kunde vem som helst göra sig till ADMIN.
export const createClientSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1, 'Namn krävs').max(200),
  phone: z.string().trim().max(50).optional(),
  address: z.string().trim().max(500).optional()
})

// ─────────────────────────────────────────────────────────────
// Typer — härledda ur schemana, aldrig skrivna för hand.
// Ändrar vi ett schema följer typen med automatiskt.
// z.infer ger typen EFTER transform (alltså normaliserad sträng).
// ─────────────────────────────────────────────────────────────

export type LoginInput = z.infer<typeof loginSchema>
export type SetPasswordInput = z.infer<typeof setPasswordSchema>
export type CreateClientInput = z.infer<typeof createClientSchema>
