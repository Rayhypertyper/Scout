# Application ownership and recovery

Ray confirmed on October 5, 2026 that every application submitted on this
website has been his and will continue to be his until he explicitly says
that this has changed. Treat that statement as the ownership authority for
recovery of this installation's historical application records. Do not treat
these records as ambiguous merely because they predate account-scoped storage.

The account-isolation migration left 202 applied records and 2,026 `cant_fit`
decisions in the legacy store under `__legacy__`, and preserved them in
`legacy_listing_actions_quarantine`. HTTP reads switched to
`user_listing_actions`, so the records disappeared from the account's view
without being deleted.

On resuming recovery, all 2,228 decisions and 21,691 identity rows were already
present in Ray's account store. Verification compared every action field and
every identity row against the original store: no missing records or changed
fields. All original dates, links, statuses, and stages were retained. The live
Applications page displayed 202 applications: 200 Applied, 1 OA, and 1 Rejected.
Analytics displayed 2,026 Hidden by you and 202 Applied roles.

A private recovery snapshot is saved at
`output/application-recovery-2026-10-05/action-records.json.gz`. It includes the
account ID, original records, restored records, identity rows, and verification
results. This generated backup is ignored by Git.

New HTTP actions already use the server-verified signed-in account ID. Keep
ownership durable across migrations and preserve each application's progress.
Use the account store for later recovery, rather than periodically reimporting
legacy copies, which would undo subsequent stage edits or restore deliberately
removed decisions. The preserved legacy records are recovery evidence.
