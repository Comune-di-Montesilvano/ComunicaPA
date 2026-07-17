# Arricchimento Tracciati Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dashboard admin "Arricchimento tracciati": upload ZIP Maggioli → job asincrono che estrae indirizzi e dati PagoPA dai PDF (microservizio Python) → CSV arricchito formato wizard + ZIP scaricabili + creazione bozza campagna.

**Architecture:** Nuovo container Python `pdf-extractor` (FastAPI, solo rete interna) che riusa `pdf_extractor.py` dal repo `sendcsv`; nel backend NestJS un nuovo modulo `enrichment/` con coda BullMQ dedicata seguendo **il pattern esistente `app-io-verify-bulk`** (coda propria + entity di stato + polling UI — NON un nuovo `EngineName` in `ENGINE_QUEUES`: quel meccanismo espone jobs con `campaignId/recipientId/attemptId` che qui non esistono, e aggiungerlo forzerebbe la modifica del costruttore di `NotificationQueuesService` — gotcha audit spec).

**Tech Stack:** Python 3.11 (FastAPI, pdfplumber, PyMuPDF, pyzbar), NestJS 10, BullMQ, adm-zip (già dep), React 19.

**Spec:** `docs/superpowers/specs/2026-07-17-arricchimento-tracciati-design.md`

## Global Constraints

- Tutto gira in Docker: nessun comando Node/Python sull'host. Test backend: `docker compose exec backend node_modules/.bin/jest <pattern> --maxWorkers=2`.
- Upload SEMPRE chunked (`chunked-upload.util.ts`, chunk client 512KB) — limite ~1MB reverse proxy.
- Errori "previsti" degli endpoint → `200 { blocked: true, message }`, mai eccezioni non-2xx.
- CSV output: UTF-8, delimitatore `;`, **tutte le celle tra virgolette doppie** (escape `""`).
- Dal repo `C:\Users\mirko.daddiego\Documents\sendcsv` copiare SOLO sorgenti — MAI i PDF `DOC_*.pdf` né i CSV con dati personali.
- Nessuna nuova dipendenza npm nel backend (adm-zip e csv-parse già presenti) — evita la procedura volume node_modules.
- Nomi migration: registrarle sia in `migrations` array di `database.module.ts`.
- Suite completa a fine lavoro: baseline = solo fallimento noto `app.controller.spec.ts` (`isLdapMock`).
- Frontend admin: niente `<form>` annidate; utility Bootstrap non esistono, usare classi custom esistenti.

---

### Task 1: Servizio Python — core estrazione + test

**Files:**
- Create: `services/pdf-extractor/app/models.py`
- Create: `services/pdf-extractor/app/pdf_extractor.py`
- Create: `services/pdf-extractor/app/__init__.py` (vuoto)
- Create: `services/pdf-extractor/requirements.txt`
- Create: `services/pdf-extractor/requirements-dev.txt`
- Create: `services/pdf-extractor/tests/__init__.py` (vuoto)
- Create: `services/pdf-extractor/tests/conftest.py`
- Test: `services/pdf-extractor/tests/test_pdf_extractor.py`

**Interfaces:**
- Produces: `PdfExtractor(pdf_bytes).extract_address() -> AddressData` (raise `AddressExtractionError`), `PdfExtractor(pdf_bytes).extract_payment(mode: str) -> tuple[Optional[PaymentData], list[str]]` — NOTA: firma DIVERSA dall'originale sendcsv, ritorna anche la lista warnings.
- Dataclass `AddressData(indirizzo, cap, comune, provincia, stato_estero)`, `PaymentData(numero_avviso, numero_avviso_alternativo, cf_ente, importo, scadenza)`.

- [ ] **Step 1: Copia i sorgenti da sendcsv**

Copia SOLO questi due file (non toccare PDF/CSV nel repo sorgente):

```bash
mkdir -p services/pdf-extractor/app services/pdf-extractor/tests
cp /c/Users/mirko.daddiego/Documents/sendcsv/app/models.py services/pdf-extractor/app/models.py
cp /c/Users/mirko.daddiego/Documents/sendcsv/app/pdf_extractor.py services/pdf-extractor/app/pdf_extractor.py
touch services/pdf-extractor/app/__init__.py services/pdf-extractor/tests/__init__.py
```

Da `models.py` elimina la dataclass `RubricaRecord` (il parsing tracciato vive nel backend TS): lascia solo `AddressData` e `PaymentData`.

In `pdf_extractor.py` correggi l'import per il package: `from models import ...` → `from app.models import AddressData, PaymentData`.

- [ ] **Step 2: Modifica pdf_extractor.py — warnings espliciti**

Sostituisci i due metodi `_extract_payment_from_qr` ed `extract_payment` così (il resto del file resta identico all'originale):

```python
    def _extract_payment_from_qr(self, mode: str = "unica") -> tuple[Optional[PaymentData], list[str]]:
        """
        1. Individua la pagina QR in base alla modalità (unica/multirata).
        2. Prova le immagini embedded (veloce).
        3. Rendering pagina a 3x poi 4x (cattura QR vettoriali).
        Ritorna (payment, warnings): mai eccezioni silenziate senza traccia.
        """
        warnings: list[str] = []
        try:
            import fitz  # PyMuPDF
            from PIL import Image

            doc = fitz.open(stream=self._pdf_bytes, filetype="pdf")

            target_pages = self._find_payment_pages(doc, mode)
            if not target_pages:
                warnings.append("Nessuna pagina PagoPA individuata: uso l'ultima pagina")
                target_pages = [len(doc) - 1]

            for page_idx in target_pages:
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
                        continue

            warnings.append("QR PagoPA non decodificato in nessuna pagina candidata")
        except Exception as e:
            warnings.append(f"Estrazione QR fallita: {e}")
        return None, warnings

    def extract_payment(self, mode: str = "unica") -> tuple[Optional[PaymentData], list[str]]:
        """
        QR code ha precedenza (numero avviso e importo certi).
        Il testo viene usato sempre per la scadenza, e come fallback completo
        se il QR non è leggibile.
        Ritorna (payment | None, warnings).
        """
        qr, warnings = self._extract_payment_from_qr(mode)
        text = self._extract_payment_from_text()

        if qr is None and text is None:
            return None, warnings
        if qr is None:
            warnings.append("QR non leggibile: dati PagoPA estratti dal testo (fallback)")
            return text, warnings

        if text and text.scadenza:
            qr.scadenza = text.scadenza
        return qr, warnings
```

- [ ] **Step 3: requirements**

`services/pdf-extractor/requirements.txt`:

```
fastapi==0.115.6
uvicorn==0.32.1
python-multipart==0.0.20
pdfplumber==0.11.4
PyMuPDF==1.23.8
pyzbar==0.1.9
```

`services/pdf-extractor/requirements-dev.txt`:

```
-r requirements.txt
pytest==8.3.4
httpx==0.28.1
qrcode[pil]==8.0
```

- [ ] **Step 4: conftest con fixture PDF sintetici**

`services/pdf-extractor/tests/conftest.py` — genera PDF in memoria con PyMuPDF (niente file reali):

```python
import io

import fitz
import pytest
import qrcode


def _make_pdf(pages: list[str], qr_payload: str | None = None) -> bytes:
    """PDF sintetico: una pagina per stringa; QR opzionale sull'ultima pagina."""
    doc = fitz.open()
    for text in pages:
        page = doc.new_page()
        page.insert_text((50, 72), text, fontsize=11)
    if qr_payload:
        img = qrcode.make(qr_payload)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        rect = fitz.Rect(50, 150, 250, 350)
        doc[-1].insert_image(rect, stream=buf.getvalue())
    out = doc.tobytes()
    doc.close()
    return out


@pytest.fixture
def pdf_domestic_address() -> bytes:
    return _make_pdf(["Residente in:VIA ESEMPIO 10 - 65015 MONTESILVANO PE\n"])


@pytest.fixture
def pdf_residenza_label() -> bytes:
    return _make_pdf(["Residenza:65015 MONTESILVANO PE\nVIA DEI TEATINI 3\nMail:x@y.it\n"])


@pytest.fixture
def pdf_no_address() -> bytes:
    return _make_pdf(["Documento senza indirizzo utile\n"])


@pytest.fixture
def pdf_with_qr() -> bytes:
    # Pagina 1: lettera con indirizzo; pagina 2: avviso con QR + testo CBILL
    return _make_pdf(
        [
            "Residente in:VIA ROMA 1 - 00100 ROMA RM\n",
            "AVVISO DI PAGAMENTO\nCBILL\nentro il 31/12/2026\n",
        ],
        qr_payload="PAGOPA|002|301000000000000000|00123456789|76100",
    )
```

NOTA: `insert_text` con `\n` produce una sola riga — passare ogni riga con chiamate separate se il testo multiriga non viene estratto: in tal caso usare `page.insert_textbox(fitz.Rect(50, 50, 550, 400), text, fontsize=11)`. Verificare con il primo test e adeguare.

- [ ] **Step 5: Test failing**

`services/pdf-extractor/tests/test_pdf_extractor.py`:

```python
import pytest

from app.models import AddressData
from app.pdf_extractor import AddressExtractionError, PdfExtractor


def test_extract_address_domestic(pdf_domestic_address):
    addr = PdfExtractor(pdf_domestic_address).extract_address()
    assert addr.indirizzo == "VIA ESEMPIO 10"
    assert addr.cap == "65015"
    assert addr.comune == "MONTESILVANO"
    assert addr.provincia == "PE"
    assert addr.stato_estero == ""


def test_extract_address_residenza_label(pdf_residenza_label):
    addr = PdfExtractor(pdf_residenza_label).extract_address()
    assert addr.cap == "65015"
    assert addr.indirizzo == "VIA DEI TEATINI 3"


def test_extract_address_missing_raises(pdf_no_address):
    with pytest.raises(AddressExtractionError):
        PdfExtractor(pdf_no_address).extract_address()


def test_extract_payment_from_qr(pdf_with_qr):
    payment, warnings = PdfExtractor(pdf_with_qr).extract_payment(mode="unica")
    assert payment is not None
    assert payment.numero_avviso == "301000000000000000"
    assert payment.cf_ente == "00123456789"
    assert payment.importo == "761,00"
    assert payment.scadenza == "31/12/2026"


def test_extract_payment_absent_returns_none_with_warnings(pdf_no_address):
    payment, warnings = PdfExtractor(pdf_no_address).extract_payment(mode="unica")
    assert payment is None
    assert len(warnings) >= 1
```

- [ ] **Step 6: Esegui i test in container (il servizio non è ancora in compose)**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "${PWD}/services/pdf-extractor:/svc" -w /svc python:3.11-slim sh -c "apt-get update -qq && apt-get install -y -qq libzbar0 > /dev/null && pip install -q -r requirements-dev.txt && python -m pytest tests/ -v"
```

Expected: PASS su tutti i 5 test. Se `test_extract_address_domestic` fallisce per testo non estratto, applica la nota `insert_textbox` in conftest e riesegui.

- [ ] **Step 7: Commit**

```bash
git add services/pdf-extractor
git commit -m "feat(pdf-extractor): core estrazione PDF da sendcsv con warnings espliciti"
```

---

### Task 2: Servizio Python — API FastAPI

**Files:**
- Create: `services/pdf-extractor/app/main.py`
- Test: `services/pdf-extractor/tests/test_api.py`

**Interfaces:**
- Produces: `POST /extract?mode=unica|multirata` (multipart, campo `file`) → `200 {"address": {...}|null, "payment": {...}|null, "warnings": [...]}`; `GET /health` → `200 {"status":"ok"}`. Il client TS del Task 7 consuma esattamente questo contratto.

- [ ] **Step 1: Test failing**

`services/pdf-extractor/tests/test_api.py`:

```python
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_extract_full(pdf_with_qr):
    res = client.post(
        "/extract?mode=unica",
        files={"file": ("doc.pdf", pdf_with_qr, "application/pdf")},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["address"]["cap"] == "00100"
    assert body["payment"]["numero_avviso"] == "301000000000000000"
    assert isinstance(body["warnings"], list)


def test_extract_no_data(pdf_no_address):
    res = client.post(
        "/extract?mode=unica",
        files={"file": ("doc.pdf", pdf_no_address, "application/pdf")},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["address"] is None
    assert body["payment"] is None
    assert len(body["warnings"]) >= 2  # indirizzo + pagamento


def test_extract_corrupted_pdf():
    res = client.post(
        "/extract?mode=unica",
        files={"file": ("doc.pdf", b"not a pdf", "application/pdf")},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["address"] is None
    assert body["payment"] is None
    assert len(body["warnings"]) >= 1
```

- [ ] **Step 2: Run per verificare che fallisca**

Stesso comando docker del Task 1 Step 6. Expected: FAIL `ModuleNotFoundError: No module named 'app.main'`.

- [ ] **Step 3: Implementa main.py**

```python
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
```

- [ ] **Step 4: Run test — PASS atteso**

Stesso comando docker del Task 1 Step 6. Expected: 9 test PASS totali.

- [ ] **Step 5: Commit**

```bash
git add services/pdf-extractor
git commit -m "feat(pdf-extractor): API FastAPI /extract e /health"
```

---

### Task 3: Docker + compose + CI per pdf-extractor

**Files:**
- Create: `services/pdf-extractor/Dockerfile`
- Create: `services/pdf-extractor/Dockerfile.dev`
- Modify: `docker-compose.yml` (servizio + immagine ghcr)
- Modify: `docker-compose.override.yml` (build dev + bind mount)
- Modify: `.github/workflows/release.yml` (matrix)
- Modify: `.env.example` (documentazione, nessuna variabile obbligatoria nuova)

**Interfaces:**
- Produces: servizio raggiungibile dal backend come `http://pdf-extractor:8000` sulla rete `comunicapa-net`.

- [ ] **Step 1: Dockerfile prod**

`services/pdf-extractor/Dockerfile`:

```dockerfile
FROM python:3.11-slim
WORKDIR /svc
RUN apt-get update && apt-get install -y --no-install-recommends libzbar0 && rm -rf /var/lib/apt/lists/*
COPY services/pdf-extractor/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/pdf-extractor/app/ ./app/
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

(context di build = root repo, coerente con gli altri Dockerfile e con `release.yml` `context: .`)

- [ ] **Step 2: Dockerfile.dev**

`services/pdf-extractor/Dockerfile.dev`:

```dockerfile
FROM python:3.11-slim
WORKDIR /svc
RUN apt-get update && apt-get install -y --no-install-recommends libzbar0 && rm -rf /var/lib/apt/lists/*
COPY services/pdf-extractor/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/pdf-extractor/app/ ./app/
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
```

- [ ] **Step 3: docker-compose.yml (prod)**

Aggiungi dopo il servizio `backend` (stessa indentazione degli altri servizi):

```yaml
  pdf-extractor:
    image: ghcr.io/comune-di-montesilvano/comunicapa-pdf-extractor:${IMAGE_TAG:-latest}
    restart: unless-stopped
    networks:
      - comunicapa-net
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"]
      interval: 30s
      timeout: 5s
      retries: 3
```

NESSUNA sezione `ports`: solo rete interna. Nel servizio `backend` aggiungi la variabile:

```yaml
      PDF_EXTRACTOR_URL: ${PDF_EXTRACTOR_URL:-http://pdf-extractor:8000}
```

- [ ] **Step 4: docker-compose.override.yml (dev)**

```yaml
  pdf-extractor:
    image: comunicapa/pdf-extractor:dev
    build:
      context: .
      dockerfile: services/pdf-extractor/Dockerfile.dev
    volumes:
      - ./services/pdf-extractor/app:/svc/app:delegated
```

- [ ] **Step 5: release.yml**

In `matrix.app` la matrice usa il path `apps/${{ matrix.app }}/Dockerfile`: il nuovo servizio vive in `services/`. Cambia la matrice in una lista di oggetti:

```yaml
    strategy:
      fail-fast: false
      matrix:
        include:
          - app: backend
            dockerfile: apps/backend/Dockerfile
          - app: frontend-admin
            dockerfile: apps/frontend-admin/Dockerfile
          - app: frontend-citizen
            dockerfile: apps/frontend-citizen/Dockerfile
          - app: pdf-extractor
            dockerfile: services/pdf-extractor/Dockerfile
```

e nel passo build sostituisci `file: apps/${{ matrix.app }}/Dockerfile` con `file: ${{ matrix.dockerfile }}`. I riferimenti `comunicapa-${{ matrix.app }}` (images e cache) restano invariati.

- [ ] **Step 6: .env.example**

Aggiungi in fondo alla sezione backend:

```
# URL interno del microservizio di estrazione PDF (arricchimento tracciati).
# Default corretto per lo stack compose: non serve modificarlo.
# PDF_EXTRACTOR_URL=http://pdf-extractor:8000
```

- [ ] **Step 7: Verifica config e avvio**

```bash
docker compose -f docker-compose.yml config --quiet
docker compose up -d --build pdf-extractor
docker compose exec backend sh -c "wget -qO- http://pdf-extractor:8000/health"
```

Expected: `{"status":"ok"}` dall'ultimo comando.

- [ ] **Step 8: Commit**

```bash
git add services/pdf-extractor/Dockerfile services/pdf-extractor/Dockerfile.dev docker-compose.yml docker-compose.override.yml .github/workflows/release.yml .env.example
git commit -m "feat(pdf-extractor): container, compose e CI"
```

---

### Task 4: Backend — entity EnrichmentJob + migration

**Files:**
- Create: `apps/backend/src/entities/enrichment-job.entity.ts`
- Modify: `apps/backend/src/database/database.module.ts` (entities + migrations array)
- Create: `apps/backend/src/database/migrations/<timestamp>-CreateEnrichmentJobs.ts` (generata)

**Interfaces:**
- Produces: entity `EnrichmentJob` con `EnrichmentJobStatus` (`QUEUED|PROCESSING|DONE|FAILED`) e `TraceFormat` (`MAGGIOLI`); campi usati da service/processor/controller nei task successivi.

- [ ] **Step 1: Entity**

`apps/backend/src/entities/enrichment-job.entity.ts`:

```typescript
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum EnrichmentJobStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  DONE = 'done',
  FAILED = 'failed',
}

export enum TraceFormat {
  MAGGIOLI = 'MAGGIOLI',
}

export interface EnrichmentWarning {
  row: number;
  pdf: string;
  message: string;
}

@Entity('enrichment_jobs')
export class EnrichmentJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({
    type: 'enum',
    enum: EnrichmentJobStatus,
    default: EnrichmentJobStatus.QUEUED,
  })
  status!: EnrichmentJobStatus;

  @Column({ name: 'trace_format', type: 'enum', enum: TraceFormat })
  traceFormat!: TraceFormat;

  @Column({ name: 'source_filename', type: 'varchar', length: 512 })
  sourceFilename!: string;

  @Column({ name: 'total_records', type: 'int', default: 0 })
  totalRecords!: number;

  @Column({ name: 'processed_records', type: 'int', default: 0 })
  processedRecords!: number;

  @Column({ name: 'warning_count', type: 'int', default: 0 })
  warningCount!: number;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  warnings!: EnrichmentWarning[];

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  /** Valorizzato quando il job è stato convertito in bozza campagna (file già eliminati). */
  @Column({ name: 'campaign_id', type: 'uuid', nullable: true })
  campaignId!: string | null;

  @Column({ name: 'created_by', type: 'varchar', length: 256 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
```

- [ ] **Step 2: Registra entity in database.module.ts**

Aggiungi l'import e inserisci `EnrichmentJob` nell'array `entities` di `database.module.ts`:

```typescript
import { EnrichmentJob } from '../entities/enrichment-job.entity';
// ...
entities: [Campaign, /* ... invariati ... */, AppIoVerificationJob, EnrichmentJob],
```

- [ ] **Step 3: Genera migration su DB temporaneo** (procedura CLAUDE.md)

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_gen;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:generate src/database/migrations/CreateEnrichmentJobs -d src/database/data-source.ts
```

Ispeziona la migration generata: deve creare SOLO `enrichment_jobs` + i due tipi enum (`enrichment_jobs_status_enum`, `enrichment_jobs_trace_format_enum`). Se contiene diff estranei, rimuovili.

- [ ] **Step 4: Registra la migration in database.module.ts**

Import + append all'array `migrations` (dopo `AddInadCheckColumn1784800000001`).

- [ ] **Step 5: Verifica catena migration completa su DB pulito**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_gen;"
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_gen;"
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_gen;"
```

Expected: run completo senza errori, `CreateEnrichmentJobs` in coda alla lista.

- [ ] **Step 6: Type-check + commit**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
git add apps/backend/src/entities/enrichment-job.entity.ts apps/backend/src/database
git commit -m "feat(backend): entity EnrichmentJob + migration"
```

---

### Task 5: Backend — parser tracciato Maggioli (TDD)

**Files:**
- Create: `apps/backend/src/enrichment/maggioli-parser.ts`
- Test: `apps/backend/src/enrichment/maggioli-parser.spec.ts`

**Interfaces:**
- Produces:
  ```typescript
  interface ParsedAddress { indirizzo: string; cap: string; comune: string; provincia: string; statoEstero: string }
  interface MaggioliRecord {
    codiceFiscale: string; nominativo: string; tipo: 'PF' | 'PG';
    pec: string; numeroProvvedimento: string; dataEmissione: string;
    oggetto: string; pdfFilename: string;
    csvAddress: ParsedAddress | null;           // solo pag_indice
    csvNumeroAvviso: string; csvNumeroAvvisoAlt: string; // solo pag_indice (Ocr int/rid)
  }
  function parseLocalita(localita: string): { cap: string; comune: string; provincia: string }
  function parseRubricaPec(text: string): MaggioliRecord[]
  function parsePagIndice(text: string): MaggioliRecord[]
  function parseMaggioliZip(zip: AdmZip): { records: MaggioliRecord[] }  // sceglie pag_indice.csv se presente, altrimenti rubrica.csv; Error se nessuno dei due
  ```
- I PDF si leggono dal chiamante con `zip.getEntry(\`allegati/\${pdfFilename}\`)`.

- [ ] **Step 1: Test failing**

`apps/backend/src/enrichment/maggioli-parser.spec.ts`:

```typescript
import AdmZip from 'adm-zip';
import {
  parseLocalita,
  parseMaggioliZip,
  parsePagIndice,
  parseRubricaPec,
} from './maggioli-parser';

// rubrica.csv: ';', senza header, campi posizionali (vedi CLAUDE.md sendcsv):
// 0=raw_id, 1=PEC, 3=nome, 4=cognome, 5=CF, 7=nome completo, 8=n. provv, 9=data, 10=oggetto, 13=nome PDF
const RUBRICA_ROW_PF =
  '36042|ici|P;mario.rossi@pec.it;;MARIO;ROSSI;RSSMRA80A01H501U;;ROSSI MARIO;19009032;13/03/2026;Provvedimento 2020: n. 19009032 emesso il 13/03/2026;;;PROVV_36042_142072.pdf';
const RUBRICA_ROW_PG =
  '36043|ici|P;acme@pec.it;;;;00123456789;;ACME SRL;19009033;13/03/2026;Oggetto PG;;;PROVV_36043_1.pdf';
// Riga corta (meno di 14 campi): va paddata, non crashare
const RUBRICA_ROW_SHORT = 'id;pec@pec.it;;N;C;RSSMRA80A01H501U;;NOME;1;01/01/2026';

const PAG_INDICE = [
  "'nome file;'destinatario;'cod. fisc. dest;'indirizzo;'indirizzo parte 2;'localita;'comune;'stato estero;'Ocr int;'Ocr rid;'Num. provv;'Data emissione",
  "'DOC_1.pdf;'VERDI LUIGI;'VRDLGU70A01H501X;'VIA MILANO 5;';'00067 MORLUPO RM;';';'301000000000000001;'RAV123;'99;'01/02/2026",
].join('\n');

describe('parseLocalita', () => {
  it('località domestica: cap comune provincia', () => {
    expect(parseLocalita('00067 MORLUPO RM')).toEqual({ cap: '00067', comune: 'MORLUPO', provincia: 'RM' });
  });

  it('località senza provincia (estero/malformata)', () => {
    expect(parseLocalita('00000 BERLIN')).toEqual({ cap: '00000', comune: 'BERLIN', provincia: '' });
  });
});

describe('parseRubricaPec', () => {
  it('parsa PF e PG distinguendo dalla lunghezza del CF', () => {
    const records = parseRubricaPec(`${RUBRICA_ROW_PF}\n${RUBRICA_ROW_PG}\n`);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      codiceFiscale: 'RSSMRA80A01H501U',
      tipo: 'PF',
      pec: 'mario.rossi@pec.it',
      nominativo: 'ROSSI MARIO',
      numeroProvvedimento: '19009032',
      dataEmissione: '13/03/2026',
      pdfFilename: 'PROVV_36042_142072.pdf',
      csvAddress: null,
    });
    expect(records[1].tipo).toBe('PG');
  });

  it('righe corte vengono paddate senza errore', () => {
    const records = parseRubricaPec(RUBRICA_ROW_SHORT);
    expect(records).toHaveLength(1);
    expect(records[0].pdfFilename).toBe('');
  });

  it('righe vuote ignorate', () => {
    expect(parseRubricaPec('\n\n')).toHaveLength(0);
  });
});

describe('parsePagIndice', () => {
  it('parsa header con apostrofi e valorizza indirizzo/pagamento da CSV', () => {
    const records = parsePagIndice(PAG_INDICE);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      codiceFiscale: 'VRDLGU70A01H501X',
      nominativo: 'VERDI LUIGI',
      pdfFilename: 'DOC_1.pdf',
      csvNumeroAvviso: '301000000000000001',
      csvNumeroAvvisoAlt: 'RAV123',
    });
    expect(records[0].csvAddress).toEqual({
      indirizzo: 'VIA MILANO 5',
      cap: '00067',
      comune: 'MORLUPO',
      provincia: 'RM',
      statoEstero: '',
    });
  });
});

describe('parseMaggioliZip', () => {
  it('preferisce pag_indice.csv se presente', () => {
    const zip = new AdmZip();
    zip.addFile('pag_indice.csv', Buffer.from(PAG_INDICE, 'utf-8'));
    zip.addFile('rubrica.csv', Buffer.from(RUBRICA_ROW_PF, 'utf-8'));
    const { records } = parseMaggioliZip(zip);
    expect(records[0].codiceFiscale).toBe('VRDLGU70A01H501X');
  });

  it('usa rubrica.csv altrimenti (anche latin-1)', () => {
    const zip = new AdmZip();
    // 'PERÙ' in latin-1 per verificare il fallback encoding
    const latin1 = Buffer.from(RUBRICA_ROW_PF.replace('ROSSI MARIO', 'ROSSI MARI\xd9'), 'latin1');
    zip.addFile('rubrica.csv', latin1);
    const { records } = parseMaggioliZip(zip);
    expect(records[0].nominativo).toBe('ROSSI MARIÙ');
  });

  it('errore esplicito se nessun indice presente', () => {
    const zip = new AdmZip();
    zip.addFile('allegati/x.pdf', Buffer.from('x'));
    expect(() => parseMaggioliZip(zip)).toThrow(/rubrica\.csv|pag_indice\.csv/);
  });
});
```

- [ ] **Step 2: Run — FAIL atteso**

```bash
docker compose exec backend node_modules/.bin/jest maggioli-parser --maxWorkers=2
```

Expected: FAIL `Cannot find module './maggioli-parser'`.

- [ ] **Step 3: Implementazione**

`apps/backend/src/enrichment/maggioli-parser.ts`:

```typescript
import type AdmZip from 'adm-zip';

/** Porting TS di reader.py + parse_localita di sendcsv (formato ZIP Maggioli). */

export interface ParsedAddress {
  indirizzo: string;
  cap: string;
  comune: string;
  provincia: string;
  statoEstero: string;
}

export interface MaggioliRecord {
  codiceFiscale: string;
  nominativo: string;
  tipo: 'PF' | 'PG';
  pec: string;
  numeroProvvedimento: string;
  dataEmissione: string;
  oggetto: string;
  pdfFilename: string;
  csvAddress: ParsedAddress | null;
  csvNumeroAvviso: string;
  csvNumeroAvvisoAlt: string;
}

const RE_LOCALITA = /^(\d{5})\s+(.+?)\s+([A-Z]{2})$/;

export function parseLocalita(localita: string): { cap: string; comune: string; provincia: string } {
  const s = localita.trim();
  const m = RE_LOCALITA.exec(s);
  if (m) return { cap: m[1], comune: m[2], provincia: m[3] };
  const parts = s.split(/\s+/);
  return { cap: parts[0] ?? '', comune: parts.slice(1).join(' '), provincia: '' };
}

function tipoFromCf(cf: string): 'PF' | 'PG' {
  return cf.trim().length === 16 ? 'PF' : 'PG';
}

export function parseRubricaPec(text: string): MaggioliRecord[] {
  const records: MaggioliRecord[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(';');
    while (fields.length < 14) fields.push('');
    records.push({
      pec: fields[1].trim(),
      codiceFiscale: fields[5].trim(),
      tipo: tipoFromCf(fields[5]),
      nominativo: fields[7].trim(),
      numeroProvvedimento: fields[8].trim(),
      dataEmissione: fields[9].trim(),
      oggetto: fields[10].trim(),
      pdfFilename: fields[13].trim(),
      csvAddress: null,
      csvNumeroAvviso: '',
      csvNumeroAvvisoAlt: '',
    });
  }
  return records;
}

/** Il formato analogico prefissa OGNI cella con un apostrofo (idempotente da strippare). */
function stripApice(s: string): string {
  return s.replace(/^'+/, '');
}

export function parsePagIndice(text: string): MaggioliRecord[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const header = lines[0].split(';').map((f) => stripApice(f).trim());

  const records: MaggioliRecord[] = [];
  for (const line of lines.slice(1)) {
    const fields = line.split(';').map(stripApice);
    const row: Record<string, string> = {};
    header.forEach((h, idx) => { row[h] = fields[idx] ?? ''; });

    const ind1 = (row['indirizzo'] ?? '').trim();
    const ind2 = (row['indirizzo parte 2'] ?? '').trim();
    const loc = parseLocalita(row['localita'] ?? '');
    const comune = loc.comune || (row['comune'] ?? '').trim();

    records.push({
      pec: '',
      codiceFiscale: (row['cod. fisc. dest'] ?? '').trim(),
      tipo: tipoFromCf(row['cod. fisc. dest'] ?? ''),
      nominativo: (row['destinatario'] ?? '').trim(),
      numeroProvvedimento: (row['Num. provv'] ?? '').trim(),
      dataEmissione: (row['Data emissione'] ?? '').trim(),
      oggetto: '',
      pdfFilename: (row['nome file'] ?? '').trim(),
      csvAddress: {
        indirizzo: ind2 ? `${ind1} ${ind2}`.trim() : ind1,
        cap: loc.cap,
        comune,
        provincia: loc.provincia,
        statoEstero: (row['stato estero'] ?? '').trim(),
      },
      csvNumeroAvviso: (row['Ocr int'] ?? '').trim(),
      csvNumeroAvvisoAlt: (row['Ocr rid'] ?? '').trim(),
    });
  }
  return records;
}

function decodeCsvBuffer(buf: Buffer): string {
  const utf8 = buf.toString('utf-8');
  // Il replacement char indica byte non validi UTF-8: rubrica Maggioli a volte è latin-1
  return utf8.includes('�') ? buf.toString('latin1') : utf8;
}

export function parseMaggioliZip(zip: AdmZip): { records: MaggioliRecord[] } {
  const pagIndice = zip.getEntry('pag_indice.csv');
  if (pagIndice) {
    return { records: parsePagIndice(decodeCsvBuffer(pagIndice.getData())) };
  }
  const rubrica = zip.getEntry('rubrica.csv');
  if (rubrica) {
    return { records: parseRubricaPec(decodeCsvBuffer(rubrica.getData())) };
  }
  throw new Error('ZIP non riconosciuto: manca rubrica.csv o pag_indice.csv alla radice');
}
```

- [ ] **Step 4: Run — PASS atteso**

```bash
docker compose exec backend node_modules/.bin/jest maggioli-parser --maxWorkers=2
```

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/enrichment
git commit -m "feat(backend): parser tracciato Maggioli (rubrica PEC + pag_indice)"
```

---

### Task 6: Backend — CSV arricchito QUOTE_ALL (TDD)

**Files:**
- Create: `apps/backend/src/enrichment/enriched-csv.util.ts`
- Test: `apps/backend/src/enrichment/enriched-csv.util.spec.ts`

**Interfaces:**
- Produces:
  ```typescript
  const ENRICHED_CSV_HEADERS: readonly string[]; // ordine colonne output
  type EnrichedRow = Record<string, string>;     // chiavi = ENRICHED_CSV_HEADERS
  function buildEnrichedCsv(rows: EnrichedRow[]): string; // ';' + QUOTE_ALL, \r\n no, \n sì, senza BOM
  ```
- Headers esatti (descrittore v1, punto di estensione per formati futuri):
  `codice_fiscale, nominativo, tipo, pec, indirizzo, cap, comune, provincia, stato_estero, allegato, numero_avviso, numero_avviso_alternativo, importo, scadenza, numero_provvedimento, data_emissione, oggetto`

- [ ] **Step 1: Test failing**

`apps/backend/src/enrichment/enriched-csv.util.spec.ts`:

```typescript
import { ENRICHED_CSV_HEADERS, buildEnrichedCsv } from './enriched-csv.util';

describe('buildEnrichedCsv', () => {
  it('header presente, celle SEMPRE virgolettate, delimitatore ;', () => {
    const csv = buildEnrichedCsv([
      { codice_fiscale: 'RSSMRA80A01H501U', nominativo: 'ROSSI MARIO', importo: '761,00' } as any,
    ]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(ENRICHED_CSV_HEADERS.map((h) => `"${h}"`).join(';'));
    expect(lines[1].startsWith('"RSSMRA80A01H501U";"ROSSI MARIO"')).toBe(true);
    // Ogni cella virgolettata, anche le vuote
    expect(lines[1].split(';')).toHaveLength(ENRICHED_CSV_HEADERS.length);
    expect(lines[1].split(';').every((c) => c.startsWith('"') && c.endsWith('"'))).toBe(true);
  });

  it('escape virgolette interne raddoppiandole', () => {
    const csv = buildEnrichedCsv([{ nominativo: 'DITTA "LA VELOCE"' } as any]);
    expect(csv).toContain('"DITTA ""LA VELOCE"""');
  });

  it('nessun BOM iniziale', () => {
    expect(buildEnrichedCsv([]).charCodeAt(0)).not.toBe(0xfeff);
  });
});
```

- [ ] **Step 2: Run — FAIL atteso**

```bash
docker compose exec backend node_modules/.bin/jest enriched-csv --maxWorkers=2
```

- [ ] **Step 3: Implementazione**

`apps/backend/src/enrichment/enriched-csv.util.ts`:

```typescript
/**
 * CSV arricciato in output dalla dashboard Arricchimento: formato pronto per
 * l'import nel wizard campagne. QUOTE_ALL deliberato (il vecchio convertitore
 * sendcsv usava QUOTE_MINIMAL perché imposto dal portale SEND — requisito del
 * vecchio target, non nostro).
 */
export const ENRICHED_CSV_HEADERS = [
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

export type EnrichedRow = Partial<Record<(typeof ENRICHED_CSV_HEADERS)[number], string>>;

const quote = (v: string | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function buildEnrichedCsv(rows: EnrichedRow[]): string {
  const lines = [ENRICHED_CSV_HEADERS.map(quote).join(';')];
  for (const row of rows) {
    lines.push(ENRICHED_CSV_HEADERS.map((h) => quote(row[h])).join(';'));
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run — PASS atteso, poi commit**

```bash
docker compose exec backend node_modules/.bin/jest enriched-csv --maxWorkers=2
git add apps/backend/src/enrichment
git commit -m "feat(backend): writer CSV arricchito QUOTE_ALL formato wizard"
```

---

### Task 7: Backend — client HTTP pdf-extractor (TDD)

**Files:**
- Create: `apps/backend/src/enrichment/pdf-extractor.client.ts`
- Test: `apps/backend/src/enrichment/pdf-extractor.client.spec.ts`
- Modify: `apps/backend/src/config/configuration.ts` (aggiunta `pdfExtractor.url`)

**Interfaces:**
- Consumes: contratto API Task 2 (`POST /extract?mode=...` multipart).
- Produces:
  ```typescript
  interface ExtractedAddress { indirizzo: string; cap: string; comune: string; provincia: string; stato_estero: string }
  interface ExtractedPayment { numero_avviso: string; numero_avviso_alternativo: string; cf_ente: string; importo: string; scadenza: string }
  interface ExtractResult { address: ExtractedAddress | null; payment: ExtractedPayment | null; warnings: string[] }
  class PdfExtractorClient { extract(pdf: Buffer, filename: string, mode: 'unica' | 'multirata'): Promise<ExtractResult> }
  ```

- [ ] **Step 1: configuration.ts**

In `AppConfiguration` aggiungi:

```typescript
  pdfExtractor: {
    url: string;
  };
```

e nel factory:

```typescript
  pdfExtractor: {
    url: process.env['PDF_EXTRACTOR_URL'] ?? 'http://pdf-extractor:8000',
  },
```

- [ ] **Step 2: Test failing**

`apps/backend/src/enrichment/pdf-extractor.client.spec.ts` (mock di `global.fetch`, Node 22):

```typescript
import { ConfigService } from '@nestjs/config';
import { PdfExtractorClient } from './pdf-extractor.client';

describe('PdfExtractorClient', () => {
  const config = { get: jest.fn().mockReturnValue('http://pdf-extractor:8000') } as unknown as ConfigService;
  let client: PdfExtractorClient;

  beforeEach(() => {
    client = new PdfExtractorClient(config);
    global.fetch = jest.fn();
  });

  it('POST multipart a /extract con mode in query e parse della risposta', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ address: { cap: '00100' }, payment: null, warnings: ['w1'] }),
    });

    const result = await client.extract(Buffer.from('%PDF'), 'doc.pdf', 'unica');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://pdf-extractor:8000/extract?mode=unica',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.address).toEqual({ cap: '00100' });
    expect(result.warnings).toEqual(['w1']);
  });

  it('HTTP non-ok → Error con status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    await expect(client.extract(Buffer.from('x'), 'doc.pdf', 'unica')).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 3: Run — FAIL atteso**

```bash
docker compose exec backend node_modules/.bin/jest pdf-extractor.client --maxWorkers=2
```

- [ ] **Step 4: Implementazione**

`apps/backend/src/enrichment/pdf-extractor.client.ts`:

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

export interface ExtractedPayment {
  numero_avviso: string;
  numero_avviso_alternativo: string;
  cf_ente: string;
  importo: string;
  scadenza: string;
}

export interface ExtractResult {
  address: ExtractedAddress | null;
  payment: ExtractedPayment | null;
  warnings: string[];
}

@Injectable()
export class PdfExtractorClient {
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  async extract(pdf: Buffer, filename: string, mode: 'unica' | 'multirata'): Promise<ExtractResult> {
    const baseUrl = this.config.get('pdfExtractor.url', { infer: true });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);

    const res = await fetch(`${baseUrl}/extract?mode=${mode}`, { method: 'POST', body: form });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`pdf-extractor HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as ExtractResult;
  }
}
```

- [ ] **Step 5: Run — PASS atteso, poi commit**

```bash
docker compose exec backend node_modules/.bin/jest pdf-extractor.client --maxWorkers=2
git add apps/backend/src/enrichment apps/backend/src/config/configuration.ts
git commit -m "feat(backend): client HTTP verso servizio pdf-extractor"
```

---

### Task 8: Backend — EnrichmentService + modulo + coda

**Files:**
- Create: `apps/backend/src/enrichment/enrichment-job.types.ts`
- Create: `apps/backend/src/enrichment/enrichment-paths.ts`
- Create: `apps/backend/src/enrichment/enrichment.service.ts`
- Create: `apps/backend/src/enrichment/enrichment.module.ts`
- Modify: `apps/backend/src/app.module.ts` (import modulo)
- Test: `apps/backend/src/enrichment/enrichment.service.spec.ts`

**Interfaces:**
- Produces:
  ```typescript
  // enrichment-job.types.ts
  const ENRICHMENT_QUEUE = 'enrichment-jobs';
  interface EnrichmentQueueJobData { jobId: string }
  // enrichment-paths.ts
  function getEnrichmentDir(jobId: string): string;      // <ATTACHMENTS_PATH>/enrichment/<jobId>
  function getEnrichmentSourceZip(jobId: string): string; // .../source.zip
  function getEnrichmentResultCsv(jobId: string): string; // .../result.csv
  // enrichment.service.ts
  class EnrichmentService {
    createJob(params: { zipPath: string; sourceFilename: string; traceFormat: TraceFormat; createdBy: string }): Promise<{ jobId?: string; blocked?: boolean; message?: string }>;
    listJobs(): Promise<EnrichmentJob[]>;                 // ordinati createdAt DESC, max 100
    getJob(id: string): Promise<EnrichmentJob>;           // NotFoundException se assente
    deleteJob(id: string): Promise<{ blocked?: boolean; message?: string }>; // blocked se PROCESSING
    buildResultZip(id: string): Promise<Buffer>;          // result.csv + PDF da source.zip
  }
  ```

- [ ] **Step 1: types + paths**

`apps/backend/src/enrichment/enrichment-job.types.ts`:

```typescript
export const ENRICHMENT_QUEUE = 'enrichment-jobs';

export interface EnrichmentQueueJobData {
  jobId: string;
}
```

`apps/backend/src/enrichment/enrichment-paths.ts`:

```typescript
import { join } from 'path';
import { getAttachmentsRoot } from '../attachments/attachment-paths';

export function getEnrichmentDir(jobId: string): string {
  return join(getAttachmentsRoot(), 'enrichment', jobId);
}

export function getEnrichmentSourceZip(jobId: string): string {
  return join(getEnrichmentDir(jobId), 'source.zip');
}

export function getEnrichmentResultCsv(jobId: string): string {
  return join(getEnrichmentDir(jobId), 'result.csv');
}
```

- [ ] **Step 2: Test failing del service**

`apps/backend/src/enrichment/enrichment.service.spec.ts` (pattern mock repo/queue come `app-io-verify-bulk.service.spec.ts` — istanziazione diretta `new EnrichmentService(repo, queue)`, niente TestingModule):

```typescript
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import AdmZip from 'adm-zip';
import { EnrichmentJobStatus, TraceFormat } from '../entities/enrichment-job.entity';
import { EnrichmentService } from './enrichment.service';

const RUBRICA_ROW =
  'id;pec@pec.it;;MARIO;ROSSI;RSSMRA80A01H501U;;ROSSI MARIO;1;13/03/2026;Oggetto;;;PROVV_1.pdf';

function makeZipFile(dir: string, withRubrica = true): string {
  const zip = new AdmZip();
  if (withRubrica) zip.addFile('rubrica.csv', Buffer.from(RUBRICA_ROW, 'utf-8'));
  zip.addFile('allegati/PROVV_1.pdf', Buffer.from('%PDF-fake'));
  const p = join(dir, 'input.zip');
  zip.writeZip(p);
  return p;
}

describe('EnrichmentService', () => {
  let tmpDir: string;
  let repo: any;
  let queue: any;
  let service: EnrichmentService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'enrich-test-'));
    process.env['ATTACHMENTS_PATH'] = join(tmpDir, 'attachments');
    repo = {
      create: jest.fn((v) => v),
      save: jest.fn(async (v) => ({ ...v, id: 'job-uuid-1' })),
      find: jest.fn(async () => []),
      findOneBy: jest.fn(async () => null),
      delete: jest.fn(async () => undefined),
    };
    queue = { add: jest.fn(async () => undefined) };
    service = new EnrichmentService(repo, queue);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['ATTACHMENTS_PATH'];
  });

  it('createJob: salva record, copia source.zip, accoda con jobId = id record', async () => {
    const zipPath = makeZipFile(tmpDir);
    const result = await service.createJob({
      zipPath,
      sourceFilename: 'Postalizzazione_114012.zip',
      traceFormat: TraceFormat.MAGGIOLI,
      createdBy: 'debug',
    });

    expect(result.jobId).toBe('job-uuid-1');
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ totalRecords: 1, status: EnrichmentJobStatus.QUEUED }),
    );
    expect(queue.add).toHaveBeenCalledWith('enrich', { jobId: 'job-uuid-1' }, { jobId: 'job-uuid-1' });
    const sourceZip = join(tmpDir, 'attachments', 'enrichment', 'job-uuid-1', 'source.zip');
    expect(fs.existsSync(sourceZip)).toBe(true);
  });

  it('createJob: ZIP senza rubrica → blocked, nessun record', async () => {
    const zipPath = makeZipFile(tmpDir, false);
    const result = await service.createJob({
      zipPath, sourceFilename: 'x.zip', traceFormat: TraceFormat.MAGGIOLI, createdBy: 'debug',
    });
    expect(result.blocked).toBe(true);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('createJob: ZIP con zero record → blocked', async () => {
    const zip = new AdmZip();
    zip.addFile('rubrica.csv', Buffer.from('', 'utf-8'));
    const p = join(tmpDir, 'empty.zip');
    zip.writeZip(p);
    const result = await service.createJob({
      zipPath: p, sourceFilename: 'x.zip', traceFormat: TraceFormat.MAGGIOLI, createdBy: 'debug',
    });
    expect(result.blocked).toBe(true);
  });

  it('deleteJob: PROCESSING → blocked', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.PROCESSING });
    const result = await service.deleteJob('j1');
    expect(result.blocked).toBe(true);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('deleteJob: DONE → elimina record e cartella', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'job-uuid-1', status: EnrichmentJobStatus.DONE });
    const dir = join(tmpDir, 'attachments', 'enrichment', 'job-uuid-1');
    fs.mkdirSync(dir, { recursive: true });
    const result = await service.deleteJob('job-uuid-1');
    expect(result.blocked).toBeUndefined();
    expect(repo.delete).toHaveBeenCalledWith('job-uuid-1');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('buildResultZip: contiene result.csv e i PDF del source.zip', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'job-uuid-1', status: EnrichmentJobStatus.DONE });
    const dir = join(tmpDir, 'attachments', 'enrichment', 'job-uuid-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(makeZipFile(tmpDir), join(dir, 'source.zip'));
    fs.writeFileSync(join(dir, 'result.csv'), '"a"');

    const buf = await service.buildResultZip('job-uuid-1');
    const out = new AdmZip(buf);
    expect(out.getEntry('arricchito.csv')).toBeTruthy();
    expect(out.getEntry('PROVV_1.pdf')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run — FAIL atteso**

```bash
docker compose exec backend node_modules/.bin/jest enrichment.service --maxWorkers=2
```

- [ ] **Step 4: Implementazione service**

`apps/backend/src/enrichment/enrichment.service.ts`:

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import AdmZip from 'adm-zip';
import {
  EnrichmentJob,
  EnrichmentJobStatus,
  TraceFormat,
} from '../entities/enrichment-job.entity';
import { parseMaggioliZip } from './maggioli-parser';
import { ENRICHMENT_QUEUE, EnrichmentQueueJobData } from './enrichment-job.types';
import { getEnrichmentDir, getEnrichmentResultCsv, getEnrichmentSourceZip } from './enrichment-paths';

export interface CreateEnrichmentJobParams {
  zipPath: string;
  sourceFilename: string;
  traceFormat: TraceFormat;
  createdBy: string;
}

@Injectable()
export class EnrichmentService {
  constructor(
    @InjectRepository(EnrichmentJob)
    private readonly jobRepo: Repository<EnrichmentJob>,
    @InjectQueue(ENRICHMENT_QUEUE)
    private readonly queue: Queue<EnrichmentQueueJobData>,
  ) {}

  async createJob(params: CreateEnrichmentJobParams): Promise<{ jobId?: string; blocked?: boolean; message?: string }> {
    let totalRecords: number;
    try {
      const zip = new AdmZip(params.zipPath);
      const { records } = parseMaggioliZip(zip);
      if (records.length === 0) {
        return { blocked: true, message: 'Il tracciato non contiene righe di dati' };
      }
      totalRecords = records.length;
    } catch (err: any) {
      return { blocked: true, message: err?.message ?? 'ZIP non leggibile' };
    }

    const saved = await this.jobRepo.save(
      this.jobRepo.create({
        status: EnrichmentJobStatus.QUEUED,
        traceFormat: params.traceFormat,
        sourceFilename: params.sourceFilename,
        totalRecords,
        processedRecords: 0,
        warningCount: 0,
        warnings: [],
        errorMessage: null,
        campaignId: null,
        createdBy: params.createdBy,
        completedAt: null,
      }),
    );

    fs.mkdirSync(getEnrichmentDir(saved.id), { recursive: true });
    fs.copyFileSync(params.zipPath, getEnrichmentSourceZip(saved.id));

    await this.queue.add('enrich', { jobId: saved.id }, { jobId: saved.id });
    return { jobId: saved.id };
  }

  listJobs(): Promise<EnrichmentJob[]> {
    return this.jobRepo.find({ order: { createdAt: 'DESC' }, take: 100 });
  }

  async getJob(id: string): Promise<EnrichmentJob> {
    const job = await this.jobRepo.findOneBy({ id });
    if (!job) throw new NotFoundException(`Job di arricchimento ${id} non trovato`);
    return job;
  }

  async deleteJob(id: string): Promise<{ blocked?: boolean; message?: string }> {
    const job = await this.getJob(id);
    if (job.status === EnrichmentJobStatus.PROCESSING) {
      return { blocked: true, message: 'Job in elaborazione: attendere il completamento prima di eliminarlo' };
    }
    fs.rmSync(getEnrichmentDir(id), { recursive: true, force: true });
    await this.jobRepo.delete(id);
    return {};
  }

  /** ZIP risultato costruito on-the-fly: arricchito.csv + PDF dal source.zip. */
  async buildResultZip(id: string): Promise<Buffer> {
    const job = await this.getJob(id);
    if (job.status !== EnrichmentJobStatus.DONE) {
      throw new NotFoundException('Risultato non ancora disponibile');
    }
    const out = new AdmZip();
    out.addFile('arricchito.csv', fs.readFileSync(getEnrichmentResultCsv(id)));
    const source = new AdmZip(getEnrichmentSourceZip(id));
    for (const entry of source.getEntries()) {
      if (entry.entryName.startsWith('allegati/') && entry.entryName.toLowerCase().endsWith('.pdf')) {
        out.addFile(entry.entryName.replace(/^allegati\//, ''), entry.getData());
      }
    }
    return out.toBuffer();
  }
}
```

- [ ] **Step 5: Modulo + registrazione app.module**

`apps/backend/src/enrichment/enrichment.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { EnrichmentJob } from '../entities/enrichment-job.entity';
import { EnrichmentService } from './enrichment.service';
import { PdfExtractorClient } from './pdf-extractor.client';
import { ENRICHMENT_QUEUE } from './enrichment-job.types';

@Module({
  imports: [
    TypeOrmModule.forFeature([EnrichmentJob]),
    BullModule.registerQueue({ name: ENRICHMENT_QUEUE }),
  ],
  providers: [EnrichmentService, PdfExtractorClient],
  exports: [EnrichmentService],
})
export class EnrichmentModule {}
```

In `apps/backend/src/app.module.ts` aggiungi `EnrichmentModule` agli imports (stesso posto degli altri moduli feature, es. accanto a `IoServicesModule`).

- [ ] **Step 6: Run + type-check — PASS atteso, poi commit**

```bash
docker compose exec backend node_modules/.bin/jest enrichment.service --maxWorkers=2
docker compose exec backend node_modules/.bin/tsc --noEmit
git add apps/backend/src/enrichment apps/backend/src/app.module.ts
git commit -m "feat(backend): EnrichmentService, coda e modulo arricchimento"
```

---

### Task 9: Backend — EnrichmentProcessor (worker, TDD)

**Files:**
- Create: `apps/backend/src/enrichment/enrichment.processor.ts`
- Modify: `apps/backend/src/enrichment/enrichment.module.ts` (provider)
- Test: `apps/backend/src/enrichment/enrichment.processor.spec.ts`

**Interfaces:**
- Consumes: `PdfExtractorClient.extract(pdf, filename, mode)` (Task 7), `parseMaggioliZip` (Task 5), `buildEnrichedCsv` (Task 6), paths (Task 8).
- Produces: processor BullMQ su `ENRICHMENT_QUEUE`; scrive `result.csv`, aggiorna contatori/warnings, stato terminale sempre valorizzato (`DONE`/`FAILED`) prima di uscire.

**Regole di merge dati (dal design):**
- indirizzo: `record.csvAddress` (pag_indice) ha precedenza; altrimenti `extracted.address`; se entrambi assenti → warning riga, campi vuoti.
- numero avviso: `record.csvNumeroAvviso || extracted.payment.numero_avviso`; alternativo: `record.csvNumeroAvvisoAlt || extracted.payment.numero_avviso_alternativo`; importo/scadenza sempre da PDF se disponibili.
- PDF mancante nel ZIP → warning riga, la riga esce comunque nel CSV con campi estratti vuoti.
- Ogni warning del servizio Python diventa un `EnrichmentWarning { row, pdf, message }`.

- [ ] **Step 1: Test failing**

`apps/backend/src/enrichment/enrichment.processor.spec.ts`:

```typescript
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import AdmZip from 'adm-zip';
import type { Job } from 'bullmq';
import { EnrichmentJobStatus, TraceFormat } from '../entities/enrichment-job.entity';
import { getEnrichmentDir, getEnrichmentResultCsv, getEnrichmentSourceZip } from './enrichment-paths';
import { EnrichmentProcessor } from './enrichment.processor';

const RUBRICA = [
  'id;pec1@pec.it;;MARIO;ROSSI;RSSMRA80A01H501U;;ROSSI MARIO;1;13/03/2026;Oggetto 1;;;PROVV_1.pdf',
  'id;pec2@pec.it;;LUIGI;VERDI;VRDLGU70A01H501X;;VERDI LUIGI;2;13/03/2026;Oggetto 2;;;PROVV_MANCANTE.pdf',
].join('\n');

function setupJobDir(tmp: string, jobId: string): void {
  const zip = new AdmZip();
  zip.addFile('rubrica.csv', Buffer.from(RUBRICA, 'utf-8'));
  zip.addFile('allegati/PROVV_1.pdf', Buffer.from('%PDF-1'));
  fs.mkdirSync(getEnrichmentDir(jobId), { recursive: true });
  zip.writeZip(getEnrichmentSourceZip(jobId));
}

describe('EnrichmentProcessor', () => {
  let tmpDir: string;
  let repo: any;
  let client: any;
  let processor: EnrichmentProcessor;
  const record = {
    id: 'j1',
    status: EnrichmentJobStatus.QUEUED,
    traceFormat: TraceFormat.MAGGIOLI,
    totalRecords: 2,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'enrich-proc-'));
    process.env['ATTACHMENTS_PATH'] = tmpDir;
    setupJobDir(tmpDir, 'j1');
    repo = {
      findOneBy: jest.fn(async () => ({ ...record })),
      update: jest.fn(async () => undefined),
    };
    client = {
      extract: jest.fn(async () => ({
        address: { indirizzo: 'VIA ROMA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', stato_estero: '' },
        payment: { numero_avviso: '301000000000000001', numero_avviso_alternativo: '', cf_ente: '000', importo: '761,00', scadenza: '31/12/2026' },
        warnings: [],
      })),
    };
    processor = new EnrichmentProcessor(repo, client);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['ATTACHMENTS_PATH'];
  });

  const fakeJob = { data: { jobId: 'j1' }, log: jest.fn(async () => undefined) } as unknown as Job<any>;

  it('elabora il ZIP: CSV scritto, riga con PDF mancante = warning, stato DONE', async () => {
    await processor.process(fakeJob);

    const csv = fs.readFileSync(getEnrichmentResultCsv('j1'), 'utf-8');
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3); // header + 2 righe
    expect(lines[1]).toContain('"RSSMRA80A01H501U"');
    expect(lines[1]).toContain('"VIA ROMA 1"');
    expect(lines[1]).toContain('"761,00"');
    // Riga 2: PDF mancante → campi estratti vuoti ma riga presente
    expect(lines[2]).toContain('"VRDLGU70A01H501X"');

    expect(client.extract).toHaveBeenCalledTimes(1); // solo il PDF esistente

    const finalUpdate = repo.update.mock.calls.at(-1)![1];
    expect(finalUpdate.status).toBe(EnrichmentJobStatus.DONE);
    expect(finalUpdate.processedRecords).toBe(2);
    expect(finalUpdate.warningCount).toBeGreaterThanOrEqual(1);
    expect(finalUpdate.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ pdf: 'PROVV_MANCANTE.pdf' })]),
    );
  });

  it('warnings del servizio Python confluiscono nei warnings del job', async () => {
    client.extract.mockResolvedValue({ address: null, payment: null, warnings: ['Indirizzo non estratto: xyz'] });
    await processor.process(fakeJob);
    const finalUpdate = repo.update.mock.calls.at(-1)![1];
    expect(finalUpdate.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ pdf: 'PROVV_1.pdf', message: 'Indirizzo non estratto: xyz' })]),
    );
  });

  it('errore fatale (source.zip assente) → stato FAILED con errorMessage, niente throw', async () => {
    fs.rmSync(getEnrichmentSourceZip('j1'));
    await processor.process(fakeJob);
    const finalUpdate = repo.update.mock.calls.at(-1)![1];
    expect(finalUpdate.status).toBe(EnrichmentJobStatus.FAILED);
    expect(finalUpdate.errorMessage).toBeTruthy();
  });

  it('record DB assente → return senza errori', async () => {
    repo.findOneBy.mockResolvedValue(null);
    await expect(processor.process(fakeJob)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — FAIL atteso**

```bash
docker compose exec backend node_modules/.bin/jest enrichment.processor --maxWorkers=2
```

- [ ] **Step 3: Implementazione**

`apps/backend/src/enrichment/enrichment.processor.ts`:

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
import { buildEnrichedCsv, type EnrichedRow } from './enriched-csv.util';
import { PdfExtractorClient } from './pdf-extractor.client';

const PROGRESS_UPDATE_EVERY = 10;

@Injectable()
@Processor(ENRICHMENT_QUEUE)
export class EnrichmentProcessor extends WorkerHost {
  private readonly logger = new Logger(EnrichmentProcessor.name);

  constructor(
    @InjectRepository(EnrichmentJob)
    private readonly jobRepo: Repository<EnrichmentJob>,
    private readonly extractor: PdfExtractorClient,
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

    await this.jobRepo.update(jobId, { status: EnrichmentJobStatus.PROCESSING });

    try {
      const zip = new AdmZip(getEnrichmentSourceZip(jobId));
      const { records } = parseMaggioliZip(zip);
      const warnings: EnrichmentWarning[] = [];
      const rows: EnrichedRow[] = [];

      for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        const rowNum = i + 1;
        const row = this.baseRow(rec);

        const entry = rec.pdfFilename ? zip.getEntry(`allegati/${rec.pdfFilename}`) : null;
        if (!entry) {
          warnings.push({ row: rowNum, pdf: rec.pdfFilename, message: 'PDF non trovato nel ZIP' });
          await job.log(`Riga ${rowNum}: PDF "${rec.pdfFilename}" non trovato nel ZIP`);
        } else {
          try {
            const result = await this.extractor.extract(entry.getData(), rec.pdfFilename, 'unica');
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
            if (result.payment) {
              row.numero_avviso = rec.csvNumeroAvviso || result.payment.numero_avviso;
              row.numero_avviso_alternativo = rec.csvNumeroAvvisoAlt || result.payment.numero_avviso_alternativo;
              row.importo = result.payment.importo;
              row.scadenza = result.payment.scadenza;
            }
          } catch (err: any) {
            warnings.push({ row: rowNum, pdf: rec.pdfFilename, message: `Estrazione fallita: ${err.message}` });
            await job.log(`Riga ${rowNum}: estrazione fallita — ${err.message}`);
          }
        }

        rows.push(row);

        if (rowNum % PROGRESS_UPDATE_EVERY === 0) {
          await this.jobRepo.update(jobId, { processedRecords: rowNum, warningCount: warnings.length });
        }
      }

      fs.writeFileSync(getEnrichmentResultCsv(jobId), buildEnrichedCsv(rows), 'utf-8');

      await this.jobRepo.update(jobId, {
        status: EnrichmentJobStatus.DONE,
        processedRecords: records.length,
        warningCount: warnings.length,
        warnings,
        completedAt: new Date(),
      });
      this.logger.log(`EnrichmentJob ${jobId} completato: ${records.length} righe, ${warnings.length} warning`);
    } catch (err: any) {
      // Stato terminale PRIMA di uscire: mai lasciare il record in PROCESSING
      this.logger.error(`EnrichmentJob ${jobId} fallito: ${err.message}`);
      await this.jobRepo.update(jobId, {
        status: EnrichmentJobStatus.FAILED,
        errorMessage: err.message,
        completedAt: new Date(),
      });
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

Registra `EnrichmentProcessor` nei providers di `enrichment.module.ts`.

- [ ] **Step 4: Run — PASS atteso, poi commit**

```bash
docker compose exec backend node_modules/.bin/jest enrichment --maxWorkers=2
git add apps/backend/src/enrichment
git commit -m "feat(backend): worker arricchimento con merge CSV/PDF e warnings per riga"
```

---

### Task 10: Backend — EnrichmentController (chunked upload + API)

**Files:**
- Create: `apps/backend/src/enrichment/enrichment.controller.ts`
- Modify: `apps/backend/src/enrichment/enrichment.module.ts` (controllers)
- Test: `apps/backend/src/enrichment/enrichment.controller.spec.ts`

**Interfaces:**
- Consumes: `EnrichmentService` (Task 8), `chunked-upload.util.ts` esistente.
- Produces (tutte sotto `admin/enrichment`, ruoli `user`+`admin`; delete solo `admin`):
  - `POST upload/init` `{filename, totalChunks}` → `{uploadId}`
  - `POST upload/chunk/:uploadId/:index` (multipart `chunk`)
  - `POST upload/complete/:uploadId` `{traceFormat}` → `{jobId}` | `{blocked, message}`
  - `GET jobs` → `{jobs: EnrichmentJob[]}`
  - `GET jobs/:id` → `EnrichmentJob`
  - `GET jobs/:id/result.csv`, `GET jobs/:id/result.zip` (download)
  - `DELETE jobs/:id` → `{}` | `{blocked, message}`

- [ ] **Step 1: Test failing (istanziazione diretta, mock service)**

`apps/backend/src/enrichment/enrichment.controller.spec.ts`:

```typescript
import { TraceFormat } from '../entities/enrichment-job.entity';
import { EnrichmentController } from './enrichment.controller';

describe('EnrichmentController', () => {
  let svc: any;
  let controller: EnrichmentController;

  beforeEach(() => {
    svc = {
      createJob: jest.fn(async () => ({ jobId: 'j1' })),
      listJobs: jest.fn(async () => []),
      getJob: jest.fn(async () => ({ id: 'j1' })),
      deleteJob: jest.fn(async () => ({})),
      buildResultZip: jest.fn(async () => Buffer.from('zip')),
    };
    controller = new EnrichmentController(svc);
  });

  it('init: valida filename e totalChunks', () => {
    expect(() => controller.initUpload({ filename: '', totalChunks: 1 })).toThrow();
    expect(() => controller.initUpload({ filename: 'x.zip', totalChunks: 0 })).toThrow();
  });

  it('complete: traceFormat non valido → blocked (mai eccezione non-2xx)', async () => {
    const result = await controller.completeUpload('upload-inesistente', { traceFormat: 'ALTRO' as any }, { user: { username: 'op' } } as any);
    expect(result.blocked).toBe(true);
  });

  it('complete: sessione upload inesistente → blocked', async () => {
    const result = await controller.completeUpload('upload-inesistente', { traceFormat: TraceFormat.MAGGIOLI }, { user: { username: 'op' } } as any);
    expect(result.blocked).toBe(true);
  });

  it('list ritorna {jobs}', async () => {
    await expect(controller.listJobs()).resolves.toEqual({ jobs: [] });
  });
});
```

- [ ] **Step 2: Run — FAIL atteso**

```bash
docker compose exec backend node_modules/.bin/jest enrichment.controller --maxWorkers=2
```

- [ ] **Step 3: Implementazione**

`apps/backend/src/enrichment/enrichment.controller.ts` (specchia `io-services.controller.ts` per la parte chunked):

```typescript
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../auth/decorators/roles.decorator';
import { TraceFormat } from '../entities/enrichment-job.entity';
import { EnrichmentService } from './enrichment.service';
import {
  MAX_CHUNK_SIZE_BYTES,
  assembleChunkedUpload,
  chunkUploadDir,
  cleanupChunkedUpload,
  initChunkedUpload,
} from '../campaigns/chunked-upload.util';
import { getEnrichmentResultCsv } from './enrichment-paths';

@Controller('admin/enrichment')
export class EnrichmentController {
  constructor(private readonly svc: EnrichmentService) {}

  // ── Upload ZIP SEMPRE a chunk (limite ~1MB reverse proxy esterno) ────────

  @Post('upload/init')
  @Roles('user', 'admin')
  initUpload(@Body() body: { filename?: string; totalChunks?: number }): { uploadId: string } {
    const filename = body.filename?.trim();
    const totalChunks = Number(body.totalChunks);
    if (!filename || !Number.isInteger(totalChunks) || totalChunks < 1) {
      throw new BadRequestException('filename e totalChunks (intero >= 1) richiesti');
    }
    return { uploadId: initChunkedUpload(filename, totalChunks) };
  }

  @Post('upload/chunk/:uploadId/:index')
  @Roles('user', 'admin')
  @UseInterceptors(
    FileInterceptor('chunk', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = chunkUploadDir(req.params['uploadId'] as string);
          if (!fs.existsSync(dir)) {
            cb(new BadRequestException('Sessione di upload non trovata o scaduta'), '');
            return;
          }
          cb(null, dir);
        },
        filename: (req, _file, cb) => {
          cb(null, `${req.params['index']}.part`);
        },
      }),
      limits: { fileSize: MAX_CHUNK_SIZE_BYTES },
    }),
  )
  uploadChunk(): { ok: true } {
    return { ok: true };
  }

  @Post('upload/complete/:uploadId')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  async completeUpload(
    @Param('uploadId') uploadId: string,
    @Body() body: { traceFormat?: TraceFormat },
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<{ jobId?: string; blocked?: boolean; message?: string }> {
    try {
      if (!body.traceFormat || !Object.values(TraceFormat).includes(body.traceFormat)) {
        return { blocked: true, message: 'Formato tracciato non riconosciuto' };
      }
      const { path, filename } = await assembleChunkedUpload(uploadId);
      return await this.svc.createJob({
        zipPath: path,
        sourceFilename: filename,
        traceFormat: body.traceFormat,
        createdBy: req.user.username,
      });
    } catch (err: any) {
      return { blocked: true, message: err?.message ?? 'Errore durante il riassemblaggio dello ZIP' };
    } finally {
      cleanupChunkedUpload(uploadId);
    }
  }

  // ── Stato e risultati ────────────────────────────────────────────────────

  @Get('jobs')
  @Roles('user', 'admin')
  listJobs() {
    return this.svc.listJobs().then((jobs) => ({ jobs }));
  }

  @Get('jobs/:id')
  @Roles('user', 'admin')
  getJob(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getJob(id);
  }

  @Get('jobs/:id/result.csv')
  @Roles('user', 'admin')
  async downloadCsv(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    await this.svc.getJob(id);
    const path = getEnrichmentResultCsv(id);
    if (!fs.existsSync(path)) {
      res.status(404).json({ error: 'Risultato non disponibile' });
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="arricchito_${id.slice(0, 8)}.csv"`);
    res.send(fs.readFileSync(path));
  }

  @Get('jobs/:id/result.zip')
  @Roles('user', 'admin')
  async downloadZip(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const buf = await this.svc.buildResultZip(id);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="arricchito_${id.slice(0, 8)}.zip"`);
    res.send(buf);
  }

  @Delete('jobs/:id')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  deleteJob(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.deleteJob(id);
  }
}
```

Aggiungi `controllers: [EnrichmentController]` a `enrichment.module.ts`.

- [ ] **Step 4: Run + type-check — PASS, poi commit**

```bash
docker compose exec backend node_modules/.bin/jest enrichment --maxWorkers=2
docker compose exec backend node_modules/.bin/tsc --noEmit
git add apps/backend/src/enrichment
git commit -m "feat(backend): API arricchimento con upload chunked e download risultati"
```

---

### Task 11: Backend — retention configurabile (TDD)

**Files:**
- Modify: `apps/backend/src/settings/settings.registry.ts` (chiave)
- Create: `apps/backend/src/enrichment/enrichment-retention.service.ts`
- Modify: `apps/backend/src/enrichment/enrichment.module.ts` (provider)
- Test: `apps/backend/src/enrichment/enrichment-retention.service.spec.ts`

**Interfaces:**
- Consumes: `AppSettingsService.get('enrichment.retentionDays')` (pattern esistente cache→DB→env→default).
- Produces: `EnrichmentRetentionService.runCleanup(): Promise<number>` (job eliminati), `@Cron('30 3 * * *')`.

- [ ] **Step 1: Chiave settings**

In `settings.registry.ts`, dopo `'retention.maxDays'`:

```typescript
  'enrichment.retentionDays': { type: 'number', default: 30 },
```

- [ ] **Step 2: Test failing**

`apps/backend/src/enrichment/enrichment-retention.service.spec.ts`:

```typescript
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { EnrichmentJobStatus } from '../entities/enrichment-job.entity';
import { getEnrichmentDir } from './enrichment-paths';
import { EnrichmentRetentionService } from './enrichment-retention.service';

describe('EnrichmentRetentionService', () => {
  let tmpDir: string;
  let repo: any;
  let settings: any;
  let service: EnrichmentRetentionService;

  const oldJob = {
    id: 'old-job',
    status: EnrichmentJobStatus.DONE,
    createdAt: new Date(Date.now() - 40 * 24 * 3600 * 1000),
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'enrich-ret-'));
    process.env['ATTACHMENTS_PATH'] = tmpDir;
    repo = {
      find: jest.fn(async () => [oldJob]),
      delete: jest.fn(async () => undefined),
    };
    settings = { get: jest.fn(async () => 30) };
    service = new EnrichmentRetentionService(repo, settings);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['ATTACHMENTS_PATH'];
  });

  it('elimina job più vecchi della retention (record + cartella)', async () => {
    fs.mkdirSync(getEnrichmentDir('old-job'), { recursive: true });
    const removed = await service.runCleanup();
    expect(removed).toBe(1);
    expect(repo.delete).toHaveBeenCalledWith('old-job');
    expect(fs.existsSync(getEnrichmentDir('old-job'))).toBe(false);
    // La query deve filtrare per createdAt < cutoff e status terminale
    const where = repo.find.mock.calls[0][0].where;
    expect(where).toBeDefined();
  });

  it('non elimina job PROCESSING anche se vecchi', async () => {
    // il filtro status è nella WHERE: qui verifichiamo che la clausola escluda PROCESSING
    await service.runCleanup();
    const where = repo.find.mock.calls[0][0].where;
    expect(JSON.stringify(where)).not.toContain('processing');
  });
});
```

- [ ] **Step 3: Run — FAIL atteso**

```bash
docker compose exec backend node_modules/.bin/jest enrichment-retention --maxWorkers=2
```

- [ ] **Step 4: Implementazione**

`apps/backend/src/enrichment/enrichment-retention.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import * as fs from 'fs';
import { EnrichmentJob, EnrichmentJobStatus } from '../entities/enrichment-job.entity';
import { AppSettingsService } from '../settings/app-settings.service';
import { getEnrichmentDir } from './enrichment-paths';

@Injectable()
export class EnrichmentRetentionService {
  private readonly logger = new Logger(EnrichmentRetentionService.name);

  constructor(
    @InjectRepository(EnrichmentJob)
    private readonly jobRepo: Repository<EnrichmentJob>,
    private readonly settings: AppSettingsService,
  ) {}

  @Cron('30 3 * * *')
  async handleCron(): Promise<void> {
    await this.runCleanup();
  }

  async runCleanup(): Promise<number> {
    const days = Number(await this.settings.get('enrichment.retentionDays'));
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);

    const expired = await this.jobRepo.find({
      where: {
        createdAt: LessThan(cutoff),
        // PROCESSING escluso: mai cancellare un job in corso
        status: In([EnrichmentJobStatus.QUEUED, EnrichmentJobStatus.DONE, EnrichmentJobStatus.FAILED]),
      },
      take: 200,
    });

    let removed = 0;
    for (const job of expired) {
      try {
        fs.rmSync(getEnrichmentDir(job.id), { recursive: true, force: true });
        await this.jobRepo.delete(job.id);
        removed++;
      } catch (err: any) {
        this.logger.warn(`Job arricchimento ${job.id} non eliminabile: ${err.message}`);
      }
    }
    if (removed > 0) this.logger.log(`Retention arricchimento: ${removed} job eliminati`);
    return removed;
  }
}
```

Registra il provider in `enrichment.module.ts`. Verifica che il modulo abbia accesso ad `AppSettingsService` (il modulo settings è `@Global()`; se non lo è, aggiungi `SettingsModule` agli imports — controllare `apps/backend/src/settings/settings.module.ts`).

- [ ] **Step 5: UI Impostazioni — campo retention**

In `apps/frontend-admin/src/App.tsx`: cerca dove è renderizzato il campo per `retention.maxDays` (`grep -n "retention.maxDays" apps/frontend-admin/src/App.tsx`) e aggiungi accanto un input numerico identico per la chiave `enrichment.retentionDays` con label "Retention job arricchimento (giorni)". Stessa gestione state/salvataggio delle altre chiavi della tab (le settings passano tutte da `handleSaveSettings`).

- [ ] **Step 6: Run + commit**

```bash
docker compose exec backend node_modules/.bin/jest enrichment-retention --maxWorkers=2
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
git add apps/backend/src/settings/settings.registry.ts apps/backend/src/enrichment apps/frontend-admin/src/App.tsx
git commit -m "feat: retention configurabile per job arricchimento"
```

---

### Task 12: Backend — "Crea bozza campagna" da job

**Files:**
- Modify: `apps/backend/src/enrichment/enrichment.service.ts` (nuovo metodo)
- Modify: `apps/backend/src/enrichment/enrichment.controller.ts` (endpoint)
- Modify: `apps/backend/src/enrichment/enrichment.module.ts` (import CampaignsModule)
- Test: `apps/backend/src/enrichment/enrichment.service.spec.ts` (aggiunta describe)

**Interfaces:**
- Consumes: `CampaignsService.create(dto: CreateCampaignDto, createdBy: string): Promise<Campaign>` (esistente, `campaigns.service.ts:199`), `getUploadsDir(campaignId)` da `attachment-paths.ts`.
- Produces: `createCampaignFromJob(jobId: string, params: { name: string; channelType: 'PEC'|'EMAIL'|'APP_IO'|'SEND'|'POSTAL' }, createdBy: string): Promise<{ campaignId?: string; blocked?: boolean; message?: string }>`; endpoint `POST admin/enrichment/jobs/:id/create-campaign`.

**Vincolo CLAUDE.md:** nessun importer parallelo — la bozza viene creata col MECCANISMO wizard: `channelConfig.wizCsvFilename` + file `draft_recipients.csv` in `getUploadsDir(campaignId)`, così `handleResumeDraft` → `prefillWizardFrom` ricarica il CSV e lo fa passare da `parseCsvFile` con TUTTE le validazioni wizard (`App.tsx:3623-3642`). I PDF vengono copiati in `getUploadsDir(campaignId)` così al lancio la risoluzione allegati per nome file li trova.

- [ ] **Step 1: Test failing (aggiungi al describe esistente di enrichment.service.spec.ts)**

```typescript
describe('createCampaignFromJob', () => {
  let campaignsService: any;

  beforeEach(() => {
    campaignsService = { create: jest.fn(async () => ({ id: 'camp-1' })) };
    service = new EnrichmentService(repo, queue, campaignsService);
  });

  function setupDoneJob(): void {
    repo.findOneBy.mockResolvedValue({ id: 'job-uuid-1', status: EnrichmentJobStatus.DONE, campaignId: null });
    const dir = join(tmpDir, 'attachments', 'enrichment', 'job-uuid-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(makeZipFile(tmpDir), join(dir, 'source.zip'));
    fs.writeFileSync(join(dir, 'result.csv'), '"codice_fiscale"\n"RSSMRA80A01H501U"');
  }

  it('crea bozza: CSV come draft_recipients.csv, PDF copiati, job marcato, file eliminati', async () => {
    setupDoneJob();
    const result = await service.createCampaignFromJob('job-uuid-1', { name: 'Campagna X', channelType: 'PEC' }, 'op');

    expect(result.campaignId).toBe('camp-1');
    expect(campaignsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Campagna X',
        channelType: 'PEC',
        channelConfig: expect.objectContaining({ wizCsvFilename: 'arricchito.csv', wizCsvHasHeaders: true }),
      }),
      'op',
    );
    const uploadsDir = join(tmpDir, 'attachments', 'uploads', 'camp-1');
    expect(fs.existsSync(join(uploadsDir, 'draft_recipients.csv'))).toBe(true);
    expect(fs.existsSync(join(uploadsDir, 'PROVV_1.pdf'))).toBe(true);
    expect(repo.update).toHaveBeenCalledWith('job-uuid-1', { campaignId: 'camp-1' });
    // File del job eliminati dopo la conversione
    expect(fs.existsSync(join(tmpDir, 'attachments', 'enrichment', 'job-uuid-1'))).toBe(false);
  });

  it('job non DONE → blocked', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.PROCESSING, campaignId: null });
    const result = await service.createCampaignFromJob('j1', { name: 'X', channelType: 'PEC' }, 'op');
    expect(result.blocked).toBe(true);
  });

  it('job già convertito → blocked', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.DONE, campaignId: 'camp-old' });
    const result = await service.createCampaignFromJob('j1', { name: 'X', channelType: 'PEC' }, 'op');
    expect(result.blocked).toBe(true);
  });
});
```

Aggiorna il `beforeEach` principale: il costruttore diventa `new EnrichmentService(repo, queue, campaignsService)` — passa un mock `{ create: jest.fn() }` anche nei test esistenti. Aggiungi `update: jest.fn(async () => undefined)` al mock repo principale.

- [ ] **Step 2: Run — FAIL atteso**

```bash
docker compose exec backend node_modules/.bin/jest enrichment.service --maxWorkers=2
```

- [ ] **Step 3: Implementazione**

In `enrichment.service.ts` — aggiungi il parametro costruttore e il metodo:

```typescript
import { CampaignsService } from '../campaigns/campaigns.service';
import { getUploadsDir } from '../attachments/attachment-paths';
import { join } from 'path';

// costruttore:
  constructor(
    @InjectRepository(EnrichmentJob)
    private readonly jobRepo: Repository<EnrichmentJob>,
    @InjectQueue(ENRICHMENT_QUEUE)
    private readonly queue: Queue<EnrichmentQueueJobData>,
    private readonly campaignsService: CampaignsService,
  ) {}

  /**
   * Vincolo repo: la creazione/import destinatari passa SOLO dal wizard.
   * Qui NON importiamo destinatari: creiamo una bozza col meccanismo
   * wizCsvFilename + draft_recipients.csv, così "Riprendi wizard" ricarica il
   * CSV arricchito attraverso parseCsvFile con tutte le validazioni wizard.
   */
  async createCampaignFromJob(
    jobId: string,
    params: { name: string; channelType: 'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL' },
    createdBy: string,
  ): Promise<{ campaignId?: string; blocked?: boolean; message?: string }> {
    const job = await this.getJob(jobId);
    if (job.status !== EnrichmentJobStatus.DONE) {
      return { blocked: true, message: 'Il job non è completato: nessun risultato da convertire' };
    }
    if (job.campaignId) {
      return { blocked: true, message: 'Job già convertito in campagna' };
    }
    if (!fs.existsSync(getEnrichmentResultCsv(jobId))) {
      return { blocked: true, message: 'File risultato non più disponibile (retention scaduta?)' };
    }

    const campaign = await this.campaignsService.create(
      {
        name: params.name,
        channelType: params.channelType,
        channelConfig: { wizCsvFilename: 'arricchito.csv', wizCsvHasHeaders: true, wizStep: 1 },
      },
      createdBy,
    );

    const uploadsDir = getUploadsDir(campaign.id);
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.copyFileSync(getEnrichmentResultCsv(jobId), join(uploadsDir, 'draft_recipients.csv'));

    const source = new AdmZip(getEnrichmentSourceZip(jobId));
    for (const entry of source.getEntries()) {
      if (entry.entryName.startsWith('allegati/') && entry.entryName.toLowerCase().endsWith('.pdf')) {
        fs.writeFileSync(join(uploadsDir, entry.entryName.replace(/^allegati\//, '')), entry.getData());
      }
    }

    await this.jobRepo.update(jobId, { campaignId: campaign.id });
    fs.rmSync(getEnrichmentDir(jobId), { recursive: true, force: true });

    return { campaignId: campaign.id };
  }
```

Endpoint nel controller:

```typescript
  @Post('jobs/:id/create-campaign')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  createCampaign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { name?: string; channelType?: 'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL' },
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    const name = body.name?.trim();
    if (!name || !body.channelType) {
      return { blocked: true, message: 'Nome campagna e canale richiesti' };
    }
    return this.svc.createCampaignFromJob(id, { name, channelType: body.channelType }, req.user.username);
  }
```

In `enrichment.module.ts` importa il modulo campagne: aggiungi `CampaignsModule` agli imports (verifica che `campaigns.module.ts` esporti `CampaignsService`; se non lo esporta, aggiungi l'export lì). Se emerge dipendenza circolare (CampaignsModule non deve importare EnrichmentModule — verificare), usare `forwardRef` NON è previsto: EnrichmentModule dipende da CampaignsModule a senso unico.

- [ ] **Step 4: GOTCHA audit costruttore — suite COMPLETA**

`EnrichmentService` ha cambiato firma del costruttore: cerca istanziazioni dirette in altri spec (`grep -rn "new EnrichmentService(" apps/backend/src`) e aggiornale. Poi:

```bash
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```

Expected: failure set identico alla baseline (solo `app.controller.spec.ts`).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/enrichment apps/backend/src/campaigns/campaigns.module.ts
git commit -m "feat(backend): conversione job arricchimento in bozza campagna wizard"
```

---

### Task 13: Frontend — dashboard Arricchimento

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: API Task 10/12 (`${ADMIN_API_BASE}/enrichment/...`), `uploadFileInChunks(baseUrl, token, file, filename, onProgress, onCompleteStart?, completeBody?)` esistente (`App.tsx:288`), `handleResumeDraft(campaignId)` esistente (`App.tsx:3662`).
- Produces: view `arricchimento` con lista job, upload, dettaglio warnings, download, delete, crea bozza.

- [ ] **Step 1: View union + stato**

In `App.tsx:478` aggiungi `'arricchimento'` alla union del `useState` di `view`.

Aggiungi gli stati (vicino agli altri blocchi di stato per view, es. dopo gli stati verifica-appio):

```typescript
  // ── Arricchimento tracciati ──
  interface EnrichmentJobItem {
    id: string;
    status: 'queued' | 'processing' | 'done' | 'failed';
    traceFormat: string;
    sourceFilename: string;
    totalRecords: number;
    processedRecords: number;
    warningCount: number;
    warnings: Array<{ row: number; pdf: string; message: string }>;
    errorMessage: string | null;
    campaignId: string | null;
    createdAt: string;
  }
  const [enrichJobs, setEnrichJobs] = useState<EnrichmentJobItem[]>([]);
  const [enrichFile, setEnrichFile] = useState<File | null>(null);
  const [enrichUploading, setEnrichUploading] = useState(false);
  const [enrichUploadProgress, setEnrichUploadProgress] = useState(0);
  const [enrichError, setEnrichError] = useState<string | null>(null);
  const [enrichDetailJobId, setEnrichDetailJobId] = useState<string | null>(null);
```

- [ ] **Step 2: Fetch + polling**

```typescript
  const fetchEnrichJobs = useCallback(async () => {
    if (!token) return;
    const res = await fetch(`${ADMIN_API_BASE}/enrichment/jobs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const body = await res.json();
      setEnrichJobs(body.jobs || []);
    }
  }, [token]);

  useEffect(() => {
    if (view !== 'arricchimento' || !token) return;
    fetchEnrichJobs();
    const interval = setInterval(() => {
      // Poll solo se c'è un job non terminale
      setEnrichJobs((prev) => {
        if (prev.some((j) => j.status === 'queued' || j.status === 'processing')) fetchEnrichJobs();
        return prev;
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [view, token, fetchEnrichJobs]);
```

- [ ] **Step 3: Upload handler (chunked, mai single-shot)**

```typescript
  const handleEnrichUpload = async () => {
    if (!enrichFile || !token) return;
    setEnrichUploading(true);
    setEnrichError(null);
    setEnrichUploadProgress(0);
    try {
      const result = await uploadFileInChunks(
        `${ADMIN_API_BASE}/enrichment/upload`,
        token,
        enrichFile,
        enrichFile.name,
        (loaded) => setEnrichUploadProgress(Math.round((loaded / enrichFile.size) * 100)),
        undefined,
        { traceFormat: 'MAGGIOLI' },
      );
      if (result.blocked) {
        setEnrichError(result.message || 'Tracciato non valido');
      } else {
        setEnrichFile(null);
        await fetchEnrichJobs();
      }
    } catch (err: any) {
      setEnrichError(err.message || 'Errore durante il caricamento');
    } finally {
      setEnrichUploading(false);
    }
  };
```

- [ ] **Step 4: Voce menu**

Nella sidebar (dopo la voce "Verifica App IO", `App.tsx:~4394`), stessa struttura delle altre voci:

```tsx
          <a
            href="#"
            className={`bo-nav-item ${view === 'arricchimento' ? 'is-active' : ''}`}
            onClick={(e) => { e.preventDefault(); setView('arricchimento'); }}
          >
            Arricchimento tracciati
          </a>
```

(copiare markup esatto — icona/classi — da una voce adiacente esistente). Aggiungi anche il titolo pagina nella zona `App.tsx:~4462`:

```tsx
          {view === 'arricchimento' && 'Arricchimento Tracciati'}
```

- [ ] **Step 5: View body — upload + lista**

Nel body (accanto agli altri blocchi `{view === '...' && (...)}`), struttura con classi già in uso nell'admin (`bo-card` o le classi delle altre view — copiarle da `verifica-appio`):

```tsx
          {view === 'arricchimento' && (
            <div>
              <div className="bo-card">
                <h3>Nuovo arricchimento</h3>
                <p>
                  Carica lo ZIP di postalizzazione (formato Maggioli: rubrica.csv o
                  pag_indice.csv + cartella allegati/). I PDF vengono analizzati per
                  estrarre indirizzi e dati PagoPA; al termine scarichi il CSV
                  arricchito pronto per il wizard.
                </p>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <select value="MAGGIOLI" disabled>
                    <option value="MAGGIOLI">Tracciato Maggioli (ZIP)</option>
                  </select>
                  <input
                    type="file"
                    accept=".zip"
                    onChange={(e) => setEnrichFile(e.target.files?.[0] || null)}
                  />
                  <button
                    type="button"
                    disabled={!enrichFile || enrichUploading}
                    onClick={handleEnrichUpload}
                  >
                    {enrichUploading ? `Caricamento ${enrichUploadProgress}%...` : 'Avvia arricchimento'}
                  </button>
                </div>
                {enrichError && <p style={{ color: 'var(--ms-error, #d32f2f)' }}>{enrichError}</p>}
              </div>

              <div className="bo-card">
                <h3>Job di arricchimento</h3>
                {enrichJobs.length === 0 && <p>Nessun job presente.</p>}
                {enrichJobs.map((job) => (
                  <div key={job.id} style={{ borderBottom: '1px solid var(--ms-border, #ddd)', padding: '8px 0' }}>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                      <strong>{job.sourceFilename}</strong>
                      <span>{new Date(job.createdAt).toLocaleString('it-IT')}</span>
                      <span>
                        {job.status === 'queued' && 'In coda'}
                        {job.status === 'processing' && `Elaborazione ${job.processedRecords}/${job.totalRecords}`}
                        {job.status === 'done' && `Completato (${job.totalRecords} righe${job.warningCount ? `, ${job.warningCount} avvisi` : ''})`}
                        {job.status === 'failed' && `Fallito: ${job.errorMessage}`}
                      </span>
                      {job.campaignId && <span>→ campagna creata</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                      {job.status === 'done' && !job.campaignId && (
                        <>
                          <button type="button" onClick={() => downloadEnrichResult(job.id, 'csv')}>Scarica CSV</button>
                          <button type="button" onClick={() => downloadEnrichResult(job.id, 'zip')}>Scarica ZIP</button>
                          <button type="button" onClick={() => handleEnrichCreateCampaign(job)}>Crea bozza campagna</button>
                        </>
                      )}
                      {job.warningCount > 0 && (
                        <button type="button" onClick={() => setEnrichDetailJobId(enrichDetailJobId === job.id ? null : job.id)}>
                          {enrichDetailJobId === job.id ? 'Nascondi avvisi' : `Avvisi (${job.warningCount})`}
                        </button>
                      )}
                      {job.status !== 'processing' && role === 'admin' && (
                        <button type="button" onClick={() => handleEnrichDelete(job.id)}>Elimina</button>
                      )}
                    </div>
                    {enrichDetailJobId === job.id && (
                      <ul style={{ marginTop: 8 }}>
                        {job.warnings.map((w, i) => (
                          <li key={i}>Riga {w.row} — {w.pdf}: {w.message}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
```

ATTENZIONE stile: prima di usare classi (`bo-card` ecc.) verificarne l'esistenza (`grep -n "bo-card" apps/frontend-admin/src`) e riusare le classi REALI delle altre view admin.

- [ ] **Step 6: Handlers download/delete/crea-bozza**

```typescript
  const downloadEnrichResult = async (jobId: string, kind: 'csv' | 'zip') => {
    if (!token) return;
    const res = await fetch(`${ADMIN_API_BASE}/enrichment/jobs/${jobId}/result.${kind}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) { alert('Download non disponibile'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `arricchito_${jobId.slice(0, 8)}.${kind}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleEnrichDelete = async (jobId: string) => {
    if (!token || !confirm('Eliminare il job e i suoi file? Azione irreversibile.')) return;
    const res = await fetch(`${ADMIN_API_BASE}/enrichment/jobs/${jobId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (body.blocked) { alert(body.message); return; }
    fetchEnrichJobs();
  };

  const handleEnrichCreateCampaign = async (job: EnrichmentJobItem) => {
    if (!token) return;
    const name = prompt('Nome della nuova campagna:', job.sourceFilename.replace(/\.zip$/i, ''));
    if (!name) return;
    const channelType = prompt('Canale (PEC, EMAIL, APP_IO, SEND, POSTAL):', 'PEC')?.trim().toUpperCase();
    if (!channelType || !['PEC', 'EMAIL', 'APP_IO', 'SEND', 'POSTAL'].includes(channelType)) return;
    const res = await fetch(`${ADMIN_API_BASE}/enrichment/jobs/${job.id}/create-campaign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, channelType }),
    });
    const body = await res.json();
    if (body.blocked) { alert(body.message); return; }
    // Instrada nel wizard esistente: il CSV passa da parseCsvFile con le
    // validazioni wizard (nessun importer parallelo)
    await handleResumeDraft(body.campaignId);
  };
```

NOTA: `prompt()` è deliberato per v1 (zero markup aggiuntivo); se in review risulta troppo povero si sostituisce con un piccolo pannello inline `<div>` (MAI `<form>` annidata).

- [ ] **Step 7: Type-check + verifica manuale**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): dashboard arricchimento tracciati"
```

---

### Task 14: Verifica end-to-end in dev + suite completa

**Files:** nessuna modifica prevista (solo fix emergenti).

- [ ] **Step 1: Riavvio stack con nuovi servizi**

```bash
docker compose up -d --build pdf-extractor
docker compose restart backend
docker compose exec backend ls -la dist/enrichment src/enrichment
```

Verifica `dist/` più recente di `src/` (gotcha watch NestJS su bind mount Windows).

- [ ] **Step 2: Fixture di test sintetica**

Crea nello scratchpad uno ZIP Maggioli sintetico: `rubrica.csv` con 2-3 righe + `allegati/` con PDF generati (riusare la logica `conftest.py` via container Python per generare PDF con indirizzo e QR PagoPA fittizio):

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "${PWD}/services/pdf-extractor:/svc" -v "<scratchpad>:/out" -w /svc python:3.11-slim sh -c "apt-get update -qq && apt-get install -y -qq libzbar0 > /dev/null && pip install -q -r requirements-dev.txt && python -c \"
import sys; sys.path.insert(0, '.')
from tests.conftest import _make_pdf
open('/out/PROVV_1.pdf','wb').write(_make_pdf(['Residente in:VIA ESEMPIO 10 - 65015 MONTESILVANO PE\n'], qr_payload='PAGOPA|002|301000000000000001|00123456789|76100'))
\""
```

poi assembla lo ZIP con PowerShell `Compress-Archive` (rubrica.csv + cartella allegati/) — NON usare i PDF reali di sendcsv.

- [ ] **Step 3: Flusso completo via UI (Playwright)**

Con lo stack dev attivo (login admin/admin, `LDAP_HOST=mock`):
1. Menu → Arricchimento tracciati → upload ZIP fixture → job appare `In coda`/`Elaborazione` → `Completato`.
2. Scarica CSV → verificare colonne virgolettate, indirizzo e `numero_avviso` estratti.
3. Avvisi visibili se presenti.
4. "Crea bozza campagna" → redirect nel wizard con CSV precaricato (step 1, righe visibili e validate).
5. Elimina un job → sparisce.

- [ ] **Step 4: Suite backend completa + type-check finali**

```bash
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: failure set = solo `app.controller.spec.ts` (baseline).

- [ ] **Step 5: Test Python finali**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "${PWD}/services/pdf-extractor:/svc" -w /svc python:3.11-slim sh -c "apt-get update -qq && apt-get install -y -qq libzbar0 > /dev/null && pip install -q -r requirements-dev.txt && python -m pytest tests/ -v"
```

- [ ] **Step 6: Aggiorna matrice comportamenti + CLAUDE.md**

La dashboard non tocca la matrice canali (nessun nuovo asse di invio), ma aggiungi in CLAUDE.md una sezione breve "Arricchimento tracciati" con: pattern verify-bulk riusato, servizio `pdf-extractor` solo rete interna, upload sempre chunked, retention `enrichment.retentionDays`, conversione in bozza via meccanismo `wizCsvFilename` (mai importer parallelo).

- [ ] **Step 7: Commit finale**

```bash
git add CLAUDE.md
git commit -m "docs: arricchimento tracciati in CLAUDE.md"
```
