// Demo recordings for the README screenshots. Every name, company and figure is invented.
// `match` is a word found in the title; `lines[0]` must be unique (the stub uses it to find the recording).

export const DEMO_RECORDINGS = [
    {
        title: "Q4 Planning Sync",
        slug: "q4-planning-sync",
        match: "Planning",
        starred: true,
        lines: [
            { speaker: "A", text: "Okay, let's get started. The goal today is to lock the Q4 roadmap and agree on what we can ship before the holiday freeze." },
            { speaker: "B", text: "Sounds good. Engineering capacity is about 70 percent of last quarter because of the migration work, so I would cut the bulk export rework." },
            { speaker: "A", text: "Agreed. What about the pricing page experiments? We should run them before the November launch." },
            { speaker: "B", text: "I can own that. Event tracking has to land first, so that is the dependency to watch." },
            { speaker: "A", text: "Let's make that the first milestone. I will update the roadmap doc and share it with the team by Friday." },
        ],
        summary:
            "The team agreed to focus Q4 on onboarding polish and the pricing page experiments. The bulk export rework moves to Q1 because engineering capacity is lower during the database migration. Event tracking is the dependency for the pricing tests.",
        keyPoints: [
            "Q4 focus is onboarding polish and pricing experiments",
            "Bulk export rework moves to Q1",
            "Event tracking must land before the pricing tests",
        ],
        actionItems: ["Update the Q4 roadmap doc and share it by Friday", "Set up event tracking for the pricing page"],
    },
    {
        title: "Customer Interview — Lena",
        slug: "customer-interview-lena",
        match: "Interview",
        lines: [
            { speaker: "A", text: "Thanks for making time, Lena. Walk me through how you used the library last week." },
            { speaker: "B", text: "Mostly I search for a client name. Titles help, but the summary should show the action items without opening the recording." },
            { speaker: "A", text: "That is useful. Did the transcript timestamps help when you needed a quote?" },
            { speaker: "B", text: "Yes, clicking a line jumps the player, which saved me a lot of scrubbing. Exporting to a document is the next thing I would want." },
            { speaker: "A", text: "Great. We will look at a document export and better search across summaries." },
        ],
        summary:
            "Lena uses the library mainly to find recordings by client name and wants summaries to surface action items. Clickable transcript timestamps save time, and exporting to a document is her next request.",
        keyPoints: [
            "Search by client name is the main workflow",
            "Summaries should show action items at a glance",
            "Clickable timestamps save scrubbing time",
        ],
        actionItems: ["Scope a document export prototype", "Prioritize search across summaries"],
    },
    {
        title: "Onboarding Design Review",
        slug: "design-review-onboarding",
        match: "Onboarding",
        lines: [
            { speaker: "A", text: "Thanks for joining. We are reviewing the new onboarding flow, mainly the first-run checklist and the provider step." },
            { speaker: "B", text: "The checklist feels long. Users drop off after the third item, so I would collapse the optional steps into one Finish later action." },
            { speaker: "A", text: "Good point. The provider step needs clearer copy too, people do not know why an AI key is needed." },
            { speaker: "B", text: "I will write two alternative headlines and test them in the next round of prototypes." },
            { speaker: "A", text: "Let's ship the collapsed checklist behind a flag and review drop-off after one week." },
        ],
        summary:
            "The design review focused on the onboarding checklist, which loses users after the third step. The team agreed to collapse optional steps and explain why an AI provider is needed. The collapsed checklist ships behind a flag for one week before the drop-off numbers are reviewed.",
        keyPoints: [
            "Checklist drop-off is highest after step three",
            "Optional steps collapse into one Finish later action",
            "The provider step needs clearer copy",
        ],
        actionItems: ["Write two alternative headlines for the provider step", "Review drop-off numbers one week after launch"],
    },
    {
        title: "Weekly Standup",
        slug: "weekly-standup",
        match: "Standup",
        lines: [
            { speaker: "A", text: "Quick round. I finished the sync retry fix and it is in review, so the import should be stable this week." },
            { speaker: "B", text: "I am still on waveform rendering for long recordings. Anything over an hour is slow to draw, so I am caching the peaks." },
            { speaker: "A", text: "Any blockers?" },
            { speaker: "B", text: "Only the sign-in test account, but it was unblocked yesterday." },
            { speaker: "A", text: "Great. Let's keep the standup short and meet again Thursday for the release notes." },
        ],
        summary:
            "The sync retry fix is in review, and waveform rendering for long recordings is being optimized with cached peaks. No blockers remain, and the team will review release notes on Thursday.",
        keyPoints: [
            "Sync retry fix is in review",
            "Waveform peaks are cached for long recordings",
            "No blockers remain",
        ],
        actionItems: ["Review the sync retry pull request", "Draft release notes for Thursday"],
    },
    {
        title: "Investor Call Prep",
        slug: "investor-call-prep",
        match: "Investor",
        lines: [
            { speaker: "A", text: "Before the investor call on Thursday, let's agree on the three numbers we lead with: weekly active users, recordings processed and retention." },
            { speaker: "B", text: "Retention is the strongest story. Four-week retention for teams that summarize recordings is about 60 percent." },
            { speaker: "A", text: "We should be careful with the growth line, since the early cohort skews toward the first beta." },
            { speaker: "B", text: "Agreed. I will add a slide on the desktop app and local-first storage, because that answers the privacy question they asked last time." },
            { speaker: "A", text: "Perfect. Send me the draft deck tonight and we will rehearse the first five minutes." },
        ],
        summary:
            "The team chose three headline metrics for the investor call: weekly active users, recordings processed and retention. Retention is the strongest story, and growth figures need context because of the beta cohort. A slide on the local-first desktop app answers the privacy question.",
        keyPoints: [
            "Lead with weekly active users, recordings processed and retention",
            "Retention for summarizing teams is about 60 percent",
            "Growth numbers need beta cohort context",
        ],
        actionItems: ["Draft the deck and send it tonight", "Rehearse the opening five minutes on Wednesday"],
    },
    {
        title: "Pricing Experiment Retro",
        slug: "pricing-experiment-retro",
        match: "Retro",
        lines: [
            { speaker: "A", text: "Let's review the pricing page test. Variant B lifted trial starts by 12 percent, but the sample was small." },
            { speaker: "B", text: "The annual plan click-through is the number I trust most. It doubled on the highlighted card." },
            { speaker: "A", text: "Should we ship it?" },
            { speaker: "B", text: "I would extend the test one more week to get a clean read on conversion, then decide." },
            { speaker: "A", text: "Fine. Let's document the setup so the next experiment starts from the same event schema." },
        ],
        summary:
            "The retrospective reviewed the highlighted-card test: trial starts rose 12 percent and annual plan clicks doubled. The team will extend the test by one week for a clean conversion read and document the event schema for future experiments.",
        keyPoints: [
            "Trial starts rose 12 percent in variant B",
            "Annual plan clicks doubled on the highlighted card",
            "One more week of data before deciding",
        ],
        actionItems: ["Extend the pricing test by one week", "Document the experiment event schema"],
    },
];
