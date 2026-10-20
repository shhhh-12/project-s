// Browser-side audio preparation.
// OpenRouter's speech-to-text providers time out after ~60 s per request and differ in the formats they accept,
// so we decode the upload, convert it to 16 kHz mono WAV and cut it into 60-second parts.
// If the browser cannot decode the file, we fall back to sending the original file as one part.

export const CHUNK_SECONDS = 60;
const TARGET_RATE = 16000;

export type AudioChunk = { data: string; format: string; start: number; end: number };
export type PreparedAudio = { chunks: AudioChunk[]; duration: number; converted: boolean };

const FORMATS: Record<string, string> = {
  mp3: 'mp3', mpeg: 'mp3', mpga: 'mp3',
  wav: 'wav', wave: 'wav', 'x-wav': 'wav',
  m4a: 'm4a', mp4: 'm4a', 'x-m4a': 'm4a',
  aac: 'aac',
  ogg: 'ogg', oga: 'ogg', opus: 'ogg',
  webm: 'webm',
  flac: 'flac',
};

export function audioFormat(file: { name: string; type: string }) {
  const ext = file.name.includes('.') ? (file.name.split('.').pop() ?? '').toLowerCase() : '';
  if (FORMATS[ext]) return FORMATS[ext];
  const sub = file.type.split('/')[1]?.toLowerCase();
  return (sub && FORMATS[sub]) || 'wav';
}

export function planChunks(duration: number, size = CHUNK_SECONDS): Array<[number, number]> {
  if (!(duration > 0)) return [];
  const parts: Array<[number, number]> = [];
  for (let start = 0; start < duration; start += size) parts.push([start, Math.min(duration, start + size)]);
  return parts;
}

export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

export function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read this audio file.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(blob);
  });
}

function mediaDuration(file: Blob) {
  return new Promise<number>((resolve) => {
    if (typeof Audio === 'undefined') return resolve(0);
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (value: number) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(value) ? value : 0);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(audio.duration);
    audio.onerror = () => done(0);
    window.setTimeout(() => done(0), 5000);
    audio.src = url;
  });
}

async function decodeToMono16k(file: Blob) {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new Ctx();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * TARGET_RATE)), TARGET_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return { samples: rendered.getChannelData(0).slice(), duration: decoded.duration };
  } finally {
    void context.close().catch(() => undefined);
  }
}

const aborted = () => new DOMException('The analysis was cancelled.', 'AbortError');

export async function prepareAudio(file: File, signal?: AbortSignal): Promise<PreparedAudio> {
  try {
    const { samples, duration } = await decodeToMono16k(file);
    const chunks: AudioChunk[] = [];
    for (const [start, end] of planChunks(duration)) {
      if (signal?.aborted) throw aborted();
      const slice = samples.subarray(Math.floor(start * TARGET_RATE), Math.min(samples.length, Math.ceil(end * TARGET_RATE)));
      if (slice.length < TARGET_RATE / 5) continue; // ignore a tail shorter than 0.2 s
      chunks.push({ data: toBase64(new Uint8Array(encodeWav(slice, TARGET_RATE))), format: 'wav', start, end });
    }
    if (!chunks.length) throw new Error('empty audio');
    return { chunks, duration, converted: true };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const duration = await mediaDuration(file);
    return {
      chunks: [{ data: await blobToBase64(file), format: audioFormat(file), start: 0, end: duration }],
      duration,
      converted: false,
    };
  }
}
