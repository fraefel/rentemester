# Changelog

Alle væsentlige ændringer i Rentemester dokumenteres her. Formatet følger
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), og produktversioner
følger [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Plads til ændringer, der endnu ikke indgår i en godkendt release.

## [0.1.0] - 2026-07-19

### Added

- Første kanoniske SemVer på tværs af CLI, MCP, HTTP API og cockpit.
- Build-identitet med Git-commit og deterministisk buildtid i release-images.
- Checksummet schema-baseline med afvisning af databaser fra nyere software.
- Deterministisk SHA-256-identitet for regler og juridiske kildefiler.
- Versions- og regelproveniens i backups, myndighedseksport og SAF-T-eksport.
- Multi-stage, non-root Docker-image med cockpit, runtime, regler og kilder.
- To-trins GHCR-releaseflow: kandidatimage og digest-bundet Digisense-promovering.
- Selvstændig CI for det separate `www`-site.

### Changed

- CI bruger den fastlåste Bun-version 1.3.14 i stedet for `latest`.
- Docker Compose-eksemplet kræver et eksplicit digest-pinnet image og bruger
  aldrig `latest`.

[Unreleased]: https://github.com/mikkelkrogsholm/rentemester/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mikkelkrogsholm/rentemester/releases/tag/v0.1.0
