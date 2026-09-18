import { Injectable } from '@nestjs/common';

const ONLINE_THRESHOLD_MS = 90_000;

@Injectable()
export class PresenceService {
  private readonly lastSeen = new Map<string, number>();

  heartbeat(username: string): void {
    this.lastSeen.set(username, Date.now());
  }

  getOnlineCount(): number {
    return this.getOnlineUsernames().length;
  }

  getOnlineUsernames(): string[] {
    const now = Date.now();
    const online: string[] = [];
    for (const [username, seenAt] of this.lastSeen) {
      if (now - seenAt <= ONLINE_THRESHOLD_MS) {
        online.push(username);
      } else {
        this.lastSeen.delete(username);
      }
    }
    return online;
  }
}
