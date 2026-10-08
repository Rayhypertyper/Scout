# Resume profiles and application drafts

Scout stores activated resume profiles in a separate SQLite file at `resolve(SCOUT_DATABASE_PATH) + ".resume-profiles.db"`, alongside the crawler database. The profile file and its SQLite journal, WAL, and shared-memory sidecars use owner-only permissions (0600 on POSIX). Profiles are isolated by verified account and are not served as static files. A newly imported file becomes a review candidate only; it is not used by listing actions until you review and save it. You can replace or delete the active profile from the account resume controls.

Before checking for legacy rows, Scout tightens an existing crawler database and its SQLite sidecars to owner-only access (0600 on POSIX). It automatically migrates legacy profiles, retaining any destination profile already present for the same account, and removes the old table only after migration completes. Crawler data remains in place. Back up the new profile database along with the crawler database; existing copies and backups of the old crawler database may still contain profile data and are not erased by migration.

## Upload and provider data flow

Resume import accepts PDF and plain text files up to 5 MiB. Scout sends the full selected PDF or text to the configured OpenAI Responses API to extract editable fields. The import screen says this before submission. Scout does not save the original upload. Text fields that cannot be matched in the uploaded text are removed from the candidate and called out for review; PDF extraction has no local text comparison, so inspect every extracted field before saving. See OpenAI's [structured output guide](https://developers.openai.com/api/docs/guides/structured-outputs) for the structured response feature Scout uses.

Application drafting sends role fields from the stored listing and a smaller resume excerpt to OpenAI. Resume rewriting sends only selected experience and project bullet text, with no separate name, contact, education, award, employer, title, or date fields. Bullet text is sent verbatim and could itself include identifying details. Cover-letter generation sends education, experience, project, award, and skill text needed to write the letter, but no separate name or contact fields; Scout adds the saved name to the signature locally. Requests use the server-side `OPENAI_API_KEY` as a bearer token in the Authorization header and the OpenAI Responses API with strict JSON schemas and `store: false`. No key belongs in browser code. Review OpenAI's [Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create) for the endpoint and request format.

OpenAI processes these requests outside Scout. Do not upload information you do not want sent to that provider. The draft feature does not retain prompt or response text in logs. Imported structured profile fields persist in the configured private SQLite file until you replace or delete the profile.

## Tailored resume drafts

Choose **Download resume** on a listing to create a draft for that role. Scout extracts keywords from the description, responsibilities, required and preferred qualifications, technologies, and title. Requirements and responsibilities receive more weight than the title. It ranks existing experience and project bullets against those priorities, gives OpenAI the parsed keywords and matching source bullets, and asks for selective edits that improve the emphasis on actual role requirements. Only bullets meeting the weighted relevance minimum are eligible, with preferred-qualification matches and explicit technology mentions reaching that threshold; a lone description or title overlap is too weak. The 40 highest-ranked eligible bullets are considered, while unrelated bullets and wording that already fits stay unchanged. Identity, education, employer and project names, titles, dates, awards, and skills come directly from the saved profile and cannot be rewritten by the model. A generated bullet must cite only its corresponding original bullet. Job requirements never count as proof that you have a skill or experience.

Before returning a generated draft, Scout checks source references, number and metric changes, missing role technologies, several unsupported leadership/scale/performance claims, and the cited role requirement. Each edit identifies a specific keyword and quotes an actual requirement from the posting. Equivalent numeric formatting such as `2,000` / `2000` and `20%` / `20 percent` passes the number check; changed values or units do not. OpenAI then reviews both factual support and whether the edit improves the source achievement's relevance to that requirement; generic synonym swaps and keyword stuffing are rejected. If a bullet fails either review, Scout sends the original bullet, rejected wording, and correction feedback to OpenAI while keeping the other edits. It allows up to three generation attempts within a 90-second overall deadline, and checks the complete repaired draft before returning it. Configuration, provider, and cancellation errors are returned directly.

The role-specific view shows original and tailored wording for each changed bullet, grouped by its source experience or project, with the keyword and posting requirement each edit targets. If no supported wording improvement is needed, the original bullets are preserved rather than rephrased to create artificial changes. Scout returns an actionable error if the saved resume has no experience/project bullets or if proposed edits cannot pass automatic correction. Expand **Relevance ordering** to compare any bullet, project, or skill reordering, then choose **Download tailored resume PDF** to export that exact draft. The role-specific view is read-only; use **Manage resume** to edit the saved profile. These checks can catch unsupported changes but cannot guarantee factual accuracy. Review the changes and downloaded resume before applying.

## Editable cover letters

Choose the cover-letter action to get an original, editable letter tailored to the role and company using the saved profile and full stored listing fields. It uses the same GPT-6 Luna / low-reasoning configuration and numeric checks as resume rewriting. Draft paragraphs carry source references, and automated checks reject references that cross distinct resume entries, fabricated metrics, or unsupported wording detected by the checks. The model never establishes eligibility from a job requirement.

Cover letters now use the same bounded automatic correction as resumes: up to three generation attempts within 90 seconds. If a paragraph fails local checks or OpenAI's factual review, only the rejected paragraphs are rewritten with correction feedback and original resume sources. Supported paragraphs are retained, paragraph IDs and order are checked, and the entire repaired letter passes local and OpenAI review again before it is returned. Copied-only resume text is rejected. Provider/configuration errors and cancellation stop the request directly; exhausted correction attempts return an actionable retry error rather than a substitute letter. The response warns you to review and personalize the letter; the checks do not replace your review.

## PDF export and configuration

The browser submits the reviewed tailored resume to `/api/resumes/:listingType/:listingId` as `{ "resume": <Resume> }` for PDF export. Export validates the bounded resume schema, escapes user text for LaTeX, and compiles with Tectonic. It does not call OpenAI again or change the saved profile. A bodyless POST to the same route remains available for the deterministic legacy export.

Set `OPENAI_API_KEY` only in the server environment. The optional `OPENAI_MODEL` defaults to `gpt-6-luna` and supplies the default for both AI features. GPT-6 Luna requests explicitly set `reasoning.effort` to `low`; `SCOUT_LLM_MODEL` can override it for the crawler fallback. Replace old Gemini model settings when migrating. Scout, the dashboard, and the scheduler automatically load an optional private repository-root `.env` file at startup. For example:

```sh
npm run dashboard
```

Variables exported in the shell or process manager take precedence over `.env`. Restart the dashboard or crawler after changing configuration. `RESUME_BASE_PATH` points to an optional private legacy base JSON for the verified owner/local setup. `RESUME_TECTONIC_PATH` selects the Tectonic executable; Scout also checks `output/resume/bin/tectonic` and then `tectonic` on `PATH`.

Authenticated profile reads require a verified account. Profile changes, draft generation, and PDF exports enforce same-origin checks and require the CSRF token obtained from the authenticated session/profile response. All profile, draft, and export responses use `private, no-store` cache headers. OpenAI calls and PDF compilation are bounded by input, response, time, and concurrency limits. Do not commit uploaded resumes, API keys, database files, or generated PDFs.

Run focused resume checks with:

```sh
npx vitest run tests/resumeDrafts.test.ts tests/resumeApi.test.ts tests/resumeProfile.test.ts
```

For a resume-only server update, run `npm run build:resume`, then restart the dashboard. This compiles drafting, tailoring, export, and their shared transport together and emits nothing if those modules fail typechecking. Updating a single compiled resume file can leave the running server with incompatible modules.
