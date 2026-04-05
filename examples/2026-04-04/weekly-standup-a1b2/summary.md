---
type: "meeting-summary"
date: "2026-04-04"
title: "Weekly Standup"
participants: ["Laszlo Korsos", "Speaker A", "Speaker B"]
platform: google-meet
duration: 24m
summarized: true
---

# Summary — Weekly Standup

## Executive Summary
Weekly standup covering API rate limiting completion, onboarding redesign progress, and a password reset token expiry bug. The team coordinated on potential overlap between mail queue latency and webhook delivery, and aligned on PR review timelines.

## Topics
### API Rate Limiting
*Participants: Speaker A, [[Laszlo Korsos]]*

Rate limiting is deployed to staging, handling 500 req/s under load tests. Next step is webhook retry logic with exponential backoff and jitter, max 5 retries over 24 hours.

### Onboarding Redesign
*Participants: Speaker B, [[Laszlo Korsos]]*

New onboarding flow nearly complete, pending email verification wiring. A bug was found in the password reset flow where tokens expire before emails arrive due to mail queue latency.

### Password Reset Token Expiry
*Participants: Speaker B, [[Laszlo Korsos]]*

Current 15-minute token expiry is too short when the mail queue is slow. Decision made to extend to 1 hour since tokens are single-use and invalidated after use.

### Mail Queue and Webhook Overlap
*Participants: Speaker A, Speaker B*

Identified potential overlap between mail queue latency and webhook delivery reliability. Jordan will check queue metrics as part of the webhook retry work.

### Billing Migration
*Participants: [[Laszlo Korsos]]*

Alex is finishing the Stripe API v1 to v2 migration, expected to complete by end of day. Will review team PRs the following morning.

## Decisions
- Extend password reset token expiry from 15 minutes to 1 hour
- Use exponential backoff with jitter for webhook retries, max 5 retries over 24 hours
- Log all webhook retry attempts for debugging delivery failures
- File a separate issue to investigate mail queue latency

## Tone
Productive and collaborative. Quick sync with clear updates, good cross-team awareness of overlapping issues.
