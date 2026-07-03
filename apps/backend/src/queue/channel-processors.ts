import { Processor } from '@nestjs/bullmq';
import { CHANNEL_QUEUES } from './notification-job.types';
import { NotificationProcessor } from './notification.processor';

// Le sottoclassi NON dichiarano un costruttore: i metadati di iniezione
// (design:paramtypes e @Inject) vengono risolti risalendo la prototype chain
// fino a NotificationProcessor, che resta @Injectable().

@Processor(CHANNEL_QUEUES.EMAIL)
export class EmailNotificationProcessor extends NotificationProcessor {}

@Processor(CHANNEL_QUEUES.PEC)
export class PecNotificationProcessor extends NotificationProcessor {}

@Processor(CHANNEL_QUEUES.APP_IO)
export class AppIoNotificationProcessor extends NotificationProcessor {}

@Processor(CHANNEL_QUEUES.SEND)
export class SendNotificationProcessor extends NotificationProcessor {}

@Processor(CHANNEL_QUEUES.POSTAL)
export class PostalNotificationProcessor extends NotificationProcessor {}
