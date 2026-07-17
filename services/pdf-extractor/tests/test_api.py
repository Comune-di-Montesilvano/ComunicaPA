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
