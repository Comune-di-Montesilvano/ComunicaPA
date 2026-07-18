from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


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


def test_extract_no_data(pdf_no_address):
    res = client.post(
        "/extract",
        files={"file": ("doc.pdf", pdf_no_address, "application/pdf")},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["address"] is None
    assert body["payment"] is None
    assert len(body["warnings"]) >= 2  # indirizzo + pagamento


def test_extract_corrupted_pdf():
    res = client.post(
        "/extract",
        files={"file": ("doc.pdf", b"not a pdf", "application/pdf")},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["address"] is None
    assert body["payment"] is None
    assert len(body["warnings"]) >= 1
