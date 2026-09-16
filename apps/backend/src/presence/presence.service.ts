import { Injectable } from '@nestjs/common';

const ONLINE_THRESHOLD_MS = 90_000;

@Injectable()
export class PresenceService {
  private readonly lastSeen = new Map<string, number>();

  heartbeat(username: string): void {
    this.lastSeen.set(username, Date.now());
  }

  getOnlineCount(): number {
    const now = Date.now();
    let count = 0;
    for (const [username, seenAt] of this.lastSeen) {
      if (now - seenAt <= ONLINE_THRESHOLD_MS) {
        count++;
      } else {
        this.lastSeen.delete(username);
      }
    }
    return count;
  }
}
