// H-112 — broadcast audio cache: PURE helper tests (no DB). The DB
// integration suite (cache pass, eviction, route) lives in tests/db/db.test.ts
// — DB suites must stay in that single file so the shared-table TRUNCATEs
// never race between parallel workers (see the note at the top of db.test.ts).

import { describe, expect, it } from "vitest";
import {
  cacheFileName,
  parseByteRange,
  sniffAudioType,
  trackIdFromFileName,
} from "@/server/broadcast/audio-cache";

describe("audio-cache pure helpers (H-112)", () => {
  it("cacheFileName derives from track id + hash only, roundtrips through trackIdFromFileName", () => {
    const id = "c1234567890123456789012345";
    const name = cacheFileName(id, "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899");
    expect(name).toBe("c1234567890123456789012345.aabbccddeeff.cache");
    expect(trackIdFromFileName(name)).toBe(id);
    expect(trackIdFromFileName("notes.txt")).toBeNull();
    expect(trackIdFromFileName(".hidden.cache")).toBeNull();
  });

  it("sniffAudioType uses a fixed allowlist decided from the file's bytes", () => {
    const mp3id3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0]);
    const mp3sync = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0]);
    const m4a = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
    expect(sniffAudioType(mp3id3)).toBe("audio/mpeg");
    expect(sniffAudioType(mp3sync)).toBe("audio/mpeg");
    expect(sniffAudioType(wav)).toBe("audio/wav");
    expect(sniffAudioType(ogg)).toBe("audio/ogg");
    expect(sniffAudioType(m4a)).toBe("audio/mp4");
    expect(sniffAudioType(new Uint8Array([1, 2, 3, 4]))).toBe("application/octet-stream");
    expect(sniffAudioType(new Uint8Array())).toBe("application/octet-stream");
  });

  it("parseByteRange: a-b, a-, -n, full, and every refusal shape", () => {
    const size = 1000;
    expect(parseByteRange(null, size)).toEqual({ kind: "full" });
    expect(parseByteRange("bytes=0-99", size)).toEqual({ kind: "range", start: 0, end: 99 });
    expect(parseByteRange("bytes=100-", size)).toEqual({ kind: "range", start: 100, end: 999 });
    expect(parseByteRange("bytes=-100", size)).toEqual({ kind: "range", start: 900, end: 999 });
    // suffix longer than the file → whole file
    expect(parseByteRange("bytes=-5000", size)).toEqual({ kind: "range", start: 0, end: 999 });
    // end beyond size is clamped
    expect(parseByteRange("bytes=900-5000", size)).toEqual({ kind: "range", start: 900, end: 999 });
    // refusals → unsatisfiable (416)
    for (const bad of ["bytes=", "bytes=500-400", "bytes=1000-", "bytes=-0", "bytes=0-9,20-29", "bytes=abc", "chunks=0-1", "bytes=0-1,", ""]) {
      expect(parseByteRange(bad, size)).toEqual({ kind: "unsatisfiable" });
    }
    expect(parseByteRange("bytes=0-99", 0)).toEqual({ kind: "unsatisfiable" });
  });
});
