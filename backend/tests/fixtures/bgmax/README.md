# BgMax example files

These are Bankgirot's public example files for Bankgiro Inbetalningar, downloaded
on 2026-10-15 from <https://www.bankgirot.se/kundservice/exempelfiler/>. The bytes are
unchanged; only the file names are shorter. `tests/unit/bgmax.test.ts` checks each
file's SHA-256, and `.gitattributes` stops git from rewriting the CRLF line endings.

| File | Original name | Agreement it illustrates |
|---|---|---|
| `utan-tillval.txt` | `bangiroinbetalningar_exempelfil_avtalutantillval_kontroller_sv.txt` | No options or reference checks |
| `ocr-kontroll.txt` | `bankgiroinbetalningar_exempelfil_avtal-om-ocr-kontroll_sv.txt` | OCR reference check |
| `ocr-kontroll-langd.txt` | `bankgiroinbetalningar_exempelfil_avtal-om-ocr-kontroll_checksiffra_langd_sv.txt` | OCR check with check digit and length |
| `utokad-blankettregistrering.txt` | `bankgiroinbetalningar_avtal-ocr-kontroll_utokad-blankettregistrering-ocr-kontroll_exempelfil.txt` | OCR check plus extended form registration |
| `bildfil.txt` | `bankgiroinbetalningar_bildfil_avtal-ocr-kontroll_utokad-blankettregistrering-ocr-kontroll_exempelfil.txt` | The same, with the image-file option |

Known quirks. The tests depend on these, so they must not be "fixed":

- `ocr-kontroll-langd.txt` has two tab characters at line 17. The parser refuses the file with `CONTROL_CHARACTER`. Some lines and the end record are also shorter than 80 characters, and the file has no final line ending.
- `ocr-kontroll-langd.txt` gives BGC serial `000000000016` to two payments from different payers, at lines 35 and 40.
- `utokad-blankettregistrering.txt` has one line of 88 characters (the overflow is blanks) and an organisation number that is not zero-filled, at line 17.
- `bildfil.txt` and `ocr-kontroll.txt` have bankgiro numbers that are left-aligned instead of zero-filled.
- All five files carry test marker `P` (production), even though they are examples.
