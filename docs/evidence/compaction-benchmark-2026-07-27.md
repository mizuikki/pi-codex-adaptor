# Remote Compaction Benchmark

Date: 2026-07-27

Command:

```sh
bun scripts/benchmark-compaction.ts
```

The benchmark generated a synthetic active branch with 10,000 entries and 49.995 MiB of JSONL.
Entries contain placeholders only; the checkpoint output and identity are test values.

Seven measured iterations produced these milliseconds:

| Operation | p50 | p95 |
| --- | ---: | ---: |
| Canonical projection | 51.115 | 82.294 |
| Checkpoint scan | 0.137 | 0.321 |
| Suffix projection | 21.869 | 29.298 |
| Before-provider-payload preparation | 22.357 | 30.774 |

The benchmark measures the active-branch projection, one O(path) checkpoint scan, suffix projection,
and the combined provider-hook preparation. It does not read a real session or persist opaque data.
