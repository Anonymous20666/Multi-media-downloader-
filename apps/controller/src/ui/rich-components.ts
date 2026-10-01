/**
 * Telegram Bot API 10.3 Native Rich Component Library.
 * Pure builders over verified TDLib / Bot API 10.3 page-block types.
 *
 * Every component produces:
 *  1. Compliant serialized `rich_message` JSON string with typed blocks.
 *  2. High-fidelity Markdown fallback string for legacy clients / non-supported contexts.
 *
 * Grounded in empirical binary audit of `/usr/local/bin/telegram-bot-api`.
 */

export type HeadingSize = 1 | 2 | 3 | 4 | 5 | 6;

export interface HeadingBlock {
  type: "heading";
  size: HeadingSize;
  text: string;
}

export interface ParagraphBlock {
  type: "paragraph";
  text: string;
}

export interface DividerBlock {
  type: "divider";
}

export interface TableCell {
  text: string;
  is_header?: boolean;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
}

export interface TableBlock {
  type: "table";
  cells: TableCell[][];
  is_bordered?: boolean;
  is_striped?: boolean;
  caption?: string;
}

export interface DetailsBlock {
  type: "details";
  summary: string;
  blocks: RichBlock[];
  is_open?: boolean;
}

export interface PreBlock {
  type: "pre";
  text: string;
  language?: string;
}

export interface BlockquoteBlock {
  type: "blockquote";
  blocks: RichBlock[];
}

export interface PullquoteBlock {
  type: "pullquote";
  text: string;
  credit?: string;
}

export interface ListItem {
  blocks: RichBlock[];
  has_checkbox?: boolean;
  is_checked?: boolean;
  value?: string;
}

export interface ListBlock {
  type: "list";
  items: ListItem[];
}

export interface InputMediaPayload {
  type: string;
  media: string;
  [key: string]: unknown;
}

export interface PhotoBlock {
  type: "photo";
  photo: InputMediaPayload | string;
  caption?: { text: string };
  has_spoiler?: boolean;
}

export interface AudioBlock {
  type: "audio";
  audio: InputMediaPayload | string;
  caption?: { text: string };
}

export interface VideoBlock {
  type: "video";
  video: InputMediaPayload | string;
  caption?: { text: string };
  has_spoiler?: boolean;
}

export interface AnimationBlock {
  type: "animation";
  animation: InputMediaPayload | string;
  caption?: { text: string };
  has_spoiler?: boolean;
}

export interface VoiceNoteBlock {
  type: "voice_note";
  voice_note: InputMediaPayload | string;
  caption?: { text: string };
}

export type RichBlock =
  | HeadingBlock
  | ParagraphBlock
  | DividerBlock
  | TableBlock
  | DetailsBlock
  | PreBlock
  | BlockquoteBlock
  | PullquoteBlock
  | ListBlock
  | PhotoBlock
  | AudioBlock
  | VideoBlock
  | AnimationBlock
  | VoiceNoteBlock;

export interface RichMessageEnvelope {
  blocks: RichBlock[];
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
}

export interface RenderedRichResult {
  rich_message: string;
  blocks: RichBlock[];
}

/**
 * Fluent builder for Telegram Bot API 10.3 native Rich Messages.
 */
export class RichMessageBuilder {
  private readonly blocks: RichBlock[] = [];
  private isRtl = false;
  private skipEntityDetection = false;

  heading(size: HeadingSize, text: string): this {
    this.blocks.push({ type: "heading", size, text });
    return this;
  }

  paragraph(text: string): this {
    this.blocks.push({ type: "paragraph", text });
    return this;
  }

  divider(): this {
    this.blocks.push({ type: "divider" });
    return this;
  }

  table(cells: TableCell[][], opts?: { is_bordered?: boolean; is_striped?: boolean; caption?: string }): this {
    this.blocks.push({
      type: "table",
      cells,
      is_bordered: opts?.is_bordered ?? true,
      is_striped: opts?.is_striped ?? true,
      ...(opts?.caption ? { caption: opts.caption } : {}),
    });
    return this;
  }

  details(summary: string, blocks: RichBlock[], isOpen = false): this {
    this.blocks.push({
      type: "details",
      summary,
      blocks,
      is_open: isOpen,
    });
    return this;
  }

  pre(text: string, language?: string): this {
    this.blocks.push({
      type: "pre",
      text,
      ...(language ? { language } : {}),
    });
    return this;
  }

  blockquote(blocks: RichBlock[]): this {
    this.blocks.push({ type: "blockquote", blocks });
    return this;
  }

  pullquote(text: string, credit?: string): this {
    this.blocks.push({
      type: "pullquote",
      text,
      ...(credit ? { credit } : {}),
    });
    return this;
  }

  list(items: ListItem[]): this {
    this.blocks.push({ type: "list", items });
    return this;
  }

  checkList(items: Array<{ text: string; isChecked?: boolean }>): this {
    this.blocks.push({
      type: "list",
      items: items.map((it) => ({
        has_checkbox: true,
        is_checked: it.isChecked ?? false,
        blocks: [{ type: "paragraph", text: it.text }],
      })),
    });
    return this;
  }

  photo(mediaUrlOrId: string, captionText?: string, hasSpoiler = false): this {
    this.blocks.push({
      type: "photo",
      photo: { type: "photo", media: mediaUrlOrId },
      ...(captionText ? { caption: { text: captionText } } : {}),
      ...(hasSpoiler ? { has_spoiler: true } : {}),
    });
    return this;
  }

  audio(mediaUrlOrId: string, captionText?: string): this {
    this.blocks.push({
      type: "audio",
      audio: { type: "audio", media: mediaUrlOrId },
      ...(captionText ? { caption: { text: captionText } } : {}),
    });
    return this;
  }

  video(mediaUrlOrId: string, captionText?: string, hasSpoiler = false): this {
    this.blocks.push({
      type: "video",
      video: { type: "video", media: mediaUrlOrId },
      ...(captionText ? { caption: { text: captionText } } : {}),
      ...(hasSpoiler ? { has_spoiler: true } : {}),
    });
    return this;
  }

  rtl(isRtl = true): this {
    this.isRtl = isRtl;
    return this;
  }

  skipEntities(skip = true): this {
    this.skipEntityDetection = skip;
    return this;
  }

  getBlocks(): RichBlock[] {
    return [...this.blocks];
  }

  /** Builds the exact Bot API 10.3 serialized JSON payload. */
  build(): RenderedRichResult {
    const envelope: RichMessageEnvelope = {
      blocks: this.blocks,
      is_rtl: this.isRtl,
      skip_entity_detection: this.skipEntityDetection,
    };
    return {
      rich_message: JSON.stringify(envelope),
      blocks: this.blocks,
    };
  }

  /** Serializes blocks into clean, robust Markdown for fallback rendering. */
  toFallbackMarkdown(): string {
    return blocksToMarkdown(this.blocks);
  }
}

function blocksToMarkdown(blocks: RichBlock[]): string {
  const lines: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "heading": {
        const hashes = "#".repeat(Math.min(block.size, 3));
        lines.push(`${hashes} ${block.text}`, "");
        break;
      }
      case "paragraph":
        lines.push(block.text, "");
        break;
      case "divider":
        lines.push("---", "");
        break;
      case "table": {
        if (block.caption) lines.push(`*${block.caption}*`);
        for (const row of block.cells) {
          lines.push(row.map((c) => (c.is_header ? `*${c.text}*` : c.text)).join(" | "));
        }
        lines.push("");
        break;
      }
      case "details":
        lines.push(`▸ *${block.summary}*`);
        lines.push(blocksToMarkdown(block.blocks));
        break;
      case "pre":
        lines.push(`\`\`\`${block.language ?? ""}\n${block.text}\n\`\`\``, "");
        break;
      case "blockquote":
        lines.push(
          blocksToMarkdown(block.blocks)
            .split("\n")
            .map((l) => (l ? `> ${l}` : ">"))
            .join("\n"),
          "",
        );
        break;
      case "pullquote":
        lines.push(`> ❝ *${block.text}* ❞${block.credit ? `\n> — _${block.credit}_` : ""}`, "");
        break;
      case "list":
        for (const item of block.items) {
          const check = item.has_checkbox ? (item.is_checked ? "☑ " : "☐ ") : "• ";
          const childText = blocksToMarkdown(item.blocks).trim();
          lines.push(`${check}${childText}`);
        }
        lines.push("");
        break;
      case "photo":
      case "video":
      case "audio":
      case "animation":
      case "voice_note":
        if (block.caption?.text) {
          lines.push(`[${block.type.toUpperCase()}] ${block.caption.text}`, "");
        }
        break;
    }
  }

  return lines.join("\n").trim();
}
