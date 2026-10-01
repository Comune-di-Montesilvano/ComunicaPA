import { Controller, Get, UseFilters, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator.js';
import { ApiKeyGuard } from './guards/api-key.guard.js';
import { ExternalApiExceptionFilter } from './external-api-exception.filter.js';
import { ExternalCapabilitiesService } from './external-capabilities.service.js';

@Controller('external/v2/capabilities')
@Public()
@UseGuards(ApiKeyGuard)
@UseFilters(ExternalApiExceptionFilter)
export class ExternalCapabilitiesController {
  constructor(private readonly capabilities: ExternalCapabilitiesService) {}

  @Get()
  get() {
    return this.capabilities.getCapabilities();
  }
}
