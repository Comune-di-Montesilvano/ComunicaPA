import { Controller, Get } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { OperatorDirectoryService } from './operator-directory.service.js';

@Controller('admin/operators')
@Roles('user', 'admin')
export class OperatorDirectoryController {
  constructor(private readonly directory: OperatorDirectoryService) {}

  // Elenco operatori per la scelta del firmatario (solo username + nome).
  @Get()
  list(): Promise<Array<{ username: string; displayName: string }>> {
    return this.directory.listAll();
  }
}
