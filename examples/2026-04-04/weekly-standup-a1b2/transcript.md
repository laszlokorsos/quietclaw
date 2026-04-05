---
type: "meeting"
date: "2026-04-04"
title: "Weekly Standup"
participants: ["Alex Chen", "Speaker A", "Speaker B"]
platform: google-meet
duration: 24m
summarized: true
---

# Weekly Standup

**Date:** 4/4/2026
**Time:** 09:00 AM — 09:24 AM
**Duration:** 24:32
**Speakers:** [[Alex Chen]], Speaker A, Speaker B

---

**[[Alex Chen]]** (0:00)
Alright, let's get started. Jordan, you want to go first?

**Speaker A** (0:04)
Sure. So I finished the API rate limiting yesterday. It's deployed to staging. I ran the load tests and we're handling 500 requests per second without any issues. Today I'm going to start on the webhook retry logic.

**[[Alex Chen]]** (0:19)
Nice. Any blockers on the webhook stuff?

**Speaker A** (0:23)
Not really. I need to decide on the backoff strategy. I'm thinking exponential with jitter, max five retries over twenty-four hours. Does that sound reasonable?

**[[Alex Chen]]** (0:34)
Yeah that's solid. Make sure we log each retry attempt so we can debug delivery failures. Sam, how about you?

**Speaker B** (0:42)
I've been working on the onboarding redesign. The new flow is almost done, just need to wire up the email verification step. I also found a bug in the password reset flow where the token expires before the email arrives if the mail queue is backed up.

**[[Alex Chen]]** (0:58)
Oh that's a good catch. How long are the tokens valid for right now?

**Speaker B** (1:03)
Fifteen minutes. I think we should bump it to an hour. The security risk is low since it's a one-time use token and we invalidate it after use anyway.

**[[Alex Chen]]** (1:12)
Agreed. Go ahead and bump it to an hour. File an issue for the mail queue latency too, we should look into that separately.

**Speaker A** (1:18)
Actually that might be related to the webhook stuff. If we're overloading the mail service that could affect delivery webhooks too. I'll check the queue metrics when I'm in there.

**[[Alex Chen]]** (1:27)
Good thinking. Alright, my update. I'm wrapping up the billing migration. We're moving from Stripe API v1 to v2. Should be done by end of day. Then I'll review both your PRs tomorrow morning.

**Speaker B** (1:39)
Sounds good. My PR should be up by end of day today.

**Speaker A** (1:44)
Same here. The rate limiting PR is already up, I just need to add a couple more tests.

**[[Alex Chen]]** (1:48)
Perfect. Anything else? No? Alright, let's get back to it. Talk to you all tomorrow.
