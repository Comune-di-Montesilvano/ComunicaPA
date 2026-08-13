import os
from dataclasses import asdict

import sentry_sdk
from fastapi import FastAPI, UploadFile

from app.pdf_extractor import AddressExtractionError, PdfExtractor

# Attivo SOLO se SENTRY_DSN_PDF_EXTRACTOR è valorizzata — stesso principio
# opt-in del backend Node (sentry.util.ts): nessun invio di default,
# specialmente in dev locale.
_sentry_dsn = os.environ.get("SENTRY_DSN_PDF_EXTRACTOR")
if _sentry_dsn:
    sentry_sdk.init(
        dsn=_sentry_dsn,
        environment=os.environ.get("SENTRY_ENVIRONMENT") or "unknown",
        traces_sample_rate=0,
    )

app = FastAPI(title="ComunicaPA PDF Extractor")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/extract")
async def extract(file: UploadFile, search_payments: bool = True):
    pdf_bytes = await file.read()
    warnings: list[str] = []
    address = None
    payment_body = None

    try:
        extractor = PdfExtractor(pdf_bytes)
        try:
            address = extractor.extract_address()
        except AddressExtractionError as e:
            warnings.append(f"Indirizzo non estratto: {str(e)[:300]}")

        if search_payments:
            totale, rate, pay_warnings = extractor.extract_payment()
            warnings.extend(pay_warnings)
            if totale is None and not rate:
                warnings.append("Dati PagoPA non trovati nel PDF")
            else:
                payment_body = {
                    "totale": asdict(totale) if totale else None,
                    "rate": [asdict(r) for r in rate],
                }
    except Exception as e:
        warnings.append(f"PDF non elaborabile: {e}")

    return {
        "address": asdict(address) if address else None,
        "payment": payment_body,
        "warnings": warnings,
    }
