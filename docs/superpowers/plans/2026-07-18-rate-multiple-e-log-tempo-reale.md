# Rate Multiple PagoPA e Log Tempo Reale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Estendere la dashboard "Arricchimento tracciati" per (1) estrarre TUTTE le rate PagoPA di un PDF (non solo il totale), classificandole via etichetta testuale con controlli di coerenza, e (2) mostrare un log push in tempo reale durante l'elaborazione del job (SSE), con dettaglio completo sul primo documento e sintetico sui successivi.

**Architecture:** Il servizio Python `pdf-extractor` scansiona tutte le pagine con QR pagamento, classifica ciascuna ("RATA UNICA" vs "N° RATA") via regex sul testo pagina, e ritorna `{totale, rate[]}` invece di un pagamento singolo. Il CSV di output passa da header fisso a header dinamico (colonne `rataN_*` quante ne servono nel job). Un nuovo `EnrichmentEventsService` (EventEmitter in-memory, stesso processo Node di worker+HTTP server) fa da bridge tra il processor BullMQ e un endpoint SSE che il frontend consuma via `fetch()` + lettura manuale dello stream (mai `EventSource` nativo, non supporta header di auth).

**Tech Stack:** Python (FastAPI, PyMuPDF, pyzbar — invariato), NestJS/TypeScript, React (fetch + ReadableStream), nessuna nuova dipendenza npm/pip.

**Spec:**
- `docs/superpowers/specs/2026-07-17-estrazione-rate-multiple-design.md`
- `docs/superpowers/specs/2026-07-18-log-tempo-reale-arricchimento-design.md`

## Global Constraints

- Tutto gira in Docker: `docker compose exec backend ...`, `docker compose exec frontend-admin ...`; test Python via `docker run --rm -v "$(pwd)/services/pdf-extractor:/svc" -w /svc python:3.11-slim sh -c "apt-get update -qq && apt-get install -y -qq libzbar0 > /dev/null && pip install -q -r requirements-dev.txt && python -m pytest tests/ -v"`.
- Classificazione pagina pagamento: **etichetta testuale**, MAI ordine di pagina. `RATA UNICA` (case-insensitive) → totale; `(\d+)\s*°?\s*RATA` (case-insensitive) → rata N (N = numero catturato, non posizione). Pagina CBILL senza etichetta riconosciuta → rata non classificabile, indice progressivo interno, warning, MAI scartata.
- Controlli di coerenza (sempre warning, mai bloccanti): somma rate vs totale; scadenze rate in ordine crescente; scadenza unica vs scadenza prima rata.
- Parametro `mode` (`unica`/`multirata`) rimosso ovunque (Python `/extract`, client TS `extract()`, processor) — era già morto, ora la scansione è sempre completa.
- CSV output: header dinamico per job (`maxRate` = massimo numero di rate tra tutti i record del job), colonne base invariate, QUOTE_ALL invariato, delimitatore `;` invariato.
- Log SSE: nessuna persistenza lato backend, nessun `EventSource` nativo (usare `fetch()` + `ReadableStreamDefaultReader` con header `Authorization` normale), bridge in-memory (`EventEmitter`) — valido solo a singola istanza backend (limite esplicito, non da migrare a Redis pub/sub ora, YAGNI).
- Nessuna nuova dipendenza npm o pip.
- Baseline test invariata: 1 fallimento noto (`app.controller.spec.ts`/`isLdapMock`) — ogni modifica deve mantenere lo stesso failure set sulla suite completa.

---

### Task 1: Python — classificazione pagina + estrazione multi-rata

**Files:**
- Modify: `services/pdf-extractor/app/pdf_extractor.py`
- Modify: `services/pdf-extractor/tests/conftest.py` (nuove fixture multi-pagina)
- Test: `services/pdf-extractor/tests/test_pdf_extractor.py`

**Interfaces:**
- Produces: `PdfExtractor.extract_payment() -> tuple[Optional[PaymentData], list[PaymentData], list[str]]` — `(totale, rate, warnings)`. **Firma cambiata**: niente più parametro `mode`, niente più singolo payment — ritorna sempre totale + lista rate (vuota se non trovate) + warning.

- [ ] **Step 1: Nuove fixture multi-pagina in conftest.py**

Aggiungi in fondo a `services/pdf-extractor/tests/conftest.py` (dopo `pdf_with_qr`):

```python
def _rata_page_text(label: str, extra: str = "") -> str:
    return f"AVVISO DI PAGAMENTO\nCBILL 301000000000000000 00123456789\n{label}\nentro il 31/12/2026\n{extra}"


@pytest.fixture
def pdf_unica_e_due_rate() -> bytes:
    """3 pagine pagamento: RATA UNICA (761,00) + 1° RATA (380,50) + 2° RATA (380,50).
    Ordine pagina deliberatamente 2°rata-1°rata-unica per verificare che la
    classificazione usi l'etichetta, non la posizione."""
    doc = fitz.open()
    pages_spec = [
        ("2° RATA", "PAGOPA|002|301000000000000002|00123456789|38050", "entro il 28/02/2027"),
        ("1° RATA", "PAGOPA|002|301000000000000001|00123456789|38050", "entro il 31/01/2027"),
        ("RATA UNICA", "PAGOPA|002|301000000000000000|00123456789|76100", "entro il 31/12/2026"),
    ]
    for label, qr_payload, scadenza_text in pages_spec:
        page = doc.new_page()
        page.insert_textbox(
            fitz.Rect(50, 50, 550, 130),
            f"AVVISO DI PAGAMENTO\nCBILL\n{label}\n{scadenza_text}\n",
            fontsize=11,
        )
        img = qrcode.make(qr_payload)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        page.insert_image(fitz.Rect(50, 150, 250, 350), stream=buf.getvalue())
    out = doc.tobytes()
    doc.close()
    return out


@pytest.fixture
def pdf_solo_rate_senza_unica() -> bytes:
    """Nessuna pagina RATA UNICA, solo 2 rate — verifica che 'totale' resti None."""
    doc = fitz.open()
    pages_spec = [
        ("1° RATA", "PAGOPA|002|301000000000000001|00123456789|38050", "entro il 31/01/2027"),
        ("2° RATA", "PAGOPA|002|301000000000000002|00123456789|38050", "entro il 28/02/2027"),
    ]
    for label, qr_payload, scadenza_text in pages_spec:
        page = doc.new_page()
        page.insert_textbox(
            fitz.Rect(50, 50, 550, 130),
            f"AVVISO DI PAGAMENTO\nCBILL\n{label}\n{scadenza_text}\n",
            fontsize=11,
        )
        img = qrcode.make(qr_payload)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        page.insert_image(fitz.Rect(50, 150, 250, 350), stream=buf.getvalue())
    out = doc.tobytes()
    doc.close()
    return out


@pytest.fixture
def pdf_rata_somma_diversa() -> bytes:
    """RATA UNICA (761,00) + 1 sola rata (100,00) dichiarata — somma non torna."""
    doc = fitz.open()
    pages_spec = [
        ("RATA UNICA", "PAGOPA|002|301000000000000000|00123456789|76100", "entro il 31/12/2026"),
        ("1° RATA", "PAGOPA|002|301000000000000001|00123456789|10000", "entro il 31/01/2027"),
    ]
    for label, qr_payload, scadenza_text in pages_spec:
        page = doc.new_page()
        page.insert_textbox(
            fitz.Rect(50, 50, 550, 130),
            f"AVVISO DI PAGAMENTO\nCBILL\n{label}\n{scadenza_text}\n",
            fontsize=11,
        )
        img = qrcode.make(qr_payload)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        page.insert_image(fitz.Rect(50, 150, 250, 350), stream=buf.getvalue())
    out = doc.tobytes()
    doc.close()
    return out


@pytest.fixture
def pdf_rata_senza_etichetta() -> bytes:
    """1 pagina CBILL senza 'RATA UNICA' né 'N RATA' — rata non classificabile."""
    doc = fitz.open()
    page = doc.new_page()
    page.insert_textbox(
        fitz.Rect(50, 50, 550, 130),
        "AVVISO DI PAGAMENTO\nCBILL\nentro il 31/12/2026\n",
        fontsize=11,
    )
    img = qrcode.make("PAGOPA|002|301000000000000000|00123456789|76100")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    page.insert_image(fitz.Rect(50, 150, 250, 350), stream=buf.getvalue())
    out = doc.tobytes()
    doc.close()
    return out
```

- [ ] **Step 2: Test failing**

Sostituisci in `services/pdf-extractor/tests/test_pdf_extractor.py` le due funzioni `test_extract_payment_from_qr` e `test_extract_payment_absent_returns_none_with_warnings` (che chiamano `extract_payment(mode="unica")`, firma che sta per cambiare) con:

```python
def test_extract_payment_from_qr(pdf_with_qr):
    totale, rate, warnings = PdfExtractor(pdf_with_qr).extract_payment()
    assert totale is not None
    assert totale.numero_avviso == "301000000000000000"
    assert totale.cf_ente == "00123456789"
    assert totale.importo == "761,00"
    assert totale.scadenza == "31/12/2026"
    assert rate == []


def test_extract_payment_absent_returns_none_with_warnings(pdf_no_address):
    totale, rate, warnings = PdfExtractor(pdf_no_address).extract_payment()
    assert totale is None
    assert rate == []
    assert len(warnings) >= 1


def test_extract_payment_unica_e_rate_classificate_da_etichetta(pdf_unica_e_due_rate):
    """Pagine in ordine 2°rata-1°rata-unica: la classificazione usa l'etichetta,
    non la posizione — rate[0] deve essere la 1° rata, rate[1] la 2°."""
    totale, rate, warnings = PdfExtractor(pdf_unica_e_due_rate).extract_payment()
    assert totale is not None
    assert totale.importo == "761,00"
    assert totale.numero_avviso == "301000000000000000"
    assert len(rate) == 2
    assert rate[0].numero_avviso == "301000000000000001"
    assert rate[0].importo == "380,50"
    assert rate[1].numero_avviso == "301000000000000002"
    assert rate[1].importo == "380,50"
    # Somma == totale, scadenze consecutive, unica ~= prima rata: nessun warning di coerenza
    assert not any("diversa dal totale" in w for w in warnings)
    assert not any("non in ordine crescente" in w for w in warnings)
    assert not any("diversa dalla scadenza della prima rata" in w for w in warnings)


def test_extract_payment_solo_rate_senza_unica(pdf_solo_rate_senza_unica):
    totale, rate, warnings = PdfExtractor(pdf_solo_rate_senza_unica).extract_payment()
    assert totale is None
    assert len(rate) == 2
    assert rate[0].numero_avviso == "301000000000000001"
    assert rate[1].numero_avviso == "301000000000000002"


def test_extract_payment_somma_rate_diversa_da_totale_warning(pdf_rata_somma_diversa):
    totale, rate, warnings = PdfExtractor(pdf_rata_somma_diversa).extract_payment()
    assert totale is not None
    assert len(rate) == 1
    assert any("diversa dal totale" in w for w in warnings)


def test_extract_payment_etichetta_non_riconosciuta_warning(pdf_rata_senza_etichetta):
    totale, rate, warnings = PdfExtractor(pdf_rata_senza_etichetta).extract_payment()
    # Nessuna etichetta "RATA UNICA" né "N RATA": la pagina finisce come rata
    # non classificabile, MAI scartata.
    assert totale is None
    assert len(rate) == 1
    assert rate[0].numero_avviso == "301000000000000000"
    assert any("etichetta rata non riconosciuta" in w for w in warnings)
```

- [ ] **Step 3: Run per verificare che fallisca**

```bash
docker run --rm -v "$(pwd)/services/pdf-extractor:/svc" -w /svc python:3.11-slim sh -c "apt-get update -qq && apt-get install -y -qq libzbar0 > /dev/null && pip install -q -r requirements-dev.txt && python -m pytest tests/test_pdf_extractor.py -v"
```

Expected: FAIL — `extract_payment() takes 1 positional argument but ...` o `TypeError: extract_payment() got an unexpected keyword argument 'mode'` (la firma vecchia non accetta ancora la nuova forma di chiamata/ritorno).

- [ ] **Step 4: Riscrivi pdf_extractor.py**

Sostituisci in `services/pdf-extractor/app/pdf_extractor.py` i metodi `_find_pagopa_pages`, `_find_payment_pages`, `_extract_payment_from_qr`, `extract_payment` (righe 116-277 nel file attuale) con:

```python
    _RE_RATA_UNICA = re.compile(r"RATA\s+UNICA", re.IGNORECASE)
    _RE_RATA_N = re.compile(r"(\d+)\s*°?\s*RATA", re.IGNORECASE)

    @staticmethod
    def _classify_payment_page(text: str) -> tuple[str, Optional[int]]:
        """Ritorna ('unica', None) | ('rata', N) | ('unknown', None) in base
        all'etichetta testuale della pagina. MAI l'ordine di pagina: alcuni
        documenti hanno solo rate, altri solo rata unica, altri entrambe le
        opzioni (stesso importo, due modalità di pagamento alternative)."""
        if PdfExtractor._RE_RATA_UNICA.search(text):
            return "unica", None
        m = PdfExtractor._RE_RATA_N.search(text)
        if m:
            return "rata", int(m.group(1))
        return "unknown", None

    @staticmethod
    def _find_cbill_pages(doc) -> list[int]:
        """Tutte le pagine con dicitura CBILL (QR pagamento reale), in ordine
        di apparizione nel documento — non ci si ferma più alla prima."""
        pages = []
        for i in range(len(doc)):
            text = (doc[i].get_text() or "").upper()
            if "CBILL" in text:
                pages.append(i)
        return pages

    @staticmethod
    def _importo_to_cents(importo: str) -> Optional[int]:
        try:
            euro, _, cents = importo.partition(",")
            cents = (cents + "00")[:2]
            return int(euro) * 100 + int(cents)
        except (ValueError, AttributeError):
            return None

    @staticmethod
    def _parse_scadenza(s: str):
        from datetime import datetime
        try:
            return datetime.strptime(s, "%d/%m/%Y").date()
        except (ValueError, TypeError):
            return None

    def _extract_payment_from_page_qr(self, doc, page_idx: int) -> tuple[Optional[PaymentData], list[str]]:
        """QR di UNA pagina specifica: immagini embedded poi rendering 3x/4x."""
        from PIL import Image
        import fitz

        warnings: list[str] = []
        page = doc[page_idx]

        images = page.get_images(full=True)
        try:
            images = sorted(
                images,
                key=lambda info: (
                    round(page.get_image_bbox(info).y0),
                    round(page.get_image_bbox(info).x0),
                ),
            )
        except Exception:
            warnings.append(f"Pagina {page_idx}: ordinamento immagini per bbox fallito, uso ordine nativo")

        for img_info in images:
            try:
                base = doc.extract_image(img_info[0])
                img = Image.open(io.BytesIO(base["image"]))
                if img.width < 50 or img.height < 50:
                    continue
                for code in self._decode_qr(img):
                    result = self._parse_pagopa_qr(code.data.decode("utf-8"))
                    if result:
                        return result, warnings
            except Exception:
                continue

        for zoom in (3, 4):
            try:
                pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                for code in self._decode_qr(img):
                    result = self._parse_pagopa_qr(code.data.decode("utf-8"))
                    if result:
                        return result, warnings
            except Exception as e:
                warnings.append(f"Pagina {page_idx}: rendering {zoom}x fallito — {e}")

        warnings.append(f"Pagina {page_idx}: QR PagoPA non decodificato")
        return None, warnings

    def extract_payment(self) -> tuple[Optional[PaymentData], list[PaymentData], list[str]]:
        """
        Scansiona TUTTO il documento per pagine CBILL (non più solo la
        prima), classifica ciascuna via etichetta testuale ("RATA UNICA" ->
        totale, "N RATA" -> rata N — il numero nell'etichetta determina
        l'indice, non la posizione pagina), estrae il QR di ciascuna.
        Ritorna (totale, rate, warnings): rate ordinate per indice
        riconosciuto. Controlli di coerenza (somma, scadenze consecutive,
        unica~=prima rata) producono warning, mai bloccanti.
        """
        warnings: list[str] = []
        totale: Optional[PaymentData] = None
        rate_by_index: dict[int, PaymentData] = {}
        unknown_counter = 0

        try:
            import fitz

            doc = fitz.open(stream=self._pdf_bytes, filetype="pdf")
            cbill_pages = self._find_cbill_pages(doc)

            if not cbill_pages:
                warnings.append("Nessuna pagina PagoPA (CBILL) individuata")
            else:
                for page_idx in cbill_pages:
                    text = doc[page_idx].get_text() or ""
                    kind, n = self._classify_payment_page(text)
                    payment, page_warnings = self._extract_payment_from_page_qr(doc, page_idx)
                    warnings.extend(page_warnings)
                    if payment is None:
                        continue
                    if kind == "unica":
                        totale = payment
                    elif kind == "rata" and n is not None:
                        rate_by_index[n] = payment
                    else:
                        unknown_counter += 1
                        idx = max(rate_by_index.keys(), default=0) + unknown_counter
                        rate_by_index[idx] = payment
                        warnings.append(f"Pagina {page_idx}: etichetta rata non riconosciuta, assegnata come rata {idx}")
        except Exception as e:
            warnings.append(f"Estrazione QR fallita: {e}")

        rate = [rate_by_index[k] for k in sorted(rate_by_index.keys())]

        text_fallback = self._extract_payment_from_text()
        if totale is None and not rate and text_fallback:
            warnings.append("QR non leggibile: dati PagoPA estratti dal testo (fallback)")
            totale = text_fallback
        elif totale and text_fallback and text_fallback.scadenza and not totale.scadenza:
            totale.scadenza = text_fallback.scadenza

        if totale and rate:
            totale_cents = self._importo_to_cents(totale.importo)
            rate_cents_list = [self._importo_to_cents(r.importo) for r in rate]
            if totale_cents is not None and all(c is not None for c in rate_cents_list):
                if totale_cents != sum(rate_cents_list):
                    warnings.append(
                        f"Somma rate ({sum(rate_cents_list) / 100:.2f}) diversa dal totale ({totale_cents / 100:.2f})"
                    )
            if totale.scadenza and rate[0].scadenza and totale.scadenza != rate[0].scadenza:
                warnings.append("Scadenza rata unica diversa dalla scadenza della prima rata")

        if len(rate) > 1:
            date_objs = [self._parse_scadenza(r.scadenza) for r in rate]
            if all(d is not None for d in date_objs) and date_objs != sorted(date_objs):
                warnings.append("Scadenze delle rate non in ordine crescente")

        return totale, rate, warnings
```

`_find_pagopa_pages` (ricerca keyword generiche dal fondo, fallback storico) viene rimosso: non più necessario, `_find_cbill_pages` scansiona tutto il documento dall'inizio e il fallback testuale (`_extract_payment_from_text`) copre già il caso "nessun CBILL trovato via QR".

- [ ] **Step 5: Run — PASS atteso**

```bash
docker run --rm -v "$(pwd)/services/pdf-extractor:/svc" -w /svc python:3.11-slim sh -c "apt-get update -qq && apt-get install -y -qq libzbar0 > /dev/null && pip install -q -r requirements-dev.txt && python -m pytest tests/test_pdf_extractor.py -v"
```

Expected: tutti i test PASS (9 totali: 4 esistenti su indirizzo + 6 su pagamento, inclusi i 4 nuovi).

- [ ] **Step 6: Commit**

```bash
git add services/pdf-extractor
git commit -m "feat(pdf-extractor): estrazione multi-rata via classificazione etichetta pagina"
```

---

### Task 2: Python — contratto `/extract` aggiornato

**Files:**
- Modify: `services/pdf-extractor/app/main.py`
- Test: `services/pdf-extractor/tests/test_api.py`

**Interfaces:**
- Consumes: `PdfExtractor.extract_payment() -> tuple[Optional[PaymentData], list[PaymentData], list[str]]` (Task 1).
- Produces: `POST /extract` (nessun query param `mode`) → `200 {"address": {...}|null, "payment": {"totale": {...}|null, "rate": [{...}, ...]} | null, "warnings": [...]}`. `payment` è `null` SOLO se sia `totale` che `rate` sono vuoti/assenti; altrimenti è sempre l'oggetto `{totale, rate}` (anche con `totale: null` se ci sono solo rate, o `rate: []` se c'è solo il totale).

- [ ] **Step 1: Test failing**

Sostituisci in `services/pdf-extractor/tests/test_api.py` la funzione `test_extract_full` (che assume `body["payment"]["numero_avviso"]`, forma piatta ormai cambiata) con:

```python
def test_extract_full(pdf_with_qr):
    res = client.post(
        "/extract",
        files={"file": ("doc.pdf", pdf_with_qr, "application/pdf")},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["address"]["cap"] == "00100"
    assert body["payment"]["totale"]["numero_avviso"] == "301000000000000000"
    assert body["payment"]["rate"] == []
    assert isinstance(body["warnings"], list)


def test_extract_multi_rata(pdf_unica_e_due_rate):
    res = client.post(
        "/extract",
        files={"file": ("doc.pdf", pdf_unica_e_due_rate, "application/pdf")},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["payment"]["totale"]["importo"] == "761,00"
    assert len(body["payment"]["rate"]) == 2
    assert body["payment"]["rate"][0]["importo"] == "380,50"
```

Rimuovi `?mode=unica` anche dalle altre due funzioni esistenti (`test_extract_no_data`, `test_extract_corrupted_pdf`): sostituisci `"/extract?mode=unica"` con `"/extract"`.

- [ ] **Step 2: Run — FAIL atteso**

```bash
docker run --rm -v "$(pwd)/services/pdf-extractor:/svc" -w /svc python:3.11-slim sh -c "apt-get update -qq && apt-get install -y -qq libzbar0 > /dev/null && pip install -q -r requirements-dev.txt && python -m pytest tests/test_api.py -v"
```

Expected: FAIL — `main.py` chiama ancora `extract_payment(mode=mode)` con la vecchia firma/forma di ritorno.

- [ ] **Step 3: Riscrivi main.py**

Sostituisci l'intero contenuto di `services/pdf-extractor/app/main.py`:

```python
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
```

- [ ] **Step 4: Run — PASS atteso**

```bash
docker run --rm -v "$(pwd)/services/pdf-extractor:/svc" -w /svc python:3.11-slim sh -c "apt-get update -qq && apt-get install -y -qq libzbar0 > /dev/null && pip install -q -r requirements-dev.txt && python -m pytest tests/ -v"
```

Expected: tutti i test PASS (`test_pdf_extractor.py` + `test_api.py`, ~14 totali).

- [ ] **Step 5: Commit**

```bash
git add services/pdf-extractor
git commit -m "feat(pdf-extractor): contratto /extract con payment {totale, rate}, rimosso mode"
```

---

### Task 3: Backend — client HTTP aggiornato (TDD)

**Files:**
- Modify: `apps/backend/src/enrichment/pdf-extractor.client.ts`
- Test: `apps/backend/src/enrichment/pdf-extractor.client.spec.ts`

**Interfaces:**
- Produces: `ExtractedPaymentDetail { numero_avviso, numero_avviso_alternativo, cf_ente, importo, scadenza }` (stessa forma di prima, rinominata); `ExtractedPayment { totale: ExtractedPaymentDetail | null; rate: ExtractedPaymentDetail[] }`; `ExtractResult { address, payment: ExtractedPayment | null, warnings }`; `PdfExtractorClient.extract(pdf: Buffer, filename: string): Promise<ExtractResult>` — **firma cambiata**: parametro `mode` rimosso.

- [ ] **Step 1: Test failing**

Sostituisci in `apps/backend/src/enrichment/pdf-extractor.client.spec.ts` il primo test (`'POST multipart a /extract con mode in query e parse della risposta'`) con:

```typescript
  it('POST multipart a /extract (nessun query param) e parse della risposta con payment {totale, rate}', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        address: { cap: '00100' },
        payment: { totale: { numero_avviso: '123' }, rate: [{ numero_avviso: '456' }] },
        warnings: ['w1'],
      }),
    });

    const result = await client.extract(Buffer.from('%PDF'), 'doc.pdf');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://pdf-extractor:8000/extract',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.address).toEqual({ cap: '00100' });
    expect(result.payment?.totale).toEqual({ numero_avviso: '123' });
    expect(result.payment?.rate).toEqual([{ numero_avviso: '456' }]);
    expect(result.warnings).toEqual(['w1']);
  });
```

Il secondo test (`'HTTP non-ok → Error con status'`) resta invariato ma aggiorna la chiamata: `client.extract(Buffer.from('x'), 'doc.pdf')` (senza terzo argomento `'unica'`).

- [ ] **Step 2: Run — FAIL atteso**

```bash
docker compose exec backend node_modules/.bin/jest pdf-extractor.client --maxWorkers=2
```

Expected: FAIL — l'URL atteso è senza `?mode=unica`, il client attuale lo aggiunge ancora.

- [ ] **Step 3: Riscrivi pdf-extractor.client.ts**

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../config/configuration';

export interface ExtractedAddress {
  indirizzo: string;
  cap: string;
  comune: string;
  provincia: string;
  stato_estero: string;
}

export interface ExtractedPaymentDetail {
  numero_avviso: string;
  numero_avviso_alternativo: string;
  cf_ente: string;
  importo: string;
  scadenza: string;
}

export interface ExtractedPayment {
  totale: ExtractedPaymentDetail | null;
  rate: ExtractedPaymentDetail[];
}

export interface ExtractResult {
  address: ExtractedAddress | null;
  payment: ExtractedPayment | null;
  warnings: string[];
}

@Injectable()
export class PdfExtractorClient {
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  async extract(pdf: Buffer, filename: string): Promise<ExtractResult> {
    const baseUrl = this.config.get('pdfExtractor.url', { infer: true });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);

    const res = await fetch(`${baseUrl}/extract`, { method: 'POST', body: form });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`pdf-extractor HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as ExtractResult;
  }
}
```

- [ ] **Step 4: Run — PASS atteso, poi commit**

```bash
docker compose exec backend node_modules/.bin/jest pdf-extractor.client --maxWorkers=2
git add apps/backend/src/enrichment
git commit -m "feat(backend): client pdf-extractor con payment {totale, rate}, rimosso mode"
```

---

### Task 4: Backend — CSV output con header dinamico (TDD)

**Files:**
- Modify: `apps/backend/src/enrichment/enriched-csv.util.ts`
- Test: `apps/backend/src/enrichment/enriched-csv.util.spec.ts`

**Interfaces:**
- Produces: `BASE_CSV_HEADERS: readonly string[]` (le 17 colonne esistenti, invariate); `buildEnrichedCsvHeaders(maxRate: number): string[]` (base + `rataN_numero_avviso/importo/scadenza` per `N` da 1 a `maxRate`); `EnrichedRow = Partial<Record<string, string>>` (non più tipizzato sui soli header base, serve accettare anche chiavi `rataN_*` dinamiche); `buildEnrichedCsv(headers: string[], rows: EnrichedRow[]): string` — **firma cambiata**: primo parametro `headers` esplicito invece della costante globale.

- [ ] **Step 1: Test failing**

Sostituisci l'intero contenuto di `apps/backend/src/enrichment/enriched-csv.util.spec.ts`:

```typescript
import { BASE_CSV_HEADERS, buildEnrichedCsv, buildEnrichedCsvHeaders } from './enriched-csv.util';

describe('buildEnrichedCsvHeaders', () => {
  it('maxRate=0: solo le colonne base', () => {
    expect(buildEnrichedCsvHeaders(0)).toEqual([...BASE_CSV_HEADERS]);
  });

  it('maxRate=2: base + rata1_* + rata2_*', () => {
    const headers = buildEnrichedCsvHeaders(2);
    expect(headers).toEqual([
      ...BASE_CSV_HEADERS,
      'rata1_numero_avviso', 'rata1_importo', 'rata1_scadenza',
      'rata2_numero_avviso', 'rata2_importo', 'rata2_scadenza',
    ]);
  });
});

describe('buildEnrichedCsv', () => {
  it('header presente, celle SEMPRE virgolettate, delimitatore ;', () => {
    const headers = buildEnrichedCsvHeaders(0);
    const csv = buildEnrichedCsv(headers, [
      { codice_fiscale: 'RSSMRA80A01H501U', nominativo: 'ROSSI MARIO', importo: '761,00' },
    ]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(headers.map((h) => `"${h}"`).join(';'));
    expect(lines[1].startsWith('"RSSMRA80A01H501U";"ROSSI MARIO"')).toBe(true);
    expect(lines[1].split(';')).toHaveLength(headers.length);
    expect(lines[1].split(';').every((c) => c.startsWith('"') && c.endsWith('"'))).toBe(true);
  });

  it('righe con meno rate del massimo del job lasciano le colonne rataN eccedenti vuote', () => {
    const headers = buildEnrichedCsvHeaders(2);
    const csv = buildEnrichedCsv(headers, [
      { codice_fiscale: 'A', rata1_importo: '380,50' }, // solo 1 rata: rata2_* vuote
    ]);
    const lines = csv.split('\n');
    const cells = lines[1].split(';');
    const rata1ImportoIdx = headers.indexOf('rata1_importo');
    const rata2ImportoIdx = headers.indexOf('rata2_importo');
    expect(cells[rata1ImportoIdx]).toBe('"380,50"');
    expect(cells[rata2ImportoIdx]).toBe('""');
  });

  it('escape virgolette interne raddoppiandole', () => {
    const headers = buildEnrichedCsvHeaders(0);
    const csv = buildEnrichedCsv(headers, [{ nominativo: 'DITTA "LA VELOCE"' }]);
    expect(csv).toContain('"DITTA ""LA VELOCE"""');
  });

  it('nessun BOM iniziale', () => {
    const headers = buildEnrichedCsvHeaders(0);
    expect(buildEnrichedCsv(headers, []).charCodeAt(0)).not.toBe(0xfeff);
  });
});
```

- [ ] **Step 2: Run — FAIL atteso**

```bash
docker compose exec backend node_modules/.bin/jest enriched-csv --maxWorkers=2
```

Expected: FAIL — `buildEnrichedCsvHeaders` non esiste, `buildEnrichedCsv` ha ancora la vecchia firma a un solo argomento.

- [ ] **Step 3: Riscrivi enriched-csv.util.ts**

```typescript
/**
 * CSV arricciato in output dalla dashboard Arricchimento: formato pronto per
 * l'import nel wizard campagne. QUOTE_ALL deliberato (il vecchio convertitore
 * sendcsv usava QUOTE_MINIMAL perché imposto dal portale SEND — requisito del
 * vecchio target, non nostro).
 *
 * Header dinamico: le colonne rataN_* (numero_avviso/importo/scadenza per
 * ogni rata) non sono fisse — dipendono dal massimo numero di rate trovate
 * tra tutti i record del job corrente (calcolato dal processor).
 */
export const BASE_CSV_HEADERS = [
  'codice_fiscale',
  'nominativo',
  'tipo',
  'pec',
  'indirizzo',
  'cap',
  'comune',
  'provincia',
  'stato_estero',
  'allegato',
  'numero_avviso',
  'numero_avviso_alternativo',
  'importo',
  'scadenza',
  'numero_provvedimento',
  'data_emissione',
  'oggetto',
] as const;

export function buildEnrichedCsvHeaders(maxRate: number): string[] {
  const headers: string[] = [...BASE_CSV_HEADERS];
  for (let i = 1; i <= maxRate; i++) {
    headers.push(`rata${i}_numero_avviso`, `rata${i}_importo`, `rata${i}_scadenza`);
  }
  return headers;
}

export type EnrichedRow = Partial<Record<string, string>>;

const quote = (v: string | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function buildEnrichedCsv(headers: string[], rows: EnrichedRow[]): string {
  const lines = [headers.map(quote).join(';')];
  for (const row of rows) {
    lines.push(headers.map((h) => quote(row[h])).join(';'));
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run — PASS atteso, poi commit**

```bash
docker compose exec backend node_modules/.bin/jest enriched-csv --maxWorkers=2
git add apps/backend/src/enrichment
git commit -m "feat(backend): CSV arricchito con header dinamico per colonne rataN_*"
```

---

### Task 5: Backend — EnrichmentEventsService (bridge SSE, TDD)

**Files:**
- Create: `apps/backend/src/enrichment/enrichment-events.service.ts`
- Modify: `apps/backend/src/enrichment/enrichment.module.ts` (provider)
- Test: `apps/backend/src/enrichment/enrichment-events.service.spec.ts`

**Interfaces:**
- Produces:
  ```typescript
  interface EnrichmentLogEvent {
    type: 'log';
    row: number;
    pdf: string;
    detail: 'full' | 'summary';
    payload: Record<string, unknown>;
  }
  interface EnrichmentTerminalEvent {
    type: 'done' | 'error';
    message?: string;
  }
  class EnrichmentEventsService {
    emitLog(jobId: string, event: Omit<EnrichmentLogEvent, 'type'>): void;
    emitTerminal(jobId: string, event: EnrichmentTerminalEvent): void;
    subscribe(jobId: string, onEvent: (e: EnrichmentLogEvent | EnrichmentTerminalEvent) => void): () => void;
  }
  ```

- [ ] **Step 1: Test failing**

`apps/backend/src/enrichment/enrichment-events.service.spec.ts`:

```typescript
import { EnrichmentEventsService } from './enrichment-events.service';

describe('EnrichmentEventsService', () => {
  let service: EnrichmentEventsService;

  beforeEach(() => {
    service = new EnrichmentEventsService();
  });

  it('subscribe riceve gli eventi emessi per lo stesso jobId dopo la subscription', () => {
    const received: unknown[] = [];
    service.subscribe('job-1', (e) => received.push(e));

    service.emitLog('job-1', { row: 1, pdf: 'a.pdf', detail: 'full', payload: { x: 1 } });
    service.emitTerminal('job-1', { type: 'done' });

    expect(received).toEqual([
      { type: 'log', row: 1, pdf: 'a.pdf', detail: 'full', payload: { x: 1 } },
      { type: 'done' },
    ]);
  });

  it('subscriber su un jobId diverso non riceve nulla', () => {
    const received: unknown[] = [];
    service.subscribe('job-1', (e) => received.push(e));

    service.emitLog('job-2', { row: 1, pdf: 'a.pdf', detail: 'full', payload: {} });

    expect(received).toEqual([]);
  });

  it('unsubscribe: nessun evento consegnato dopo la chiamata', () => {
    const received: unknown[] = [];
    const unsubscribe = service.subscribe('job-1', (e) => received.push(e));
    unsubscribe();

    service.emitLog('job-1', { row: 1, pdf: 'a.pdf', detail: 'summary', payload: {} });

    expect(received).toEqual([]);
  });

  it('multi-subscriber sullo stesso jobId ricevono entrambi lo stesso evento', () => {
    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];
    service.subscribe('job-1', (e) => receivedA.push(e));
    service.subscribe('job-1', (e) => receivedB.push(e));

    service.emitTerminal('job-1', { type: 'error', message: 'boom' });

    expect(receivedA).toEqual([{ type: 'error', message: 'boom' }]);
    expect(receivedB).toEqual([{ type: 'error', message: 'boom' }]);
  });

  it('emit senza subscriber non lancia errori', () => {
    expect(() => service.emitLog('job-senza-subscriber', { row: 1, pdf: 'a.pdf', detail: 'summary', payload: {} })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run — FAIL atteso**

```bash
docker compose exec backend node_modules/.bin/jest enrichment-events --maxWorkers=2
```

- [ ] **Step 3: Implementazione**

`apps/backend/src/enrichment/enrichment-events.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

export interface EnrichmentLogEvent {
  type: 'log';
  row: number;
  pdf: string;
  detail: 'full' | 'summary';
  payload: Record<string, unknown>;
}

export interface EnrichmentTerminalEvent {
  type: 'done' | 'error';
  message?: string;
}

export type EnrichmentStreamEvent = EnrichmentLogEvent | EnrichmentTerminalEvent;

/**
 * Bridge in-memory tra il worker BullMQ (EnrichmentProcessor) e l'endpoint
 * SSE consultato dal frontend. Funziona SOLO perché worker e HTTP server
 * girano nello stesso processo Node (un solo servizio "backend" in
 * docker-compose, nessun worker separato) — se in futuro il backend scala a
 * più repliche, va sostituito con Redis pub/sub (non anticipato ora, YAGNI).
 * Nessuna persistenza: chi non è connesso quando un evento viene emesso lo
 * perde, è un log LIVE non uno storico (i warning finali restano comunque
 * su EnrichmentJob.warnings a fine job).
 */
@Injectable()
export class EnrichmentEventsService {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Più operatori potrebbero osservare lo stesso job in parallelo.
    this.emitter.setMaxListeners(50);
  }

  emitLog(jobId: string, event: Omit<EnrichmentLogEvent, 'type'>): void {
    this.emitter.emit(jobId, { type: 'log', ...event } satisfies EnrichmentLogEvent);
  }

  emitTerminal(jobId: string, event: EnrichmentTerminalEvent): void {
    this.emitter.emit(jobId, event);
  }

  subscribe(jobId: string, onEvent: (e: EnrichmentStreamEvent) => void): () => void {
    this.emitter.on(jobId, onEvent);
    return () => this.emitter.off(jobId, onEvent);
  }
}
```

Registra `EnrichmentEventsService` in `providers` di `enrichment.module.ts` (accanto a `EnrichmentService`, `PdfExtractorClient`, `EnrichmentProcessor`, `EnrichmentRetentionService`).

- [ ] **Step 4: Run — PASS atteso, poi commit**

```bash
docker compose exec backend node_modules/.bin/jest enrichment-events --maxWorkers=2
git add apps/backend/src/enrichment
git commit -m "feat(backend): EnrichmentEventsService, bridge in-memory per log SSE"
```

---

### Task 6: Backend — Processor: rate + eventi log (TDD)

**Files:**
- Modify: `apps/backend/src/enrichment/enrichment.processor.ts`
- Test: `apps/backend/src/enrichment/enrichment.processor.spec.ts`

**Interfaces:**
- Consumes: `PdfExtractorClient.extract(pdf, filename): Promise<ExtractResult>` (Task 3, `ExtractResult.payment: {totale, rate} | null`), `buildEnrichedCsvHeaders(maxRate)`/`buildEnrichedCsv(headers, rows)` (Task 4), `EnrichmentEventsService.emitLog/emitTerminal` (Task 5).
- Produces: comportamento invariato all'esterno (stessa entity, stesso `EnrichmentQueueJobData`), ma ora: righe CSV con colonne `rataN_*`, ed emette eventi log durante l'elaborazione.

- [ ] **Step 1: Aggiorna i test esistenti (mock payment ora {totale, rate})**

In `apps/backend/src/enrichment/enrichment.processor.spec.ts`, il mock `client.extract` ritorna oggi `{ address, payment: {...campi piatti...}, warnings }` — aggiorna TUTTI i mock a ritornare `payment: { totale: {...} | null, rate: [...] }`. Sostituisci l'intero blocco `beforeEach` e i test che usano `client.extract.mockResolvedValue` con:

```typescript
    client = {
      extract: jest.fn(async () => ({
        address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
        payment: {
          totale: { numero_avviso: '301000000000000001', numero_avviso_alternativo: '', cf_ente: '000', importo: '761,00', scadenza: '31/12/2026' },
          rate: [],
        },
        warnings: [],
      })),
    };
    events = { emitLog: jest.fn(), emitTerminal: jest.fn() };
    processor = new EnrichmentProcessor(repo, client, events);
```

(`events` è una nuova variabile `let events: any;` dichiarata nel `describe`, il costruttore `EnrichmentProcessor` ora prende un terzo parametro.)

Il test `'warnings del servizio Python confluiscono nei warnings del job'` aggiorna il mock a:

```typescript
    client.extract.mockResolvedValue({ address: null, payment: null, warnings: ['Indirizzo non estratto: xyz'] });
```

(già compatibile, `payment: null` resta valido).

Il test `'indirizzo e numero avviso da pag_indice.csv vincono sui dati estratti dal PDF'` (Task 9 del piano precedente) aggiorna il mock:

```typescript
    client.extract.mockResolvedValue({
      address: { indirizzo: 'VIA PDF ESTRATTA 99', cap: '99999', comune: 'ALTROVE', provincia: 'XX', stato_estero: '' },
      payment: {
        totale: { numero_avviso: '999999999999999999', numero_avviso_alternativo: 'PDF-ALT', cf_ente: '000', importo: '10,00', scadenza: '01/01/2027' },
        rate: [],
      },
      warnings: [],
    });
```

- [ ] **Step 2: Aggiungi test per rate multiple + eventi log**

Aggiungi in fondo al file (prima dell'ultima `});` di chiusura del `describe`):

```typescript
  it('rate multiple: header CSV con colonne rataN_*, riga con meno rate lascia colonne vuote', async () => {
    client.extract.mockResolvedValueOnce({
      address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
      payment: {
        totale: { numero_avviso: '301000000000000000', numero_avviso_alternativo: '', cf_ente: '000', importo: '761,00', scadenza: '31/12/2026' },
        rate: [
          { numero_avviso: '301000000000000001', numero_avviso_alternativo: '', cf_ente: '000', importo: '380,50', scadenza: '31/01/2027' },
          { numero_avviso: '301000000000000002', numero_avviso_alternativo: '', cf_ente: '000', importo: '380,50', scadenza: '28/02/2027' },
        ],
      },
      warnings: [],
    });
    // Riga 2 (PDF mancante nello ZIP): nessuna rata, colonne rataN_* vuote

    await processor.process(fakeJob);

    const csv = fs.readFileSync(getEnrichmentResultCsv('j1'), 'utf-8');
    const lines = csv.split('\n');
    expect(lines[0]).toContain('"rata1_importo"');
    expect(lines[0]).toContain('"rata2_importo"');
    expect(lines[1]).toContain('"380,50"'); // rata1 e rata2 hanno lo stesso importo in questo fixture
    const cells2 = lines[2].split(';');
    const rata1Idx = lines[0].split(';').indexOf('"rata1_importo"');
    expect(cells2[rata1Idx]).toBe('""'); // riga 2 senza PDF: nessuna rata
  });

  it('emette evento log full per la riga 1, summary per le successive, terminale done a fine job', async () => {
    await processor.process(fakeJob);

    expect(events.emitLog).toHaveBeenCalledWith('j1', expect.objectContaining({ row: 1, detail: 'full' }));
    expect(events.emitLog).toHaveBeenCalledWith('j1', expect.objectContaining({ row: 2, detail: 'summary' }));
    expect(events.emitTerminal).toHaveBeenCalledWith('j1', { type: 'done' });
  });

  it('errore fatale: emette evento terminale error invece di done', async () => {
    fs.rmSync(getEnrichmentSourceZip('j1'));
    await processor.process(fakeJob);
    expect(events.emitTerminal).toHaveBeenCalledWith('j1', expect.objectContaining({ type: 'error' }));
    expect(events.emitTerminal).not.toHaveBeenCalledWith('j1', { type: 'done' });
  });
```

- [ ] **Step 3: Run — FAIL atteso**

```bash
docker compose exec backend node_modules/.bin/jest enrichment.processor --maxWorkers=2
```

Expected: FAIL — costruttore `EnrichmentProcessor` non accetta ancora `events`, `baseRow`/merge non gestisce `payment.totale`/`payment.rate`.

- [ ] **Step 4: Riscrivi enrichment.processor.ts**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import * as fs from 'fs';
import AdmZip from 'adm-zip';
import {
  EnrichmentJob,
  EnrichmentJobStatus,
  EnrichmentWarning,
} from '../entities/enrichment-job.entity';
import { ENRICHMENT_QUEUE, EnrichmentQueueJobData } from './enrichment-job.types';
import { getEnrichmentResultCsv, getEnrichmentSourceZip } from './enrichment-paths';
import { parseMaggioliZip, type MaggioliRecord } from './maggioli-parser';
import { buildEnrichedCsv, buildEnrichedCsvHeaders, type EnrichedRow } from './enriched-csv.util';
import { PdfExtractorClient, type ExtractedPaymentDetail } from './pdf-extractor.client';
import { EnrichmentEventsService } from './enrichment-events.service';

const PROGRESS_UPDATE_EVERY = 10;

@Injectable()
@Processor(ENRICHMENT_QUEUE)
export class EnrichmentProcessor extends WorkerHost {
  private readonly logger = new Logger(EnrichmentProcessor.name);

  constructor(
    @InjectRepository(EnrichmentJob)
    private readonly jobRepo: Repository<EnrichmentJob>,
    private readonly extractor: PdfExtractorClient,
    private readonly events: EnrichmentEventsService,
  ) {
    super();
  }

  async process(job: Job<EnrichmentQueueJobData>): Promise<void> {
    const { jobId } = job.data;
    const record = await this.jobRepo.findOneBy({ id: jobId });
    if (!record) {
      this.logger.warn(`EnrichmentJob ${jobId} non trovato — job BullMQ scartato`);
      return;
    }

    try {
      await this.jobRepo.update(jobId, { status: EnrichmentJobStatus.PROCESSING });

      const zip = new AdmZip(getEnrichmentSourceZip(jobId));
      const { records } = parseMaggioliZip(zip);
      const warnings: EnrichmentWarning[] = [];
      const rows: EnrichedRow[] = [];
      let maxRate = 0;

      for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        const rowNum = i + 1;
        const row = this.baseRow(rec);
        let rateCount = 0;

        const entry = rec.pdfFilename ? zip.getEntry(`allegati/${rec.pdfFilename}`) : null;
        if (!entry) {
          warnings.push({ row: rowNum, pdf: rec.pdfFilename, message: 'PDF non trovato nel ZIP' });
          await job.log(`Riga ${rowNum}: PDF "${rec.pdfFilename}" non trovato nel ZIP`);
          this.events.emitLog(jobId, {
            row: rowNum,
            pdf: rec.pdfFilename,
            detail: rowNum === 1 ? 'full' : 'summary',
            payload: { errore: 'PDF non trovato nel ZIP' },
          });
        } else {
          try {
            const result = await this.extractor.extract(entry.getData(), rec.pdfFilename);
            for (const w of result.warnings) {
              warnings.push({ row: rowNum, pdf: rec.pdfFilename, message: w });
            }
            if (!rec.csvAddress && result.address) {
              row.indirizzo = result.address.indirizzo;
              row.cap = result.address.cap;
              row.comune = result.address.comune;
              row.provincia = result.address.provincia;
              row.stato_estero = result.address.stato_estero;
            }
            if (result.payment?.totale) {
              row.numero_avviso = rec.csvNumeroAvviso || result.payment.totale.numero_avviso;
              row.numero_avviso_alternativo = rec.csvNumeroAvvisoAlt || result.payment.totale.numero_avviso_alternativo;
              row.importo = result.payment.totale.importo;
              row.scadenza = result.payment.totale.scadenza;
            }
            if (result.payment?.rate?.length) {
              rateCount = result.payment.rate.length;
              maxRate = Math.max(maxRate, rateCount);
              result.payment.rate.forEach((rata: ExtractedPaymentDetail, idx: number) => {
                const n = idx + 1;
                row[`rata${n}_numero_avviso`] = rata.numero_avviso;
                row[`rata${n}_importo`] = rata.importo;
                row[`rata${n}_scadenza`] = rata.scadenza;
              });
            }

            this.events.emitLog(jobId, {
              row: rowNum,
              pdf: rec.pdfFilename,
              detail: rowNum === 1 ? 'full' : 'summary',
              payload: rowNum === 1
                ? {
                    indirizzo: result.address,
                    pagamentoTotale: result.payment?.totale ?? null,
                    rate: result.payment?.rate ?? [],
                    warnings: result.warnings,
                  }
                : {
                    indirizzoTrovato: Boolean(result.address || rec.csvAddress),
                    pagamentoTotaleTrovato: Boolean(result.payment?.totale),
                    numeroRate: rateCount,
                    warningCount: result.warnings.length,
                  },
            });
          } catch (err: any) {
            warnings.push({ row: rowNum, pdf: rec.pdfFilename, message: `Estrazione fallita: ${err.message}` });
            await job.log(`Riga ${rowNum}: estrazione fallita — ${err.message}`);
            this.events.emitLog(jobId, {
              row: rowNum,
              pdf: rec.pdfFilename,
              detail: rowNum === 1 ? 'full' : 'summary',
              payload: { errore: `Estrazione fallita: ${err.message}` },
            });
          }
        }

        rows.push(row);

        if (rowNum % PROGRESS_UPDATE_EVERY === 0) {
          await this.jobRepo.update(jobId, { processedRecords: rowNum, warningCount: warnings.length });
        }
      }

      const headers = buildEnrichedCsvHeaders(maxRate);
      fs.writeFileSync(getEnrichmentResultCsv(jobId), buildEnrichedCsv(headers, rows), 'utf-8');

      await this.jobRepo.update(jobId, {
        status: EnrichmentJobStatus.DONE,
        processedRecords: records.length,
        warningCount: warnings.length,
        warnings,
        completedAt: new Date(),
      });
      this.events.emitTerminal(jobId, { type: 'done' });
      this.logger.log(`EnrichmentJob ${jobId} completato: ${records.length} righe, ${warnings.length} warning`);
    } catch (err: any) {
      // Stato terminale PRIMA di uscire: mai lasciare il record in PROCESSING
      this.logger.error(`EnrichmentJob ${jobId} fallito: ${err.message}`);
      await this.jobRepo.update(jobId, {
        status: EnrichmentJobStatus.FAILED,
        errorMessage: err.message,
        completedAt: new Date(),
      });
      this.events.emitTerminal(jobId, { type: 'error', message: err.message });
    }
  }

  private baseRow(rec: MaggioliRecord): EnrichedRow {
    return {
      codice_fiscale: rec.codiceFiscale,
      nominativo: rec.nominativo,
      tipo: rec.tipo,
      pec: rec.pec,
      indirizzo: rec.csvAddress?.indirizzo ?? '',
      cap: rec.csvAddress?.cap ?? '',
      comune: rec.csvAddress?.comune ?? '',
      provincia: rec.csvAddress?.provincia ?? '',
      stato_estero: rec.csvAddress?.statoEstero ?? '',
      allegato: rec.pdfFilename,
      numero_avviso: rec.csvNumeroAvviso,
      numero_avviso_alternativo: rec.csvNumeroAvvisoAlt,
      importo: '',
      scadenza: '',
      numero_provvedimento: rec.numeroProvvedimento,
      data_emissione: rec.dataEmissione,
      oggetto: rec.oggetto,
    };
  }
}
```

Nota: `maxRate` è calcolato SOLO sulle rate estratte via PDF (`pag_indice.csv` non fornisce mai dati per singola rata — invariato dal design originale).

- [ ] **Step 5: Run — PASS atteso, poi commit**

```bash
docker compose exec backend node_modules/.bin/jest enrichment.processor --maxWorkers=2
docker compose exec backend node_modules/.bin/tsc --noEmit
git add apps/backend/src/enrichment
git commit -m "feat(backend): processor gestisce rate multiple + emette eventi log per SSE"
```

---

### Task 7: Backend — endpoint SSE (TDD)

**Files:**
- Modify: `apps/backend/src/enrichment/enrichment.controller.ts`
- Test: `apps/backend/src/enrichment/enrichment.controller.spec.ts`

**Interfaces:**
- Consumes: `EnrichmentEventsService.subscribe(jobId, onEvent): () => void` (Task 5), `EnrichmentService.getJob(id)` (esistente).
- Produces: `GET admin/enrichment/jobs/:id/stream` (ruoli `user`+`admin`) — `Content-Type: text/event-stream`, righe `data: <json>\n\n` per ogni evento, chiude lo stream alla ricezione di un evento terminale o alla disconnessione client.

- [ ] **Step 1: Test failing**

Aggiungi a `apps/backend/src/enrichment/enrichment.controller.spec.ts` (nel `beforeEach`, aggiungi `events` al mock e passalo al costruttore):

```typescript
    events = {
      subscribe: jest.fn(() => jest.fn()), // ritorna una funzione di unsubscribe fittizia
    };
    controller = new EnrichmentController(svc, events);
```

(dichiara `let events: any;` insieme a `svc`/`controller` in cima al `describe`).

Aggiungi in fondo al file, prima dell'ultima `});`:

```typescript
  it('stream: job già terminale (DONE) → invia subito evento done e chiude, nessuna subscription', async () => {
    svc.getJob = jest.fn(async () => ({ id: 'j1', status: 'done' }));
    const req: any = { on: jest.fn() };
    const res: any = { setHeader: jest.fn(), write: jest.fn(), end: jest.fn() };

    await controller.streamJob('j1', req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"type":"done"'));
    expect(res.end).toHaveBeenCalled();
    expect(events.subscribe).not.toHaveBeenCalled();
  });

  it('stream: job in corso (processing) → si iscrive e inoltra gli eventi ricevuti', async () => {
    svc.getJob = jest.fn(async () => ({ id: 'j1', status: 'processing' }));
    let capturedHandler: ((e: any) => void) | undefined;
    const unsubscribe = jest.fn();
    events.subscribe = jest.fn((_jobId: string, handler: (e: any) => void) => {
      capturedHandler = handler;
      return unsubscribe;
    });
    const req: any = { on: jest.fn() };
    const res: any = { setHeader: jest.fn(), write: jest.fn(), end: jest.fn() };

    const streamPromise = controller.streamJob('j1', req, res);
    // Simula un evento emesso mentre il client è connesso
    capturedHandler?.({ type: 'log', row: 1, pdf: 'a.pdf', detail: 'full', payload: {} });
    capturedHandler?.({ type: 'done' });
    await streamPromise;

    expect(events.subscribe).toHaveBeenCalledWith('j1', expect.any(Function));
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"row":1'));
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"type":"done"'));
    expect(res.end).toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('stream: disconnessione client → unsubscribe chiamata', async () => {
    svc.getJob = jest.fn(async () => ({ id: 'j1', status: 'processing' }));
    let closeHandler: (() => void) | undefined;
    const unsubscribe = jest.fn();
    events.subscribe = jest.fn(() => unsubscribe);
    const req: any = { on: jest.fn((event: string, cb: () => void) => { if (event === 'close') closeHandler = cb; }) };
    const res: any = { setHeader: jest.fn(), write: jest.fn(), end: jest.fn() };

    const streamPromise = controller.streamJob('j1', req, res);
    closeHandler?.();
    await streamPromise;

    expect(unsubscribe).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run — FAIL atteso**

```bash
docker compose exec backend node_modules/.bin/jest enrichment.controller --maxWorkers=2
```

- [ ] **Step 3: Implementazione**

In `apps/backend/src/enrichment/enrichment.controller.ts`, aggiungi l'import e il parametro costruttore:

```typescript
import { EnrichmentEventsService } from './enrichment-events.service';
```

```typescript
  constructor(
    private readonly svc: EnrichmentService,
    private readonly events: EnrichmentEventsService,
  ) {}
```

Aggiungi il nuovo endpoint (dopo `getJob`, prima di `downloadCsv`):

```typescript
  @Get('jobs/:id/stream')
  @Roles('user', 'admin')
  async streamJob(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const job = await this.svc.getJob(id);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (job.status === 'done' || job.status === 'failed') {
      res.write(`data: ${JSON.stringify({ type: job.status === 'done' ? 'done' : 'error', message: job.errorMessage ?? undefined })}\n\n`);
      res.end();
      return;
    }

    await new Promise<void>((resolve) => {
      const unsubscribe = this.events.subscribe(id, (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'done' || event.type === 'error') {
          unsubscribe();
          res.end();
          resolve();
        }
      });
      req.on('close', () => {
        unsubscribe();
        resolve();
      });
    });
  }
```

- [ ] **Step 4: Run — PASS atteso, poi commit**

```bash
docker compose exec backend node_modules/.bin/jest enrichment.controller --maxWorkers=2
docker compose exec backend node_modules/.bin/tsc --noEmit
git add apps/backend/src/enrichment
git commit -m "feat(backend): endpoint SSE GET jobs/:id/stream per log live"
```

---

### Task 8: Frontend — pannello log live + rate nei warning

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `GET ${ADMIN_API_BASE}/enrichment/jobs/:id/stream` (Task 7), `apiFetch` esistente (`App.tsx:1252`).
- Produces: pannello log nella vista job, aperto automaticamente mentre `status` è `queued`/`processing`.

- [ ] **Step 1: Stato per il log live**

Aggiungi vicino agli altri stati enrichment (dopo `enrichCampaignError`, `App.tsx:570`):

```typescript
  interface EnrichLogEntry {
    row: number;
    pdf: string;
    detail: 'full' | 'summary';
    payload: Record<string, unknown>;
  }
  const [enrichLiveLogs, setEnrichLiveLogs] = useState<Record<string, EnrichLogEntry[]>>({});
  const [enrichStreamingJobId, setEnrichStreamingJobId] = useState<string | null>(null);
```

- [ ] **Step 2: Funzione di lettura stream (fetch + reader manuale, MAI EventSource)**

Aggiungi dopo `fetchEnrichJobs` (circa `App.tsx:1485`):

```typescript
  const streamEnrichJobLog = async (jobId: string) => {
    setEnrichStreamingJobId(jobId);
    setEnrichLiveLogs((prev) => ({ ...prev, [jobId]: [] }));
    try {
      const res = await apiFetch(`/enrichment/jobs/${jobId}/stream`);
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;
          const json = JSON.parse(line.slice('data:'.length).trim());
          if (json.type === 'done' || json.type === 'error') {
            setEnrichStreamingJobId(null);
            await fetchEnrichJobs();
            return;
          }
          setEnrichLiveLogs((prev) => ({
            ...prev,
            [jobId]: [...(prev[jobId] || []), json as EnrichLogEntry],
          }));
        }
      }
    } catch {
      setEnrichStreamingJobId(null);
    }
  };
```

- [ ] **Step 3: Avvia lo stream dopo l'upload e per job già in corso alla navigazione**

Nel corpo di `handleEnrichUpload` (`App.tsx:1498`), dopo `await fetchEnrichJobs();` nel branch di successo (quando `result.blocked` è falso), aggiungi:

```typescript
        if (result.jobId) streamEnrichJobLog(result.jobId);
```

Nell'`useEffect` di polling esistente (`App.tsx:1487` circa, quello che chiama `fetchEnrichJobs` ogni 3s se c'è un job `queued`/`processing`), dopo il primo `fetchEnrichJobs()` iniziale, avvia lo stream per qualunque job già in corso trovato (caso: l'operatore naviga sulla vista job mentre un job caricato in una sessione precedente sta ancora girando):

```typescript
    fetchEnrichJobs().then(() => {
      setEnrichJobs((current) => {
        const inProgress = current.find((j) => j.status === 'queued' || j.status === 'processing');
        if (inProgress && !enrichStreamingJobId) streamEnrichJobLog(inProgress.id);
        return current;
      });
    });
```

(Verifica che `fetchEnrichJobs` ritorni una `Promise` — se attualmente non ha `return` esplicito sull'ultima istruzione async, aggiungilo perché questo `.then()` funzioni.)

- [ ] **Step 4: Pannello log nella vista job**

Nel blocco JSX del job (`App.tsx:7108`-`7157` circa, dentro `enrichJobs.map((job) => (...))`), dopo il blocco `{enrichDetailJobId === job.id && (...)}` (warning) e prima del pannello "Crea bozza campagna", aggiungi:

```tsx
                    {enrichLiveLogs[job.id]?.length > 0 && (
                      <div className="border rounded p-3 mt-2 bg-light">
                        <h6 className="small fw-bold mb-2">
                          Log elaborazione {enrichStreamingJobId === job.id && <span className="badge bg-info-subtle text-info-emphasis ms-1">live</span>}
                        </h6>
                        {enrichLiveLogs[job.id].map((entry, i) =>
                          entry.detail === 'full' ? (
                            <div key={i} className="border rounded p-2 mb-2 bg-white">
                              <strong className="small">Riga {entry.row} — {entry.pdf}</strong>
                              <pre className="small mb-0 mt-1" style={{ whiteSpace: 'pre-wrap' }}>
                                {JSON.stringify(entry.payload, null, 2)}
                              </pre>
                            </div>
                          ) : (
                            <div key={i} className="small text-muted">
                              Riga {entry.row} — {entry.pdf}: {JSON.stringify(entry.payload)}
                            </div>
                          ),
                        )}
                      </div>
                    )}
```

- [ ] **Step 5: Type-check**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: pulito. Se `EnrichLogEntry`/`enrichLiveLogs` danno errori di tipo su `Record<string, EnrichLogEntry[]>[job.id]` possibilmente `undefined`, usa optional chaining come già mostrato (`enrichLiveLogs[job.id]?.length`).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): pannello log live job arricchimento via SSE (fetch+reader)"
```

---

### Task 9: Verifica end-to-end + CLAUDE.md

**Files:** nessuna modifica di codice prevista (solo fix emergenti + doc).

- [ ] **Step 1: Riavvio stack**

```bash
docker compose up -d --build pdf-extractor
docker compose restart backend
docker compose exec backend ls -la dist/enrichment src/enrichment
```

Verifica `dist/` più recente di `src/`.

- [ ] **Step 2: Fixture sintetica con rate multiple**

Genera (via container Python, riusando le fixture di `conftest.py` — vedi Task 1) un PDF con `RATA UNICA` + `1° RATA` + `2° RATA`, assembla uno ZIP Maggioli sintetico (`rubrica.csv` + `allegati/`) — stesso procedimento del Task 14 del piano precedente (`docs/superpowers/plans/2026-07-17-arricchimento-tracciati.md`), MAI dati reali da `sendcsv`.

- [ ] **Step 3: Flusso UI con browser tool**

Login admin → Arricchimento Tracciati → upload ZIP fixture → **verificare che il pannello log appaia SUBITO durante l'elaborazione** (non solo a job concluso), con la riga 1 in dettaglio completo (indirizzo, `pagamentoTotale`, `rate` array) e le righe successive sintetiche → job completo → scarica CSV → verificare colonne `rata1_numero_avviso`/`rata1_importo`/`rata1_scadenza`/`rata2_*` presenti e valorizzate correttamente.

- [ ] **Step 4: Suite complete**

```bash
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
docker run --rm -v "$(pwd)/services/pdf-extractor:/svc" -w /svc python:3.11-slim sh -c "apt-get update -qq && apt-get install -y -qq libzbar0 > /dev/null && pip install -q -r requirements-dev.txt && python -m pytest tests/ -v"
```

Expected: failure set backend identico alla baseline (solo `app.controller.spec.ts`), tsc puliti, pytest tutto verde.

- [ ] **Step 5: Aggiorna CLAUDE.md**

Nella sezione "## Arricchimento tracciati" esistente, aggiungi due paragrafi (stesso stile bold-lead-in delle altre sezioni):

```markdown
**Rate multiple PagoPA — classificazione via etichetta, mai ordine pagina.**
`pdf_extractor.py` scansiona TUTTE le pagine con QR pagamento (non solo la
prima) e classifica ciascuna leggendo il testo: `RATA UNICA` → totale,
`N° RATA` → rata N (il numero nell'etichetta determina l'indice, non la
posizione — alcuni documenti non hanno la pagina "rata unica", altri hanno
solo quella). Il CSV di output ha quindi un header dinamico per job:
colonne `rataN_numero_avviso/importo/scadenza` quante ne servono (max
trovato tra i record del job), calcolate da `buildEnrichedCsvHeaders()`
(`enriched-csv.util.ts`) — non più una costante fissa. Controlli di
coerenza (somma rate vs totale, scadenze consecutive, unica≈prima rata)
producono warning, mai bloccanti.

**Log live job (SSE) — bridge in-memory, valido a singola istanza.**
`GET admin/enrichment/jobs/:id/stream` inoltra in tempo reale gli eventi
che `EnrichmentProcessor` emette via `EnrichmentEventsService`
(`EventEmitter` per jobId) man mano che elabora ogni riga — funziona solo
perché worker BullMQ e HTTP server girano nello stesso processo Node
(un solo servizio `backend`, nessun worker separato). Se il backend scala
a più repliche in futuro, va sostituito con Redis pub/sub — non fatto ora
(YAGNI). Il frontend NON usa `EventSource` nativo (non supporta header
`Authorization`): legge lo stream via `fetch()` +
`response.body.getReader()`, parsing manuale delle righe `data: ...\n\n`.
Nessuna persistenza lato backend — è un log live, non uno storico (i
warning finali restano su `EnrichmentJob.warnings` come sempre).
```

- [ ] **Step 6: Commit finale**

```bash
git add CLAUDE.md
git commit -m "docs: rate multiple PagoPA e log live in CLAUDE.md"
```

## Self-review del piano

- **Copertura spec rate multiple**: classificazione via etichetta (Task 1), niente ordine pagina (Task 1, fixture con pagine deliberatamente fuori ordine), controlli di coerenza (Task 1, 3 fixture dedicate), contratto `/extract` `{totale,rate}` (Task 2), client TS (Task 3), CSV dinamico (Task 4), merge nel processor (Task 6). ✅ tutto coperto.
- **Copertura spec log live**: bridge in-memory (Task 5), eventi per riga full/summary (Task 6), endpoint SSE (Task 7), frontend fetch+reader mai EventSource (Task 8). ✅ tutto coperto.
- **Coerenza tipi tra task**: `PdfExtractorClient.extract()` perde il parametro `mode` in Task 3 — verificato che Task 6 lo chiami senza terzo argomento. `ExtractResult.payment` diventa `{totale, rate} | null` in Task 3 — verificato che Task 6 legga `result.payment?.totale`/`result.payment?.rate`, mai `result.payment.numero_avviso` diretto (vecchia forma). `buildEnrichedCsv` guadagna il parametro `headers` in Task 4 — verificato che Task 6 lo chiami con `buildEnrichedCsvHeaders(maxRate)` come primo argomento.
- **Nessun placeholder**: ogni step ha codice completo, nessun TODO/TBD.
