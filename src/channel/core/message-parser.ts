// ---------------------------------------------------------------------------
// Message parser — Lark IM message parsing for all deployment targets
//
// Converts Feishu/Lark message types (text, post, interactive) to plain text
// or markdown. Shared by both Node.js and Worker deployments.
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a Lark IM message event object.
 * Handles text, post (rich text), and interactive (card) message types.
 */
export function parseMessageToText(msg: Record<string, unknown>): string {
  const msgType = String(msg.message_type ?? '');
  const rawContent = String(msg.content ?? '');
  return parseMessageContent(msgType, rawContent);
}

/**
 * Parse a Feishu message body.content string into readable text/markdown,
 * handling text, post, and interactive (card) message types.
 */
export function parseMessageContent(msgType: string, content: string): string {
  if (msgType === 'text') {
    try {
      const parsed = JSON.parse(content);
      return (parsed.text ?? content).replace(/@_user_\d+/g, '').trim();
    } catch {
      return content.replace(/@_user_\d+/g, '').trim();
    }
  }

  if (msgType === 'post') {
    try { return extractPostText(JSON.parse(content)); } catch { return ''; }
  }

  if (msgType === 'interactive') {
    try { return extractCardText(JSON.parse(content)); } catch { return ''; }
  }

  return '';
}

// =============================================================================
// Post (rich text) message parsing
// =============================================================================

/**
 * Convert Feishu post (rich text) message content to Markdown.
 *
 * Post structure (standard format):
 *   { title, content: [[{tag, text, ...}, ...], ...] }
 * Or wrapped in language key:
 *   { zh_cn: { title, content: [[...]] } }
 *
 * Each outer array element is one paragraph. Inline elements: text, a (link),
 * at (mention), img.
 *
 * Reference: https://open.feishu.cn/document/ukTMukTMukTM/uMDMxEjLzATMx4yMwETM
 */
function extractPostText(data: Record<string, any>): string {
  // Resolve language wrapper if present
  const section = data.content ? data : (data.zh_cn ?? data.en_us ?? Object.values(data)[0]);
  if (!section?.content) return '';

  const lines: string[] = [];

  for (const paragraph of section.content) {
    if (!Array.isArray(paragraph) || paragraph.length === 0) {
      lines.push('');
      continue;
    }

    const parts = paragraph.map((inline: any) => convertInline(inline));
    lines.push(parts.filter(Boolean).join('\n'));
  }

  return lines.join('\n\n').trim();
}

/** Convert a single post inline element to Markdown text. */
function convertInline(inline: Record<string, any>): string {
  const tag = inline.tag;

  if (tag === 'text') {
    let text = inline.text ?? '';
    const styles: string[] = inline.style ?? [];
    if (styles.includes('bold')) text = `**${text}**`;
    if (styles.includes('italic')) text = `*${text}*`;
    if (styles.includes('code')) text = `\`${text}\``;
    if (styles.includes('strikethrough')) text = `~~${text}~~`;
    return text;
  }

  if (tag === 'a') {
    const href = inline.href ?? '';
    const text = inline.text ?? href;
    return href ? `[${text}](${href})` : text;
  }

  if (tag === 'at') {
    const name = inline.user_name ?? '';
    return name ? `@${name}` : '@user';
  }

  if (tag === 'img') {
    return inline.image_key ? `![image](${inline.image_key})` : '';
  }

  return '';
}

// =============================================================================
// Interactive (card) message parsing
// =============================================================================

/**
 * Extract plain text/markdown from Feishu interactive (card) message content.
 *
 * JSON 2.0: { body: { elements: [{ tag: "markdown", content: "..." }] } }
 * Legacy:   { elements: [{ tag: "div", text: { tag: "lark_md", content } }] }
 * Rich-text component (tag: "rich_text"): { elements: [{ tag: "text_run", text: "..." }] }
 */
function extractCardText(data: Record<string, any>): string {
  // Locate the elements array — differs between JSON 2.0 and legacy format
  const elements: any[] = data.body?.elements ?? data.elements ?? [];
  if (elements.length === 0) return '';

  const parts: string[] = [];

  for (const el of elements) {
    if (el.tag === 'markdown') {
      if (el.content) parts.push(el.content);
    } else if (el.tag === 'div' && el.text) {
      if (el.text.content) parts.push(el.text.content);
    } else if (el.tag === 'rich_text' && el.elements) {
      let line = '';
      for (const re of el.elements) {
        line += convertRichTextElement(re);
      }
      if (line) parts.push(line);
    } else if (el.tag === 'note' && el.elements) {
      let line = '';
      for (const ne of el.elements) line += convertRichTextElement(ne);
      if (line) parts.push(line);
    } else if (el.tag === 'hr') {
      parts.push('---');
    }
  }

  return parts.join('\n\n').trim();
}

/** Convert a single rich-text element (card component) to markdown. */
function convertRichTextElement(el: Record<string, any>): string {
  if (el.tag === 'text_run') {
    let text = el.text ?? '';
    const style = el.text_element_style ?? {};
    if (style.bold) text = `**${text}**`;
    if (style.italic) text = `*${text}*`;
    if (style.strikethrough) text = `~~${text}~~`;
    if (style.code) text = `\`${text}\``;
    if (style.underline) text = `<u>${text}</u>`;
    return text;
  }

  if (el.tag === 'link') {
    const url = el.url ?? '';
    const text = el.text ?? url;
    return url ? `[${text}](${url})` : text;
  }

  if (el.tag === 'mention') {
    return `@${el.user_name ?? el.user_id ?? 'user'}`;
  }

  if (el.tag === 'emoji') {
    return el.emoji ?? '';
  }

  return '';
}
