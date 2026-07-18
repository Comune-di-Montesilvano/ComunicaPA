from dataclasses import asdict

from fastapi import FastAPI, UploadFile

from app.pdf_extractor import AddressExtractionError, PdfExtractor

app = FastAPI(title="ComunicaPA PDF Extractor")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/extract")
async def extract(file: UploadFile):
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
