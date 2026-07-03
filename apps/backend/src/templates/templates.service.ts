import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Template } from '../entities/template.entity';
import type { CreateTemplateDto, UpdateTemplateDto } from './dto/template.dto';

@Injectable()
export class TemplatesService {
  constructor(
    @InjectRepository(Template)
    private readonly repo: Repository<Template>,
  ) {}

  list(): Promise<Template[]> {
    return this.repo.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<Template> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Template ${id} non trovato`);
    return entity;
  }

  private async assertValidPairing(dto: { type: string; pairedTemplateId?: string }): Promise<void> {
    if (!dto.pairedTemplateId) return;
    const paired = await this.repo.findOneBy({ id: dto.pairedTemplateId });
    if (!paired) throw new BadRequestException('Template gemello non trovato');
    const expectedPairedType = dto.type === 'MAIL' ? 'APP_IO' : 'MAIL';
    if (paired.type !== expectedPairedType) {
      throw new BadRequestException(`Un template ${dto.type} puo essere accoppiato solo a un template ${expectedPairedType}`);
    }
  }

  async create(dto: CreateTemplateDto): Promise<Template> {
    if (dto.type === 'MAIL' && !dto.bodyHtml) {
      throw new BadRequestException('bodyHtml richiesto per template di tipo MAIL');
    }
    if (dto.type === 'APP_IO' && !dto.bodyMarkdown) {
      throw new BadRequestException('bodyMarkdown richiesto per template di tipo APP_IO');
    }
    await this.assertValidPairing(dto);

    const entity = this.repo.create({
      type: dto.type,
      name: dto.name,
      subject: dto.subject,
      bodyHtml: dto.type === 'MAIL' ? dto.bodyHtml! : '',
      bodyMarkdown: dto.type === 'APP_IO' ? dto.bodyMarkdown! : '',
      pairedTemplateId: dto.pairedTemplateId ?? null,
    });
    return this.repo.save(entity);
  }

  async update(id: string, dto: UpdateTemplateDto): Promise<Template> {
    const entity = await this.findOne(id);
    if (dto.pairedTemplateId !== undefined) {
      await this.assertValidPairing({ type: entity.type, pairedTemplateId: dto.pairedTemplateId });
      entity.pairedTemplateId = dto.pairedTemplateId;
    }
    if (dto.name !== undefined) entity.name = dto.name;
    if (dto.subject !== undefined) entity.subject = dto.subject;
    if (dto.bodyHtml !== undefined && entity.type === 'MAIL') entity.bodyHtml = dto.bodyHtml;
    if (dto.bodyMarkdown !== undefined && entity.type === 'APP_IO') entity.bodyMarkdown = dto.bodyMarkdown;
    return this.repo.save(entity);
  }

  async remove(id: string): Promise<void> {
    const result = await this.repo.delete({ id });
    if (!result.affected) throw new NotFoundException(`Template ${id} non trovato`);
  }
}
