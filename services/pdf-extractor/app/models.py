from dataclasses import dataclass


@dataclass
class AddressData:
    indirizzo: str = ""
    cap: str = ""
    comune: str = ""
    provincia: str = ""
    stato_estero: str = ""


@dataclass
class PaymentData:
    numero_avviso: str = ""             # 18 cifre (Ocr int)
    numero_avviso_alternativo: str = "" # Ocr rid / CDS
    cf_ente: str = ""
    importo: str = ""                   # es. "761,00"
    scadenza: str = ""                  # "GG/MM/AAAA" o vuoto
