import type { PreviewMessageResult } from '../../campaigns/dto/preview-message.dto';

export interface AttemptDetailDto {
  attemptNumber: number;
  status: string;
  channelType: string;
  errorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
  appIo: { attempted: false } | { attempted: true; success: boolean; error: string | null };
  iun: string | null;
  sendStatus: string | null;
  sendStatusUpdatedAt: string | null;
  protocolNumber: number | null;
  protocolYear: number | null;
  protocolledAt: string | null;
  postalTrackingId: string | null;
  postalStatus: string | null;
  postalStatusUpdatedAt: string | null;
}

export interface NotificationDetailDto {
  recipient: {
    id: string;
    codiceFiscale: string;
    fullName: string | null;
    email: string | null;
    pec: string | null;
    status: string;
  };
  campaign: {
    id: string;
    name: string;
    channelType: string;
  };
  attempts: AttemptDetailDto[];
  downloads: Array<{ channel: string; attachmentIndex: number; downloadedAt: string }>;
  preview: PreviewMessageResult;
  appIoPreview: PreviewMessageResult | null;
}
