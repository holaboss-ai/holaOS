/** Rich markdown README content for each template, keyed by template name. */
export const templateReadmes: Record<string, string> = {
  social_operator: `## Overview

Social Operator is your always-on AI social media team. It combines multiple specialist agents — writers, analysts, and publishers — that collaborate to run your social media accounts autonomously.

![Social Operator](https://images.unsplash.com/photo-1611162616305-c69b3fa7fbe0?w=800&h=400&fit=crop&q=80)

## How It Works

Social Operator uses a **team-based agent architecture**. A routing agent analyzes your request and delegates to the right specialist:

\`\`\`
Your Input (natural language)
       │
       ▼
┌──────────────────┐
│  General Agent    │  ← understands intent
│  (Router)         │
└──────┬───────────┘
       │
  ┌────┼────┬────────┐
  ▼    ▼    ▼        ▼
┌────┐┌────┐┌──────┐┌──────┐
│ 𝕏  ││ in ││ 📹   ││ 🎨   │
│    ││    ││Video ││Image │
│Agent││Agent││Agent ││Agent │
└────┘└────┘└──────┘└──────┘
\`\`\`

Each platform agent knows the best practices, character limits, formatting rules, and audience expectations for its platform.

## Platform Agents

| Agent | Platform | Capabilities |
|-------|----------|-------------|
| **Twitter Agent** | X / Twitter | Threads, quote tweets, engagement replies, trending topic newsjacking |
| **LinkedIn Agent** | LinkedIn | Thought leadership posts, professional stories, carousel ideas |
| **Video Script Agent** | YouTube, TikTok | Hook-first scripts, short-form & long-form, caption generation |
| **Image Agent** | All platforms | AI image generation prompts, visual content briefs |

## Example Usage

Just tell the operator what you want in natural language:

\`\`\`
"Write a Twitter thread about why startups should invest in
content marketing early, include data points and a CTA"
\`\`\`

The router identifies this as a Twitter task and delegates to the Twitter Agent, which produces:

\`\`\`markdown
1/ Most startups wait too long to invest in content marketing.

By the time they start, competitors already own the conversation.

Here's why starting early gives you an unfair advantage: 🧵

2/ Companies that blog get 67% more leads than those that don't.
   (Source: HubSpot State of Marketing)

   But it's not just about leads — it's about building trust
   before your prospect ever talks to sales.

3/ Early content compounds. A blog post written today will still
   drive traffic 2 years from now.

   That's unlike paid ads, where traffic stops the moment
   you stop spending.

...

7/ Start before you're ready.

   The best time to invest in content was last year.
   The second best time is today.

   If you're building a startup, DM me — happy to share
   our content playbook. 📩
\`\`\`

## Configuration

Customize agent behavior in your workspace settings:

\`\`\`yaml
social_media:
  brand_voice: "Professional but approachable, data-driven"
  platforms:
    twitter:
      max_thread_length: 10
      include_hashtags: false
      emoji_style: "minimal"
    linkedin:
      tone: "thought-leadership"
      post_length: "medium"  # short | medium | long
  content_rules:
    - "Always include a call-to-action"
    - "Back claims with data when possible"
    - "Avoid jargon — write at an 8th grade reading level"
\`\`\`

## Views

### Content Feed
See all generated content in a chronological feed. Filter by platform, status (draft / approved / published), or date range.

### Performance
Track how your published content performs across platforms with engagement metrics, reach estimates, and trend analysis.

## Getting Started

1. Activate the template and connect your social accounts
2. Set your brand voice and content preferences
3. Start giving the operator tasks — it learns your style over time

> **Tip:** Start with a few test posts in "draft" mode. Review, edit, and approve them. The agents learn from your edits and improve over time.
`,

  devrel_worker: `## Ship code. Share the journey. Let AI handle the storytelling.

You're already building interesting things. The problem is, nobody knows — because turning a commit into a tweet is just annoying enough that you never do it.

This workspace watches your GitHub and writes your social posts for you.

### What it actually does

You push code. The agent notices. It reads your commits, PRs, and releases, understands what changed, and drafts a post that sounds like you — not like a robot.

\`\`\`
You: "What did I ship this week?"

Agent reads GitHub:
  → 12 commits on main
  → PR #47 merged: "Add real-time notifications"
  → v2.1.0 released

Agent drafts:
  "Shipped real-time notifications this week 🔔
   Users now get instant updates instead of polling.
   The diff was surprisingly clean — 200 lines total.
   v2.1.0 is live."

You: "Post it" → Done.
\`\`\`

### What you can say

\`\`\`
"Summarize my GitHub activity from the last 7 days"

"Write a tweet about PR #47"

"Draft a LinkedIn post about our latest release"

"What's the most interesting thing I committed today?"

"Write a thread about the architecture changes in v2.0"
\`\`\`

### How it works

\`\`\`
GitHub                        Twitter / LinkedIn
(your code activity)          (your audience)
      │                              ▲
      ▼                              │
┌──────────┐    AI Agent    ┌──────────────┐
│ github   │───────────────►│   twitter    │
│ module   │  reads code,   │   module     │
└──────────┘  writes posts  └──────────────┘
\`\`\`

The **github module** reads your repos — commits, PRs, releases, diffs. The **twitter module** (or linkedin, or both) handles drafting and publishing. The agent connects them.

### Flexible setup

The default is github + twitter, but you can swap or add channels:

- **github + twitter** — Quick dev updates, hot takes
- **github + linkedin** — Professional dev updates for your network
- **github + twitter + linkedin** — Full coverage

Just install the apps you want from the marketplace.

### Getting started

1. **Launch this workspace** — GitHub and Twitter apps install automatically.
2. **Connect your accounts** — The platform handles OAuth for both GitHub and Twitter.
3. **Ask the agent** — *"What did I ship this week?"* and go from there.

> **How it stays authentic:** The agent reads your actual code and commit messages. It doesn't make things up. Every post is drafted from real activity — and you always review before it goes out.
`,

  starter: `## Overview

Starter is the simplest Holaboss template — a clean workspace with one general-purpose AI agent, ready for you to customize. Think of it as a blank canvas with smart defaults.

![Getting Started](https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=800&h=400&fit=crop&q=80)

## What's Included

- **1 General Agent** — handles any task you throw at it
- **Clean workspace** — no pre-configured views or workflows
- **Full customization** — add agents, views, and integrations as you need them

## Use Cases

The Starter template is perfect for:

- **Experimenting** with the Holaboss platform before committing to a specific workflow
- **Custom workflows** that don't fit into any pre-built template
- **Learning** how agents, views, and workspace settings work

## Quick Start

\`\`\`bash
# Once activated, just start chatting with your agent:
"Help me draft a product announcement for our new feature"
"Summarize this article and pull out the key takeaways"
"Write a comparison table of our product vs. competitors"
\`\`\`

The general agent can:
- Generate and edit content
- Research topics and summarize findings
- Create structured outputs (tables, lists, outlines)
- Help plan campaigns and strategies

## Growing Your Workspace

As your needs evolve, you can add more capabilities:

| What you need | What to add |
|--------------|-------------|
| Multi-platform posting | Connect social accounts + add platform agents |
| Content calendar | Add Calendar view |
| Analytics | Add Analytics view + Data Collector agent |
| Team collaboration | Invite team members + set permissions |

## Configuration

\`\`\`typescript
// The starter workspace has minimal config
// Add settings as you need them
const workspace = {
  agents: ["general"],
  views: [],
  integrations: [],
  // Add more as you grow:
  // agents: ["general", "twitter", "linkedin"],
  // views: ["calendar", "analytics"],
  // integrations: ["twitter", "linkedin"],
}
\`\`\`

> **Tip:** Browse the Store for pre-built templates if you want a more opinionated starting point. You can always switch templates later.
`,

  social_media_manager: `## Overview

Social Media Manager gives you a dedicated AI team that handles your entire social media workflow — from ideation to publishing and performance tracking.

Instead of juggling multiple tools and tabs, you get a single workspace where three AI agents collaborate to keep your social channels active and growing.

![Dashboard Preview](https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=800&h=400&fit=crop&q=80)

## How It Works

The template ships with three pre-configured agents that work together:

| Agent | Role | What it does |
|-------|------|-------------|
| **Content Strategist** | Planning | Analyzes your niche, competitors, and trending topics to build a weekly content calendar |
| **Copywriter** | Creation | Generates platform-native copy for Twitter threads, LinkedIn posts, and Reddit comments |
| **Scheduler** | Distribution | Queues posts at optimal times based on your audience's activity patterns |

## Quick Start

Once you activate the template, the Content Strategist kicks off by analyzing your brand profile:

\`\`\`yaml
# Example: auto-generated content plan
week: 2024-W12
theme: "Product Launch Series"
posts:
  - platform: twitter
    type: thread
    topic: "Behind the scenes of our new feature"
    scheduled: "2024-03-18T09:00:00Z"
  - platform: linkedin
    type: article
    topic: "How we solved X for our customers"
    scheduled: "2024-03-19T11:30:00Z"
  - platform: reddit
    type: comment
    subreddit: "r/SaaS"
    topic: "Helpful reply about content automation"
    scheduled: "2024-03-20T15:00:00Z"
\`\`\`

## Views

### Calendar View
See your entire content pipeline at a glance. Drag-and-drop to reschedule, click to edit, and color-coded by platform.

### Analytics Dashboard
Track engagement rates, follower growth, and best-performing content types across all platforms.

## Configuration

You can customize agent behavior through the workspace settings:

\`\`\`typescript
const config = {
  // Posting frequency per platform
  frequency: {
    twitter: 5,   // posts per week
    linkedin: 3,
    reddit: 2,
  },
  // Content tone
  voice: "professional-casual",
  // Auto-approve or review before posting
  approval: "review-first",
}
\`\`\`

## Best Practices

- **Start with "review-first" mode** until you're comfortable with the AI's output quality
- **Connect your analytics** early so the Strategist can learn what resonates with your audience
- **Set brand guidelines** in the workspace settings to keep the Copywriter on-brand
- Avoid scheduling more than 3 posts per day on any single platform

> **Tip:** The Content Strategist improves over time. Give it 2-3 weeks of data before judging content quality.
`,

  growth_engine: `## Overview

Growth Engine is a data-driven template for teams that want to systematically grow their social media audience. It combines audience intelligence with engagement automation to help you find, attract, and retain followers.

![Growth Analytics](https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=800&h=400&fit=crop&q=80)

## Architecture

\`\`\`
┌─────────────────┐     ┌──────────────────────┐
│  Growth Analyst  │────▶│  Engagement Data      │
│  (monitoring)    │     │  - follower trends    │
└────────┬────────┘     │  - engagement rates   │
         │              │  - competitor growth   │
         ▼              └──────────────────────┘
┌─────────────────┐
│  Engagement      │────▶  Automated responses,
│  Specialist      │       optimized posting times,
│  (execution)     │       community interactions
└─────────────────┘
\`\`\`

## Key Features

### Audience Intelligence
The Growth Analyst continuously monitors your audience demographics, engagement patterns, and growth trajectory. It identifies:

- **Peak engagement windows** — when your audience is most active
- **Content themes that drive follows** — what makes people hit subscribe
- **Competitor strategies** — what's working for similar accounts

### Smart Engagement

\`\`\`python
# Example: How the engagement algorithm scores opportunities
def score_engagement_opportunity(post):
    relevance = compute_topic_relevance(post, brand_profile)
    reach = estimate_audience_overlap(post.author)
    timing = get_recency_score(post.created_at)

    return (relevance * 0.5) + (reach * 0.3) + (timing * 0.2)
\`\`\`

### Growth Tracking

| Metric | Description | Update Frequency |
|--------|-------------|-----------------|
| Follower velocity | Net new followers per day | Real-time |
| Engagement rate | Interactions / impressions | Daily |
| Audience quality | Bot score, activity level | Weekly |
| Growth vs. competitors | Relative growth rate | Weekly |

## Dashboard

The Growth Dashboard gives you a single view of all growth metrics with trend lines, goal tracking, and AI-generated insights.

> **Note:** Connect at least one social account before activating this template. The Growth Analyst needs historical data to establish baseline metrics.

## Tips for Maximum Growth

1. Set realistic weekly growth targets — the system uses these to calibrate effort
2. Review the "Engagement Opportunities" feed daily for the first week
3. Enable the competitor tracker for at least 3 accounts in your niche
4. Use the A/B testing feature for post formats to find what converts
`,

  content_repurposer: `## Overview

Content Repurposer transforms your long-form content into platform-optimized posts automatically. Write once, publish everywhere — each piece tailored to the platform's unique format and audience expectations.

![Content Pipeline](https://images.unsplash.com/photo-1499750310107-5fef28a66643?w=800&h=400&fit=crop&q=80)

## How It Works

Feed in any long-form content — blog posts, podcast transcripts, video scripts, newsletters — and the AI agents break it down into platform-native pieces.

\`\`\`
Blog Post (2,000 words)
        │
        ▼
┌──────────────────┐
│  Content Analyzer │
│  Extracts key     │
│  insights & hooks │
└────────┬─────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌────────┐
│Twitter │ │LinkedIn│  ... and more
│ Thread │ │  Post  │
│ (8 pts)│ │(1 long)│
└────────┘ └────────┘
\`\`\`

## Example Output

Given a blog post about "Why AI Agents Beat Single Prompts", the system produces:

### Twitter Thread
\`\`\`markdown
1/ Most people use AI wrong.

They type one prompt and expect magic.

But the real power? AI agents that work together.

Here's what we learned building our platform: 🧵

2/ A single prompt is like hiring one person to do everything.
   Sure, they'll try. But the output is generic.

3/ AI agents specialize. One researches. One writes. One edits.
   The result? Content that actually sounds human.

...
\`\`\`

### LinkedIn Post
\`\`\`markdown
I used to spend 3 hours repurposing every blog post.

Now it takes 5 minutes.

Here's the shift that changed everything:

Instead of manually adapting content for each platform,
we built AI agents that understand platform-native formats.

The key insight: each platform has unwritten rules...
\`\`\`

## Pipeline View

Track every piece of content through its transformation pipeline:

| Stage | Status | Output |
|-------|--------|--------|
| Input | ✅ Complete | Blog post imported |
| Analysis | ✅ Complete | 6 key points extracted |
| Twitter | ✅ Ready | 8-tweet thread |
| LinkedIn | ⏳ In Review | Long-form post |
| Reddit | 📝 Drafting | Discussion starter |

## Configuration

\`\`\`typescript
const repurposeConfig = {
  platforms: ["twitter", "linkedin", "reddit"],
  style: {
    twitter: { maxThreadLength: 10, includeEmoji: true },
    linkedin: { tone: "thought-leadership", maxLength: 1500 },
    reddit: { subreddits: ["r/SaaS", "r/marketing"], style: "conversational" },
  },
  // Automatically queue or require manual review
  autoPublish: false,
}
\`\`\`

> **Pro Tip:** The Content Analyzer works best with content that has clear section headers and a logical structure. Well-organized input = better output.
`,

  brand_monitor: `## Overview

Brand Monitor keeps a pulse on every mention of your brand, competitors, and industry keywords across social platforms. Get real-time alerts, sentiment analysis, and trend reports — all in one workspace.

![Monitoring Dashboard](https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800&h=400&fit=crop&q=80)

## Agents

### Monitor Agent
Continuously scans social platforms for mentions matching your configured keywords. Uses fuzzy matching to catch misspellings and abbreviations.

### Analyst Agent
Processes each mention through a sentiment pipeline:

\`\`\`python
# Simplified sentiment scoring
def analyze_mention(mention):
    sentiment = classify_sentiment(mention.text)  # positive | neutral | negative
    urgency = detect_urgency(mention)              # low | medium | high | critical
    reach = estimate_reach(mention.author)

    return MentionAnalysis(
        sentiment=sentiment,
        urgency=urgency,
        reach=reach,
        suggested_action=determine_action(sentiment, urgency, reach),
    )
\`\`\`

### Reporter Agent
Compiles daily and weekly digest reports with:
- Mention volume trends
- Sentiment distribution shifts
- Top mentions by reach
- Competitor comparison

## Alert Configuration

\`\`\`yaml
alerts:
  - name: "Negative high-reach mention"
    conditions:
      sentiment: negative
      reach: "> 10000"
      urgency: high
    action: notify_slack
    channel: "#brand-alerts"

  - name: "Competitor product launch"
    conditions:
      keyword_group: competitors
      topic: "launch OR announce OR release"
    action: notify_email
    recipients: ["marketing@company.com"]
\`\`\`

## Mention Feed

The Feed view shows all mentions in real-time with filtering by:

| Filter | Options |
|--------|---------|
| Sentiment | Positive, Neutral, Negative |
| Platform | Twitter, LinkedIn, Reddit, News |
| Reach | Low, Medium, High, Viral |
| Urgency | Low, Medium, High, Critical |

## Reports

Weekly reports include:
- **Share of Voice** — your mentions vs. competitors
- **Sentiment Trend** — 7-day rolling sentiment score
- **Top Advocates** — users who mention you positively most often
- **Risk Alerts** — potential PR issues flagged early

> **Important:** Brand Monitor requires at least one social platform connection to start scanning. Add your brand keywords in the workspace settings after activation.
`,

  analytics_hub: `## Overview

Analytics Hub centralizes all your social media metrics into a single, AI-powered dashboard. Instead of logging into five different platforms, you get one unified view with cross-platform insights and AI-generated recommendations.

![Analytics Overview](https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800&h=400&fit=crop&q=80)

## Data Pipeline

\`\`\`
Social Platforms          Analytics Hub
┌──────────┐         ┌────────────────────┐
│ Twitter   │────────▶│                    │
│ LinkedIn  │────────▶│   Data Collector   │
│ Reddit    │────────▶│   Agent            │
│ Instagram │────────▶│                    │
└──────────┘         └─────────┬──────────┘
                               │
                               ▼
                     ┌────────────────────┐
                     │  Insight Generator  │
                     │  Agent              │
                     │                    │
                     │  • Trend detection  │
                     │  • Anomaly alerts   │
                     │  • Recommendations  │
                     └────────────────────┘
\`\`\`

## Key Metrics

The Overview dashboard tracks these core metrics across all connected platforms:

| Metric | Description | Visualization |
|--------|-------------|---------------|
| Total Reach | Combined impressions across platforms | Area chart |
| Engagement Rate | Weighted avg. of likes, comments, shares | Line chart |
| Follower Growth | Net new followers per platform | Stacked bar |
| Content Performance | Top posts by engagement | Ranked table |
| Audience Demographics | Age, location, interests | Pie + map |

## AI-Generated Insights

The Insight Generator produces weekly reports like:

\`\`\`markdown
## Weekly Insight Report — Mar 11, 2024

### 📈 What's Working
- Twitter threads about "behind the scenes" content got **3.2x** more engagement than average
- LinkedIn posts published between 9-10am EST had **47%** higher reach
- Short-form video content drove **2x** more profile visits

### 📉 Areas to Improve
- Reddit engagement dropped **15%** week-over-week — consider varying subreddit targeting
- Instagram stories completion rate is below benchmark (currently 42%, target 60%)

### 💡 Recommendations
1. Double down on Twitter threads — your audience responds well to storytelling
2. Test LinkedIn carousel format — competitors seeing strong results
3. Schedule a Reddit AMA to re-engage the community
\`\`\`

## Deep Dive View

For detailed analysis, the Deep Dive view lets you:
- Compare metrics across custom date ranges
- Filter by platform, content type, or campaign
- Export raw data as CSV for custom analysis
- Set up custom dashboards with drag-and-drop widgets

## Getting Started

1. Connect your social accounts in workspace settings
2. Wait 24 hours for initial data sync
3. The Insight Generator needs ~1 week of data before producing meaningful recommendations

> **Tip:** Pin your most important metrics to the top of the Overview dashboard for quick daily check-ins.
`,

  ops_assistant: `## Overview

Ops Assistant streamlines your daily operations by automating task management, generating reports, and coordinating team workflows. It's like having a virtual chief of staff that never sleeps.

![Operations Dashboard](https://images.unsplash.com/photo-1484480974693-6ca0a78fb36b?w=800&h=400&fit=crop&q=80)

## Daily Workflow

\`\`\`
6:00 AM  ─── Task Manager scans incoming requests & priorities
         │
8:00 AM  ─── Morning brief generated and posted to Slack
         │
         ├── Throughout the day:
         │   • Auto-triages new tasks by urgency
         │   • Assigns to team members based on capacity
         │   • Sends reminders for approaching deadlines
         │
5:00 PM  ─── End-of-day report compiled
         │
6:00 PM  ─── Report Writer generates daily summary
\`\`\`

## Task Management

The Task Manager agent organizes work using a priority matrix:

| Priority | Response Time | Examples |
|----------|--------------|---------|
| 🔴 Critical | < 1 hour | Service outage, security issue |
| 🟠 High | < 4 hours | Customer escalation, blocker |
| 🟡 Medium | < 24 hours | Feature request, non-urgent bug |
| 🟢 Low | < 1 week | Documentation, nice-to-have |

### Auto-Triage Rules

\`\`\`typescript
const triageRules = {
  critical: {
    keywords: ["outage", "security", "data loss", "production down"],
    sources: ["pagerduty", "datadog"],
    action: "notify_oncall",
  },
  high: {
    keywords: ["customer", "escalation", "blocker", "urgent"],
    sources: ["zendesk", "slack-escalations"],
    action: "assign_lead",
  },
}
\`\`\`

## Report Writer

Daily reports include:
- Tasks completed vs. planned
- Blockers and escalations
- Team capacity utilization
- Key metrics snapshot

\`\`\`markdown
## Daily Operations Report — March 12, 2024

### Summary
- **12** tasks completed (target: 10) ✅
- **2** blockers identified and escalated
- **85%** team capacity utilized

### Completed
- [TASK-234] Deploy new auth middleware ✅
- [TASK-237] Update API rate limits ✅
- [TASK-241] Fix notification delivery delay ✅
...

### Blockers
- [TASK-239] Database migration blocked by schema conflict
  → Escalated to @db-team, ETA: tomorrow

### Tomorrow's Focus
1. Complete database migration (carried over)
2. Sprint planning for Q2 features
3. Security audit follow-up items
\`\`\`

> **Setup Tip:** Connect your project management tool (Linear, Jira, Asana) in workspace settings to enable full task synchronization.
`,

  lead_generator: `## Overview

Lead Generator identifies and qualifies potential leads from social media conversations, engagement patterns, and community interactions. It automates the top of your sales funnel so your team can focus on closing.

![Lead Pipeline](https://images.unsplash.com/photo-1553877522-43269d4ea984?w=800&h=400&fit=crop&q=80)

## How It Works

### Lead Scout Agent
Monitors social platforms for buying signals:

\`\`\`python
# Signal detection patterns
buying_signals = [
    "looking for a tool that",
    "anyone recommend",
    "switching from",
    "need help with",
    "frustrated with",
    "our team needs",
]

intent_classifiers = {
    "high_intent": ["ready to buy", "need a solution", "budget approved"],
    "medium_intent": ["evaluating", "comparing", "researching"],
    "low_intent": ["curious about", "interesting", "cool project"],
}
\`\`\`

### Qualifier Agent
Scores each lead on multiple dimensions:

| Dimension | Weight | Signals |
|-----------|--------|---------|
| Intent | 40% | Keywords, context, urgency |
| Fit | 30% | Company size, industry, tech stack |
| Reach | 15% | Follower count, influence score |
| Timing | 15% | Recency, buying cycle stage |

## Pipeline View

\`\`\`
Discovered → Qualified → Contacted → Responded → Meeting
   (45)        (18)        (12)         (7)        (3)
\`\`\`

Each stage shows:
- Lead count and conversion rate
- Average time in stage
- Suggested next actions

## Lead Card

Every discovered lead gets a profile card:

\`\`\`yaml
lead:
  name: "Sarah Chen"
  company: "TechCorp (Series B, 50-200 employees)"
  source: "Twitter"
  signal: "Looking for a social media automation tool for our marketing team"
  score: 82/100
  intent: high
  fit: strong
  suggested_action: "Reply with case study link"
  talking_points:
    - Their current tool (Buffer) lacks AI features
    - Company recently hired 3 marketing roles
    - CEO tweeted about scaling content operations
\`\`\`

## Configuration

\`\`\`typescript
const leadConfig = {
  // Define your ideal customer profile
  icp: {
    companySize: "10-500",
    industries: ["SaaS", "E-commerce", "Agency"],
    techSignals: ["marketing automation", "content tools"],
  },
  // Platforms to monitor
  platforms: ["twitter", "linkedin", "reddit"],
  // Daily lead target
  dailyTarget: 10,
  // Auto-enrich leads with company data
  enrichment: true,
}
\`\`\`

> **Best Practice:** Review and provide feedback on lead quality during the first week. The Qualifier Agent uses your feedback to improve scoring accuracy.
`,

  campaign_planner: `## Overview

Campaign Planner helps you design, execute, and measure multi-platform marketing campaigns with AI-powered optimization. From initial strategy to post-campaign analysis, every phase is coordinated by your AI team.

![Campaign Planning](https://images.unsplash.com/photo-1533750349088-cd871a92f312?w=800&h=400&fit=crop&q=80)

## Campaign Lifecycle

\`\`\`
Phase 1: Strategy        Phase 2: Execution       Phase 3: Analysis
┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ • Goal setting│    │ • Content creation│    │ • Performance     │
│ • Audience    │───▶│ • Scheduling     │───▶│   review          │
│   targeting   │    │ • A/B testing    │    │ • ROI calculation │
│ • Channel mix │    │ • Budget mgmt   │    │ • Learnings       │
└──────────────┘    └──────────────────┘    └──────────────────┘
\`\`\`

## Agents

### Strategist
Creates the campaign blueprint:

\`\`\`yaml
campaign:
  name: "Q1 Product Launch"
  goal: "Drive 500 signups in 2 weeks"
  budget: "$2,000"
  channels:
    twitter:
      allocation: 40%
      tactics: ["launch thread", "daily tips series", "influencer mentions"]
    linkedin:
      allocation: 35%
      tactics: ["announcement post", "founder story", "employee advocacy"]
    reddit:
      allocation: 25%
      tactics: ["AMA in r/SaaS", "value-first comments", "case study post"]
  timeline:
    pre_launch: "Mar 1-7"
    launch_week: "Mar 8-14"
    follow_up: "Mar 15-21"
\`\`\`

### Executor
Manages day-to-day campaign operations:
- Creates and schedules content per the strategy
- Monitors real-time performance
- Adjusts tactics based on what's working
- Manages A/B tests across platforms

### Analyst
Delivers campaign performance reports:

| Metric | Target | Actual | Status |
|--------|--------|--------|--------|
| Signups | 500 | 623 | 🟢 +24.6% |
| Cost per signup | $4.00 | $3.21 | 🟢 -19.8% |
| Total reach | 100K | 142K | 🟢 +42% |
| Engagement rate | 3.5% | 4.1% | 🟢 +17.1% |

## Timeline View

The Timeline view shows your campaign schedule as a Gantt-style chart with:
- Content pieces mapped to dates
- Platform color-coding
- Budget burn-down overlay
- Real-time performance annotations

## Results View

Post-campaign analysis includes:
- Channel-by-channel ROI breakdown
- Top-performing content pieces
- Audience insights gathered
- Recommendations for next campaign

> **Getting Started:** Define your campaign goal first — the Strategist works backwards from your target to recommend tactics, channels, and budget allocation.
`,

  community_builder: `## Overview

Community Builder helps you grow and nurture online communities with automated engagement, member onboarding, and community health tracking.

![Community Growth](https://images.unsplash.com/photo-1529156069898-49953e39b3ac?w=800&h=400&fit=crop&q=80)

## Agents

### Community Manager
Handles day-to-day community operations:
- Monitors conversations for topics that need attention
- Identifies top contributors and advocates
- Flags potential issues before they escalate
- Suggests discussion topics based on community interests

### Welcome Bot
Automates the new member experience:

\`\`\`typescript
const onboardingFlow = {
  steps: [
    {
      trigger: "member_joined",
      action: "send_welcome_dm",
      template: "welcome-intro",
      delay: "0m",
    },
    {
      trigger: "welcome_dm_read",
      action: "suggest_channels",
      personalized: true,
      delay: "5m",
    },
    {
      trigger: "first_post",
      action: "celebrate_publicly",
      template: "first-post-celebration",
      delay: "0m",
    },
    {
      trigger: "7_days_inactive",
      action: "re_engage",
      template: "we-miss-you",
      delay: "0m",
    },
  ],
}
\`\`\`

## Community Health Metrics

| Metric | Healthy | Warning | Critical |
|--------|---------|---------|----------|
| Daily active members | > 20% | 10-20% | < 10% |
| New member retention (7d) | > 60% | 30-60% | < 30% |
| Avg. response time | < 2h | 2-8h | > 8h |
| Sentiment score | > 0.7 | 0.4-0.7 | < 0.4 |

## Member Directory

The Members view provides:
- Searchable directory with engagement scores
- Activity timeline per member
- Contribution leaderboard
- Segmentation by interests and activity level

\`\`\`yaml
member_segments:
  champions:
    criteria: "top 5% by engagement score"
    count: 12
    perks: ["early access", "feedback sessions"]
  active:
    criteria: "posted in last 7 days"
    count: 145
  at_risk:
    criteria: "no activity in 14+ days, previously active"
    count: 23
    action: "re-engagement campaign"
  new:
    criteria: "joined in last 30 days"
    count: 67
    action: "onboarding flow"
\`\`\`

> **Tip:** Start by identifying your top 10 community champions and give them special recognition. Engaged advocates drive organic growth better than any automation.
`,

  inbox_worker: `## Your inbox, managed by AI. You stay in control.

Inbox Worker connects to your Gmail and acts as a smart assistant that searches, reads, and drafts — so you spend less time in email and more time on what matters.

### The idea

Email is where deals happen, decisions get made, and context lives. But managing it is tedious. Inbox Worker doesn't replace Gmail — it sits on top of it. The agent reads your threads, understands context, and drafts replies that sound like you. Nothing sends without your say-so.

### What you can say to the agent

\`\`\`
"Find all emails from Alice in the last month"

"Summarize the thread with Bob about the Q3 proposal"

"Draft a reply to the latest email from Sarah — tell her we're
interested but need to push the timeline by two weeks"

"Show me unread emails with attachments from this week"

"Draft a follow-up to everyone I haven't heard back from in 7 days"

"Label all emails from @acme.com as 'Acme Deal'"
\`\`\`

The agent searches your inbox, reads full conversation threads for context, and creates drafts you can review and send with one click.

### How it works

\`\`\`
                 ┌──────────────────┐
  Your message   │    AI Agent       │
  ─────────────► │    understands    │
                 │    your intent    │
                 └────────┬─────────┘
                          │
                 ┌────────▼─────────┐
                 │   Gmail Module    │
                 │                   │
                 │  search · read    │
                 │  draft  · send    │
                 │  label · organize │
                 └────────┬─────────┘
                          │
                          ▼
                      Gmail API
\`\`\`

The **gmail module** handles all API interactions — OAuth, rate limits, pagination. The agent focuses on understanding your intent and writing contextual emails.

### Views

#### Inbox
Search and browse your Gmail threads directly in the workspace. Filter by sender, date, labels, or keywords. Click into any thread to see the full conversation.

#### Drafts
Review AI-drafted replies before sending. Edit inline, approve, or ask the agent to rewrite. Every draft shows the original thread for context.

### The draft-then-send rule

The agent will never send an email without your explicit confirmation. Every outgoing message goes through:

**Agent drafts** → **You review** → **You say "send"** → **Email sent**

### Getting started

1. **Launch this workspace** — The Gmail app installs automatically.
2. **Connect your Google account** — The platform handles OAuth securely.
3. **Ask the agent** — *"Check my inbox for unread emails from this week"* and go from there.

> **Privacy:** Your email data stays between you and the Gmail API. The agent processes messages in your sandbox — nothing is stored outside your workspace.
`,

  sales_worker: `## Your contacts live in a spreadsheet. Your conversations live in Gmail. This workspace connects them.

Gmail CRM isn't a traditional CRM that forces you into a rigid pipeline. It's two simple tools — **Gmail** and **Google Sheets** — orchestrated by an AI agent that understands your relationships.

### The idea

You already have a customer list somewhere (probably a Google Sheet). You already email them (from Gmail). The missing piece isn't another dashboard — it's someone who reads your spreadsheet, checks your email history, and tells you *"Hey, you haven't talked to Alice in 3 weeks, and last time she was interested in the proposal."*

That's what this workspace does.

### What you can say to the agent

\`\`\`
"Sync my contacts from the sheet"

"Who haven't I talked to in over two weeks?"

"Show me my last conversation with Alice"

"Draft a follow-up to Bob — reference the pricing we discussed"

"Move Alice to closed-won and update the sheet"

"Add a new contact: sarah@company.com, CTO at Acme"
\`\`\`

The agent reads your Sheet for contact data, searches Gmail for conversation history, drafts emails with full context, and sends them after you confirm. Stage changes write back to your Sheet automatically.

### How it works under the hood

\`\`\`
Google Sheets                     Gmail
(your contact list)               (your conversations)
      │                                │
      ▼                                ▼
┌──────────┐    AI Agent    ┌──────────────┐
│ sheets   │◄──────────────►│    gmail      │
│ module   │   orchestrates │    module     │
└──────────┘                └──────────────┘
      │                                │
      ▼                                ▼
  read rows                      search threads
  update cells                   read messages
  append rows                    draft replies
                                 send emails
\`\`\`

There's no separate CRM database. Your Sheet **is** the database. Gmail **is** the communication layer. The agent is the glue.

### Getting started

1. **Prepare your Google Sheet** — First row should be headers: \`Email | Name | Company | Stage | Notes\`. Add your contacts below.
2. **Launch this workspace** — The Gmail and Sheets apps will be installed automatically.
3. **Tell the agent to sync** — Say *"sync my contacts"* and it'll pull everything from your Sheet.
4. **Start managing** — Ask about stale contacts, draft follow-ups, update pipeline stages. All through conversation.

### The draft-then-send rule

The agent will never send an email without your explicit confirmation. Every email goes through:

**Agent drafts** → **You review** → **You say "send"** → **Email sent**

This keeps you in control while letting AI handle the heavy lifting of reading context, writing copy, and tracking follow-ups.

> **Pro tip:** Your Sheet is the single source of truth for contacts. Edit it directly anytime — bulk imports, manual tweaks, sharing with teammates. The agent syncs on demand, never overwrites your changes.
`,
};
