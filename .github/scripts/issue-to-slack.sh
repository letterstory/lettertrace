#!/usr/bin/env bash
# Post one GitHub issue event to a Slack incoming webhook as a Block Kit message.
#
# Every value arrives through the environment, never as a shell argument, so an
# issue title like `$(rm -rf /)` or one full of quotes is data to jq and nothing
# else. Slack mrkdwn treats & < > as markup, so they are escaped before the
# text is sent; the issue URL is the only thing that goes out unescaped.
#
# Required env:
#   SLACK_WEBHOOK_URL   the channel's incoming-webhook URL
#   REPO                owner/name
#   ISSUE_NUMBER, ISSUE_TITLE, ISSUE_URL, ISSUE_BODY
#   AUTHOR, AUTHOR_URL
#   ACTION              opened | reopened
# Optional:
#   LABELS              comma-separated label names
set -euo pipefail

: "${SLACK_WEBHOOK_URL:?missing}" "${REPO:?missing}" "${ISSUE_NUMBER:?missing}" \
  "${ISSUE_TITLE:?missing}" "${ISSUE_URL:?missing}" "${AUTHOR:?missing}" "${ACTION:?missing}"

payload=$(jq -n \
  --arg repo "$REPO" \
  --arg number "$ISSUE_NUMBER" \
  --arg title "$ISSUE_TITLE" \
  --arg url "$ISSUE_URL" \
  --arg body "${ISSUE_BODY:-}" \
  --arg author "$AUTHOR" \
  --arg author_url "${AUTHOR_URL:-}" \
  --arg labels "${LABELS:-}" \
  --arg action "$ACTION" '
  def esc: gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;");
  # First 300 characters of the body, whitespace collapsed, as a quote block.
  def excerpt:
    ($body | gsub("\r"; "") | gsub("\\s+"; " ") | ltrimstr(" ") | .[0:300]) as $t
    | if ($t | length) == 0 then "" elif ($body | length) > 300 then "> \($t | esc)…" else "> \($t | esc)" end;
  (if $action == "reopened" then "Issue reopened" else "New issue" end) as $verb
  | ($labels | split(",") | map(select(length > 0)) | map("`\(. | esc)`") | join(" ")) as $labeltext
  | {
      text: "\($verb) in \($repo | esc): #\($number) \($title | esc)",
      blocks: ([
        { type: "header", text: { type: "plain_text", text: "\($verb) · \($repo)", emoji: false } },
        { type: "section", text: { type: "mrkdwn",
            text: ("*<\($url)|#\($number) \($title | esc)>*\nby <\($author_url)|\($author | esc)>" + (if $labeltext == "" then "" else "  ·  \($labeltext)" end)) } },
        (if excerpt == "" then empty else { type: "section", text: { type: "mrkdwn", text: excerpt } } end),
        { type: "context", elements: [ { type: "mrkdwn", text: "<https://github.com/\($repo)/issues|All issues in \($repo | esc)>" } ] }
      ])
    }')

# Slack answers a bare "ok" on success; anything else (invalid_payload,
# no_service, channel_not_found) is a real failure and should fail the job.
response=$(curl --silent --show-error --max-time 15 \
  -H 'content-type: application/json' --data "$payload" "$SLACK_WEBHOOK_URL")
if [ "$response" != "ok" ]; then
  echo "Slack rejected the message: $response" >&2
  exit 1
fi
echo "Posted #$ISSUE_NUMBER from $REPO to Slack."
