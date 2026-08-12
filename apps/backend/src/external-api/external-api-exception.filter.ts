import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, HttpException, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { captureException } from '../common/sentry.util';

interface NormalizedError {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

@Catch()
export class ExternalApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ExternalApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const body = this.normalize(exception);
    if (body.error.code === 'INTERNAL_ERROR') {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
      captureException(exception);
    }
    response.status(200).json(body);
  }

  private normalize(exception: unknown): NormalizedError {
    if (exception instanceof UnauthorizedException) {
      return { success: false, error: { code: 'UNAUTHORIZED', message: this.messageOf(exception) } };
    }
    if (exception instanceof NotFoundException) {
      return { success: false, error: { code: 'NOT_FOUND', message: this.messageOf(exception) } };
    }
    if (exception instanceof BadRequestException) {
      const response = exception.getResponse();
      const details = typeof response === 'object' && response !== null && 'message' in response ? (response as { message: unknown }).message : this.messageOf(exception);
      return { success: false, error: { code: 'VALIDATION_ERROR', message: 'Validazione fallita', details } };
    }
    if (exception instanceof HttpException) {
      return { success: false, error: { code: 'LAUNCH_BLOCKED', message: this.messageOf(exception) } };
    }
    return { success: false, error: { code: 'INTERNAL_ERROR', message: 'Errore interno' } };
  }

  private messageOf(exception: HttpException): string {
    const response = exception.getResponse();
    if (typeof response === 'string') return response;
    if (typeof response === 'object' && response !== null && 'message' in response) {
      const msg = (response as { message: unknown }).message;
      return typeof msg === 'string' ? msg : exception.message;
    }
    return exception.message;
  }
}
