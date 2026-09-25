# Tailored resume downloads

Each listing and its detail panel have a **Download resume** button. It sends a POST to `/api/resumes/:listingType/:listingId`, loads the complete stored listing, prioritizes relevant projects, experience bullets, and skills, and returns a PDF compiled from LaTeX using Tectonic.

Tailoring is deterministic and local: it matches listing title, description, technologies, responsibilities, and qualifications against the base resume. It reorders existing material, preserves all claims and employment chronology, and never adds missing skills or follows instructions embedded in listings. It does not use an LLM to rewrite bullets. Sparse listings may produce the same ordering. Review the downloaded resume before applying.

## Personal setup

The supplied PDF has been transcribed into `output/resume/base.json` on this machine. This file is ignored by Git and is not served as a static asset. Edit this structured base when your experience changes. Its schema is `resumeSchema` in `src/resume/tailor.ts`. No resume or contact details are embedded in tracked source files.

- `RESUME_BASE_PATH`: optional absolute path to the structured base JSON; default `output/resume/base.json` relative to server cwd.
- `RESUME_TECTONIC_PATH`: optional absolute path to the Tectonic executable. The server checks `output/resume/bin/tectonic`, then `tectonic` on PATH.
- `RESUME_OWNER_USER_ID`: optional immutable authenticated user ID; otherwise the verified user's email must equal `ownerEmail` in the base JSON.

Tectonic 0.17.0 is installed in the ignored `output/resume/bin` directory on this machine. For another machine, install Tectonic (`brew install tectonic` on macOS) and copy your private base JSON separately. Standard TeX packages and fonts are downloaded on first use; compilation then uses the local cache. Resume contents are not sent to a remote compiler.

In non-production, downloads are available for direct loopback requests using a localhost host, including when auth is configured. Remote requests and all production requests require the verified owner. This is a single-owner feature; other accounts cannot download the owner's resume. It is not a multi-user resume upload service.

Compilation runs without shell execution, in an isolated temporary directory, with a 120-second timeout and one active compiler per server process. Temporary artifacts are deleted and downloads use `private, no-store`. Busy, unavailable compiler, missing profile, missing role, and authorization failures appear as retryable UI feedback where appropriate.

Run focused checks with `npx vitest run tests/resume.test.ts tests/resumeAccess.test.ts tests/resumeApi.test.ts`.
