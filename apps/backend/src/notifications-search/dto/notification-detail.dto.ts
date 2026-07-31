import type { PreviewMessageResult } from '../../campaigns/dto/preview-message.dto';
import type { ResolvedPaymentData } from '../../channels/payment-config.util';

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
  postalDeliveryStatus?: string | null;
  postalDeliveryCode?: number | null;
  postalDeliveryDate?: string | null;
  postalAcceptanceId?: string | null;
  postalStatusHistory: Array<{ stato: string; rilevatoIl: string; codiceErrore?: string; descrizione?: string; statoConsegna?: string; codiceConsegna?: number }> | null;
  costCents?: number | null;
  costCalculatedAt?: string | null;
  costBreakdown?: Record<string, unknown> | null;
}

export interface NotificationDetailDto {
  recipient: {
    id: string;
    codiceFiscale: string;
    fullName: string | null;
    email: string | null;
    pec: string | null;
    status: string;
    physicalAddress: { address: string; municipality: string; zip?: string; province?: string; foreignState?: string | null } | null;
  };
  campaign: {
    id: string;
    name: string;
    channelType: string;
    postalServiceType: string | null;
    postalReturnReceipt: boolean;
  };
  attempts: AttemptDetailDto[];
  downloads: Array<{ channel: string; attachmentIndex: number; downloadedAt: string }>;
  preview: PreviewMessageResult;
  appIoPreview: PreviewMessageResult | null;
  totalCostCents?: number | null;
  attachments: Array<{ index: number; label: string }>;
  /** null = campagna senza channelConfig.paymentConfig.enabled, o dato non risolvibile per questo destinatario. */
  payment: ResolvedPaymentData | null;
}
