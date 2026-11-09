# RU Deep Cuts

A daily answer game for Rutgers–New Brunswick. You get three prompts a day, such as "Name a dining hall" or "Name a bus route." Give one correct answer to each. The fewer players who give the same answer, the more points it earns.

Play it here: https://claude.ai/artifact/7CRMVZpt7miYDuweCBkgs5

## How answer frequency is decided

- Every answer starts with a **baseline weight**: an estimate of how often a Rutgers student would say it. These weights are in the `BANK` array in `index.html`.
- The baseline counts as **25 imaginary players**. Every real player's answer is added on top of it:
  `share = (25 × baseline_share + real_count) / (25 + real_players)`
- Points = `15 × log2(1 / share)`, capped at 100 per prompt and 300 per day.
- Early in the day the baseline does most of the work. After a few hundred players, the real answers decide almost everything.

## How the three daily prompts are chosen

- Every player gets the same three prompts, and they change at midnight Eastern.
- The question bank is shuffled once per cycle with a fixed seed, then handed out three per day. Nobody sees a repeat until the whole bank has been used.
- A scheduled set for a specific date overrides the bank. It is stored in the page's database at `schedule/<YYYY-MM-DD>` as `{questions: [{prompt, hint, answers: [[name, weight, ...aliases]]}]}`, and only editors can write it.

## Data

Each player's answers are stored at `plays/<player id>` under `days.<date>`. Everyone can read them, and each player can write only their own. Running this file outside claude.ai has no live crowd, so scoring falls back to the baseline estimates.
