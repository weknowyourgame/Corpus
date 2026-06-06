# Evals for Corpus — Explained Simply

A plain-English guide to what evals are, why Corpus needs them, and how we'll set them up.

---

## 1. What is an "eval"? (start here)

An **eval** (short for *evaluation*) is just an **automated test for an AI**.

Think of it like an exam:

- You give the AI a **task** ("make the cars in this game 2x faster").
- The AI does its thing.
- A **checker** looks at the result and decides: did it actually work? ✅ or ❌

That's it. An eval is one question + one answer key. Run a bunch of them and you get a **score** ("Corpus passed 17 out of 20 tasks").

### Why not just "try it and see"?

Because "looks good to me" doesn't scale and isn't trustworthy. Evals give you:

- **A number.** "82% pass rate" instead of a vibe.
- **Repeatability.** Run the same tasks next week and see if you got better or worse.
- **No cheating yourself.** The checker is strict and automatic — it doesn't get impressed by code that *looks* right but doesn't work.
- **Comparisons.** Test Claude vs GPT vs your tier setups on the exact same tasks.

### A regular test vs an AI eval

| Normal software test | AI eval |
|---|---|
| Checks exact code output | Checks the *outcome* (AI can solve it many valid ways) |
| Pass/fail is obvious | Often needs a smart checker to judge "is this good enough?" |
| Same result every time | AI can answer differently each run, so you run several times |

---

## 2. The 3 pieces every eval needs

Any eval — for Corpus or anything else — is made of three parts:

1. **The task** — the prompt/instruction given to the AI ("add a working shop GUI").
2. **The agent under test** — the AI being graded. *For us, this is Corpus* (your full agent: tools, RAG, prompts, the works).
3. **The checker** — code that inspects the result and says pass or fail ("does a ShopGui exist with a working buy button?").

A **harness** (or "eval runner") is the machinery that glues these together: it feeds the task to the agent, waits, then runs the checker, and tallies the score.

```
  TASK  ──►  AGENT (Corpus)  ──►  RESULT  ──►  CHECKER  ──►  ✅ / ❌
                                                              │
                                          run 20 of these ──► SCORE: 17/20
```

---

## 3. Why this is tricky for Corpus specifically

Corpus isn't a chatbot that returns text. It **changes a real Roblox game** — creates instances, edits scripts, sets properties — all *inside Roblox Studio* via your plugin.

So the checker can't just read a text answer. It has to look **inside the live Studio game** and verify the actual change happened ("is the car's speed attribute really doubled?"). 

**Only your Studio plugin can see inside Studio.** That's the key constraint that shapes everything below.

---

## 4. Why we can't just use Roblox's OpenGameEval

Roblox made a Roblox-specific eval set called **OpenGameEval**. Sounds perfect — but there's a catch:

- You hand it your **API key** and a model name (claude / gemini / openai).
- **Roblox runs the model on their own servers, inside their own agent setup.**
- There's no way to point it at *your* bridge. (The setting that would allow it, `--llm-url`, is explicitly "not supported yet.")

**Result:** OpenGameEval tests the bare model (Claude by itself, wrapped in *Roblox's* scaffolding). It does **not** test Corpus — none of your tools, RAG, system prompts, or recovery logic ever run. So the score wouldn't tell you anything about how good *your product* is.

**But** — the good part — OpenGameEval's actual **task files are open source** (sitting in `open-game-eval/Evals/`). The prompts, the test game worlds, and the pass/fail checks are all free to read and reuse. We just won't use their *runner*.

---

## 5. The plan: reuse their tasks, run them through Corpus

We take the **best of both**:

- **Their tasks** (well-designed, free) →
- **Our runner** (so *Corpus* is the thing being graded) →
- **Their checks**, run through **your plugin** (the only thing that can see inside Studio).

### How it'll flow

```
┌──────────────────────────────────────────────────────────────┐
│  1. Eval harness picks a task                                │
│     e.g. "Make the cars 2x faster" (from OpenGameEval files) │
└───────────────────────────┬──────────────────────────────────┘
                            │  sends the prompt to your bridge
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  2. Corpus runs for real                                     │
│     POST /agent/conversations/:id/runs                       │
│     → your agent thinks, calls tools, edits the game         │
│     → Studio plugin actually applies the changes             │
└───────────────────────────┬──────────────────────────────────┘
                            │  Corpus finishes
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  3. Checker verifies the outcome                             │
│     runs the task's check function INSIDE Studio             │
│     "is the speed attribute really doubled?"                 │
└───────────────────────────┬──────────────────────────────────┘
                            │
                            ▼
                    ✅ Pass  or  ❌ Fail
              (repeat for all tasks → final score)
```

### What each piece will be

| Piece | What we'll use |
|---|---|
| **Tasks** | Copied/adapted from `open-game-eval/Evals/*.lua` |
| **Test game worlds** | The Roblox placefiles those tasks expect (e.g. `racing.rbxl`) |
| **Agent under test** | Corpus, via your existing `/agent/conversations/:id/runs` endpoint |
| **Checker** | The task's `check_scene` / `check_game` functions, run through your Studio plugin |
| **Harness/runner** | A small script (or a tool like **Inspect AI**) that drives the loop and tallies scores |

---

## 6. What you'll get out of it

Once it's running, you'll be able to do things like:

```
$ run-corpus-evals

001_make_cars_faster      ✅ Pass
002_add_shop_gui          ✅ Pass
003_fix_remote_security   ❌ Fail
...
Corpus score: 17/20 (85%)
```

And then:

- See if a prompt change made Corpus **better or worse** (re-run, compare numbers).
- Compare **free vs pro vs ultra** tiers on identical tasks.
- Catch **regressions** before they ship.
- Eventually run it in **CI** so every change gets scored automatically.

---

## 7. Words you'll see (mini glossary)

- **Eval** — one automated AI test (task + checker).
- **Harness / runner** — the program that runs evals and tallies scores.
- **Task / scenario** — the instruction given to the AI.
- **Checker / scorer** — code that decides pass/fail.
- **Pass rate** — % of tasks the agent got right.
- **Regression** — when a change accidentally makes things worse.
- **Placefile (`.rbxl`)** — a saved Roblox game world used as the test environment.
- **Reference mode** — running a task with a known-correct answer (to test the eval itself, not the AI).

---

## 8. Next step

The first concrete build: **wire up ONE task end-to-end** — `001_make_cars_faster` — running through real Corpus, with the check verifying the result in Studio. Once one works, adding the rest is copy-paste.

> This doc is the "why and how." The actual code comes next.
