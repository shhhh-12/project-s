import { describe, expect, it } from 'vitest';
import { audioFormat, encodeWav, planChunks, toBase64 } from './audio';

describe('audio helpers', () => {
  it('plans 60 second parts', () => {
    expect(planChunks(150)).toEqual([[0, 60], [60, 120], [120, 150]]);
    expect(planChunks(0)).toEqual([]);
  });
  it('writes a valid 16-bit mono WAV header', () => {
    const wav = new DataView(encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 16000));
    const tag = (o: number) => String.fromCharCode(wav.getUint8(o), wav.getUint8(o + 1), wav.getUint8(o + 2), wav.getUint8(o + 3));
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(wav.getUint32(24, true)).toBe(16000);
    expect(wav.getUint32(40, true)).toBe(8);
    expect(wav.byteLength).toBe(52);
  });
  it('base64-encodes large buffers', () => {
    const bytes = new Uint8Array(200_000).fill(65);
    expect(atob(toBase64(bytes)).length).toBe(200_000);
  });
  it('detects the upload format from name, then mime type', () => {
    expect(audioFormat({ name: 'Call 1.M4A', type: '' })).toBe('m4a');
    expect(audioFormat({ name: 'recording', type: 'audio/mpeg' })).toBe('mp3');
    expect(audioFormat({ name: 'x.opus', type: '' })).toBe('ogg');
  });
});
