import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OperatorDirectoryEntry } from '../entities/operator-directory-entry.entity.js';
import { OperatorDirectoryController } from './operator-directory.controller.js';
import { OperatorDirectoryService } from './operator-directory.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([OperatorDirectoryEntry])],
  controllers: [OperatorDirectoryController],
  providers: [OperatorDirectoryService],
  exports: [OperatorDirectoryService],
})
export class OperatorDirectoryModule {}
