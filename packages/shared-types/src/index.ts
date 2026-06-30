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
