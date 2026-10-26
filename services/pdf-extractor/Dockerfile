FROM python:3.14-slim@sha256:35caba83af2fe6da9a5d922f9b0156f21d1246a48278c58a08bd253303ba42e8
WORKDIR /svc
# PKG_REFRESH (data del giorno, passata da release.yml) invalida la cache del layer una
# volta al giorno: senza, la cache registry congela `apt-get upgrade` e le patch
# Debian non entrano mai finche' l'immagine base non viene ripubblicata.
ARG PKG_REFRESH=none
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends libzbar0 && rm -rf /var/lib/apt/lists/*
COPY services/pdf-extractor/requirements.txt .
# pip non serve a runtime: rimosso dopo l'install insieme alle sue librerie vendored
# (pip/_vendor: urllib3, msgpack...) che portano CVE indipendenti da quelle dell'app.
RUN pip install --no-cache-dir -r requirements.txt \
    && (pip uninstall -y pip setuptools wheel || true)
COPY services/pdf-extractor/app/ ./app/
# Utente senza privilegi: un PDF ostile che sfrutta un bug di PyMuPDF/pdfplumber
# non ottiene root nel container. Il servizio lavora solo in memoria.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin extractor
USER 10001
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
