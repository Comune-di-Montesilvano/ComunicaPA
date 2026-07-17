import io
import re
from typing import Optional

import pdfplumber

from app.models import AddressData, PaymentData


class AddressExtractionError(Exception):
    pass


class PdfExtractor:
    # Regex indirizzo domestico:
    # "Residente in:VIA ESEMPIO 10 - 65015 MONTESILVANO PE"
    _RE_DOMESTIC = re.compile(
        r"Residente\s+in\s*:\s*(.+?)\s*[-–]\s*(\d{5})\s+([\w\s\'\\u2019]+?)\s+([A-Z]{2})\s*(?:\n|$)",
        re.MULTILINE | re.IGNORECASE,
    )
    _RE_FOREIGN = re.compile(
        r"Residente\s+in\s*:\s*(.+?)\s*[-–]\s*(\d{5})\s+([\w\s]+?)\s*[-–]\s*([A-Za-z][A-Za-z\s]{2,})\s*(?:\n|$)",
        re.MULTILINE | re.IGNORECASE,
    )

    # Template TARI alternativo:
    # "Residenza:65015 MONTESILVANO PE\nVIA DEI TEATINI 3\nMail:..."
    # (CAP comune provincia sulla riga della label, via sulla/e riga/e dopo)
    _RE_RESIDENZA_LABEL = re.compile(
        r"Residenza\s*:\s*(\d{5})\s+(.+?)\s+([A-Z]{2})\s*\n(.*?)\n\s*Mail\s*:",
        re.IGNORECASE | re.DOTALL,
    )

    # Regex testo per fallback (quando il QR non è leggibile)
    _RE_CBILL = re.compile(
        r"[A-Z0-9]{5}\s+((?:\d[\d ]{16,20}\d))\s+(\d{11})",
        re.MULTILINE,
    )
    _RE_IMPORTO = re.compile(
        r"(\d[\d\.]*[,\.]\d{2})\s*[Ee]uro\s*\(?(?:rata\s+unica|unica)\)?",
        re.IGNORECASE,
    )
    _RE_SCADENZA = re.compile(
        r"entro\s+(?:il\s+)?(\d{1,2}/\d{1,2}/\d{4})",
        re.IGNORECASE,
    )

    def __init__(self, pdf_bytes: bytes):
        self._pdf_bytes = pdf_bytes

    def _open(self):
        return pdfplumber.open(io.BytesIO(self._pdf_bytes))

    # ------------------------------------------------------------------
    # Indirizzo
    # ------------------------------------------------------------------

    def extract_address(self) -> AddressData:
        with self._open() as pdf:
            if not pdf.pages:
                raise AddressExtractionError("PDF vuoto")
            text = pdf.pages[0].extract_text() or ""

        m = self._RE_DOMESTIC.search(text)
        if m:
            return AddressData(
                indirizzo=m.group(1).strip(),
                cap=m.group(2).strip(),
                comune=m.group(3).strip(),
                provincia=m.group(4).strip(),
                stato_estero="",
            )

        m = self._RE_FOREIGN.search(text)
        if m:
            return AddressData(
                indirizzo=m.group(1).strip(),
                cap=m.group(2).strip(),
                comune=m.group(3).strip(),
                provincia="",
                stato_estero=m.group(4).strip(),
            )

        m = self._RE_RESIDENZA_LABEL.search(text)
        if m:
            indirizzo = re.sub(r"\s+", " ", m.group(4)).strip()
            return AddressData(
                indirizzo=indirizzo,
                cap=m.group(1).strip(),
                comune=m.group(2).strip(),
                provincia=m.group(3).strip(),
                stato_estero="",
            )

        raise AddressExtractionError(
            f"Pattern 'Residente in:' non trovato. Testo pagina 0:\n{text[:500]}"
        )

    # ------------------------------------------------------------------
    # Pagamento — QR code (primario) + testo (fallback / scadenza)
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_pagopa_qr(text: str) -> Optional["PaymentData"]:
        """Parsa PAGOPA|002|<numero>|<cf_ente>|<centesimi> → PaymentData."""
        parts = text.split("|")
        if len(parts) < 5 or parts[0] != "PAGOPA":
            return None
        try:
            centesimi = int(parts[4])
            importo = f"{centesimi // 100},{centesimi % 100:02d}"
        except ValueError:
            importo = ""
        return PaymentData(numero_avviso=parts[2], cf_ente=parts[3], importo=importo)

    @staticmethod
    def _find_pagopa_pages(doc) -> list[int]:
        """Trova le pagine PagoPA cercando dal fondo (dove di solito si trova)."""
        keywords = ("PAGOPA", "PAGO PA", "CBILL", "AVVISO DI PAGAMENTO")
        pages = []
        for i in range(len(doc) - 1, -1, -1):
            text = (doc[i].get_text() or "").upper()
            if any(kw in text for kw in keywords):
                pages.append(i)
        return pages

    @classmethod
    def _find_payment_pages(cls, doc, mode: str) -> list[int]:
        """
        Individua la pagina da usare per il pagamento. Il CSV SEND ha un solo
        campo importo: si vuole sempre il totale (rata unica), mai una singola
        rata parziale.

        Si cerca dall'inizio del documento la prima pagina con un QR di
        pagamento reale (dicitura "CBILL", presente solo sulle pagine con QR,
        mai nel riepilogo testuale iniziale). Questa pagina è sempre quella
        del totale, anche quando seguono una o più pagine con le rate — a
        prescindere da quante siano ("mode" non incide sulla ricerca: la
        regola vale sia per i PDF a rata unica che per quelli con anche le
        rate). In assenza di match si torna al comportamento storico
        (ricerca per keyword generiche a partire dal fondo).
        """
        for i in range(len(doc)):
            text = (doc[i].get_text() or "").upper()
            if "CBILL" in text:
                return [i]

        return cls._find_pagopa_pages(doc)

    @staticmethod
    def _decode_qr(img: "Image.Image"):
        """Decodifica QR con preprocessing grayscale + autocontrast."""
        from PIL import ImageOps
        from pyzbar.pyzbar import decode as qr_decode

        gray = ImageOps.autocontrast(ImageOps.grayscale(img))
        codes = qr_decode(gray)
        if not codes:
            codes = qr_decode(img)
        return codes

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

    def _extract_payment_from_text(self) -> Optional[PaymentData]:
        """Fallback: estrae dati PagoPA via regex sul testo del PDF."""
        with self._open() as pdf:
            full_text = "\n".join((p.extract_text() or "") for p in pdf.pages)

        m_cbill = self._RE_CBILL.search(full_text)
        if not m_cbill:
            return None

        numero_avviso = re.sub(r"\s+", "", m_cbill.group(1))
        cf_ente = m_cbill.group(2)

        importo = ""
        m_imp = self._RE_IMPORTO.search(full_text)
        if m_imp:
            raw = m_imp.group(1)
            if "," in raw:
                importo = raw.replace(".", "")
            else:
                importo = raw.replace(".", ",")

        scadenza = ""
        m_sc = self._RE_SCADENZA.search(full_text)
        if m_sc:
            scadenza = m_sc.group(1)

        return PaymentData(
            numero_avviso=numero_avviso,
            cf_ente=cf_ente,
            importo=importo,
            scadenza=scadenza,
        )

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
