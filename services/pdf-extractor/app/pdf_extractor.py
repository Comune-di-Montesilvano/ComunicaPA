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

    # Regex per classificazione pagina pagamento
    _RE_RATA_UNICA = re.compile(r"RATA\s+UNICA", re.IGNORECASE)
    _RE_RATA_N = re.compile(r"(\d+)\s*°?\s*RATA", re.IGNORECASE)

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
        unknown_rate: list[PaymentData] = []

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
                    if not payment.scadenza:
                        # Il QR PagoPA non porta la scadenza: recuperata dal
                        # testo della STESSA pagina (non dal testo globale,
                        # che confonderebbe le scadenze di rate diverse).
                        m_sc = self._RE_SCADENZA.search(text)
                        if m_sc:
                            payment.scadenza = m_sc.group(1)
                    if kind == "unica":
                        totale = payment
                    elif kind == "rata" and n is not None:
                        rate_by_index[n] = payment
                    else:
                        # Indice non numerabile in modo affidabile (nessuna
                        # etichetta "N RATA"): tenuta in una lista separata,
                        # sempre accodata in fondo a `rate` — non può mai
                        # collidere con l'indice di una rata numerata reale
                        # trovata prima o dopo nel loop.
                        unknown_rate.append(payment)
                        warnings.append(f"Pagina {page_idx}: etichetta rata non riconosciuta, aggiunta in coda a rate")
        except Exception as e:
            warnings.append(f"Estrazione QR fallita: {e}")

        rate = [rate_by_index[k] for k in sorted(rate_by_index.keys())] + unknown_rate

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
