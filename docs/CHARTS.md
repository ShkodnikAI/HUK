# How the charts work (plain language)

HUK's rankings are deterministic, explainable algorithms — no AI decides
chart positions (AGENTS.md §2). This page explains every signal that feeds
the scores. The API renders this file (H-305).

## What counts, and how much

| Signal | Weight | Notes |
|---|---|---|
| A like | +1 | |
| A dislike | −1 | Never shown publicly; never removes a track from the air |
| Added to a public playlist | +1.5 | The track was deliberately chosen |
| Listened to ≥ 80 % | +0.5 | Once per listener per UTC day |
| Listened to ≥ 80 % on another day | +0.5 | Coming back matters more than a single sit-through |
| Skipped early in a personal playlist | −0.5 | The listener chose the track and still skipped it |

Every signal is multiplied by the listener's **reputation** (new accounts
start at 0.2 and reach 1.0 after 14 days) and by a **time decay** with a
7-day half-life: yesterday's signal weighs twice as much as one from two
weeks ago. A score is therefore mostly about *recent* listening.

## From signals to a score

Positive and negative weights are pooled, and the score is the lower bound
of a 95 % confidence interval over them (a Wilson bound, continuity
corrected for small numbers). In plain language: **a track must prove
itself**. 5 likes on a fresh track score lower than 199 likes out of 200
on an established one, because the interval for 5 votes is wide.

A track needs at least **10 distinct voters** to enter a chart; below that
its published score is 0 (it can still be scheduled by the station).

## Anti-fraud v1

Cheap, deterministic rules run daily; a flagged vote weighs exactly 0:

- **Vote burst** — at least 5 votes on one track within 10 minutes from an
  account younger than 3 days;
- **IP cluster** — more than 2 votes on one track in one day from the same
  rotating IP hash.

New accounts rise to full trust over 14 days (0.2 at birth, 1.0 at day 14).
Flags are internal (never exposed), and every flag batch is audited.

## Where the score is used

- **Charts (H-305)**: top-100 per category from the `TrackScore` table.
- **Station scheduling**: the `top` pool plays the highest scores; the
  `fresh` pool (tracks younger than 14 days) is sampled from each track's
  like/dislike record (Thompson sampling) — new tracks get a real chance,
  proven tracks play more.
