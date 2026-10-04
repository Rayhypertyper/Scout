# Scout OpenAI extraction fallback

Scout can ask OpenAI to recover role details only when the page's deterministic
extractors leave a job unsupported or a supported field unknown. The recovered
values still pass through Scout's normal role classification, location checks,
application-link resolution, validation, deduplication, and storage path. User
preferences do not control crawl extraction or canonical admission.

OpenAI may only return facts supported by exact text on the fetched page. Scout
checks each quoted span against that page before accepting it and stores the
field, value, source URL, model, content hash, exact quote, and character offsets
with the internship. Facts that remain unclear stay unknown.

The fallback supplies raw posting details such as title, employer, description,
locations, responsibilities, qualification text, salary, dates, term, duration,
job ID, and an application URL. It does not generate Scout's relevance score,
categories, remote/work mode, work authorization, sponsorship, or eligibility
states. Scout continues to derive those fields with its existing deterministic
analyzers from the accepted raw details. A missing or ambiguous fact remains
unknown; OpenAI evidence does not by itself establish a student's eligibility.
For a recognized role, the fallback fills only missing fields and preserves the
deterministic fields. A new candidate from a parser-unsupported page still goes
through the regular analyzer, relevance threshold, URL checks, deduplication,
and persistence gates.

## Enable it

Create a private `.env` file at the repository root (copy `.env.example` if
needed) and add your key:

```dotenv
OPENAI_API_KEY=your-private-key
SCOUT_LLM_MODEL=gpt-6-luna
```

Then start Scout normally from the repository root:

```sh
npm run scout -- --source 'https://careers.example.com/jobs'
```

Scout, the dashboard, and the local scheduler load the optional project-root
`.env` file automatically before reading settings. A normal `npm run scout`
or `npm run dashboard` start is enough; the scheduler's crawler child inherits
the loaded environment. Variables already supplied by the shell, launchd, or
hosting environment take precedence and are never overwritten. Restart a
running Scout, dashboard, or scheduler after changing `.env` so it reads the
new value.

The fallback is enabled when a key is present and can be explicitly disabled
with `SCOUT_LLM_FALLBACK=0`. Configure the model with `SCOUT_LLM_MODEL`; it otherwise uses `OPENAI_MODEL`
or defaults to `gpt-6-luna`. GPT-6 Luna requests explicitly use low reasoning. Replace old Gemini model settings when migrating.

The API key is sent only as a bearer token in the Authorization header to the
OpenAI Responses API. Requests use strict JSON schemas and `store: false`. Scout bounds provider
timeouts, request count, concurrency, and input/output size. Tune those limits
with `SCOUT_LLM_TIMEOUT_MS`, `SCOUT_LLM_MAX_REQUESTS`,
`SCOUT_LLM_CONCURRENCY`, `SCOUT_LLM_MAX_INPUT_CHARS`, and
`SCOUT_LLM_MAX_OUTPUT_CHARS`.

Defaults are a 15-second request timeout, at most 12 requests per crawl,
concurrency 2, 24,000 input characters, and 32,000 output characters. These
are upper bounds, not targets; the service also obeys the crawl's cancellation
signal and skips pages already identified as closed, blocked, or unsuccessful.

## Review extraction misses

Each fallback attempt appends a structured record to
`<SCOUT_OUTPUT_DIR>/parser-misses.jsonl` and a readable entry to
`<SCOUT_OUTPUT_DIR>/parser-misses.md`. These records preserve the source page,
the deterministic extraction gap, and the exact corresponding source wording.
They also record attempted facts that could not be accepted and why, so parser
coverage gaps can be reviewed without treating an unsupported model response as
an extracted fact.
The internship payload also carries accepted field evidence through SQLite
storage and JSON output.

If the key is absent, the fallback is disabled, or a provider response cannot
be validated, Scout continues with deterministic results. Existing fields are
preserved; unsupported or uncertain facts remain unknown.
