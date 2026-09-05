import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OperatorDirectoryEntry } from '../entities/operator-directory-entry.entity.js';
import { OperatorDirectoryService } from './operator-directory.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([OperatorDirectoryEntry])],
  providers: [OperatorDirectoryService],
  exports: [OperatorDirectoryService],
})
export class OperatorDirectoryModule {}
