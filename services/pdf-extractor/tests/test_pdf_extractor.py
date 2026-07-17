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
