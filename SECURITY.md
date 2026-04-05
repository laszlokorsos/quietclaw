# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report security issues by emailing **security@quietclaw.dev** with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## What to Expect

- **Acknowledgment** within 48 hours
- **Assessment** within 1 week
- **Fix or mitigation** as quickly as possible, depending on severity
- Credit in the release notes (unless you prefer to remain anonymous)

## Scope

QuietClaw handles sensitive data (meeting audio, transcripts, API keys). We take the following areas especially seriously:

- **API key exposure** — keys stored via `safeStorage` should never leak to logs, config files, or IPC
- **Local API authentication** — the localhost API should not be accessible to unauthorized processes
- **Audio data privacy** — recordings and transcripts should only be accessible to the local user
- **Native addon safety** — the Core Audio Taps addon runs with elevated audio permissions

## Responsible Disclosure

We ask that you give us reasonable time to address vulnerabilities before public disclosure. We commit to transparent communication throughout the process.
