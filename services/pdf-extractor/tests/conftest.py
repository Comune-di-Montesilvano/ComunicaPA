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
    # Pagina 1: lettera con indirizzo; pagina 2: avviso con QR + testo CBILL (RATA UNICA)
    return _make_pdf(
        [
            "Residente in:VIA ROMA 1 - 00100 ROMA RM\n",
            "AVVISO DI PAGAMENTO\nCBILL 301000000000000000 00123456789\nRATA UNICA\nentro il 31/12/2026\n",
        ],
        qr_payload="PAGOPA|002|301000000000000000|00123456789|76100",
    )


@pytest.fixture
def pdf_unica_e_due_rate() -> bytes:
    """3 pagine pagamento: RATA UNICA (761,00) + 1° RATA (380,50) + 2° RATA (380,50).
    Ordine pagina deliberatamente 2°rata-1°rata-unica per verificare che la
    classificazione usi l'etichetta, non la posizione."""
    doc = fitz.open()
    pages_spec = [
        ("2° RATA", "PAGOPA|002|301000000000000002|00123456789|38050", "entro il 28/02/2027"),
        ("1° RATA", "PAGOPA|002|301000000000000001|00123456789|38050", "entro il 31/01/2027"),
        ("RATA UNICA", "PAGOPA|002|301000000000000000|00123456789|76100", "entro il 31/01/2027"),
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


def _build_multi_page_pdf(pages_spec: list[tuple[str, str, str]]) -> bytes:
    """Costruisce un PDF con una pagina CBILL per ogni (label, qr_payload,
    scadenza_text) in pages_spec, stesso pattern delle fixture sopra."""
    doc = fitz.open()
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
def pdf_rata_senza_etichetta_e_prima_rata() -> bytes:
    """Pagina CBILL senza etichetta riconosciuta SEGUITA da una vera '1° RATA':
    riproduce la collisione d'indice — l'etichetta non riconosciuta viene
    provvisoriamente numerata come indice 1, poi arriva davvero una '1° RATA'.
    Entrambe devono sopravvivere in `rate`, nessuna sovrascritta."""
    return _build_multi_page_pdf(
        [
            ("", "PAGOPA|002|301000000000000099|00123456789|50000", "entro il 31/12/2026"),
            ("1° RATA", "PAGOPA|002|301000000000000001|00123456789|38050", "entro il 31/01/2027"),
        ]
    )


@pytest.fixture
def pdf_unica_scadenza_diversa_da_prima_rata() -> bytes:
    """RATA UNICA (761,00, scadenza 31/12/2026) + 1 sola rata (761,00,
    scadenza 15/01/2027 — diversa dalla scadenza della rata unica). Importi
    identici: la somma torna, così SOLO il warning di scadenza può scattare,
    isolato dal warning di somma diversa."""
    return _build_multi_page_pdf(
        [
            ("RATA UNICA", "PAGOPA|002|301000000000000000|00123456789|76100", "entro il 31/12/2026"),
            ("1° RATA", "PAGOPA|002|301000000000000001|00123456789|76100", "entro il 15/01/2027"),
        ]
    )


@pytest.fixture
def pdf_rate_scadenze_non_ordinate() -> bytes:
    """2 rate numerate con scadenze fuori ordine cronologico: 1° RATA scade
    dopo la 2° RATA."""
    return _build_multi_page_pdf(
        [
            ("1° RATA", "PAGOPA|002|301000000000000001|00123456789|38050", "entro il 28/02/2027"),
            ("2° RATA", "PAGOPA|002|301000000000000002|00123456789|38050", "entro il 31/01/2027"),
        ]
    )
