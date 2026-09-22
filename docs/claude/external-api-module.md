# External API module

## External API (`external-api/`) — due gotcha reali, non presi dalla suite unit

**Modulo consumato solo internamente prima → serve `exports` esplicito
quando arriva un nuovo consumer esterno al modulo.** `DomicilioModule`
dichiarava `providers: [DomicilioService]` ma nessun `exports` (mai servito
finora: `DomicilioController` lo usava dentro lo stesso modulo).
`ExternalApiModule`, importando `DomicilioModule` per riusare
`DomicilioService` nel nuovo `ExternalDomicilioController`, andava in
crash-loop al boot reale (`docker compose up`) — DI di Nest non risolve un
provider non esportato attraverso un `imports`. Nessuno unit test lo
intercetta: i service spec istanziano `new DomicilioService(...)`
direttamente, bypassando interamente il grafo dei moduli Nest. Fix: aggiungere
`exports: [DomicilioService]` a `DomicilioModule`. Ogni volta che un modulo
esistente guadagna un nuovo consumer esterno (anche se già usato da tempo
internamente), verificare che i provider richiesti siano in `exports` — non
darlo per scontato solo perché funzionava prima.

**`@Post()` di NestJS risponde 201 di default, non 200 — serve
`@HttpCode(HttpStatus.OK)` esplicito su ogni handler POST di `external/v1/*`.**
Il contratto "always 200" per gli endpoint `external/v1/*` (stesso principio
della sezione "Reverse proxy esterno in produzione" sopra) è normalizzato
solo per il path di errore da `ExternalApiExceptionFilter` — un handler che
risponde con successo mantiene lo status HTTP di default di Nest, 201 per
`@Post()`. `ExternalNotificationsController.create()` ed
`ExternalAttachmentsController` (init/chunk/complete) sono partiti senza
`@HttpCode(HttpStatus.OK)` per 11 task, mai scoperto perché ogni unit test
chiamava i metodi controller direttamente e asseriva solo sul corpo della
risposta, mai sullo status HTTP che Nest avrebbe realmente prodotto — emerso
solo con un E2E che boota l'app e fa richieste HTTP vere (task 12). Ogni
nuovo handler `@Post()` sotto `external/v1/*` va annotato esplicitamente,
non assumere che il filtro di eccezioni copra anche il caso di successo.

