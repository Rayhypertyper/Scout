export const APPLICATION_STAGES = [
  "applied",
  "oa",
  "recruiter",
  "interview",
  "final",
  "offer",
  "rejected",
] as const;

export type ApplicationStage = (typeof APPLICATION_STAGES)[number];
export type LegacyApplicationStatus = "pending" | "accepted" | "rejected";

export function isApplicationStage(value: unknown): value is ApplicationStage {
  return typeof value === "string" && (APPLICATION_STAGES as readonly string[]).includes(value);
}

export function applicationStageFromLegacyStatus(value: unknown): ApplicationStage {
  if (value === "accepted") return "offer";
  if (value === "rejected") return "rejected";
  return "applied";
}

export function legacyApplicationStatusForStage(stage: ApplicationStage): LegacyApplicationStatus {
  if (stage === "offer") return "accepted";
  if (stage === "rejected") return "rejected";
  return "pending";
}
