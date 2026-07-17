from dataclasses import asdict

from fastapi import FastAPI, Query, UploadFile

from app.pdf_extractor import AddressExtractionError, PdfExtractor

app = FastAPI(title="ComunicaPA PDF Extractor")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/extract")
async def extract(file: UploadFile, mode: str = Query("unica", pattern="^(unica|multirata)$")):
    pdf_bytes = await file.read()
    warnings: list[str] = []
    address = None
    payment = None

    try:
        extractor = PdfExtractor(pdf_bytes)
        try:
            address = extractor.extract_address()
        except AddressExtractionError as e:
            # Messaggio troncato: contiene i primi 500 char della pagina, utile
            # nei log del job ma da non gonfiare oltre.
            warnings.append(f"Indirizzo non estratto: {str(e)[:300]}")

        payment, pay_warnings = extractor.extract_payment(mode=mode)
        warnings.extend(pay_warnings)
        if payment is None:
            warnings.append("Dati PagoPA non trovati nel PDF")
    except Exception as e:
        warnings.append(f"PDF non elaborabile: {e}")

    return {
        "address": asdict(address) if address else None,
        "payment": asdict(payment) if payment else None,
        "warnings": warnings,
    }
