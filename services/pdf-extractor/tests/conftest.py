import io

import fitz
import pytest
import qrcode


def _make_pdf(pages: list[str], qr_payload: str | None = None) -> bytes:
    """PDF sintetico: una pagina per stringa; QR opzionale sull'ultima pagina."""
    doc = fitz.open()
    for text in pages:
        page = doc.new_page()
        # Use insert_textbox for proper multi-line text handling
        page.insert_textbox(fitz.Rect(50, 50, 550, 400), text, fontsize=11)
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
            "AVVISO DI PAGAMENTO\nCBILL 301000000000000000 00123456789\nentro il 31/12/2026\n",
        ],
        qr_payload="PAGOPA|002|301000000000000000|00123456789|76100",
    )
