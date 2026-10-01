/**
 * CancelRegistry: the ✕ button sets a flag keyed by chat+status-message;
 * long flows (batch downloads, album fetches) check it between sends and stop.
 * Real cancellation of queued work — not just a text edit.
 */
export class CancelRegistry {
  private set = new Set<string>();

  private key(chatId: number, messageId: number): string {
    return `${chatId}:${messageId}`;
  }

  cancel(chatId: number, messageId: number): void {
    this.set.add(this.key(chatId, messageId));
  }

  isCancelled(chatId: number, messageId: number): boolean {
    return this.set.has(this.key(chatId, messageId));
  }

  clear(chatId: number, messageId: number): void {
    this.set.delete(this.key(chatId, messageId));
  }
}
