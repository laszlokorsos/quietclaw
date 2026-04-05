#!/bin/bash
# Generate sample meeting data for QuietClaw screenshots
set -e

DATA_DIR="$HOME/.quietclaw"
MEETINGS_DIR="$DATA_DIR/meetings"
DB_PATH="$DATA_DIR/quietclaw.db"

WORK_EMAIL="jamie@acmecorp.com"
PERSONAL_EMAIL="jamie.smith@gmail.com"

# Helper: generate UUID-like string
uuid() { python3 -c "import uuid; print(uuid.uuid4())"; }
hash4() { python3 -c "import uuid; print(str(uuid.uuid4())[:4])"; }

# Helper: date math
date_ago() {
  if [[ "$(uname)" == "Darwin" ]]; then
    date -v-${1}d "+%Y-%m-%d"
  else
    date -d "$1 days ago" "+%Y-%m-%d"
  fi
}

iso_date() {
  local days_ago=$1 hour=$2 min=$3
  if [[ "$(uname)" == "Darwin" ]]; then
    local base=$(date -v-${days_ago}d "+%Y-%m-%d")
  else
    local base=$(date -d "$days_ago days ago" "+%Y-%m-%d")
  fi
  printf "%sT%02d:%02d:00.000Z" "$base" "$hour" "$min"
}

write_meeting() {
  local title="$1" days_ago=$2 start_hour=$3 start_min=$4 duration_min=$5
  local cal_email="$6" platform="$7" summarized=$8 action_count=$9
  shift 9
  local speakers_json="$1" transcript_json="$2"
  local summary_text="${3:-}" topics_json="${4:-}" decisions_json="${5:-}" actions_json="${6:-}"

  local id=$(uuid)
  local slug_base=$(echo "$title" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//' | sed 's/-$//' | cut -c1-50)
  local h=$(hash4)
  local s="${slug_base}-${h}"
  local date=$(date_ago $days_ago)
  local start_time=$(iso_date $days_ago $start_hour $start_min)
  local end_min=$(( start_min + duration_min ))
  local end_hour=$(( start_hour + end_min / 60 ))
  end_min=$(( end_min % 60 ))
  local end_time=$(iso_date $days_ago $end_hour $end_min)
  local duration=$(( duration_min * 60 ))

  local meeting_dir="$MEETINGS_DIR/$date/$s"
  mkdir -p "$meeting_dir"

  # metadata.json
  local meeting_link
  if [[ "$platform" == "google_meet" ]]; then
    meeting_link="https://meet.google.com/abc-defg-hij"
  else
    meeting_link="https://zoom.us/j/1234567890"
  fi

  cat > "$meeting_dir/metadata.json" << METAEOF
{
  "id": "$id",
  "title": "$title",
  "slug": "$s",
  "startTime": "$start_time",
  "endTime": "$end_time",
  "duration": $duration,
  "calendarEvent": {
    "eventId": "evt-$(hash4)",
    "calendarAccountEmail": "$cal_email",
    "title": "$title",
    "startTime": "$start_time",
    "endTime": "$end_time",
    "attendees": [],
    "platform": "$platform",
    "meetingLink": "$meeting_link"
  },
  "speakers": $speakers_json,
  "summarized": $summarized,
  "sttProvider": "deepgram",
  "files": {
    "metadata": "metadata.json",
    "transcript_json": "transcript.json",
    "transcript_md": "transcript.md"
  }
}
METAEOF

  # transcript.json
  cat > "$meeting_dir/transcript.json" << TEOF
{
  "segments": $transcript_json,
  "duration": $duration,
  "provider": "deepgram",
  "model": "nova-2",
  "language": "en"
}
TEOF

  # transcript.md
  echo "---" > "$meeting_dir/transcript.md"
  echo "type: transcript" >> "$meeting_dir/transcript.md"
  echo "date: \"$date\"" >> "$meeting_dir/transcript.md"
  echo "title: \"$title\"" >> "$meeting_dir/transcript.md"
  echo "---" >> "$meeting_dir/transcript.md"
  echo "" >> "$meeting_dir/transcript.md"
  echo "# $title" >> "$meeting_dir/transcript.md"

  if [[ "$summarized" == "true" && -n "$summary_text" ]]; then
    cat > "$meeting_dir/summary.json" << SEOF
{
  "executive_summary": "$summary_text",
  "topics": $topics_json,
  "decisions": $decisions_json,
  "sentiment": "collaborative",
  "provider": "anthropic",
  "model": "claude-haiku-4-5-20251001"
}
SEOF
    echo "---" > "$meeting_dir/summary.md"
    echo "type: summary" >> "$meeting_dir/summary.md"
    echo "date: \"$date\"" >> "$meeting_dir/summary.md"
    echo "title: \"$title\"" >> "$meeting_dir/summary.md"
    echo "summarized: true" >> "$meeting_dir/summary.md"
    echo "---" >> "$meeting_dir/summary.md"
    echo "" >> "$meeting_dir/summary.md"
    echo "$summary_text" >> "$meeting_dir/summary.md"

    cat > "$meeting_dir/actions.json" << AEOF
$actions_json
AEOF
  fi

  # Insert into SQLite
  local speakers_escaped=$(echo "$speakers_json" | sed "s/'/''/g")
  sqlite3 "$DB_PATH" "INSERT OR REPLACE INTO meetings (id, title, slug, start_time, end_time, duration, date, speakers, summarized, stt_provider, meeting_dir, action_count, calendar_account) VALUES ('$id', '$(echo "$title" | sed "s/'/''/g")', '$s', '$start_time', '$end_time', $duration, '$date', '$speakers_escaped', $([ "$summarized" = "true" ] && echo 1 || echo 0), 'deepgram', '$meeting_dir', $action_count, '$cal_email');"

  echo "  ✓ $date — $title"
}

echo "Generating sample meetings..."
echo ""

# Meeting 1: Weekly Product Sync (today, work, 3 speakers, summarized)
write_meeting "Weekly Product Sync" 0 10 0 34 \
  "$WORK_EMAIL" "google_meet" "true" 3 \
  '[{"name":"Me","speakerId":0,"source":"microphone"},{"name":"Sarah Chen","speakerId":1,"source":"system","email":"sarah@acmecorp.com"},{"name":"Marcus Johnson","speakerId":2,"source":"system","email":"marcus@acmecorp.com"}]' \
  '[{"speaker":"Me","speakerId":0,"source":"microphone","start":0,"end":120,"text":"Hey everyone, let'\''s kick off the weekly sync. Sarah, want to start with the roadmap update?","confidence":0.97},{"speaker":"Sarah Chen","speakerId":1,"source":"system","start":120,"end":280,"text":"Sure. We'\''ve been looking at the Q3 priorities and I think we should go mobile-first. The data from last quarter shows 68% of our engagement comes from push notifications.","confidence":0.96},{"speaker":"Me","speakerId":0,"source":"microphone","start":280,"end":340,"text":"That makes sense. Marcus, where are we with the push notification redesign?","confidence":0.98},{"speaker":"Marcus Johnson","speakerId":2,"source":"system","start":340,"end":480,"text":"The new template editor is about 90% done. We could realistically ship it by the 18th if we move the A/B testing up to next week.","confidence":0.95}]' \
  "Discussed Q3 roadmap priorities and mobile push notification redesign. Agreed to move up the A/B testing timeline and ship the new template editor by end of month." \
  '[{"topic":"Q3 Roadmap","participants":["Sarah Chen","Me"],"summary":"Reviewed priorities and agreed on mobile-first approach."},{"topic":"Push Notification Redesign","participants":["Marcus Johnson","Me"],"summary":"Template editor nearly ready. A/B testing moved to next week."}]' \
  '["Ship template editor by April 18","Move A/B testing to next week"]' \
  '[{"id":"act-001","description":"Share A/B test plan with the team by Thursday","assignee":"Marcus Johnson","priority":"high","agent_executable":false,"status":"pending"},{"id":"act-002","description":"Schedule final interviews for frontend candidates","assignee":"Sarah Chen","priority":"medium","agent_executable":true,"status":"pending"},{"id":"act-003","description":"Draft Q3 OKRs for product team review","assignee":"Me","priority":"medium","agent_executable":false,"status":"pending"}]'

# Meeting 2: 1:1 with Jordan (today, work, 2 speakers, summarized)
write_meeting "1:1 with Jordan" 0 14 30 22 \
  "$WORK_EMAIL" "zoom" "true" 2 \
  '[{"name":"Me","speakerId":0,"source":"microphone"},{"name":"Jordan Park","speakerId":1,"source":"system","email":"jordan@acmecorp.com"}]' \
  '[{"speaker":"Me","speakerId":0,"source":"microphone","start":0,"end":80,"text":"Hey Jordan, how'\''s the pipeline migration going?","confidence":0.98},{"speaker":"Jordan Park","speakerId":1,"source":"system","start":80,"end":220,"text":"Pretty good actually. We'\''re about 70% through. The main blocker right now is the legacy Kafka consumer.","confidence":0.96},{"speaker":"Me","speakerId":0,"source":"microphone","start":220,"end":340,"text":"Would you want to lead the refactor on that? It'\''s a good opportunity for some architecture work.","confidence":0.97},{"speaker":"Jordan Park","speakerId":1,"source":"system","start":340,"end":460,"text":"Yeah, I'\''d really like that. I'\''ve been wanting to do more architecture-level stuff.","confidence":0.95}]' \
  "Discussed Jordan'\''s progress on the data pipeline migration and career growth goals." \
  '[{"topic":"Pipeline Migration","participants":["Jordan Park","Me"],"summary":"Migration 70% complete. Legacy Kafka consumer is the main blocker."},{"topic":"Career Growth","participants":["Jordan Park","Me"],"summary":"Jordan wants more architecture work. Will join the review rotation."}]' \
  '["Jordan will lead the Kafka consumer refactor","Add Jordan to architecture review rotation"]' \
  '[{"id":"act-004","description":"Add Jordan to the architecture review calendar","assignee":"Me","priority":"medium","agent_executable":true,"status":"pending"},{"id":"act-005","description":"Draft RFC for Kafka consumer refactor","assignee":"Jordan Park","priority":"high","agent_executable":false,"status":"pending"}]'

# Meeting 3: Board Meeting Prep (yesterday, work, 4 speakers, summarized)
write_meeting "Board Meeting Prep" 1 9 0 48 \
  "$WORK_EMAIL" "google_meet" "true" 4 \
  '[{"name":"Me","speakerId":0,"source":"microphone"},{"name":"Lisa Wang","speakerId":1,"source":"system","email":"lisa@acmecorp.com"},{"name":"David Kim","speakerId":2,"source":"system","email":"david@acmecorp.com"},{"name":"Speaker C","speakerId":3,"source":"system"}]' \
  '[{"speaker":"Me","speakerId":0,"source":"microphone","start":0,"end":100,"text":"Alright, let'\''s go through the board deck. Lisa, can you walk us through the structure?","confidence":0.97},{"speaker":"Lisa Wang","speakerId":1,"source":"system","start":100,"end":250,"text":"Sure. I'\''ve reorganized it into four sections: growth metrics, product update, financials, and the ask.","confidence":0.96},{"speaker":"David Kim","speakerId":2,"source":"system","start":250,"end":380,"text":"Our net revenue retention is at 118%, which is best-in-class. We should lead with that.","confidence":0.95}]' \
  "Reviewed board deck structure and financial projections. Key focus: ARR growth narrative and enterprise pipeline." \
  '[{"topic":"Board Deck Review","participants":["Lisa Wang","Me","David Kim"],"summary":"Updated deck structure. Need cohort retention data."},{"topic":"Enterprise Pipeline","participants":["Lisa Wang","Speaker C"],"summary":"Three enterprise deals in late stage."}]' \
  '["Add cohort retention data to growth slide","Lead with NRR metric"]' \
  '[{"id":"act-006","description":"Update growth slide with cohort retention data","assignee":"David Kim","priority":"high","agent_executable":false,"status":"pending"},{"id":"act-007","description":"Send updated deck to board members by Thursday","assignee":"Lisa Wang","priority":"high","agent_executable":true,"status":"pending"},{"id":"act-008","description":"Schedule board deck dry run for Wednesday","assignee":"Lisa Wang","priority":"high","agent_executable":true,"status":"pending"},{"id":"act-009","description":"Prepare talking points for enterprise pipeline questions","assignee":"Me","priority":"medium","agent_executable":false,"status":"pending"}]'

# Meeting 4: Coffee Chat (yesterday, personal, 2 speakers, NOT summarized)
write_meeting "Coffee Chat with Alex" 1 16 0 18 \
  "$PERSONAL_EMAIL" "google_meet" "false" 0 \
  '[{"name":"Me","speakerId":0,"source":"microphone"},{"name":"Alex Rivera","speakerId":1,"source":"system","email":"alex.rivera@gmail.com"}]' \
  '[{"speaker":"Me","speakerId":0,"source":"microphone","start":0,"end":80,"text":"Hey Alex! Good to catch up. How'\''s the new role going?","confidence":0.98},{"speaker":"Alex Rivera","speakerId":1,"source":"system","start":80,"end":200,"text":"It'\''s been great honestly. The team is really strong. Very different culture from where I was before.","confidence":0.96}]'

# Meeting 5: Sprint Retro (2 days ago, work, 4 speakers, summarized)
write_meeting "Sprint Retrospective" 2 11 0 41 \
  "$WORK_EMAIL" "google_meet" "true" 2 \
  '[{"name":"Me","speakerId":0,"source":"microphone"},{"name":"Sarah Chen","speakerId":1,"source":"system","email":"sarah@acmecorp.com"},{"name":"Jordan Park","speakerId":2,"source":"system","email":"jordan@acmecorp.com"},{"name":"Priya Patel","speakerId":3,"source":"system","email":"priya@acmecorp.com"}]' \
  '[{"speaker":"Me","speakerId":0,"source":"microphone","start":0,"end":60,"text":"Let'\''s start with what went well this sprint.","confidence":0.98},{"speaker":"Jordan Park","speakerId":2,"source":"system","start":60,"end":180,"text":"The deployment automation is a game changer. We saved about four hours per release.","confidence":0.96},{"speaker":"Priya Patel","speakerId":3,"source":"system","start":180,"end":320,"text":"On the flip side, the on-call situation is rough. I got paged six times last week and only two were actionable.","confidence":0.95}]' \
  "Retro covered deployment automation wins and on-call alert fatigue. Team agreed to dedicate 20% of next sprint to reducing alert noise." \
  '[{"topic":"What Went Well","participants":["Jordan Park","Sarah Chen"],"summary":"Deployment automation saved ~4 hours per release."},{"topic":"What Needs Improvement","participants":["Priya Patel","Me"],"summary":"On-call alert fatigue — too many non-actionable alerts."}]' \
  '["Dedicate 20% of next sprint to alert noise reduction"]' \
  '[{"id":"act-010","description":"Audit current alert rules and identify noisy ones","assignee":"Priya Patel","priority":"high","agent_executable":false,"status":"pending"},{"id":"act-011","description":"Set up shared on-call runbook in Notion","assignee":"Jordan Park","priority":"medium","agent_executable":true,"status":"pending"}]'

# Meeting 6: Design Review (3 days ago, work, 2 speakers, summarized)
write_meeting "Design Review — Onboarding Flow" 3 14 0 28 \
  "$WORK_EMAIL" "zoom" "true" 1 \
  '[{"name":"Me","speakerId":0,"source":"microphone"},{"name":"Nina Torres","speakerId":1,"source":"system","email":"nina@acmecorp.com"}]' \
  '[{"speaker":"Nina Torres","speakerId":1,"source":"system","start":0,"end":140,"text":"I'\''ve been looking at the analytics and we'\''re losing about 30% of users at step 4.","confidence":0.96},{"speaker":"Me","speakerId":0,"source":"microphone","start":140,"end":260,"text":"What if we combined the permissions into one step and made summarization setup optional?","confidence":0.97}]' \
  "Reviewed onboarding flow mockups. Agreed on 3-step wizard instead of 5." \
  '[{"topic":"Onboarding Simplification","participants":["Nina Torres","Me"],"summary":"Consolidated 5 steps to 3 by combining permissions."}]' \
  '["3-step onboarding: permissions, API key, calendar"]' \
  '[{"id":"act-012","description":"Update Figma mockups with simplified 3-step flow","assignee":"Nina Torres","priority":"medium","agent_executable":false,"status":"pending"}]'

# Meeting 7: Investor check-in (5 days ago, work, 2 speakers, summarized)
write_meeting "Investor Check-in" 5 10 30 26 \
  "$WORK_EMAIL" "zoom" "true" 1 \
  '[{"name":"Me","speakerId":0,"source":"microphone"},{"name":"Rachel Green","speakerId":1,"source":"system","email":"rachel@sequoia.com"}]' \
  '[{"speaker":"Rachel Green","speakerId":1,"source":"system","start":0,"end":140,"text":"These numbers look really strong. The 118% net retention is well above the benchmark for your stage.","confidence":0.96},{"speaker":"Me","speakerId":0,"source":"microphone","start":140,"end":300,"text":"Thanks. The expansion revenue is really driving it. Our enterprise pipeline is also looking promising.","confidence":0.97}]' \
  "Quarterly check-in. Shared growth metrics and product roadmap. Rachel interested in enterprise pipeline." \
  '[{"topic":"Growth Update","participants":["Me","Rachel Green"],"summary":"ARR growing 22% QoQ. Net retention impressed Rachel."},{"topic":"Enterprise Strategy","participants":["Rachel Green","Me"],"summary":"Rachel offered portfolio company intro as design partner."}]' \
  '["Send Rachel the updated metrics deck"]' \
  '[{"id":"act-013","description":"Send Rachel the Q2 metrics deck and enterprise pipeline summary","assignee":"Me","priority":"high","agent_executable":true,"status":"pending"}]'

echo ""
echo "Done! 7 sample meetings created across $(date_ago 5) to $(date_ago 0)."
echo "Restart QuietClaw (pnpm dev) to see them in the app."
