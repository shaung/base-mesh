// ---------------------------------------------------------------------------
// Lark WebSocket binary protocol — protobuf Frame decoder
//
// The Lark event service uses a protobuf-based binary protocol
// (pbbp2.Frame / pbbp2.Header). This module provides a lightweight
// decoder so the Worker can process events without the full SDK.
//
// Wire format reference: https://protobuf.dev/programming-guides/encoding/
// ---------------------------------------------------------------------------

// ---- Frame types -----------------------------------------------------------

export const FRAME_CONTROL = 0;
export const FRAME_DATA = 1;

export const HEADER_TYPE = 'type';
export const HEADER_MESSAGE_ID = 'message_id';
export const HEADER_SUM = 'sum';
export const HEADER_SEQ = 'seq';

// ---- Header -----------------------------------------------------------------

export interface DecodedHeader {
  key: string;
  value: string;
}

// ---- Frame ------------------------------------------------------------------

export interface DecodedFrame {
  seqId: bigint;
  logId: bigint;
  service: number;
  method: number;        // 0=control, 1=data
  headers: DecodedHeader[];
  payloadEncoding: string;
  payloadType: string;
  payload: Uint8Array;
  logIdNew: string;
}

// ---- Protobuf wire format reader --------------------------------------------

class PbReader {
  private view: DataView;
  private pos = 0;

  constructor(buf: ArrayBuffer) {
    this.view = new DataView(buf);
  }

  /** Read a varint (up to 10 bytes). */
  varint(): bigint {
    let result = 0n;
    let shift = 0;
    while (true) {
      const byte = this.view.getUint8(this.pos++);
      result |= BigInt(byte & 0x7f) << BigInt(shift);
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) throw new Error('varint too long');
    }
  }

  /** Read a varint as number (safe for values < 2^31). */
  varint32(): number {
    return Number(this.varint());
  }

  /** Skip length-delimited bytes and return them. */
  bytes(): Uint8Array {
    const len = this.varint32();
    const start = this.pos;
    this.pos += len;
    return new Uint8Array(this.view.buffer, this.view.byteOffset + start, len);
  }

  /** Read a length-delimited string. */
  string(): string {
    return new TextDecoder().decode(this.bytes());
  }

  /** Check if we've reached the end of the message. */
  get done(): boolean {
    return this.pos >= this.view.byteLength;
  }

  /** Peek at the next tag without consuming it. Returns 0 if done. */
  peekTag(): number {
    if (this.done) return 0;
    // Save position, read tag, restore
    const saved = this.pos;
    const tag = this.varint32();
    this.pos = saved;
    return tag;
  }
}

// ---- Decoder ----------------------------------------------------------------

/** Decode a protobuf-encoded Lark event Frame from binary data. */
export function decodeFrame(buffer: ArrayBuffer): DecodedFrame {
  const reader = new PbReader(buffer);

  const frame: DecodedFrame = {
    seqId: 0n,
    logId: 0n,
    service: 0,
    method: 0,
    headers: [],
    payloadEncoding: '',
    payloadType: '',
    payload: new Uint8Array(0),
    logIdNew: '',
  };

  while (!reader.done) {
    const tag = reader.varint32();
    const field = tag >>> 3;    // field number (upper 5 bits)
    const wireType = tag & 0x07; // wire type (lower 3 bits)

    switch (field) {
      case 1: // SeqID (uint64, wireType 0 = varint)
        frame.seqId = reader.varint();
        break;
      case 2: // LogID (uint64, wireType 0)
        frame.logId = reader.varint();
        break;
      case 3: // service (int32, wireType 0)
        frame.service = reader.varint32();
        break;
      case 4: // method (int32, wireType 0)
        frame.method = reader.varint32();
        break;
      case 5: { // headers (repeated Header, wireType 2 = length-delimited)
        const headerBuf = reader.bytes();
        frame.headers.push(decodeHeader(headerBuf.buffer as ArrayBuffer));
        break;
      }
      case 6: // payloadEncoding (string, wireType 2)
        frame.payloadEncoding = reader.string();
        break;
      case 7: // payloadType (string, wireType 2)
        frame.payloadType = reader.string();
        break;
      case 8: // payload (bytes, wireType 2)
        frame.payload = reader.bytes();
        break;
      case 9: // LogIDNew (string, wireType 2)
        frame.logIdNew = reader.string();
        break;
      default:
        // Skip unknown fields
        switch (wireType) {
          case 0: reader.varint(); break;
          case 2: reader.bytes(); break;
          default: throw new Error(`unsupported wire type ${wireType} for field ${field}`);
        }
    }
  }

  return frame;
}

/** Decode a protobuf-encoded Header embedded message. */
function decodeHeader(buffer: ArrayBuffer): DecodedHeader {
  const reader = new PbReader(buffer);
  const header: DecodedHeader = { key: '', value: '' };

  while (!reader.done) {
    const tag = reader.varint32();
    const field = tag >>> 3;

    switch (field) {
      case 1: // key (string, wireType 2)
        header.key = reader.string();
        break;
      case 2: // value (string, wireType 2)
        header.value = reader.string();
        break;
      default:
        // Skip unknown
        if ((tag & 0x07) === 2) reader.bytes();
        else reader.varint();
    }
  }

  return header;
}

/** Build a short hex dump for debugging. */
export function hexDump(buf: ArrayBuffer, maxLen = 32): string {
  const bytes = new Uint8Array(buf, 0, Math.min(buf.byteLength, maxLen));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}
