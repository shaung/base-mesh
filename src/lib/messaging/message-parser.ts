import type { Part } from '../../lib/types.js';

/**
 * Parse a Feishu post message content into structured parts and text summary.
 * Iterates post paragraphs, extracting text and image elements.
 * Other tags (a, at) are intentionally skipped — their text falls through to summary.
 */
export function parsePostToParts(postContent: string): { parts: Part[]; textSummary: string } {
  try {
    const parsed = JSON.parse(postContent);
    const section = parsed.content ? parsed : (parsed.zh_cn ?? parsed.en_us ?? Object.values(parsed)[0]);
    if (!section?.content) return { parts: [], textSummary: '' };

    const parts: Part[] = [];
    const textFragments: string[] = [];

    for (const paragraph of section.content) {
      if (!Array.isArray(paragraph)) continue;
      for (const inline of paragraph) {
        if (!inline || typeof inline !== 'object') continue;
        if (inline.tag === 'text') {
          const text = String(inline.text ?? '');
          if (text) {
            parts.push({ kind: 'text', text });
            textFragments.push(text);
          }
        } else if (inline.tag === 'img') {
          const imageKey = String(inline.image_key ?? '');
          if (imageKey) {
            parts.push({
              kind: 'file',
              file_token: imageKey,
              file_uri: `/files/${imageKey}`,
              name: 'image.png',
              mime_type: 'image/png',
            });
            textFragments.push('[image]');
          }
        }
      }
    }

    const textSummary = textFragments.join(' ').trim();
    return { parts, textSummary };
  } catch (e) {
    return { parts: [], textSummary: '' };
  }
}
