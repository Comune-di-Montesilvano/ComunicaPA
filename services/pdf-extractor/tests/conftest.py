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
def pdf_sede_label() -> bytes:
    """Template avviso PG: 'Sede:CAP comune provincia via' su una riga (verificato dal vivo)."""
    return _make_pdf(
        ["Contribuente:PIZZANUOVA SRLS\nSede:65126 PESCARA PE VIA MARCO POLO 12\nOggetto: Saldo TARI 2026\n"]
    )


@pytest.fixture
def pdf_residenza_inline_label() -> bytes:
    """Template TARI saldo persona fisica: 'Residenza:CAP comune provincia via'
    su una riga sola (stessa struttura di Sede: ma per persona fisica, non PG)
    — verificato dal vivo su un documento reale, nessun 'Mail:' a differenza
    della variante multi-riga già coperta da pdf_residenza_label."""
    return _make_pdf(
        [
            "ROSSI MARIO Codice Utente 999999 VIA SANTA LUCIA 42 65010 SPOLTORE PE "
            "Contribuente:ROSSI MARIO nato il:01/01/1970 a PESCARA - PE "
            "C.F.:RSSMRA70A01G482X Residenza:65010 SPOLTORE PE VIA SANTA LUCIA 42 "
            "Oggetto: Saldo TARI 2026 - Avviso di pagamento\n"
        ]
    )


@pytest.fixture
def pdf_residenza_vuota_fallback_header() -> bytes:
    """Bug reale: 'Residenza:' presente ma VUOTA ('Residenza:\\nMail:...',
    nessun valore prima di 'Mail:') — né _RE_RESIDENZA_LABEL né
    _RE_RESIDENZA_INLINE_LABEL matchano (nessuna cifra dopo i due punti).
    L'indirizzo vero resta comunque nel blocco intestazione, prima di
    'Contribuente:' — verificato dal vivo, DOC_733580_160297.pdf."""
    return _make_pdf(
        [
            "CIESZKOWSKI ARTUR PIOTR\nCodice Utente 160297\nVIA VALLE D'AOSTA 9\n"
            "65015 MONTESILVANO PE\nContribuente:CIESZKOWSKI ARTUR PIOTR\n"
            "nato il:14/11/1982 a BUGAJ - POLONIA\nC.F.:CSZRRP82S14Z127R\n"
            "Residenza:\nMail:artur.cieszowski@gmail.com\n"
            "Oggetto: Saldo TARI 2026 - Avviso di pagamento\n"
        ]
    )


@pytest.fixture
def pdf_no_address() -> bytes:
    return _make_pdf(["Documento senza indirizzo utile\n"])


@pytest.fixture
def pdf_foreign_address_clean() -> bytes:
    """Formato pulito: via - CAP comune - stato (CAP 4 cifre, non 5 — Belgio)."""
    return _make_pdf(["Residente in: Rue Test 132 - 1180 Uccle - Belgio\n"])


@pytest.fixture
def pdf_foreign_address_cap_embedded() -> bytes:
    """CAP estero incorporato nella riga indirizzo (keyword 'CAP'), seguito
    da uno pseudocodice a 5 cifre + comune che NON è un CAP reale — bug
    reale riscontrato su un documento Maggioli reale (Svizzera)."""
    return _make_pdf(["Residente in: Bahnhofplatz 2 CAP 8802 - 86078 Testdorf - Svizzera\n"])


@pytest.fixture
def pdf_foreign_address_no_cap() -> bytes:
    """Nessun CAP nella riga (formato osservato su documenti reali svizzeri/tedeschi)."""
    return _make_pdf(["Residente in: Teststrasse 11 - Testort - Svizzera\n"])


@pytest.fixture
def pdf_foreign_address_parenthetical() -> bytes:
    """Nome stato ripetuto tra parentesi subito dopo la via (formato osservato
    su documenti reali svizzeri)."""
    return _make_pdf(["Residente in: Teststrasse 67 (Svizzera) - Testcity - Svizzera\n"])


@pytest.fixture
def pdf_foreign_address_alphanumeric_zip() -> bytes:
    """CAP alfanumerico (formato canadese) — limite noto/accettato: resta
    dentro il comune, non viene separato."""
    return _make_pdf(["Residente in: 732 Test Blvd. Testregion - Testcity R2Y 1M8 - Canada\n"])


@pytest.fixture
def pdf_foreign_address_extra_segment() -> bytes:
    """4 segmenti invece di 3 (duplicazione CAP/stato tra parentesi) —
    formato osservato su un documento reale belga."""
    return _make_pdf(["Residente in: Rue Test 8 - CAP. 5030 (Belgio) - 5030 Testville - Belgio\n"])


@pytest.fixture
def pdf_domestic_address_malformed_no_province() -> bytes:
    """Indirizzo domestico malformato: manca la provincia a 2 lettere finale
    richiesta da _RE_DOMESTIC, quindi il match cade sul fallback
    _parse_foreign_address. Il segmento finale ('65015 MONTESILVANO') NON è
    uno stato estero valido — inizia con un CAP — e deve essere rigettato
    dal sanity check invece di essere interpretato come 'stato_estero'."""
    return _make_pdf(["Residente in: VIA X 10 - LOC. Y - 65015 MONTESILVANO\n"])


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
def pdf_due_rate_stessa_pagina() -> bytes:
    """Bug reale (verificato dal vivo su tracciato 'TARI saldo'): 2 rate
    affiancate sulla STESSA pagina, 2 QR distinti. Contenuto inserito in
    ordine "2° prima di 1°" per riprodurre il reading-order scramblato che
    get_text() (senza sort=True) produce su layout multi-colonna reali —
    l'abbinamento QR<->etichetta deve comunque risultare corretto (1° QR
    per bbox = 1° RATA in lettura visiva sort=True)."""
    doc = fitz.open()
    page = doc.new_page()
    # 2° RATA (colonna destra) inserita PRIMA nello stream di contenuto.
    page.insert_textbox(fitz.Rect(320, 50, 570, 90), "2° RATA entro il 30/11/2026\n", fontsize=11)
    page.insert_textbox(fitz.Rect(320, 100, 570, 130), "CBILL\n", fontsize=11)
    img2 = qrcode.make("PAGOPA|002|301000000000000002|00123456789|26200")
    buf2 = io.BytesIO()
    img2.save(buf2, format="PNG")
    page.insert_image(fitz.Rect(320, 150, 520, 350), stream=buf2.getvalue())
    # 1° RATA (colonna sinistra) inserita DOPO — nel documento reale finisce
    # visivamente a sinistra ma più avanti nello stream.
    page.insert_textbox(fitz.Rect(50, 50, 300, 90), "1° RATA entro il 31/10/2026\n", fontsize=11)
    page.insert_textbox(fitz.Rect(50, 100, 300, 130), "CBILL\n", fontsize=11)
    img1 = qrcode.make("PAGOPA|002|301000000000000001|00123456789|26200")
    buf1 = io.BytesIO()
    img1.save(buf1, format="PNG")
    page.insert_image(fitz.Rect(50, 150, 250, 350), stream=buf1.getvalue())
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
