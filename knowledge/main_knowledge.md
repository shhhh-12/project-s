# Sales Call Evaluation Knowledge Pack

Version 1.0 | Status: MVP | Active module: Inbound B2C | All other modules written but DISABLED

## 0. How to use this pack

Each section marked FILE maps to one markdown file in your /knowledge folder. Your code loads the core files plus the rubric for the enabled module, and builds the prompt from them. To enable a disabled module later, flip its flag in config, review its weights, and run your golden set. Nothing is rewritten from scratch.

```yaml
version: 1.0
segments:
  b2c: enabled
  b2b: disabled
call_types:
  inbound_lead: enabled        # customer enquired or filled a form
  outbound_cold: disabled
  discovery_b2b: disabled
  demo: disabled
  negotiation_closing: disabled
  follow_up: disabled
  renewal_upsell: disabled
```

Prompt assembly order: short system prompt (role, rules, output schema) + core\_fundamentals + scoring\_system + the enabled call type file + the segment file. Always stamp the pack version, prompt version and model name on every result.

---

## 1. FILE: core\_fundamentals.md (applies to every call type)

### 1.1 Universal call structure

Prepare, Open, Discover, Present, Handle objections, Close, Follow up. Every call type uses these stages. What changes between call types is the weight and the expectation of each stage.

### 1.2 The ten fundamentals

1. **Preparation and context awareness.** The rep knows who they are calling, what the person enquired about, and the history. Failure: asking things the customer already wrote in the form.
2. **Opening and rapport.** Clear greeting, name, company, reason for call, a warm and natural tone, and a quick check that the timing is okay. Failure: robotic script, rushing to the pitch.
3. **Control and agenda.** The rep frames the call ('I will ask a few questions, then suggest the best option') and steers the conversation without dominating it.
4. **Discovery questioning.** Open questions that uncover situation, problem, impact and desired outcome. The SPIN model (Situation, Problem, Implication, Need-payoff) is the reference. Failure: jumping to the pitch, only yes/no questions.
5. **Active listening.** Paraphrasing, acknowledging, using the customer's own words, comfortable pauses, no interrupting. Failure: talking over, ignoring a stated need.
6. **Tailored value presentation.** Features are connected to the specific needs the customer stated. Failure: generic pitch, feature dumping.
7. **Objection handling.** LAER: Listen, Acknowledge, Explore, Respond. The rep finds the real concern before answering. Failure: arguing, instantly discounting, ignoring the objection.
8. **Closing and commitment.** Asks for the decision or books a specific next step with a date and time. Failure: ends with 'I will call you later', no next step, never asks.
9. **Tone, pace and confidence.** Clear, steady, enthusiastic but not pushy, no excessive filler words.
10. **Compliance and honesty.** Accurate claims, no false urgency, no pressure tactics, respects opt-out requests, handles personal and payment data properly.

### 1.3 Critical red flags (apply to every call type)

- False or unverifiable claims, guaranteed outcomes, invented discounts or deadlines.
- Manipulative pressure or fake scarcity.
- Ignoring a clear 'not interested' or 'do not call' request.
- Disparaging competitors with unsupported claims.
- Misleading about price, fees, contract terms or cancellation.
- Mishandling sensitive data (asking for card or ID details in an unsafe way).
- Rudeness, mocking, or talking over the customer repeatedly.

Any critical red flag triggers the gate rule in the scoring system.

### 1.4 Framework glossary (so the model uses consistent terms)

| Framework | Use |
| --- | --- |
| SPIN | Discovery questioning structure |
| LAER | Objection handling |
| BANT | Qualification: Budget, Authority, Need, Timeline |
| MEDDIC | B2B qualification: Metrics, Economic buyer, Decision criteria, Decision process, Identify pain, Champion |
| Challenger | Teach and reframe the customer's thinking (mostly B2B) |
| Sandler | Up-front contracts, pain-first selling |
| Feel-Felt-Found | Empathy based objection response |
| Assumptive close | Proceeding as if the decision is made ('Shall I set that up for Friday?') |
| Alternative close | Choice between two yes options ('Plan A or Plan B?') |
| Trial close | Checking temperature mid-call ('How does that sound so far?') |

---

## 2. FILE: scoring\_system.md

### 2.1 Scale (used for every criterion)

| Score | Meaning |
| --- | --- |
| 0 | Absent, or done in a harmful way |
| 1 | Attempted but weak or mechanical |
| 2 | Solid, with clear gaps |
| 3 | Strong, natural and effective |

Each criterion has its own anchored descriptions of 0 to 3 in the call type file. The model must match the transcript to the anchor, not to a general feeling.

### 2.2 Rules the model must follow

1. Write the evidence first (exact quote plus timestamp), then the score. A score without a quote is invalid.
2. Score the process, not the outcome. A closed sale with weak discovery still gets a low discovery score. A lost sale with excellent technique can score high.
3. If a criterion did not apply (for example, the customer raised no objection), mark it N/A. Do not invent a score.
4. If the transcript is unclear or evidence is missing, lower the confidence, do not guess.
5. Do not reward length or enthusiasm on their own.
6. Do not calculate totals. Code does that.

### 2.3 Total score calculation (done in code)

```
criterion_pct = score / 3
total = sum(weight x criterion_pct) / sum(weights of applicable criteria) x 100
```

N/A criteria are removed and the remaining weights are renormalized.

### 2.4 Gate rules

- Critical red flag present: total is capped at 50 and the call is marked FAIL on compliance regardless of other scores.
- Compliance criterion scored 0: same cap.

### 2.5 Grade bands

| Total | Band |
| --- | --- |
| 85 to 100 | Excellent |
| 70 to 84 | Good |
| 55 to 69 | Needs improvement |
| Below 55 | Poor |

Bands are starting points. Calibrate them against your golden set.

### 2.6 Confidence flag

Set confidence to low when audio is poor, diarization looks wrong, the call is under 2 minutes, or the transcript has many unclear segments. Low-confidence results are shown with a warning.

---

## 3. FILE: call\_types/inbound\_lead.md (ENABLED) with segments/b2c.md

### 3.1 Context of this call type

The customer enquired or filled a form, and the lead was assigned to a rep. The customer is warm and expects contact, but may have forgotten, may be comparing options, and loses interest fast. The rep has one main chance, so the goals of the call are: confirm interest, understand the real need, match the right offer, handle concerns, and either close or lock a specific next step.

B2C characteristics: one person (or a household) decides, often within hours or days, emotion and trust matter as much as logic, price sensitivity is high, and a family member may need to agree.

Inbound-specific expectations:

- Speed to lead: the quicker the first call after the enquiry, the better the conversion (metadata, scored in code, see 3.5).
- The rep must reference the enquiry and not start cold.
- The rep must not treat the lead like a cold prospect, but also must not assume the sale is made.

### 3.2 Criteria and weights

| # | Criterion | Weight |
| --- | --- | --- |
| 1 | Opening and rapport | 10 |
| 2 | Lead context and intent verification | 10 |
| 3 | Discovery and need analysis | 20 |
| 4 | Active listening and conversation control | 10 |
| 5 | Solution presentation and value fit | 15 |
| 6 | Objection handling | 15 |
| 7 | Closing and next step | 15 |
| 8 | Compliance and professionalism | 5 |
|  | Total | 100 |

### 3.3 Anchored scales

**1. Opening and rapport**

- 0: No introduction, or rude or confusing start.
- 1: Introduces self but scripted, no warmth, no check on timing.
- 2: Clear intro, friendly tone, states reason for call.
- 3: Warm, natural, confirms the person has time, sets a simple agenda for the call.

**2. Lead context and intent verification**

- 0: Does not mention the enquiry at all, treats it like a cold call.
- 1: Mentions the enquiry but asks for information already given in the form.
- 2: References the enquiry and confirms what the customer was looking for.
- 3: References the enquiry specifically, confirms the intent and urgency (why now, what triggered it), and uses the form details without repeating them.

**3. Discovery and need analysis**

- 0: No discovery questions, jumps to pitch.
- 1: Only surface-level or closed questions.
- 2: Explores the need and the problem, but not the impact, urgency, or decision factors.
- 3: Uncovers need, why it matters, what happens if unsolved, budget range, timeline and who else is involved in the decision, using open questions.

**4. Active listening and conversation control**

- 0: Talks over the customer, ignores what is said, or loses control of the call.
- 1: Listens partly, interrupts, or lets the customer drive with no structure.
- 2: Mostly listens, acknowledges points, keeps reasonable structure.
- 3: Paraphrases and uses customer language, handles pauses well, balanced talk time, smoothly steers the flow.

**5. Solution presentation and value fit**

- 0: Generic or inaccurate pitch, or no pitch.
- 1: Lists features without linking them to the customer's needs.
- 2: Links most features to stated needs, but benefits are not specific.
- 3: Recommends a fitting option, ties each benefit to the customer's own words, explains price clearly with value, and checks understanding.

**6. Objection handling** (N/A if no objection was raised)

- 0: Ignores, argues, or pressures.
- 1: Gives a canned answer or immediately drops the price.
- 2: Acknowledges and answers, but does not explore the root concern.
- 3: Acknowledges, asks what is behind the concern, answers with relevant evidence or an alternative, and confirms the concern is resolved.

**7. Closing and next step**

- 0: No attempt, call ends vaguely.
- 1: Weak attempt ('let me know if interested').
- 2: Asks for the decision or suggests a next step, but without a specific time or commitment.
- 3: Summarizes agreement, asks for the decision confidently, or books a specific next step with date, time and owner, and confirms how the customer will be reached.

**8. Compliance and professionalism**

- 0: Any critical red flag (see core fundamentals 1.3).
- 1: Minor issues such as unclear pricing details or one slightly pushy moment.
- 2: Honest and professional, small gaps (for example, forgot to confirm consent for follow-up).
- 3: Fully accurate, transparent about price and terms, respectful, handles data properly.

### 3.4 Common B2C objections and what good handling looks like

| Objection | Good handling |
| --- | --- |
| 'It is too expensive' | Ask what they are comparing it with, restate value tied to their need, offer a fitting alternative or payment option. Do not discount first. |
| 'I need to think about it' | Ask what specifically they want to think about, resolve it now, or book a dated follow-up. |
| 'I need to talk to my family' | Identify the decision maker, offer to include them, summarize the points to share, and book a follow-up time. |
| 'I am comparing other options' | Ask what matters most in the comparison, differentiate on those points without bashing. |
| 'I do not trust / not sure about this' | Offer proof (reviews, guarantees, clear terms), slow down, avoid pressure. |
| 'Not now' | Ask about timing, confirm what would make it the right time, schedule a check-in. |
| 'I was just enquiring' | Respect it, give clear information, ask permission for a follow-up. |

### 3.5 Objective metrics (computed in code, passed to the model as facts)

| Metric | Starting benchmark for inbound B2C (calibrate later) |
| --- | --- |
| Rep talk ratio | 40 to 55 percent |
| Questions asked by rep | 8 or more in a call over 8 minutes |
| Longest rep monologue | Under 60 to 90 seconds |
| Customer questions answered | All answered |
| Filler words per minute | Under 3 |
| Interruptions by rep | Fewer than 3 |
| Call duration | Track by outcome, not a fixed target |
| Speed to lead (form submitted to first call) | Under 5 minutes is strong, over 24 hours is weak |
| Next step set | Yes or no |

These are heuristics. Replace them with numbers from your own best calls once you have data.

### 3.6 Inbound B2C red flags (in addition to 1.3)

- Claiming a discount or offer that does not exist.
- Creating false urgency ('only today').
- Not disclosing fees or contract terms.
- Continuing after the customer says they are not interested.
- Collecting payment details without a clear and safe process.

---

## 4. Other call types (DISABLED, ready to enable)

Each block lists the goal, the weight changes versus the inbound B2C table, and what the rubric must emphasize. When enabling, write the anchored 0 to 3 scales for the new criteria in the same style as section 3.3, then validate on the golden set.

### 4.1 FILE: call\_types/outbound\_cold.md (DISABLED)

Goal: earn attention fast and book a meeting or take a first step.

| Criterion | Weight |
| --- | --- |
| Opening hook and permission | 25 |
| Relevance and research | 10 |
| Discovery (short) | 15 |
| Objection handling ('not interested', 'send an email') | 25 |
| Next step or meeting booked | 20 |
| Compliance | 5 |

Emphasize: first 30 seconds, pattern interrupt, resilience after the first no, call-to-action clarity, compliance with do-not-call rules.

### 4.2 FILE: call\_types/discovery\_b2b.md (DISABLED)

Goal: qualify and build the case for a deal with multiple stakeholders.

| Criterion | Weight |
| --- | --- |
| Opening and agenda setting | 10 |
| Pain and business impact (quantified) | 25 |
| Qualification (MEDDIC or BANT coverage) | 20 |
| Stakeholder and decision process mapping | 15 |
| Active listening | 10 |
| Next step with mutual commitment | 15 |
| Compliance | 5 |

Emphasize: economic buyer identified, champion built, metrics and decision criteria captured, timeline and budget process, multi-threading intent.

### 4.3 FILE: call\_types/demo.md (DISABLED)

Goal: show how the product solves the pains found in discovery.

| Criterion | Weight |
| --- | --- |
| Recap of discovery and agenda | 15 |
| Tailored demo (show relevant pains only) | 25 |
| Engagement and interaction | 15 |
| Handling questions and objections | 15 |
| Value and ROI articulation | 15 |
| Next steps | 10 |
| Compliance | 5 |

Emphasize: no feature tour, stories tied to the customer's words, checking understanding, avoiding long monologues.

### 4.4 FILE: call\_types/negotiation\_closing.md (DISABLED)

Goal: agree on terms and close without destroying margin or trust.

| Criterion | Weight |
| --- | --- |
| Value reinforcement before price | 20 |
| Handling price and terms pressure | 25 |
| Trading concessions (give and get) | 15 |
| Decision process and timeline confirmation | 15 |
| Closing and mutual action plan | 20 |
| Compliance | 5 |

Emphasize: never discount without getting something back, anchoring, silence after stating price, written next steps.

### 4.5 FILE: call\_types/follow\_up.md (DISABLED)

Goal: move an existing opportunity forward.

Weights: reference to previous conversation 15, new value or reason to talk 25, progress on open concerns 25, urgency without pressure 15, next step 15, compliance 5.

### 4.6 FILE: call\_types/renewal\_upsell.md (DISABLED)

Goal: retain and expand an existing customer.

Weights: account health and outcomes review 25, listening for new needs 20, expansion fit 20, risk and churn handling 20, next step 10, compliance 5.

---

## 5. FILE: segments (B2C enabled, B2B disabled)

| Dimension | B2C (ENABLED) | B2B (DISABLED) |
| --- | --- | --- |
| Decision maker | One person or household | Committee of several stakeholders |
| Sales cycle | Minutes to days | Weeks to months |
| Main drivers | Emotion, trust, price, convenience | Business case, risk, ROI, politics |
| Qualification | Need, budget, timeline, who else decides | MEDDIC or BANT, economic buyer, champion |
| Discovery depth | Personal need and impact | Business impact, quantified metrics |
| Calls per deal | Often 1 to 2 | Usually 3 to 8 |
| Close style | Direct ask on the call or booked follow-up | Mutual action plan, next meeting |
| Objections | Price, trust, family, timing | Budget cycle, integration, security, competitor, internal approval |
| Key score emphasis | Rapport speed, listening, direct close | Multi-threading, business case, stakeholder mapping |
| Tone | Friendly, simple language | Consultative, credible, precise |

To enable B2B: set b2b to enabled, add the B2B segment file with the rows above as guidance, and enable the relevant call types in section 4.

---

## 6. Output schema (validate every response)

Shown as YAML for readability, implement it as a JSON schema.

```yaml
call_type: inbound_lead
segment: b2c
pack_version: 1.0
criteria:
  - id: discovery
    evidence:
      - quote: ''
        timestamp: '00:00'
        speaker: rep
    reasoning: ''
    score: 0-3 or null   # null means N/A
red_flags:
  - type: ''
    quote: ''
    timestamp: ''
key_moments:
  - timestamp: ''
    note: ''
confidence: high | medium | low
```

Code adds: objective metrics, total score, band, gate result, model name, prompt version, pack version. Coaching feedback (top 3 strengths, top 3 improvements, one concrete suggested phrase) is generated in a separate call using the scores as input.

---

## 7. Improvement loop and maintenance

1. Golden set: 30 to 50 calls scored by an experienced human, stored with their evidence quotes. Include strong, average, and poor calls, and a few tricky ones (no objections, very short calls, angry customers).
2. Eval script: after any change to the pack, prompt or model, rerun the golden set and record agreement (exact match, within 1 point, correlation per criterion).
3. Feedback capture: users can mark a score as wrong and state the correct score and why. Store each correction with the transcript snippet.
4. Monthly review: look at the biggest disagreements, find the rubric anchor that was unclear, and rewrite it. Add the corrected cases to the golden set.
5. Changelog: record every change below with the date, what changed and the eval result.
6. Later options: few-shot examples retrieved from corrected cases (RAG), a company-specific playbook file per client, and fine-tuning a smaller model once you have thousands of corrected scores.

### Changelog

| Version | Date | Change | Golden set agreement |
| --- | --- | --- | --- |
| 1.0 | 2026-10-15 | Initial pack, inbound B2C enabled | not yet measured |

---

## 8. FILE: language\_handling.md (Tanglish and English calls)

Most of your calls mix Tamil and English, often switching mid-sentence. This changes the transcription step more than the rubric, and it needs a few extra rules in the scoring prompt.

### 8.1 Transcription (the biggest accuracy risk)

The scoring model can only be as good as the transcript. Bad transcription of Tanglish will look like bad sales skill.

1. **Test before you commit.** Take 5 to 10 real calls, have a Tamil speaker write the correct transcript for a 2 to 3 minute stretch of each, and compare candidate speech-to-text services on word error rate. Candidates to test: Whisper large-v3 (hosted), AssemblyAI, Deepgram, Google or Azure speech, and an India-focused service such as Sarvam AI. Check each one's current Tamil and code-mixing support and pricing, since this changes often.
2. **Prefer two-channel recordings if you can get them.** If your telephony provider records rep and customer on separate channels, you get perfect speaker separation for free, and talk ratio and interruption metrics become reliable. Mono recordings need diarization, which is less accurate on phone audio.
3. **Pick one transcript script and stay consistent.** Either Tamil script for Tamil words, or romanized Tanglish for everything. Romanized text is usually easier for LLMs to quote and for you to debug. Do not mix both in one pipeline.
4. **Add a normalization step.** A cheap model call that fixes obvious spelling variants (for example the many ways of writing the same Tamil word in English letters) and produces a short English gloss for each line. Keep the original line as the evidence quote and use the gloss only to help the scorer.
5. **Pass a hint vocabulary** (product names, plan names, common Tamil business terms) to the speech-to-text service if it supports custom vocabulary.

### 8.2 Rules to add to the scoring prompt

- The transcript is code-mixed Tamil and English. Do not penalize code-switching. It is natural and often builds rapport.
- Quotes used as evidence must be copied from the original transcript. Reasoning is written in English.
- If a line is unclear because of transcription quality, do not score against it. Lower the confidence instead.
- Judge meaning, not grammar. Informal speech is normal in this market.
- Respectful address matters for rapport. Appropriate use of respectful forms (for example sir, madam, and the polite you rather than the casual you in Tamil) counts toward Opening and rapport. Casual address to a stranger counts against it.
- Filler words are counted in code, using a Tamil and English filler list, not by the model.

### 8.3 Tanglish phrases the model should recognize

Give the scorer a short glossary so it does not miss objections or buying signals. Extend this from your own call data.

| Customer says (romanized, typical forms) | Meaning | Treat as |
| --- | --- | --- |
| romba costly, price jaasthi | Too expensive | Price objection |
| yosichu solren, konjam time venum | I will think and tell you | Stall, probe the real concern |
| veetla pesitu solren | I will discuss at home | Family or decision maker objection |
| apram paakalam, later pannalam | Let us see later | Timing objection |
| interest illa, venam | Not interested, do not want | Rejection, check for compliance on opt-out |
| vera edathula kekkuren | I am checking elsewhere | Competitor comparison |
| seri, okay pannalam | Okay, we can do it | Possible buying signal, rep should close |
| details anuppunga | Send the details | Often a polite brush-off, rep should still set a next step |

The rep should be scored on whether they probe and respond to these, not on whether they spoke in a specific language.

### 8.4 Golden set and human scoring

- The human scorer for your golden set must speak Tamil and English fluently, and ideally have sales experience.
- Include calls with heavy code-mixing, noisy audio, and fast speech in the golden set, so your eval shows where the pipeline breaks.
- Track agreement separately for the transcription step (word error rate) and the scoring step. If the scores disagree with humans, check the transcript first before changing the rubric.

### 8.5 Model choice for the scoring step

Test two or three models on your Tanglish golden set via OpenRouter and compare. Strong general models usually read romanized Tamil reasonably well, but this varies, so measure it on your own calls and pin the winning model version.
