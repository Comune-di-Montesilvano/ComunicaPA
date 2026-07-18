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


def test_extract_payment_etichetta_non_riconosciuta_non_sovrascrive_rata_numerata(
    pdf_rata_senza_etichetta_e_prima_rata,
):
    """Regressione: una pagina non classificabile NON deve mai far perdere
    una rata numerata reale (né viceversa) per collisione d'indice."""
    totale, rate, warnings = PdfExtractor(pdf_rata_senza_etichetta_e_prima_rata).extract_payment()
    assert totale is None
    assert len(rate) == 2
    numeri_avviso = {r.numero_avviso for r in rate}
    assert numeri_avviso == {"301000000000000099", "301000000000000001"}
    assert any("etichetta rata non riconosciuta" in w for w in warnings)
    # Effetto collaterale atteso (non un difetto della fix collisione): la
    # pagina non classificabile è sempre accodata in FONDO a `rate` (per
    # indice, non per data), quindi qui finisce dopo la 1° RATA pur avendo
    # scadenza cronologicamente precedente — il check "ordine crescente"
    # scatta correttamente su questo scostamento.
    assert any("non in ordine crescente" in w for w in warnings)


def test_extract_payment_unica_scadenza_diversa_da_prima_rata_warning(
    pdf_unica_scadenza_diversa_da_prima_rata,
):
    totale, rate, warnings = PdfExtractor(pdf_unica_scadenza_diversa_da_prima_rata).extract_payment()
    assert totale is not None
    assert len(rate) == 1
    assert any("diversa dalla scadenza della prima rata" in w for w in warnings)
    # Importi identici: la somma torna, isolando il warning di scadenza.
    assert not any("diversa dal totale" in w for w in warnings)


def test_extract_payment_rate_scadenze_non_ordinate_warning(pdf_rate_scadenze_non_ordinate):
    totale, rate, warnings = PdfExtractor(pdf_rate_scadenze_non_ordinate).extract_payment()
    assert totale is None
    assert len(rate) == 2
    assert any("non in ordine crescente" in w for w in warnings)
