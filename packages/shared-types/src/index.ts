export type NotificationChannel = 'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL';

export interface INotification {
  id: string;
  recipientId: string;
  channel: NotificationChannel;
  subject: string;
  body: string;
  createdAt: Date;
  sentAt: Date | null;
}

export interface IChannel {
  type: NotificationChannel;
  enabled: boolean;
  config: Record<string, string>;
}

export type OperatorRole = 'admin' | 'user';

export interface JwtOperatorPayload {
  sub: string;
  username: string;
  role: OperatorRole;
  type: 'operator';
  iat?: number;
  exp?: number;
}

export interface CitizenTokenClaims {
  sub: string;
  codiceFiscale: string;
  email?: string;
  name?: string;
  iat?: number;
  exp?: number;
}

export interface NotificationJobData {
  campaignId: string;
  recipientId: string;
  attemptId: string;
  channel: NotificationChannel;
}
