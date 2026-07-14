# Upstream Synchronization

`UPSTREAM_CODEX.toml` is the authoritative upstream identity. Synchronization must fetch the immutable
peeled commit from `https://github.com/openai/codex`, extract only recorded paths, verify every source
hash and license, apply recorded patches, and reproduce the stored vendor tree hash.

The `0.0.0` skeleton contains no vendored Codex source. Its empty-tree hash is intentional and the
manifest status is `pending`. The first vendor import must add the dependency graph, file allowlist,
SBOM, source hashes, patch list, and generated protocol/tool fixtures in one reviewed change.

An upstream baseline change is always a dedicated pull request. It must update source identity, Rust
toolchain, official conformance packages, Cargo dependency set, schemas, fixtures, licenses,
conformance results, and binary size measurements together. Dependency automation must not update any
part of this coupled set independently.
