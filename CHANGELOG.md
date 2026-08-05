# Changelog

All notable changes to this project will be documented in this file.

This project uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
and Release Please. The repository skeleton is version `0.0.0`; the first prerelease will be
`0.1.0-rc.0`.

## [Unreleased]

### Changed

- Pin blocking CI to Pi extension SDK tag `pi-extension-sdk-v1.3.1` (private fork product `0.83.0-local.1`; ABI remains v1). Stock/public fail-closed smoke still uses unsupported npm `0.82.1`.
- Adapt Codex lifecycle terminal states and reject custom fetch before native dispatch on the Pi 0.83.0 host.
