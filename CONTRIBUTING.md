# Contributing to QuietClaw

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Development Setup

```bash
git clone https://github.com/laszlokorsos/quietclaw.git
cd quietclaw
pnpm install
pnpm run build:native    # Build the Core Audio native addon
pnpm run dev             # Start in dev mode with hot reload
```

**Prerequisites:** Node.js 20+, pnpm, Python 3 (for node-gyp), macOS 13+

## Running Tests

```bash
pnpm test                # Run all tests
npx tsc --noEmit         # Type check
```

## Project Structure

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation, including how to add new STT providers, summarizers, calendar integrations, and audio capture platforms.

## Making Changes

1. **Fork the repo** and create a feature branch from `main`
2. **Make your changes** — keep commits focused and well-described
3. **Run tests and type check** before pushing
4. **Open a pull request** against `main`

### Code Style

- TypeScript strict mode — no `any`
- Functional React components with Tailwind for styling
- Use `electron-log` for structured logging
- Secrets go through `safeStorage`, never in config files or code
- Keep the native addon surface minimal — only audio capture

### What Makes a Good PR

- Focused on a single change (bug fix, feature, refactor — not all three)
- Tests pass, types check
- No unrelated formatting changes
- Clear description of what and why

## Reporting Issues

- **Bugs:** Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md)
- **Features:** Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md)
- **Security:** See [SECURITY.md](SECURITY.md) — do not open a public issue

## License

By contributing, you agree that your contributions will be licensed under the [Apache 2.0 License](LICENSE).
