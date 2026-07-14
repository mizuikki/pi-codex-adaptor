# Repository Instructions

## Scope and architecture

- Keep all project text, source, tests, commits, and release notes in English.
- Preserve the dependency direction documented in `docs/architecture.md`.
- Pi-specific types belong in `src/integration/pi` and UI code. Domain and application code must not
  import Pi, terminal UI, filesystem, HTTP, or native process implementations.
- TypeScript communicates with the native bridge only through the versioned JSONL bridge protocol.
  Do not implement Responses, SSE, WebSocket, retry, compaction wire behavior, PTY, or patch execution
  in TypeScript.
- Treat this repository as an independent product. Derive Codex behavior only from the pinned
  official baseline and the product contract.
- Do not add account usage, rate-limit, reset-credit, or app-server agent lifecycle features.

## Upstream source

- OpenAI Codex is pinned by `UPSTREAM_CODEX.toml`. Vendor work must use the peeled source commit, not
  a moving branch or a local checkout.
- Keep project glue outside `native/vendor/openai-codex`.
- Every vendor change must update the allowlist, source hashes, tree hash, license inventory, and
  replayable patch list together.

## Changes and releases

- Use Conventional Commits for commit and pull request titles.
- Human pull requests require exactly one of `release:major`, `release:minor`, `release:patch`, or
  `release:none`, and the label must agree with the title.
- Use Release Please to update `package.json`, `.release-please-manifest.json`, and `CHANGELOG.md`.
  Do not edit versions manually and do not add Changesets.
- Release Please creates release pull requests only. It must not tag, create GitHub releases, or
  publish npm packages.
- Assemble and verify one tarball. Publish that exact tarball, then create its Git tag and GitHub
  release only after npm succeeds.
- Pin third-party GitHub Actions by full commit SHA.

## Verification

- Run `bun run check` for source changes.
- Run focused tests while developing and scale verification to the affected boundary.
- Never place credentials, user paths, account data, prompts, or real compaction payloads in fixtures,
  logs, snapshots, diagnostics, or errors.
