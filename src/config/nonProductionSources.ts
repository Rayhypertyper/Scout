export function isKnownNonProductionJobBoard(value: string): boolean {
  try {
    const url = new URL(value);
    return /(?:^|\.)greenhouse\.(?:io|com)$/i.test(url.hostname)
      && ["cssmerge", "mergeapiintegrationsandbox"].includes(url.pathname.split("/").filter(Boolean)[0]?.toLocaleLowerCase() ?? "");
  } catch {
    return false;
  }
}
