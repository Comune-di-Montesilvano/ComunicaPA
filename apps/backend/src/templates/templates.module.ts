import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Template } from '../entities/template.entity.js';
import { TemplatesService } from './templates.service.js';
import { TemplatesController } from './templates.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([Template])],
  controllers: [TemplatesController],
  providers: [TemplatesService],
})
export class TemplatesModule {}
