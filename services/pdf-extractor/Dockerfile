FROM python:3.15-slim@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928
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
# requirements.txt = lock completo (transitive comprese) con hash, generato da
# requirements.in con pip-compile: --require-hashes rifiuta qualunque pacchetto con hash
# diverso, --no-deps impedisce di tirare dentro altro oltre al lock.
RUN pip install --no-cache-dir --require-hashes --no-deps -r requirements.txt \
    && (pip uninstall -y pip setuptools wheel || true)
COPY services/pdf-extractor/app/ ./app/
# Utente senza privilegi: un PDF ostile che sfrutta un bug di PyMuPDF/pdfplumber
# non ottiene root nel container. Il servizio lavora solo in memoria.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin extractor
USER 10001
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
