import type { NotificationChannel } from '@comunicapa/shared-types';

export class PreviewRecipientDto {
  codiceFiscale!: string;
  fullName?: string;
  email?: string;
  pec?: string;
  extraData?: Record<string, string>;
}

export class PreviewMessageDto {
  channelType!: NotificationChannel;
  subject!: string;
  body!: string;
  attachments?: Array<{ key: string; label: string }>;
  recipient!: PreviewRecipientDto;
  format?: 'html' | 'markdown';
}

export interface PreviewMessageResult {
  subject: string;
  bodyHtml?: string;
  bodyMarkdown?: string;
}
