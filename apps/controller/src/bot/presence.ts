/**
 * Presence: the bot never feels dead. Chat actions (typing/uploading) while we
 * work, emoji reactions on the user's message (👀 received → ✅ done).
 * All fire-and-forget on the background lane — presence must never fail a flow.
 */
import { Sender } from "../telegram/sender.js";

export type UploadKind = "photo" | "video" | "voice" | "document";
const ACTION: Record<UploadKind, string> = { photo: "upload_photo", video: "upload_video", voice: "upload_voice", document: "upload_document" };

export class Presence {
  private sender: Sender;
  constructor(sender: Sender) {
    this.sender = sender;
  }

  action(chatId: number, what: "typing" | UploadKind): void {
    const action = what === "typing" ? "typing" : ACTION[what];
    this.sender.enqueue("sendChatAction", { chat_id: chatId, action }, "background").catch(() => {});
  }

  react(chatId: number, messageId: number, emoji: string): void {
    this.sender
      .enqueue("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji }] }, "background")
      .catch(() => {});
  }
}
