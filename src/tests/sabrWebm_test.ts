import { assert, assertEquals } from "./deps.ts";
import {
    EbmlCursor,
    findFirstClusterOffset,
    parseWebmInit,
} from "../lib/sabr/ebml.ts";

// The init portion (EBML header, SeekHead, Info, Tracks, Cues — everything
// before the first Cluster) of a real SABR VP9 pull: aqz-KE-bpKQ itag 242.
const INIT_B64 =
    "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZxCbnN0RTZt0qk27i1OrhBVJqWZTrIEvTbuLU6uEFlSua1Os" +
    "gWpNu4tTq4QcU7trU6yBrxVJqWa2Ktexgw9CQESJhEka7HBNgJFnb29nbGUvdmlkZW8tZmlsZVdBkWdvb2dsZS92aWRlby1maWxl" +
    "FlSua8CuvteBAXPFh4Qk/rz2o3uDgQGcgQAj44OEAfygVYaFVl9WUDngmrCCAaq6gfBVsJBVsYEBVbmBAVW6gQFVu4EBHFO7a0gb" +
    "u4yzgQC3h/eBAfGCCNC7jbOCD8G3h/eBAfGCYRa7jrOCIK+3iPeBAfGDAVa+u46zgjOxt4j3gQHxgwMLMbuOs4JOpbeI94EB8YME" +
    "KMy7jrOCXy+3iPeBAfGDBReJu46zgmspt4j3gQHxgwXG0ruOs4KGgbeI94EB8YMGxSy7jrOCoRG3iPeBAfGDB8nau46zgrvDt4j3" +
    "gQHxgwjLKruOs4LLhLeI94EB8YMKDpS7jrOC5ty3iPeBAfGDCxMAu46zgvL4t4j3gQHxgwwaiLuPs4MBCmi3iPeBAfGDDR/gu4+z" +
    "gwEar7eI94EB8YMOxtW7j7ODASe0t4j3gQHxgw/bv7uPs4MBNge3iPeBAfGDERhFu4+zgwFJj7eI94EB8YMTFoG7j7ODAWTFt4j3" +
    "gQHxgxQLibuPs4MBdji3iPeBAfGDFS1/u4+zgwGLDbeI94EB8YMWDUa7j7ODAZbFt4j3gQHxgxamaruPs4MBpwy3iPeBAfGDF9SL" +
    "u4+zgwG74beI94EB8YMZS3i7j7ODAceZt4j3gQHxgxovSLuPs4MB3f+3iPeBAfGDG9c8u4+zgwHze7eI94EB8YMdpti7j7ODAgDD" +
    "t4j3gQHxgx5ppbuPs4MCHBu3iPeBAfGDH2nbu4+zgwIxl7eI94EB8YMhFZe7j7ODAkHdt4j3gQHxgyLG/buPs4MCV5y3iPeBAfGD" +
    "JAk1u4+zgwJykLeI94EB8YMlEKS7j7ODAosst4j3gQHxgyY63buPs4MCmom3iPeBAfGDJ62mu4+zgwKnj7eI94EB8YMo4j+7j7OD" +
    "AsE1t4j3gQHxgyoAg7uPs4MC0kS3iPeBAfGDK5sHu4+zgwLnn7eI94EB8YMtcce7j7ODAvTFt4j3gQHxgy7ZrLuPs4MDDzS3iPeB" +
    "AfGDL+fXu4+zgwMdybeI94EB8YMwwcK7j7ODAzWdt4j3gQHxgzHcwLuPs4MDS+G3iPeBAfGDM5lmu4+zgwNb5beI94EB8YM1Qlm7" +
    "j7ODA26Et4j3gQHxgzaxHbuPs4MDhQu3iPeBAfGDOCDOu4+zgwOdQ7eI94EB8YM5YH67j7ODA62Jt4j3gQHxgzov3ruPs4MDwqG3" +
    "iPeBAfGDOvq5u4+zgwPd2LeI94EB8YM8Il27j7ODA+mQt4j3gQHxgz0sHLuPs4MEA5u3iPeBAfGDPlXKu4+zgwQaZLeI94EB8YM/" +
    "7qe7j7ODBDEtt4j3gQHxg0E12ruPs4MERy+3iPeBAfGDQvlCu4+zgwRVxLeI94EB8YNElw67j7ODBGlMt4j3gQHxg0XTAruPs4ME" +
    "eZO3iPeBAfGDRpGsu4+zgwSGmLeI94EB8YNHQNa7j7ODBKGMt4j3gQHxg0hfc7uPs4MEuWC3iPeBAfGDSakGu4+zgwTFnbeI94EB" +
    "8YNLBp27j7ODBN1xt4j3gQHxg0zIy7uPs4ME8BC3iPeBAfGDTsfcu4+zgwUBpLeI94EB8YNQjLi7j7ODBRz8t4j3gQHxg1GYb7uP" +
    "s4MFKy23iPeBAfGDUxFdu4+zgwVAZ7eI94EB8YNUSdK7j7ODBVpQt4j3gQHxg1V0CLuPs4MFdai3iPeBAfGDVnUvu4+zgwWHXbeI" +
    "94EB8YNYWEi7j7ODBaIPt4j3gQHxg1l8q7uPs4MFu1G3iPeBAfGDWvTRu4+zgwXLd7eI94EB8YNb9J67j7ODBeIft4j3gQHxg11s" +
    "x7uPs4MF/Ai3iPeBAfGDXhx8u4+zgwYOZLeI94EB8YNfR+W7j7ODBient4j3gQHxg2BmULuPs4MGPUS3iPeBAfGDYcfqu4+zgwZU" +
    "cbeI94EB8YNjDTi7j7ODBmq1t4j3gQHxg2SlQ7uPs4MGefG3iPeBAfGDZgTku4+zgwaKvbeI94EB8YNnzZC7j7ODBp4kt4j3gQHx" +
    "g2nNN7uPs4MGr1S3iPeBAfGDa5oju4+zgwbKSLeI94EB8YNssqG7j7ODBtqPt4j3gQHxg25mXLuPs4MG9ee3iPeBAfGDb21Xu4+z" +
    "gwcPbLeI94EB8YNwpqm7j7ODBx1bt4j3gQHxg3F9M7uPs4MHLou3iPeBAfGDc28Iu4+zgwdIU7eI94EB8YN0chG7j7ODB2Ort4j3" +
    "gQHxg3VqlbuPs4MHcym3iPeBAfGDdghWu4+zgweOgbeI94EB8YN3CQS7j7ODB504t4j3gQHxg3fEqbuPs4MHrX+3iPeBAfGDeGLw" +
    "u4+zgwe9xbeI94EB8YN5u+i7j7ODB84Mt4j3gQHxg3tmiLuPs4MH3lO3iPeBAfGDfRlPu4+zgwf0EbeI94EB8YN+zpO7j7ODCAKn" +
    "t4j3gQHxg4Bm67uPs4MIEHS3iPeBAfGDgesMu4+zgwgfbbeI94EB8YODe+W7j7ODCC7st4j3gQHxg4UR27uPs4MIP/u3iPeBAfGD" +
    "huY0u4+zgwhbU7eI94EB8YOH3NG7j7ODCHart4j3gQHxg4j2YbuPs4MIkVy3iPeBAfGDitTKu4+zgwiho7eI94EB8YOMeTm7j7OD" +
    "CLx1t4j3gQHxg42YHLuPs4MI0ne3iPeBAfGDj0Fqu4+zgwjivbeI94EB8YORAaK7j7ODCPMEt4j3gQHxg5K6KbuPs4MJDly3iPeB" +
    "AfGDk6MLu4+zgwkj2LeI94EB8YOVrra7j7ODCT8wt4j3gQHxg5a3T7uPs4MJVKy3iPeBAfGDmCi3u4+zgwlk87eI94EB8YOYb/27" +
    "j7ODCXDtt4j3gQHxg5jBRLuPs4MJjEW3iPeBAfGDmZQfu4+zgwmc8LeI94EB8YOabqc=" +
    "";
const init = () => Uint8Array.from(atob(INIT_B64), (ch) => ch.charCodeAt(0));

Deno.test("parseWebmInit reads the Segment's Cues, past the EBML header", () => {
    const idx = parseWebmInit(init())!;
    assert(idx, "parsed");
    assertEquals(idx.timescale, 1000);
    assertEquals(idx.trackNumber, 1);
    assertEquals(idx.durations.length, 123);
    assertEquals(idx.starts.slice(0, 4), [0, 4033, 8367, 13233]);
    assertEquals(idx.durations.slice(0, 3), [4033, 4334, 4866]);
    // Consecutive Segment-relative cluster positions (verified on the wire:
    // the second cue's Cluster is at file offset 24898 = 2300 + 22598).
    assertEquals(idx.sizes[0], 22598);
    assertEquals(idx.init.length, 2300);
    // Timeline covers Info.Duration.
    const last = idx.starts.length - 1;
    assertEquals(idx.starts[last] + idx.durations[last], 634567);
});

Deno.test("findFirstClusterOffset spots a Cluster before its body arrives", () => {
    const head = init();
    const data = new Uint8Array(head.length + 6);
    data.set(head);
    data.set([0x1f, 0x43, 0xb6, 0x75, 0x84, 0x00], head.length);
    assertEquals(findFirstClusterOffset(data), head.length);
    assertEquals(findFirstClusterOffset(head), null);
});

Deno.test("an unknown-size Segment runs to the end of the data", () => {
    const data = init();
    // Segment at 36: 4-byte id, then a 4-byte size (10 9b 9c dd) -> all
    // value bits set, i.e. unknown (a streamed Segment).
    data.set([0x1f, 0xff, 0xff, 0xff], 40);
    assertEquals(new EbmlCursor(data).element(36), null);
    assert(new EbmlCursor(data).element(36, true)?.unknown);
    const idx = parseWebmInit(data)!;
    assertEquals(idx.durations.length, 123);
});

Deno.test("8-byte size VINTs don't overflow 32-bit math", () => {
    const c = new EbmlCursor(
        Uint8Array.from([0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x05]),
    );
    assertEquals(c.size(0), { value: 2 ** 32 + 5, length: 8, unknown: false });
});
