import { Module } from '@nestjs/common';
import { DomicileVerificationEventsService } from './domicile-verification-events.service.js';

/**
 * Modulo minimo (zero altre dipendenze) apposta per essere importato SIA da
 * `DomicileVerificationModule` SIA da `RegistroImpreseModule` senza ciclo —
 * `RegistroImpreseModule` è già importato da `DomicileVerificationModule`,
 * quindi il verso opposto (import diretto reciproco) richiederebbe
 * `forwardRef`. Passando da questo modulo terzo, nessuno dei due importa
 * l'altro.
 */
@Module({
  providers: [DomicileVerificationEventsService],
  exports: [DomicileVerificationEventsService],
})
export class DomicileVerificationEventsModule {}
